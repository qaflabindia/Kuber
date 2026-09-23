/**
 * Key management. A KMS holds key-encryption keys (KEKs) and only ever wraps or unwraps data
 * keys; data never passes through it. Implementations are swappable: this file provides the local
 * key-file KMS for single-machine use. AWS KMS, GCP KMS or Vault Transit implement the same
 * interface for production, where the KEK never leaves the service.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { CryptoError } from "./cipher.ts";

export interface Kms {
  readonly name: string;
  activeKekId(): string;
  kekIds(): string[];
  wrap(key: Buffer, context: string): Promise<{ kekId: string; wrapped: string }>;
  unwrap(kekId: string, wrapped: string, context: string): Promise<Buffer>;
}

interface KeyFile { format: "kuber-keys/1"; active: string; keys: Record<string, string> }

const aesWrap = (kek: Buffer, key: Buffer, context: string) => {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, nonce);
  c.setAAD(Buffer.from(`wrap|${context}`));
  const body = Buffer.concat([c.update(key), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString("base64url");
};
const aesUnwrap = (kek: Buffer, wrapped: string, context: string) => {
  const b = Buffer.from(wrapped, "base64url");
  const d = createDecipheriv("aes-256-gcm", kek, b.subarray(0, 12));
  d.setAAD(Buffer.from(`wrap|${context}`));
  d.setAuthTag(b.subarray(b.length - 16));
  try { return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]); }
  catch { throw new CryptoError("auth_failed", "key unwrap failed: wrong master key or tampered key record"); }
};

export const newKekId = (d = new Date()) => `kek-${d.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;

/** Master keys in a local file (JSON, mode 0600, outside the repository). */
export class LocalFileKms implements Kms {
  readonly name = "local-file";
  private constructor(private path: string, private file: KeyFile, private keys: Map<string, Buffer>) {}

  static load(path: string, opts: { strictPermissions?: boolean } = {}): LocalFileKms {
    if (!existsSync(path)) throw new CryptoError("key_file", `master key file not found: ${path}. Create it with: keys init`);
    const st = statSync(path);
    if (opts.strictPermissions !== false && (st.mode & 0o077) !== 0) {
      throw new CryptoError("key_file", `master key file ${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${path}`);
    }
    let f: KeyFile;
    try { f = JSON.parse(readFileSync(path, "utf8")); } catch { throw new CryptoError("key_file", `master key file ${path} is not valid JSON`); }
    if (f.format !== "kuber-keys/1" || !f.keys?.[f.active]) throw new CryptoError("key_file", `master key file ${path} has no active key`);
    const keys = new Map(Object.entries(f.keys).map(([id, b64]) => {
      const k = Buffer.from(b64, "base64");
      if (k.length !== 32) throw new CryptoError("key_file", `master key ${id} is not 256-bit`);
      return [id, k] as const;
    }));
    return new LocalFileKms(path, f, keys);
  }

  /** Create a new key file with one master key. Refuses to overwrite. */
  static create(path: string): string {
    if (existsSync(path)) throw new CryptoError("key_file", `refusing to overwrite existing key file ${path}`);
    const id = newKekId();
    writeFileSync(path, JSON.stringify({ format: "kuber-keys/1", active: id, keys: { [id]: randomBytes(32).toString("base64") } }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return id;
  }

  /** Add a new master key and make it active. Old keys stay until retired, so existing wraps still open. */
  addKek(): string {
    const id = newKekId();
    this.file = { ...this.file, active: id, keys: { ...this.file.keys, [id]: randomBytes(32).toString("base64") } };
    this.keys.set(id, Buffer.from(this.file.keys[id]!, "base64"));
    this.persist();
    return id;
  }

  /** Remove a master key. The caller must first prove nothing is wrapped with it. */
  removeKek(id: string) {
    if (id === this.file.active) throw new CryptoError("key_file", "cannot remove the active master key");
    const { [id]: _gone, ...rest } = this.file.keys;
    this.file = { ...this.file, keys: rest };
    this.keys.delete(id);
    this.persist();
  }

  private persist() {
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);                                    // atomic replace
  }

  activeKekId() { return this.file.active; }
  kekIds() { return [...this.keys.keys()]; }
  async wrap(key: Buffer, context: string) { return { kekId: this.file.active, wrapped: aesWrap(this.keys.get(this.file.active)!, key, context) }; }
  async unwrap(kekId: string, wrapped: string, context: string) {
    const kek = this.keys.get(kekId);
    if (!kek) throw new CryptoError("no_key", `master key ${kekId} is not in the key file (retired too early?)`);
    return aesUnwrap(kek, wrapped, context);
  }
}

/** In-memory KMS for tests only. */
export class MemoryKms implements Kms {
  readonly name = "memory";
  private keys = new Map<string, Buffer>([["kek-test-1", randomBytes(32)]]);
  private active = "kek-test-1";
  rotate() { const id = `kek-test-${this.keys.size + 1}`; this.keys.set(id, randomBytes(32)); this.active = id; return id; }
  activeKekId() { return this.active; }
  kekIds() { return [...this.keys.keys()]; }
  async wrap(key: Buffer, context: string) { return { kekId: this.active, wrapped: aesWrap(this.keys.get(this.active)!, key, context) }; }
  async unwrap(kekId: string, wrapped: string, context: string) {
    const kek = this.keys.get(kekId);
    if (!kek) throw new CryptoError("no_key", `unknown master key ${kekId}`);
    return aesUnwrap(kek, wrapped, context);
  }
}
