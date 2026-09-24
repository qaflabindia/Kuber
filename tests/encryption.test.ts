/**
 * Encryption at rest: what is stored is unreadable without the tenant's keys, cannot be moved
 * between rows or tenants, and survives rotation; shredding makes it unreadable for good.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { uuid } from "@kuber/contracts";
import { CryptoError, Keyring, LocalFileKms, MemoryKms, decryptStream, encryptStream, openWith, sealWith } from "@kuber/crypto";
import { EventStore } from "@kuber/eventstore";
import { KeyAdmin, type Cell } from "@kuber/core";
import { ROOT, enrol, startCell } from "./helpers.ts";

// ---------------------------------------------------------------- primitives
describe("field encryption", () => {
  const key = randomBytes(32);
  it("round-trips any text and binds it to its context", () => {
    fc.assert(fc.property(fc.string(), fc.string({ minLength: 1 }), (pt, ctx) => {
      const tok = sealWith(key, 1, pt, ctx);
      expect(tok.startsWith("kb1.1.")).toBe(true);
      // Short encodings turn up in random ciphertext by chance; only a long one would mean a leak.
      if (pt.length >= 8) expect(tok).not.toContain(Buffer.from(pt).toString("base64url"));
      expect(openWith(key, tok, ctx).toString("utf8")).toBe(pt);
      expect(() => openWith(key, tok, ctx + "x")).toThrow(CryptoError);
    }), { numRuns: 200 });
  });
  it("detects any single-byte tamper and a wrong key", () => {
    const tok = sealWith(key, 1, "UPI/DR/SWIGGY", "row-1");
    const [pre, v, body] = tok.split(".");
    const raw = Buffer.from(body!, "base64url");
    for (let i = 0; i < raw.length; i += 7) {
      const t = Buffer.from(raw); t[i]! ^= 1;
      expect(() => openWith(key, `${pre}.${v}.${t.toString("base64url")}`, "row-1")).toThrow(/authentication/);
    }
    expect(() => openWith(randomBytes(32), tok, "row-1")).toThrow(/authentication/);
  });
  it("never produces the same ciphertext twice (fresh nonces)", () => {
    expect(sealWith(key, 1, "same", "ctx")).not.toBe(sealWith(key, 1, "same", "ctx"));
  });
});

describe("backup stream encryption", () => {
  const kms = new MemoryKms();
  const roundTrip = async (data: Buffer) => {
    const enc: Buffer[] = [];
    await pipeline(Readable.from([data]), await encryptStream(kms, "test"), async function* (src) { for await (const c of src) enc.push(c as Buffer); });
    return Buffer.concat(enc);
  };
  const decrypt = async (blob: Buffer) => {
    const out: Buffer[] = [];
    await pipeline(Readable.from([blob]), decryptStream(kms), async function* (src) { for await (const c of src) out.push(c as Buffer); });
    return Buffer.concat(out);
  };
  it("round-trips empty, small and multi-chunk files", async () => {
    for (const n of [0, 1, 1 << 20, (1 << 20) + 1, 3 * (1 << 20) + 17]) {
      const data = randomBytes(n);
      expect((await decrypt(await roundTrip(data))).equals(data)).toBe(true);
    }
  });
  it("detects truncation, appended data and tampering", async () => {
    const blob = await roundTrip(randomBytes(2.5 * (1 << 20)));
    await expect(decrypt(blob.subarray(0, blob.length - 100))).rejects.toThrow();
    const cut = blob.subarray(0, blob.length - 1);
    await expect(decrypt(cut)).rejects.toThrow();
    await expect(decrypt(Buffer.concat([blob, Buffer.from("extra")]))).rejects.toThrow();
    const t = Buffer.from(blob); t[t.length - 40]! ^= 1;
    await expect(decrypt(t)).rejects.toThrow(/authentication/);
  });
});

describe("master key file", () => {
  it("is created 0600, refuses to be overwritten, and is refused when readable by others", () => {
    const dir = mkdtempSync(join(tmpdir(), "kuber-keys-")), file = join(dir, "master.keys");
    const id = LocalFileKms.create(file);
    expect(() => LocalFileKms.create(file)).toThrow(/refusing to overwrite/);
    expect(LocalFileKms.load(file).activeKekId()).toBe(id);
    chmodSync(file, 0o644);
    expect(() => LocalFileKms.load(file)).toThrow(/readable by other users/);
    chmodSync(file, 0o600);
  });
  it("rotates: new wraps use the new key, old wraps still open until retired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuber-keys-")), file = join(dir, "master.keys");
    LocalFileKms.create(file);
    const kms = LocalFileKms.load(file), dek = randomBytes(32);
    const old = await kms.wrap(dek, "ctx");
    const newId = kms.addKek();
    const reloaded = LocalFileKms.load(file);
    expect(reloaded.activeKekId()).toBe(newId);
    expect((await reloaded.unwrap(old.kekId, old.wrapped, "ctx")).equals(dek)).toBe(true);
    reloaded.removeKek(old.kekId);
    await expect(LocalFileKms.load(file).unwrap(old.kekId, old.wrapped, "ctx")).rejects.toThrow(/not in the key file/);
    expect(JSON.parse(readFileSync(file, "utf8")).keys[old.kekId]).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the database holds no plaintext
const T = "laksh", B = "main", OWNER = "owner:laksh";
const clock = { value: "2026-10-25" };
const kms = new MemoryKms();
let cell: Cell, stop: () => Promise<void>, owner: postgres.Sql, admin: KeyAdmin, ownerUrl: string, appUrl: string, ownerKeys: Keyring;
const SENSITIVE = ["SWIGGY", "swiggy", "ACME", "acme solutions", "plumb", "UNKNOWN MERCHANT", "HOME LOAN"];

/** Simulate an attacker with owner rights who disables the append-only guard to tamper. */
async function tamper(sql: postgres.Sql, fn: (t: postgres.TransactionSql) => Promise<unknown>) {
  await sql.begin(async (t) => {
    await t`ALTER TABLE es.events DISABLE TRIGGER events_append_only`;
    await fn(t);
    await t`ALTER TABLE es.events ENABLE TRIGGER events_append_only`;
  });
}

async function dumpText(sql: postgres.Sql, tenant?: string) {
  const tables = await sql<{ s: string; t: string }[]>`
    SELECT table_schema AS s, table_name AS t FROM information_schema.tables
    WHERE table_schema IN ('es','agent','reporting','ops','keys') AND table_type = 'BASE TABLE'`;
  let all = "";
  for (const { s, t } of tables) {
    const rows = await sql.unsafe(`SELECT row_to_json(x)::text AS j FROM ${s}.${t} x`) as { j: string }[];
    all += rows.filter((r) => !tenant || r.j.includes(tenant)).map((r) => r.j).join("\n");
  }
  return all;
}

beforeAll(async () => {
  let db: { ownerUrl: string; url: string };
  ({ cell, stop, db } = await startCell(clock, { kms }) as never);
  await enrol(cell, T, [OWNER]);                                   // the only person: explicit single-owner exception
  await cell.identity.setSettings(T, OWNER, { soloOwner: true, sodLimitPaise: null });
  ownerUrl = db.ownerUrl; appUrl = db.url;
  owner = postgres(ownerUrl, { max: 2, onnotice: () => undefined });
  // Operator actions run with the owner role, exactly as the keys CLI does; the app role cannot.
  ownerKeys = new Keyring(owner, kms, 0);
  admin = new KeyAdmin(owner, ownerKeys, new EventStore(owner, "admin", { keyring: ownerKeys, legacy: "allow" }), 0);
  await cell.gl.openBook(T, B, "laksh", "freelancer", OWNER);
  await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: "Opening BANK", voucherType: "opening",
    lines: [{ accountId: "BANK", amount: "12500000", dimensions: {} }, { accountId: "OPENING", amount: "-12500000", dimensions: {} }] }, { principal: OWNER });
  await cell.channels.submitStatement(T, B, readFileSync(join(ROOT, "samples", "hdfc_2026_10.csv"), "utf8"), OWNER);
  await cell.settle();
  const p = await cell.ops.plan(T, B, OWNER, "post", {});
  await cell.ops.commit(T, p.planId, OWNER, p.hash);
  await cell.agent.addRule(T, "zomato", "LIVING", OWNER);
  await cell.settle();
  await cell.ops.plan(T, B, OWNER, "record", { narration: "Swiggy dinner", amount: 450, direction: "out", account: "LIVING", via: "CASH" });
});
afterAll(async () => { await owner.end(); await stop(); });

describe("at rest", () => {
  it("no merchant name, narration or rule appears anywhere in the database", async () => {
    const dump = await dumpText(owner);
    expect(dump.length).toBeGreaterThan(10_000);
    for (const s of SENSITIVE) expect(dump.includes(s), `found "${s}" in plaintext`).toBe(false);
    expect(dump).not.toContain("zomato");
  });

  it("the application still reads everything back", async () => {
    const drafts = await cell.agent.queue(T);
    expect(drafts[0]!.proposal.narration).toContain("UNKNOWN MERCHANT");
    const lines = await cell.reporting.drill(T, B, "LIVING");
    expect(lines.some((l) => /SWIGGY/i.test(l.narration))).toBe(true);
    expect((await cell.ops.pending(T, B)).some((p) => p.summary.includes("Swiggy dinner"))).toBe(true);
  });

  it("every event is sealed and the outbox carries only ciphertext", async () => {
    const [e] = await owner`SELECT count(*)::int AS n, count(*) FILTER (WHERE data ? '$c')::int AS sealed FROM es.events`;
    expect(e!.sealed).toBe(e!.n);
    const [o] = await owner`SELECT count(*)::int AS n FROM es.outbox WHERE NOT (envelope->'data' ? '$c')`;
    expect(o!.n).toBe(0);
  });

  it("parties are keyed pseudonyms, not guessable hashes of the name", async () => {
    const ids = (await owner`SELECT party_id FROM agent.parties`).map((r) => r.party_id as string);
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) expect(id).toMatch(/^p\.[A-Za-z0-9_-]{22}$/);
  });

  it("a ciphertext moved to another row does not open", async () => {
    const [a, b] = await owner<{ global_position: string; data: unknown }[]>`
      SELECT global_position::text, data FROM es.events WHERE tenant_id = ${T} AND type = 'JournalPosted' ORDER BY global_position LIMIT 2`;
    await tamper(owner, (t) => t`UPDATE es.events SET data = ${t.json(a!.data as never)} WHERE global_position = ${b!.global_position}`);
    const s = await owner`SELECT stream_id FROM es.events WHERE global_position = ${b!.global_position}`;
    await expect(cell.store.readStream(T, s[0]!.stream_id as string)).rejects.toThrow(/authentication/);
    const v = await admin.verify(true);
    expect(v.problems.some((p) => /digest|authentication/.test(p))).toBe(true);
    await tamper(owner, (t) => t`UPDATE es.events SET data = ${t.json(b!.data as never)} WHERE global_position = ${b!.global_position}`);
    expect((await admin.verify(true)).problems).toEqual([]);
  });

  it("deleting or reordering stored events breaks the link chain, detectably without keys", async () => {
    const [x] = await owner<{ global_position: string; digest: string }[]>`
      SELECT global_position::text, digest FROM es.events WHERE tenant_id = ${T} ORDER BY global_position OFFSET 3 LIMIT 1`;
    await expect(owner`UPDATE es.events SET digest = ${"f".repeat(64)} WHERE global_position = ${x!.global_position}`).rejects.toThrow(/append-only/);
    await tamper(owner, (t) => t`UPDATE es.events SET digest = ${"f".repeat(64)} WHERE global_position = ${x!.global_position}`);
    expect((await cell.store.verifyStorage()).problems.some((p) => p.includes("link chain broken"))).toBe(true);
    await tamper(owner, (t) => t`UPDATE es.events SET digest = ${x!.digest} WHERE global_position = ${x!.global_position}`);
    expect((await cell.store.verifyStorage()).problems).toEqual([]);
  });

  it("the application role cannot rewrite events, re-wrap keys or shred", async () => {
    const app = postgres(appUrl, { max: 1, onnotice: () => undefined });
    try {
      await expect(app.begin(async (t) => { await t`SELECT set_config('kuber.role','system',true)`; await t`UPDATE es.events SET data = '{}' WHERE false`; })).rejects.toThrow(/permission denied/);
      await expect(app.begin(async (t) => { await t`SELECT set_config('kuber.role','system',true)`; await t`UPDATE keys.tenant_keys SET state = 'retired' WHERE false`; })).rejects.toThrow(/permission denied/);
      await expect(app.begin(async (t) => { await t`SELECT set_config('kuber.role','system',true)`; await t`INSERT INTO keys.shredded VALUES ('x', now(), 'y', 'z')`; })).rejects.toThrow(/permission denied/);
    } finally { await app.end(); }
  });
});

describe("rotation", () => {
  it("tenant key rotation re-encrypts everything and drops the old key", async () => {
    const before = (await cell.store.verifyStorage()).events;
    const v = await ownerKeys.rotateTenant(T);
    cell.keyring.invalidate(T);
    expect(v).toBe(2);
    // Published envelopes sealed with v1 pin it until the broker can no longer deliver them (F13);
    // here the broker is taken as purged, so nothing outside PostgreSQL needs v1.
    await admin.recordBusPurge("operator:test");
    const r = await admin.reencrypt(T);
    expect(r.events).toBeGreaterThan(20);
    expect(r.columns).toBeGreaterThan(10);
    expect(r.dropped).toEqual([1]);
    const [left] = await owner`SELECT count(*)::int AS n FROM es.events WHERE tenant_id = ${T} AND data->>'$c' LIKE 'kb1.1.%'`;
    expect(left!.n).toBe(0);
    const check = await admin.verify(true);
    expect(check.problems).toEqual([]);
    expect(check.events).toBe(before);
    const q = await cell.agent.queue(T);
    expect(q.length).toBe(1);
    expect(q[0]!.proposal.narration).toContain("UNKNOWN MERCHANT");        // re-sealed JSON opens as an object
    expect((await cell.ops.pending(T, B))[0]!.summary).toContain("Swiggy dinner");
  });

  it("master key rotation re-wraps tenant keys without touching data", async () => {
    const [before] = await owner`SELECT md5(string_agg(data::text, '' ORDER BY global_position)) AS h FROM es.events`;
    kms.rotate();
    expect(await ownerKeys.rewrapAll()).toBeGreaterThan(1);
    expect(Object.keys(await ownerKeys.kekUsage())).toEqual([kms.activeKekId()]);
    cell.keyring.invalidate();
    const [after] = await owner`SELECT md5(string_agg(data::text, '' ORDER BY global_position)) AS h FROM es.events`;
    expect(after!.h).toBe(before!.h);
    expect((await admin.verify(true)).problems).toEqual([]);
  });
});

describe("legacy plaintext and shredding", () => {
  it("plaintext written before encryption is refused, then sealed by the migration", async () => {
    const plain = new EventStore(owner, "legacy", null);
    await plain.append("channels", "old-co", { streamId: "old-co/signal/1", expected: "no_stream",
      events: [{ type: "SignalReceived", data: { signalId: "s1", bookId: "main", channel: "chat", trust: "user", contentHash: "a".repeat(64), lines: 1 } }] }, { principal: "owner:old" });
    await expect(cell.store.readStream("old-co", "old-co/signal/1")).rejects.toThrow(/stored unencrypted/);
    expect(Object.keys((await admin.verify()).plaintext)).toContain("es.events.data");
    const r = await admin.encryptLegacy();
    expect(r.events).toBe(1);
    expect((await cell.store.readStream("old-co", "old-co/signal/1"))[0]!.type).toBe("SignalReceived");
    const v = await admin.verify(true);
    expect(v.plaintext).toEqual({});
    expect(v.problems).toEqual([]);
  });

  it("crypto-shredding makes a tenant unreadable for good and purges its projections", async () => {
    await admin.shred("old-co", "operator:test", "erasure request");
    cell.keyring.invalidate("old-co");
    await expect(cell.store.readStream("old-co", "old-co/signal/1")).rejects.toThrow(/crypto-shredded/);
    await expect(cell.keyring.forTenant("old-co")).rejects.toThrow(/crypto-shredded/);
    // the sealed record remains and its structure still verifies, without any key
    const v = await cell.store.verifyStorage({ tenantId: "old-co" });
    expect(v.events).toBe(1);
    expect(v.problems).toEqual([]);
    // the other tenant is untouched
    expect((await cell.agent.queue(T)).length).toBe(1);
  });
});
