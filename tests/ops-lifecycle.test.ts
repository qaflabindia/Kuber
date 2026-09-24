/**
 * Operational lifecycle (assessment F12, F13, F15):
 *   F13  key lifecycle covers every retained copy (published envelopes within bus retention,
 *        snapshots, evidence, report snapshots); erasure leaves nothing readable, fences writes,
 *        survives a restore through the shred ledger; verify reports residue.
 *   F12  exhausted deliveries become durable dead letters that can be retried or discarded;
 *        projections rebuild deterministically from the event store and are checked against it.
 *   F15  statements disclose the projection position vs the ledger, can require freshness, and a
 *        certified snapshot reproduces from the ledger later.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { uuid } from "@kuber/contracts";
import { Keyring } from "@kuber/crypto";
import { EventStore, openEnvelope } from "@kuber/eventstore";
import { StaleReportError } from "@kuber/reporting";
import { KeyAdmin, OpsAdmin, PROJECTION_TABLES, buildServer, type Cell } from "@kuber/core";
import { MemoryBus } from "@kuber/bus";
import { CORE_AUTH_SECRET, ROOT, enrol, signed, startCell } from "./helpers.ts";

const OWNER = "owner:ops";
const csv = (f: string) => readFileSync(join(ROOT, "samples", f), "utf8");
const journal = (cell: Cell, t: string, b: string, amount: string, date = "2026-10-01", narration = "Ops test") =>
  cell.gl.execute(t, b, { kind: "PostJournal", journalId: uuid(), txnDate: date, narration,
    lines: [{ accountId: "BANK", amount, dimensions: {} }, { accountId: "OPENING", amount: (-BigInt(amount)).toString(), dimensions: {} }] }, { principal: OWNER });

/** A fresh cell with one open book, plus an owner connection, keyring and admins. */
async function fixture(tenant: string, extra: Parameters<typeof startCell>[1] = {}, entity = "individual") {
  const f = await startCell({ value: "2026-11-25" }, extra);
  const owner = postgres(f.db.ownerUrl, { max: 3, onnotice: () => undefined });
  const keyring = new Keyring(owner, f.cell.keyring.kms, 0);
  const store = new EventStore(owner, "admin", { keyring });
  await f.cell.gl.openBook(tenant, "main", tenant, entity, OWNER);
  if (f.cell.bus instanceof MemoryBus) await f.cell.settle();
  return { ...f, owner, keyring, store, ops: new OpsAdmin(owner, f.cell),
    keys: (graceMs = 0, busRetentionMs?: number) => new KeyAdmin(owner, keyring, store, graceMs, { busRetentionMs }),
    stop: async () => { await owner.end(); await f.stop(); } };
}

// ====================================================================== F13 key lifecycle
describe("F13: key lifecycle covers every retained copy", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const T = "keys";
  beforeAll(async () => { f = await fixture(T); });
  afterAll(async () => { await f?.stop(); });

  it("keeps a retired key while an envelope sealed with it may still be delivered by the broker (A13)", async () => {
    const [row] = await f.owner`SELECT envelope FROM es.outbox WHERE tenant_id = ${T} ORDER BY id LIMIT 1`;
    const published = row!.envelope;
    await f.keyring.rotateTenant(T);
    const r = await f.keys(0).reencrypt(T);                     // no cache grace, default 7-day bus retention
    expect(r.events).toBeGreaterThan(0);
    expect(r.dropped).not.toContain(1);
    expect(r.kept.join()).toMatch(/v1: 1 envelope\(s\) sealed with it were published to the broker/);
    f.keyring.invalidate(T);
    expect((await openEnvelope(f.keyring, published)).type).toBe("BookOpened");   // a late consumer can still read it
    // the event store itself is fully re-sealed under v2
    const [e] = await f.owner`SELECT count(*)::int AS n FROM es.events WHERE tenant_id = ${T} AND data->>'$c' NOT LIKE 'kb1.2.%'`;
    expect(e!.n).toBe(0);
  });

  it("drops the key once the broker can no longer hold such envelopes (retention passed or bus purged)", async () => {
    const admin = f.keys(0);
    await admin.recordBusPurge("operator:test");
    const r = await admin.dropRetired(T);
    expect(r).toEqual({ dropped: [1], kept: [] });
    const [o] = await f.owner`SELECT count(*)::int AS n FROM es.outbox WHERE tenant_id = ${T}`;
    expect(o!.n).toBe(0);                                          // published copies pruned with the key
    f.cell.keyring.invalidate(T);
    expect((await f.cell.reporting.trialBalance(T, "main")).basis!.fresh).toBe(true);
    expect(await f.cell.gl.verify(T, "main")).toBeNull();          // GL chain intact after rotation
  });

  it("re-seals unpublished outbox rows so the relay publishes under the new key", async () => {
    await journal(f.cell, T, "main", "700");                      // not settled: outbox row unpublished
    await f.keyring.rotateTenant(T);
    const r = await f.keys(0, 0).reencrypt(T);
    expect(r.kept.join()).not.toMatch(/stored value/);
    const [o] = await f.owner`SELECT envelope->'data'->>'$c' AS c FROM es.outbox WHERE tenant_id = ${T} AND published_at IS NULL`;
    expect(o!.c).toMatch(/^kb1\.3\./);
    f.cell.keyring.invalidate(T);
    await f.cell.settle();
    expect((await f.cell.reporting.trialBalance(T, "main")).totals["Total debits"]).toBe(700n);
  });

  it("re-seals certified report snapshots and drops cached aggregate snapshots under a retired key", async () => {
    const snap = await f.cell.reporting.certify(T, "main", "trial-balance", { asOf: null }, OWNER);
    // a GL snapshot sealed with the key about to be retired (GL snapshots are sealed {$c} rows)
    await f.owner`INSERT INTO es.snapshots (stream_id, tenant_id, stream_version, state) VALUES (${`${T}/book/old`}, ${T}, 1, ${f.owner.json({ $c: "kb1.3.fake" })})`;
    await f.keyring.rotateTenant(T);
    const admin = f.keys(0, 0);
    expect((await admin.usage(T, 3))["reporting.snapshots.body"]).toBe(1);
    const r = await admin.reencrypt(T);
    expect(r.dropped).toContain(3);
    expect(await f.owner`SELECT 1 FROM es.snapshots WHERE tenant_id = ${T} AND state->>'$c' NOT LIKE 'kb1.4.%'`).toHaveLength(0);
    f.cell.keyring.invalidate(T);
    expect((await f.cell.reporting.getSnapshot(T, snap.snapshotId))!.verified).toBe(true);
  });
});

describe("F13: crypto-shred leaves nothing readable", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const T = "gone", KEEP = "stays";
  beforeAll(async () => {
    f = await fixture(T);
    await f.cell.gl.openBook(KEEP, "main", KEEP, "individual", OWNER);
    await journal(f.cell, T, "main", "10000"); await journal(f.cell, KEEP, "main", "500");
    await f.cell.settle();
    await f.cell.reporting.certify(T, "main", "balance-sheet", { asOf: null }, OWNER);
  });
  afterAll(async () => { await f?.stop(); });

  it("the retention inventory classifies every tenant table", async () => {
    expect((await f.keys().erasureReport()).unclassified).toEqual([]);
    expect(PROJECTION_TABLES).toEqual(expect.arrayContaining(["evidence.balances", "evidence.records", "evidence.lookup", "es.dead_letters", "reporting.snapshots"]));
  });

  it("purges evidence balances and every other readable projection (A14), verify reports no residue", async () => {
    const admin = f.keys();
    const r = await admin.shred(T, "operator:test", "synthetic tenant");
    expect(r.purged["evidence.balances"]).toBe(2);
    expect(r.purged["reporting.snapshots"]).toBe(1);
    expect(await f.owner`SELECT * FROM evidence.balances WHERE tenant_id = ${T}`).toHaveLength(0);
    const v = await admin.verify(true);
    expect(v.residue).toEqual({});
    expect(v.unclassified).toEqual([]);
    expect(v.problems).toEqual([]);                                // sealed history still verifies structurally
    // the other tenant is untouched
    expect((await f.cell.reporting.trialBalance(KEEP, "main")).totals["Total debits"]).toBe(500n);
  });

  it("fences new writes for the shredded tenant even from a process that still caches its keys", async () => {
    await expect(journal(f.cell, T, "main", "1")).rejects.toThrow(/crypto-shredded/);
  });

  it("verify reports anything that reappears; purge-shredded removes it", async () => {
    await f.owner`INSERT INTO evidence.balances VALUES (${T}, 'main', 'BANK', 1)`;
    const admin = f.keys();
    expect((await admin.verify(false)).residue).toEqual({ [T]: { "evidence.balances": 1 } });
    await admin.purgeShredded();
    expect((await admin.verify(false)).residue).toEqual({});
  });

  it("a restore from before the shred is erased again from the shred ledger", async () => {
    // simulate the restored state: tombstone and key deletion undone, projections back
    await f.owner`DELETE FROM keys.shredded WHERE tenant_id = ${T}`;
    await f.owner`INSERT INTO keys.tenant_keys (tenant_id, purpose, version, kek_id, wrapped, state) VALUES (${T}, 'data', 9, 'k', 'w', 'active')`;
    await f.owner`INSERT INTO reporting.daily VALUES (${T}, 'main', 'BANK', '2026-10-01', 10000, 10000, 0)`;
    const admin = f.keys();
    const r = await admin.reapplyShreds([{ tenant: T, by: "operator:test", reason: "synthetic tenant" }]);
    expect(r.reshredded).toEqual([T]);
    expect((await admin.verify(false)).residue).toEqual({});
  });
});

// ====================================================================== F12 dead letters
const FAIL_TRIGGER = `
CREATE OR REPLACE FUNCTION public.fail_777() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.amount = 777 THEN RAISE EXCEPTION 'injected projection failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER fail_777 BEFORE INSERT ON reporting.lines FOR EACH ROW EXECUTE FUNCTION public.fail_777();`;

describe("F12: dead letters", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const T = "dlq";
  beforeAll(async () => { f = await fixture(T); });
  afterAll(async () => { await f?.stop(); });

  it("records an exhausted delivery durably with the event reference and error", async () => {
    await f.owner.unsafe(FAIL_TRIGGER);
    const [posted] = await journal(f.cell, T, "main", "777");
    await expect(f.cell.settle()).rejects.toThrow(/dead letters: reporting/);
    (f.cell.bus as MemoryBus).deadLetters.length = 0;
    const [d] = await f.ops.deadLetters();
    expect(d).toMatchObject({ consumer: "reporting", tenant_id: T, event_id: posted!.eventId, global_position: posted!.globalPosition,
      type: "JournalPosted", stream_id: `${T}/book/main`, attempts: 4, status: "open" });
    expect(d!.error).toMatch(/injected projection failure/);
    // other consumers were not affected; the gap is visible
    expect((await f.ops.gaps(0)).reporting).toEqual([{ tenant_id: T, type: "JournalPosted", n: 1, oldest: posted!.globalPosition }]);
    expect((await f.cell.reporting.trialBalance(T, "main")).basis).toMatchObject({ projectedSeq: 0, ledgerSeq: 1, lag: 1, fresh: false });
    expect((await f.ops.check("reporting", T))[0]!.ok).toBe(false);
  });

  it("retry re-reads the event from the store and runs the handler; failure keeps it open", async () => {
    const [d] = await f.ops.deadLetters();
    expect(await f.ops.retry(d!.id, "operator:test")).toMatchObject({ ok: false, error: expect.stringMatching(/injected/) });
    await f.owner.unsafe("DROP TRIGGER fail_777 ON reporting.lines");
    expect(await f.ops.retry(d!.id, "operator:test")).toEqual({ id: d!.id, ok: true });
    expect(await f.ops.deadLetters()).toEqual([]);
    expect((await f.ops.deadLetters({ status: "all" }))[0]).toMatchObject({ status: "retried", resolved_by: "operator:test", attempts: 5 });
    expect((await f.cell.reporting.trialBalance(T, "main")).basis).toMatchObject({ projectedSeq: 1, lag: 0, fresh: true });
    expect(await f.ops.gaps(0)).toEqual({});
    expect((await f.ops.check("reporting", T))[0]).toMatchObject({ ok: true, problems: [] });
    await expect(f.ops.retry(d!.id, "operator:test")).rejects.toThrow(/retried/);
  });

  it("discard needs a reason and closes the dead letter", async () => {
    await f.owner.unsafe(FAIL_TRIGGER);
    await journal(f.cell, T, "main", "777", "2026-10-02");
    await expect(f.cell.settle()).rejects.toThrow(/dead letters/);
    (f.cell.bus as MemoryBus).deadLetters.length = 0;
    const [d] = await f.ops.deadLetters({ consumer: "reporting" });
    await expect(f.ops.discard(d!.id, "operator:test", "")).rejects.toThrow(/reason/);
    await f.ops.discard(d!.id, "operator:test", "superseded by rebuild");
    expect(await f.ops.deadLetters()).toEqual([]);
    await f.owner.unsafe("DROP TRIGGER fail_777 ON reporting.lines");
    // the rebuild repairs what was discarded
    const [r] = await f.ops.rebuild("reporting", T);
    expect(r!.check).toMatchObject({ ok: true });
    expect((await f.cell.reporting.trialBalance(T, "main")).totals["Total debits"]).toBe(1554n);
  });

  it("status summarises outbox, dead letters, gaps and report lag", async () => {
    const s = await f.ops.status();
    expect(s.outbox.pending).toBe(0);
    expect(s.deadLetters).toEqual({});
    expect(s.gaps).toEqual({});
    expect(s.reports).toEqual([{ tenant: T, book: "main", projectedSeq: 2, ledgerSeq: 2, lag: 0, contiguous: true }]);
  });
});

// ====================================================================== F12 dead letters over JetStream
const NATS_BIN = process.env.NATS_SERVER_BIN ?? "/opt/bin/nats-server";
const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const until = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 100)); }
};

describe.skipIf(!existsSync(NATS_BIN))("F12: dead letters over NATS JetStream (max_deliver)", () => {
  let nats: ChildProcess, dir: string, f: Awaited<ReturnType<typeof fixture>>, relay: Promise<void>;
  const T = "jet";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kuber-nats-"));
    const port = await freePort();
    nats = spawn(NATS_BIN, ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 500));
    f = await fixture(T, { bus: { natsUrl: `nats://127.0.0.1:${port}`, maxDeliver: 2 }, cellId: `jet${Date.now()}` });
    relay = f.cell.relay.run(20);
  }, 30_000);
  afterAll(async () => { f?.cell.relay.stop(); await relay; await f?.stop(); nats?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("terminates the message after the last delivery and records it; retry repairs the projection", async () => {
    await until(() => f.cell.reporting.books(T), (b) => b.length === 1);
    await f.owner.unsafe(FAIL_TRIGGER);
    await journal(f.cell, T, "main", "777");
    const [d] = await until(() => f.ops.deadLetters(), (x) => x.length === 1);
    expect(d).toMatchObject({ consumer: "reporting", type: "JournalPosted", attempts: 2 });
    await f.owner.unsafe("DROP TRIGGER fail_777 ON reporting.lines");
    expect((await f.ops.retry(d!.id, "operator:test")).ok).toBe(true);
    expect((await f.cell.reporting.trialBalance(T, "main", null, { freshness: "require" })).totals["Total debits"]).toBe(777n);
  }, 30_000);
});

// ====================================================================== F12 rebuild
describe("F12: projection rebuild from the event store", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const T = "meera", B = "main", ME = "owner:meera";
  const clock = { value: "2026-10-25" };
  let live: Record<string, string>;
  beforeAll(async () => {
    f = await fixture(T, { clock: () => clock.value }, "freelancer");
    const c = f.cell;
    // The only person in this workspace: owner with the explicit single-owner exception (identity.test.ts covers maker-checker).
    await enrol(c, T, [ME]);
    await c.identity.setSettings(T, ME, { soloOwner: true, sodLimitPaise: null });
    await journal(c, T, B, "12500000", "2026-09-30", "Opening BANK");
    await c.channels.submitChat(T, B, "Paid 450 to the plumber in cash", ME, "2026-10-05");
    await c.channels.submitStatement(T, B, csv("hdfc_2026_10.csv"), ME);
    await c.settle();
    const loan = (await c.agent.queue(T)).find((d) => (d.proposal as { narration: string }).narration.includes("LOAN"))!;
    await c.agent.approveDraft(T, loan.draft_id as string, ME, "LOANS");
    await c.settle();
    const p = await c.ops.plan(T, B, ME, "post", {});
    await c.ops.commit(T, p.planId, ME, p.hash);
    await c.settle();
    clock.value = "2026-11-25";
    await c.channels.submitStatement(T, B, csv("hdfc_2026_11.csv"), ME);
    await c.settle();
    for (const d of await c.agent.queue(T)) {
      if ((d.proposal as { txnDate: string }).txnDate <= "2026-10-31") await c.agent.rejectDraft(T, d.draft_id as string, ME, "not mine");
    }
    const close = await c.ops.plan(T, B, ME, "close", { periodEnd: "2026-10-31" });
    await c.ops.commit(T, close.planId, ME, close.hash);
    await c.settle();
    live = {};
    for (const name of ["reporting", "agent", "evidence"]) live[name] = (await f.ops.check(name, T))[0]!.fingerprint;
  }, 60_000);
  afterAll(async () => { await f?.stop(); });

  it("live projections are consistent with the event store", async () => {
    for (const name of ["reporting", "agent", "evidence"]) expect((await f.ops.check(name, T))[0]).toMatchObject({ ok: true, problems: [] });
  });

  for (const name of ["reporting", "agent", "evidence"]) {
    it(`${name}: rebuild reproduces the live projection exactly, and is idempotent`, async () => {
      const progress: number[] = [];
      const [r] = await f.ops.rebuild(name, T, (_t, n) => progress.push(n));
      expect(r!.before).toBe(live[name]);
      expect(r!.after).toBe(live[name]);
      expect(r!.events).toBeGreaterThan(0);
      expect(progress.at(-1)).toBe(r!.events);
      expect(r!.check).toMatchObject({ ok: true, fingerprint: live[name] });
      const [again] = await f.ops.rebuild(name, T);
      expect(again!.after).toBe(live[name]);
      expect(again!.events).toBe(r!.events);
    });
  }

  it("a damaged projection is detected by check and repaired by rebuild", async () => {
    await f.owner`DELETE FROM reporting.daily WHERE tenant_id = ${T} AND account_id = 'BANK'`;
    await f.owner`UPDATE evidence.balances SET balance = balance + 1 WHERE tenant_id = ${T} AND account_id = 'BANK'`;
    await f.owner`DELETE FROM agent.journal_index WHERE tenant_id = ${T} AND journal_id = (SELECT min(journal_id) FROM agent.journal_index WHERE tenant_id = ${T})`;
    const bad = { reporting: (await f.ops.check("reporting", T))[0]!, evidence: (await f.ops.check("evidence", T))[0]!, agent: (await f.ops.check("agent", T))[0]! };
    expect(bad.reporting.problems.join()).toMatch(/balance main\|BANK/);
    expect(bad.evidence.problems.join()).toMatch(/evidence balance main\|BANK/);
    expect(bad.agent.ok).toBe(false);
    for (const name of ["reporting", "agent", "evidence"]) {
      const [r] = await f.ops.rebuild(name, T);
      expect(r!.after).toBe(live[name]);
    }
  });

  it("the live consumers stay exactly-once after a rebuild (inbox rewritten)", async () => {
    const [n] = await f.owner`SELECT count(*)::int AS n FROM es.inbox WHERE consumer = 'reporting'`;
    await f.ops.rebuild("reporting", T);
    const [m] = await f.owner`SELECT count(*)::int AS n FROM es.inbox WHERE consumer = 'reporting'`;
    expect(m!.n).toBe(n!.n);
    // a redelivery of an already-projected event does nothing
    const [posted] = await f.cell.store.readEvents({ tenantId: T, types: ["JournalPosted"], limit: 1 });
    await f.cell.consumers.reporting!(posted!);
    expect((await f.ops.check("reporting", T))[0]!.fingerprint).toBe(live.reporting);
  });
});

// ====================================================================== F15 freshness and certified snapshots
describe("F15: report freshness and certified snapshots", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const T = "fresh", B = "main";
  beforeAll(async () => { f = await fixture(T); });
  afterAll(async () => { await f?.stop(); });

  it("a statement discloses the projection position against the ledger", async () => {
    await journal(f.cell, T, B, "1000");
    await f.cell.settle();
    await journal(f.cell, T, B, "2000");                          // committed, not yet projected
    const tb = await f.cell.reporting.trialBalance(T, B);
    expect(tb.basis).toMatchObject({ bookId: B, projectedSeq: 1, ledgerSeq: 2, lag: 1, contiguous: true, fresh: false });
    expect(tb.totals["Total debits"]).toBe(1000n);
  });

  it("freshness 'require' refuses a stale projection; 'wait' waits for it to catch up", async () => {
    await expect(f.cell.reporting.balanceSheet(T, B, null, { freshness: "require" })).rejects.toBeInstanceOf(StaleReportError);
    await expect(f.cell.reporting.profitAndLoss(T, B, null, null, { freshness: "wait", timeoutMs: 100 })).rejects.toThrow(/projected 1 of 2/);
    const waiting = f.cell.reporting.trialBalance(T, B, null, { freshness: "wait", timeoutMs: 10_000, pollMs: 10 });
    setTimeout(() => void f.cell.settle(), 100);
    const tb = await waiting;
    expect(tb.basis).toMatchObject({ projectedSeq: 2, ledgerSeq: 2, lag: 0, fresh: true });
    expect(tb.totals["Total debits"]).toBe(3000n);
  });

  it("a gap below the checkpoint is not reported as fresh", async () => {
    await f.owner`UPDATE reporting.checkpoints SET journals = journals - 1 WHERE tenant_id = ${T}`;
    expect((await f.cell.reporting.freshness(T, B))).toMatchObject({ projectedSeq: 2, ledgerSeq: 2, contiguous: false, fresh: false });
    await f.owner`UPDATE reporting.checkpoints SET journals = journals + 1 WHERE tenant_id = ${T}`;
  });

  it("the HTTP API reports the basis and refuses stale reports with 409 when asked", async () => {
    await enrol(f.cell, T, [OWNER]);
    const app = buildServer(f.cell, { auth: { secret: CORE_AUTH_SECRET } });
    try {
      const headers = { "x-kuber-tenant": T, "x-kuber-principal": OWNER };
      const ok = await app.inject(signed({ method: "GET", url: `/v1/tenants/${T}/books/${B}/reports/trial-balance?fresh=require`, headers }));
      expect(ok.statusCode).toBe(200);
      expect(ok.json().basis).toMatchObject({ projectedSeq: 2, ledgerSeq: 2, fresh: true });
      await journal(f.cell, T, B, "5");
      const stale = await app.inject(signed({ method: "GET", url: `/v1/tenants/${T}/books/${B}/reports/balance-sheet?fresh=require`, headers }));
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: "stale_report", basis: { lag: 1 } });
      await f.cell.settle();
    } finally { await app.close(); }
  });

  it("a certified snapshot is sealed, verifiable and reproducible after later postings", async () => {
    const snap = await f.cell.reporting.certify(T, B, "trial-balance", { asOf: "2026-10-31" }, OWNER);
    expect(snap.seq).toBe(3);
    expect(snap.statement.totals["Total debits"]).toBe("3005");
    const [row] = await f.owner`SELECT body, content_hash FROM reporting.snapshots WHERE snapshot_id = ${snap.snapshotId}`;
    expect(row!.body).toMatch(/^kb1\./);                          // sealed at rest
    expect(row!.content_hash).toBe(snap.contentHash);
    await journal(f.cell, T, B, "40000", "2026-10-15");
    await f.cell.settle();
    expect((await f.cell.reporting.trialBalance(T, B, "2026-10-31")).totals["Total debits"]).toBe(43005n);
    const r = await f.cell.reporting.reproduceSnapshot(T, snap.snapshotId);
    expect(r).toMatchObject({ matches: true, ledgerMatches: true, contentHash: snap.contentHash });
    expect(r.reproduced.totals["Total debits"]).toBe("3005");
    expect((await f.cell.reporting.listSnapshots(T, B)).map((s) => s.snapshot_id)).toEqual([snap.snapshotId]);
  });

  it("certify refuses a stale projection instead of certifying a partial report", async () => {
    await journal(f.cell, T, B, "9");
    await expect(f.cell.reporting.certify(T, B, "balance-sheet", {}, OWNER, { freshness: "require" })).rejects.toBeInstanceOf(StaleReportError);
    await f.cell.settle();
  });

  it("a tampered snapshot does not verify", async () => {
    const snap = await f.cell.reporting.certify(T, B, "profit-and-loss", { from: "2026-04-01", to: "2027-03-31" }, OWNER);
    await f.owner`UPDATE reporting.snapshots SET content_hash = 'x' WHERE snapshot_id = ${snap.snapshotId}`;
    expect((await f.cell.reporting.getSnapshot(T, snap.snapshotId))!.verified).toBe(false);
    expect((await f.cell.reporting.reproduceSnapshot(T, snap.snapshotId)).matches).toBe(false);
  });
});

// ====================================================================== rebuild with GL confirmations (F06 JournalConfirmed)
describe("F12: rebuild covers provisional journals confirmed by the GL", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const T = "conf", B = "main", ME = "owner:conf";
  beforeAll(async () => {
    f = await fixture(T);
    await f.cell.channels.submitChat(T, B, "Paid 100 to Alice via bank", ME, "2026-10-01");
    await f.cell.settle();
    await f.cell.channels.submitStatement(T, B, "Date,Narration,Withdrawal Amt,Deposit Amt\n01/10/2026,UPI/DR/ALICE K/alice@okaxis,100,\n", ME);
    await f.cell.settle();
  });
  afterAll(async () => { await f?.stop(); });

  it("replays JournalConfirmed so the rebuilt projection is not provisional", async () => {
    const book = await f.cell.store.readStream(T, `${T}/book/${B}`);
    expect(book.at(-1)!.type).toBe("JournalConfirmed");
    const live = { reporting: (await f.ops.check("reporting", T))[0]!, agent: (await f.ops.check("agent", T))[0]! };
    expect(live.reporting).toMatchObject({ ok: true });
    await f.owner`UPDATE reporting.lines SET provisional = true WHERE tenant_id = ${T}`;
    expect((await f.ops.check("reporting", T))[0]!.problems.join()).toMatch(/confirmed by the GL still provisional/);
    for (const name of ["reporting", "agent"] as const) {
      const [r] = await f.ops.rebuild(name, T);
      expect(r!.after).toBe(live[name].fingerprint);
      expect(r!.check.ok).toBe(true);
    }
    expect((await f.cell.reporting.recentJournals(T, B))[0]!.provisional).toBe(false);
  });
});
