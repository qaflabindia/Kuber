/**
 * Streaming authenticated encryption for large files (backups).
 *
 * Layout: header, then chunks. Header = "KUBERBK1" ‖ u16 len ‖ JSON {kekId, wrapped, noncePrefix}.
 * A fresh 256-bit file key is wrapped by the KMS. Each chunk (≤ 1 MiB plaintext) is AES-256-GCM with
 * nonce = noncePrefix(7) ‖ counter(u32) ‖ lastFlag(1) and the header as additional data, so
 * reordering, truncation (missing final chunk), appending, or swapping headers all fail to decrypt.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { CryptoError } from "./cipher.ts";
import type { Kms } from "./kms.ts";

const MAGIC = Buffer.from("KUBERBK1");
const CHUNK = 1 << 20;
const TAG = 16;

const nonceFor = (prefix: Buffer, counter: number, last: boolean) => {
  const n = Buffer.alloc(12); prefix.copy(n, 0); n.writeUInt32BE(counter, 7); n[11] = last ? 1 : 0; return n;
};

export async function encryptStream(kms: Kms, purpose: string): Promise<Transform> {
  const fileKey = randomBytes(32), prefix = randomBytes(7);
  const { kekId, wrapped } = await kms.wrap(fileKey, `file|${purpose}`);
  const meta = Buffer.from(JSON.stringify({ kekId, wrapped, purpose, noncePrefix: prefix.toString("base64") }));
  const header = Buffer.concat([MAGIC, Buffer.from([meta.length >> 8, meta.length & 255]), meta]);
  const aad = createHash("sha256").update(header).digest();
  let pending = Buffer.alloc(0), counter = 0, sentHeader = false;
  const seal = (pt: Buffer, last: boolean) => {
    const c = createCipheriv("aes-256-gcm", fileKey, nonceFor(prefix, counter++, last)); c.setAAD(aad);
    const body = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    return Buffer.concat([len, body]);
  };
  return new Transform({
    transform(chunk: Buffer, _e, cb: TransformCallback) {
      if (!sentHeader) { this.push(header); sentHeader = true; }
      pending = Buffer.concat([pending, chunk]);
      // keep at least one byte back so the final chunk is always sealed with last=1
      while (pending.length > CHUNK) { this.push(seal(pending.subarray(0, CHUNK), false)); pending = pending.subarray(CHUNK); }
      cb();
    },
    flush(cb: TransformCallback) {
      if (!sentHeader) this.push(header);
      this.push(seal(pending, true)); cb();
    },
  });
}

export function decryptStream(kms: Kms): Transform {
  let buf = Buffer.alloc(0), key: Buffer | null = null, prefix: Buffer | null = null, aad: Buffer | null = null;
  let counter = 0, done = false, pendingKey: Promise<void> | null = null;
  const fail = (m: string) => new CryptoError("auth_failed", `backup cannot be decrypted: ${m}`);
  return new Transform({
    transform(chunk: Buffer, _e, cb: TransformCallback) {
      buf = Buffer.concat([buf, chunk]);
      const step = async () => {
        if (!key) {
          if (buf.length < 10) return;
          if (!buf.subarray(0, 8).equals(MAGIC)) throw fail("not a Kuber encrypted file");
          const ml = (buf[8]! << 8) | buf[9]!;
          if (buf.length < 10 + ml) return;
          const header = buf.subarray(0, 10 + ml);
          const meta = JSON.parse(buf.subarray(10, 10 + ml).toString()) as { kekId: string; wrapped: string; purpose: string; noncePrefix: string };
          key = await kms.unwrap(meta.kekId, meta.wrapped, `file|${meta.purpose}`);
          prefix = Buffer.from(meta.noncePrefix, "base64"); aad = createHash("sha256").update(header).digest();
          buf = buf.subarray(10 + ml);
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len) break;
          const body = buf.subarray(4, 4 + len);
          if (done) throw fail("data after the final chunk");
          // the final chunk is the one that authenticates with last=1
          let pt: Buffer | null = null;
          for (const last of [false, true]) {
            try {
              const d = createDecipheriv("aes-256-gcm", key!, nonceFor(prefix!, counter, last)); d.setAAD(aad!);
              d.setAuthTag(body.subarray(len - TAG));
              pt = Buffer.concat([d.update(body.subarray(0, len - TAG)), d.final()]);
              if (last) done = true;
              break;
            } catch { /* try the other flag */ }
          }
          if (!pt) throw fail(`chunk ${counter} failed authentication`);
          counter++; this.push(pt); buf = buf.subarray(4 + len);
        }
      };
      pendingKey = (pendingKey ?? Promise.resolve()).then(step);
      pendingKey.then(() => cb(), (e) => cb(e));
    },
    flush(cb: TransformCallback) {
      (pendingKey ?? Promise.resolve()).then(() => cb(done && buf.length === 0 ? null : fail("file is truncated")), (e) => cb(e));
    },
  });
}
