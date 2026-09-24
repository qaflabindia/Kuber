/**
 * Balance checks verify the book incrementally from a recorded checkpoint (stream, version, link):
 * tampering after the checkpoint is still found, tampering before it is found by a full
 * verification, and only the owner or the system role can move a checkpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { uuid } from "@kuber/contracts";
import { Keyring, MemoryKms } from "@kuber/crypto";
import { EventStore } from "@kuber/eventstore";
import { KeyAdmin, type Cell } from "@kuber/core";
import { enrol, startCell } from "./helpers.ts";

const T = "chk", B = "main", OWNER = "owner:chk";
const STREAM = `${T}/book/${B}`;
const kms = new MemoryKms();
let cell: Cell, stop: () => Promise<void>, owner: postgres.Sql, admin: KeyAdmin, appUrl: string, systemUrl: string;

async function tamper(fn: (t: postgres.TransactionSql) => Promise<unknown>) {
  await owner.begin(async (t) => {
    await t`ALTER TABLE es.events DISABLE TRIGGER events_append_only`;
    await fn(t);
    await t`ALTER TABLE es.events ENABLE TRIGGER events_append_only`;
  });
}
const post = (n: number) => cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-01", narration: `journal ${n}`,
  lines: [{ accountId: "LIVING", amount: String(100 + n), dimensions: {} }, { accountId: "BANK", amount: String(-(100 + n)), dimensions: {} }] }, { principal: OWNER });
const checkpoint = async () => (await owner<{ stream_version: number; link: string; verified_by: string }[]>`
  SELECT stream_version, link, verified_by FROM es.verify_checkpoints WHERE stream_id = ${STREAM}`)[0];
const balance = async () => (await cell.ops.plan(T, B, OWNER, "balance", {})).checks.find((c) => c.label === "Hash chain intact")!;
const row = async (version: number) => (await owner<{ global_position: string; digest: string; data: unknown }[]>`
  SELECT global_position::text, digest, data FROM es.events WHERE stream_id = ${STREAM} AND stream_version = ${version}`)[0]!;

beforeAll(async () => {
  const f = await startCell({ value: "2026-10-25" }, { kms });
  ({ cell, stop } = f);
  appUrl = f.db.url; systemUrl = f.db.systemUrl;
  owner = postgres(f.db.ownerUrl, { max: 2, onnotice: () => undefined });
  const keys = new Keyring(owner, kms, 0);
  admin = new KeyAdmin(owner, keys, new EventStore(owner, "admin", { keyring: keys, legacy: "allow" }), 0);
  await enrol(cell, T, [OWNER]);
  await cell.gl.openBook(T, B, T, "individual", OWNER);
  for (let i = 0; i < 6; i++) await post(i);
});
afterAll(async () => { await owner.end(); await stop(); });

describe("verification checkpoints", () => {
  it("a balance check verifies everything once, records a checkpoint, then verifies only what follows", async () => {
    expect(await checkpoint()).toBeUndefined();
    const first = await cell.gl.verifyDetail(T, B);
    expect(first).toMatchObject({ broken: null, from: 0, to: 7, events: 7, checkpointed: true });
    expect(await checkpoint()).toMatchObject({ stream_version: 7, verified_by: "kuber_system" });   // written by the system role
    expect(await cell.gl.verifyDetail(T, B)).toMatchObject({ broken: null, from: 7, to: 7, events: 0 });
    await post(10); await post(11);
    const c = await balance();
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/2 new event\(s\) verified/);
    expect((await checkpoint())!.stream_version).toBe(9);
  });

  it("tampering after the checkpoint is detected by the incremental check and the checkpoint does not move", async () => {
    await post(20); await post(21);                                      // versions 10, 11 follow the checkpoint at 9
    const [a, b] = [await row(10), await row(11)];
    await tamper((t) => t`UPDATE es.events SET data = ${t.json(a.data as never)} WHERE global_position = ${b.global_position}`);
    try {
      expect(await cell.gl.verify(T, B)).toMatch(/#11: .*authentication/);
      const c = await balance();
      expect(c.ok).toBe(false);
      expect((await checkpoint())!.stream_version).toBe(9);
    } finally {
      await tamper((t) => t`UPDATE es.events SET data = ${t.json(b.data as never)} WHERE global_position = ${b.global_position}`);
    }
    // a broken link (digest changed) after the checkpoint, without keys
    await tamper((t) => t`UPDATE es.events SET digest = ${"f".repeat(64)} WHERE global_position = ${a.global_position}`);
    try {
      expect(await cell.gl.verify(T, B)).toMatch(/#10: link chain broken/);
      expect((await cell.store.verifyStorage({ tenantId: T, incremental: true })).problems.join()).toMatch(/#10: link chain broken/);
    } finally {
      await tamper((t) => t`UPDATE es.events SET digest = ${a.digest} WHERE global_position = ${a.global_position}`);
    }
    expect(await cell.gl.verify(T, B)).toBeNull();
    expect((await checkpoint())!.stream_version).toBe(11);
  });

  it("tampering before the checkpoint is not re-read by the incremental check; a full verification finds it", async () => {
    const x = await row(3);
    await tamper((t) => t`UPDATE es.events SET digest = ${"e".repeat(64)} WHERE global_position = ${x.global_position}`);
    try {
      expect(await cell.gl.verify(T, B)).toBeNull();                         // incremental: history before the checkpoint is trusted
      expect(await cell.gl.verify(T, B, { full: true })).toMatch(/#3: link chain broken/);
      const inc = await admin.verify(true, { incremental: true, record: true });
      expect(inc.problems.filter((p) => p.startsWith(STREAM))).toEqual([]);
      const full = await admin.verify(true, { record: true });               // keys verify --full
      expect(full.problems).toContain(`${STREAM}#3: link chain broken`);
      expect((await checkpoint())!.stream_version).toBe(11);                // a broken stream's checkpoint never moves
    } finally {
      await tamper((t) => t`UPDATE es.events SET digest = ${x.digest} WHERE global_position = ${x.global_position}`);
    }
    expect((await admin.verify(true, { record: true })).problems).toEqual([]);
  });

  it("a changed link at the checkpoint itself, or a missing checkpointed event, is detected incrementally", async () => {
    const cp = (await checkpoint())!;
    const at = (await owner<{ global_position: string; link: string }[]>`
      SELECT global_position::text, link FROM es.events WHERE stream_id = ${STREAM} AND stream_version = ${cp.stream_version}`)[0]!;
    await tamper((t) => t`UPDATE es.events SET link = ${"0".repeat(64)} WHERE global_position = ${at.global_position}`);
    try {
      expect(await cell.gl.verify(T, B)).toMatch(/no longer matches its verified checkpoint/);
    } finally {
      await tamper((t) => t`UPDATE es.events SET link = ${at.link} WHERE global_position = ${at.global_position}`);
    }
    await owner`UPDATE es.verify_checkpoints SET stream_version = 999 WHERE stream_id = ${STREAM}`;
    try {
      expect(await cell.gl.verify(T, B)).toMatch(/#999: verified event is missing/);
    } finally {
      await owner`UPDATE es.verify_checkpoints SET stream_version = ${cp.stream_version} WHERE stream_id = ${STREAM}`;
    }
    expect(await cell.gl.verify(T, B)).toBeNull();
  });

  it("the application role can read checkpoints but not write them; the system role and the owner can", async () => {
    const app = postgres(appUrl, { max: 1, onnotice: () => undefined });
    const sys = postgres(systemUrl, { max: 1, onnotice: () => undefined });
    try {
      const asTenant = (sql: postgres.Sql, fn: (t: postgres.TransactionSql) => Promise<unknown>) =>
        sql.begin(async (t) => { await t`SELECT set_config('kuber.tenant', ${T}, true)`; return fn(t); });
      expect(await asTenant(app, (t) => t`SELECT stream_version FROM es.verify_checkpoints WHERE stream_id = ${STREAM}`)).toHaveLength(1);
      await expect(asTenant(app, (t) => t`UPDATE es.verify_checkpoints SET stream_version = 1`)).rejects.toThrow(/permission denied/);
      await expect(asTenant(app, (t) => t`INSERT INTO es.verify_checkpoints (stream_id, tenant_id, stream_version, link)
        VALUES (${`${T}/book/forged`}, ${T}, 1, ${"a".repeat(64)})`)).rejects.toThrow(/permission denied/);
      await expect(app`DELETE FROM es.verify_checkpoints`).rejects.toThrow(/permission denied/);
      const n = await sys.begin((t) => t`UPDATE es.verify_checkpoints SET verified_at = now() WHERE stream_id = ${STREAM}`);
      expect(n.count).toBe(1);
    } finally { await app.end(); await sys.end(); }
  });
});
