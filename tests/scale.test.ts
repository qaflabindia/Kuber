/**
 * Scale (F09-F11): tenant-partitioned delivery, persistent book state with durable snapshots,
 * and indexed interactive queries. Every optimisation here is checked against the computation
 * it replaces: same answers, same order, same bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, uuid, type Account, type Envelope, type Line } from "@kuber/contracts";
import type { Cell } from "@kuber/core";
import { MemoryBus, NatsBus, partitionOf, type Bus } from "@kuber/bus";
import { GeneralLedger, JournalMap, SnapshotStore, verifyChain, type BookState } from "@kuber/gl";
import { OPERATIONS, type OpContext } from "@kuber/ops";
import { FOLD_SOURCE, emptyBook, evolve } from "../modules/gl/src/book.ts";
import { PMap, addAt, rangeAgg, type DateNode } from "../modules/gl/src/pmap.ts";
import { serialize, deserialize } from "../modules/gl/src/snapshot.ts";
import { balancesByScan, balancesFromState, latestTxnDate, openProvisional } from "../modules/ops/src/math.ts";
import { ROOT, enrol, startCell } from "./helpers.ts";

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x instanceof Map ? [...x.entries()] : x));

// ------------------------------------------------------------------ synthetic books
const ACCOUNTS = ["BANK", "CASH", "LIVING", "BIZEXP", "FEES", "OPENING", "SUSPENSE", "RETAINED"];
const DATES = ["2025-03-31", "2025-04-01", "2025-12-31", "2026-02-31", "2026-03-31", "2026-04-01", "2026-10-05", "2026-10-05x"];
const VOUCHERS = ["journal", "closing", "payment", "receipt", "opening"];
const acc = (accountId: string): Account => ({ accountId, name: accountId, nature: "asset", taxonomyTag: "BS.cash", isControl: false, isCashLike: false, requiredDims: [] });

type Step = { kind: "post"; date: number; voucher: number; provisional: boolean; lines: [number, number][] } | { kind: "reverse" | "confirm"; target: number };
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("post" as const), date: fc.nat(DATES.length - 1), voucher: fc.nat(VOUCHERS.length - 1),
    provisional: fc.boolean(), lines: fc.array(fc.tuple(fc.nat(ACCOUNTS.length - 1), fc.integer({ min: -100000, max: 100000 })), { minLength: 1, maxLength: 5 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("reverse" as const), target: fc.nat(1000) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("confirm" as const), target: fc.nat(1000) }) },
);

function eventsOf(steps: Step[]): Envelope[] {
  const env = (type: string, data: unknown, v: number) => ({ eventId: uuid(), globalPosition: String(v), streamId: "t/book/b", streamVersion: v, type,
    schemaVersion: 1, data, meta: { tenantId: "t", cellId: "c", principal: "owner:t", correlationId: "x", occurredAt: "" }, recordedAt: "" }) as unknown as Envelope;
  const out: Envelope[] = [env("BookOpened", { bookId: "b", entityId: "t", entityType: "freelancer", basis: "statutory", currency: "INR", accounts: ACCOUNTS.map(acc) }, 1)];
  const posted: string[] = [];
  steps.forEach((s, i) => {
    if (s.kind === "post") {
      const id = `j${i}`;
      posted.push(id);
      out.push(env("JournalPosted", { bookId: "b", journalId: id, seq: posted.length, txnDate: DATES[s.date], narration: `n${i}`, voucherType: VOUCHERS[s.voucher],
        provisional: s.provisional, prevHash: "", hash: "", lines: s.lines.map(([a, amt]) => ({ accountId: ACCOUNTS[a]!, amount: String(amt), dimensions: {} })) }, out.length + 1));
    } else if (posted.length && s.kind === "confirm") {
      out.push(env("JournalConfirmed", { bookId: "b", journalId: posted[s.target % posted.length]!, source: `t/txn/${i}` }, out.length + 1));
    } else if (posted.length) {
      out.push(env("JournalReversed", { bookId: "b", journalId: posted[s.target % posted.length]!, reversalJournalId: `r${i}`, reason: "x" }, out.length + 1));
    }
  });
  return out;
}

const filterArb = fc.record({
  from: fc.option(fc.constantFrom(...DATES, ""), { nil: undefined }),
  to: fc.option(fc.constantFrom(...DATES, "", "9999-12-31"), { nil: undefined }),
  excludeVoucher: fc.option(fc.constantFrom("closing", "journal"), { nil: undefined }),
});

describe("persistent book state (F10)", () => {
  it("PMap behaves like Map", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.string({ maxLength: 4 }), fc.integer())), (ops) => {
      let p = PMap.empty<number>(); const m = new Map<string, number>();
      const versions: [PMap<number>, Map<string, number>][] = [];
      for (const [k, v] of ops) { p = p.set(k, v); m.set(k, v); versions.push([p, new Map(m)]); }
      expect(p.size).toBe(m.size);
      for (const [k, v] of m) expect(p.get(k)).toBe(v);
      expect(new Map(p.entries())).toEqual(m);
      for (const [pv, mv] of versions) { expect(pv.size).toBe(mv.size); for (const [k, v] of mv) expect(pv.get(k)).toBe(v); }   // old versions intact
    }));
    let big = PMap.empty<number>();
    for (let i = 0; i < 20000; i++) big = big.set(`k${i}`, i);
    expect(big.size).toBe(20000);
    for (let i = 0; i < 20000; i += 97) expect(big.get(`k${i}`)).toBe(i);
    expect(big.get("missing")).toBeUndefined();
  });

  it("date-range aggregates equal a scan", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom(...DATES), fc.integer({ min: -1000, max: 1000 }), fc.boolean())),
      fc.option(fc.constantFrom(...DATES), { nil: undefined }), fc.option(fc.constantFrom(...DATES), { nil: undefined }), (adds, lo, hi) => {
        let t: DateNode | null = null;
        adds.forEach(([d, a, c], i) => { t = addAt(t, d, { all: BigInt(a), non: c ? 0n : BigInt(a), fa: i, fn: c ? Infinity : i }); });
        const inR = adds.map((x, i) => [x, i] as const).filter(([[d]]) => (lo === undefined || d >= lo) && (hi === undefined || d <= hi));
        const r = rangeAgg(t, lo, hi);
        expect(r.all).toBe(inR.reduce((s, [[, a]]) => s + BigInt(a), 0n));
        expect(r.non).toBe(inR.reduce((s, [[, a, c]]) => s + (c ? 0n : BigInt(a)), 0n));
        expect(r.fa).toBe(inR.length ? inR[0]![1] : Infinity);
        expect(r.fn).toBe(inR.find(([[, , c]]) => !c)?.[1] ?? Infinity);
      }));
  });

  it("indexed balances, provisional set and latest date equal the journal scan on random books (order included)", () => {
    fc.assert(fc.property(fc.array(stepArb, { maxLength: 60 }), fc.array(filterArb, { minLength: 1, maxLength: 5 }), (steps, filters) => {
      const s = eventsOf(steps).reduce(evolve, emptyBook());
      expect(s.journals).toBeInstanceOf(JournalMap);
      const scan: BookState = { ...s, journals: new Map(s.journals) };
      for (const f of filters) {
        expect([...balancesFromState(s, f).entries()]).toEqual([...balancesByScan(scan, f).entries()]);
      }
      expect([...openProvisional(s)]).toEqual([...s.journals.entries()].filter(([, j]) => j.provisional && !j.reversedBy));
      expect(latestTxnDate(s)).toBe(latestTxnDate(scan));
    }), { numRuns: 300 });
  });

  it("evolve is pure: earlier states and branches are unaffected by later events", () => {
    fc.assert(fc.property(fc.array(stepArb, { minLength: 2, maxLength: 40 }), fc.nat(), (steps, cut) => {
      const evs = eventsOf(steps);
      const k = 1 + (cut % evs.length);
      const prefix = evs.slice(0, k).reduce(evolve, emptyBook());
      const before = json(serialize(prefix, null));
      const full = evs.slice(k).reduce(evolve, prefix);
      const branch = evolve(prefix, evs[1] ?? evs[0]!);                    // a second path from the same state
      expect(json(serialize(prefix, null))).toBe(before);
      expect(json(serialize(full, null))).toBe(json(serialize(evs.reduce(evolve, emptyBook()), null)));
      expect(branch.journals.size).toBeGreaterThanOrEqual(prefix.journals.size);
      expect([...prefix.journals.keys()]).toHaveLength(prefix.journals.size);
    }));
  });

  it("a snapshot round trip reproduces the state and its indexes", () => {
    fc.assert(fc.property(fc.array(stepArb, { maxLength: 50 }), fc.array(filterArb, { minLength: 1, maxLength: 3 }), (steps, filters) => {
      const s = eventsOf(steps).reduce(evolve, emptyBook());
      const r = deserialize(JSON.parse(JSON.stringify(serialize(s, "L"))));
      expect(json(serialize(r, "L"))).toBe(json(serialize(s, "L")));
      for (const f of filters) expect([...balancesFromState(r, f).entries()]).toEqual([...balancesFromState(s, f).entries()]);
    }));
  });

  it("the snapshot schema fingerprints the whole fold, including confirmations and the event version", () => {
    expect(FOLD_SOURCE()).toContain("JournalConfirmed");
    expect(FOLD_SOURCE()).toContain("streamVersion");
    const s = eventsOf([{ kind: "post", date: 0, voucher: 0, provisional: true, lines: [[0, 5], [1, -5]] }, { kind: "confirm", target: 0 }]).reduce(evolve, emptyBook());
    expect(s.version).toBe(3);
    expect([...openProvisional(s)]).toHaveLength(0);
    expect(deserialize(JSON.parse(JSON.stringify(serialize(s, "L")))).version).toBe(3);
  });

  it("folding is no longer quadratic in the number of journals", () => {
    const run = (n: number) => {
      const t = performance.now();
      let s = emptyBook();
      for (let i = 0; i < n; i++) s = evolve(s, { type: "JournalPosted", meta: { principal: "p" }, data: { journalId: `j${i}`, seq: i + 1, txnDate: "2026-09-01",
        narration: "x", voucherType: "journal", provisional: false, lines: [{ accountId: "BANK", amount: "1", dimensions: {} }, { accountId: "CASH", amount: "-1", dimensions: {} }] } } as unknown as Envelope);
      return performance.now() - t;
    };
    run(2000);
    expect(run(20000)).toBeLessThan(3000);                                  // was ~6 s for 10k before (O(n^2) map copies)
  });
});

// ------------------------------------------------------------------ partitioned delivery
const fakeEnv = (tenant: string, v: number): Envelope =>
  ({ eventId: uuid(), streamId: `${tenant}/s`, streamVersion: v, type: "JournalPosted", data: {}, meta: { tenantId: tenant } }) as unknown as Envelope;
const tenantsInDistinctLanes = (n: number) => {
  const a = "tenant-a"; let b = "tenant-b", i = 0;
  while (n > 1 && partitionOf(b, n) === partitionOf(a, n)) b = `tenant-b${++i}`;
  return [a, b] as const;
};
const waitFor = async (ok: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 5)); } return true; };

async function fairness(bus: Bus, lanes: number, subject: (t: string) => string) {
  const [A, B] = tenantsInDistinctLanes(lanes);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const seen: string[] = [];
  await bus.subscribe({ name: "fair", filter: [subject("*")], handler: async (e) => { if (e.meta.tenantId === A) await gate; seen.push(`${e.meta.tenantId}:${e.streamVersion}`); } });
  await bus.publish(subject(A), fakeEnv(A, 1));
  for (let v = 1; v <= 3; v++) await bus.publish(subject(B), fakeEnv(B, v));
  await bus.publish(subject(A), fakeEnv(A, 2));
  const bDone = await waitFor(() => seen.filter((x) => x.startsWith(B)).length === 3, lanes > 1 ? 5000 : 300);
  const aBlocked = !seen.some((x) => x.startsWith(A));
  release();
  await waitFor(() => seen.length === 5);
  return { bDone, aBlocked, seen, A, B };
}

describe("tenant-partitioned delivery (F09)", () => {
  it("a slow tenant does not hold up a tenant in another lane (memory bus)", async () => {
    const r = await fairness(new MemoryBus(0, 8), 8, (t) => `kuber.c.gl.JournalPosted.${t}`);
    expect(r.aBlocked).toBe(true);
    expect(r.bDone).toBe(true);
    expect(r.seen.filter((x) => x.startsWith(r.A))).toEqual([`${r.A}:1`, `${r.A}:2`]);
  });

  it("with one partition the same slow tenant blocks everyone (the old behaviour)", async () => {
    const r = await fairness(new MemoryBus(0, 1), 1, (t) => `kuber.c.gl.JournalPosted.${t}`);
    expect(r.bDone).toBe(false);
    expect(r.seen).toEqual([`${r.A}:1`, `${r.B}:1`, `${r.B}:2`, `${r.B}:3`, `${r.A}:2`]);
  });

  it("keeps every tenant's events in publish order under random handler delays", async () => {
    const bus = new MemoryBus(0, 4);
    const got = new Map<string, number[]>();
    await bus.subscribe({ name: "o", filter: ["kuber.c.m.E.*"], handler: async (e) => {
      await new Promise((r) => setTimeout(r, Math.random() * 2));
      got.set(e.meta.tenantId, [...(got.get(e.meta.tenantId) ?? []), e.streamVersion]);
    } });
    const tenants = Array.from({ length: 9 }, (_, i) => `t${i}`);
    for (let v = 1; v <= 30; v++) for (const t of tenants) await bus.publish(`kuber.c.m.E.${t}`, fakeEnv(t, v));
    await bus.idle();
    for (const t of tenants) expect(got.get(t)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("partitions are stable and spread tenants", () => {
    const counts = new Array(8).fill(0);
    for (let i = 0; i < 8000; i++) counts[partitionOf(`tenant-${i}`, 8)]++;
    expect(Math.min(...counts)).toBeGreaterThan(800);
    expect(partitionOf("acme", 8)).toBe(partitionOf("acme", 8));
    expect(partitionOf("acme", 1)).toBe(0);
  });
});

const NATS = process.env.KUBER_INTEGRATION === "1" ? (process.env.NATS_URL ?? "nats://localhost:4222") : null;
describe.skipIf(!NATS)("tenant-partitioned delivery over NATS JetStream (F09)", () => {
  const subject = (cell: string) => (t: string) => `kuber.${cell}.gl.JournalPosted.${t}`;
  const buses: NatsBus[] = [];
  afterAll(async () => { for (const b of buses) await b.close().catch(() => undefined); });
  const open = async (cell: string, partitions: number) => { const b = await NatsBus.connect(NATS!, cell, { partitions }); buses.push(b); return b; };

  it("a slow tenant does not hold up a tenant in another lane", async () => {
    const cell = `sc${Date.now().toString(36)}`;
    const r = await fairness(await open(cell, 4), 4, subject(cell));
    expect(r.aBlocked).toBe(true);
    expect(r.bDone).toBe(true);
    expect(r.seen.filter((x) => x.startsWith(r.A))).toEqual([`${r.A}:1`, `${r.A}:2`]);
  });

  it("migrates an unpartitioned durable in order, and refuses to re-route lanes with work in flight", async () => {
    const cell = `mg${Date.now().toString(36)}`, s = subject(cell);
    // an installation from before partitioning: one durable `m`, 5-token subjects, a backlog nobody consumed yet
    const pub1 = await open(cell, 1);
    await (pub1 as unknown as { ensureConsumer(d: string, f: string[]): Promise<void> }).ensureConsumer("m", [s("*")]);
    for (let v = 1; v <= 3; v++) await pub1.publish(s("acme"), fakeEnv("acme", v));
    await pub1.close();

    const seen: number[] = [];
    const bus = await open(cell, 4);
    await bus.subscribe({ name: "m", filter: [s("*")], handler: async (e) => { seen.push(e.streamVersion); } });
    expect(seen).toEqual([1, 2, 3]);                                    // drained before the lanes start
    await bus.publish(s("acme"), fakeEnv("acme", 4));
    expect(await waitFor(() => seen.length === 4)).toBe(true);
    await bus.close();

    const pub4 = await open(cell, 4);
    await pub4.publish(s("acme"), fakeEnv("acme", 5));                  // pending on a lane consumer
    await pub4.close();
    await expect(NatsBus.connect(NATS!, cell, { partitions: 2 })).rejects.toThrow(/re-routes tenants/);
  });
});

// ------------------------------------------------------------------ database-backed
const T = "scale", B = "main", OWNER = "owner:scale";
const clock = { value: "2026-10-25" };
let cell: Cell, stop: () => Promise<void>;
const post = (i: number, extra: Partial<{ txnDate: string; voucherType: string; lines: Line[]; provisional: boolean }> = {}) =>
  cell.gl.execute(T, B, { kind: "PostJournal", journalId: `sj-${i}`, txnDate: extra.txnDate ?? `2026-0${1 + (i % 9)}-1${i % 10}`, narration: `secret narration ${i}`,
    voucherType: extra.voucherType, provisional: extra.provisional,
    lines: extra.lines ?? [{ accountId: i % 2 ? "LIVING" : "BIZEXP", amount: String(100 + i), dimensions: {} }, { accountId: i % 3 ? "BANK" : "CASH", amount: String(-(100 + i)), dimensions: {} }] },
    { principal: OWNER });

describe("snapshots, cache and indexed queries on PostgreSQL (F10, F11)", () => {
  beforeAll(async () => {
    ({ cell, stop } = await startCell(clock));
    await enrol(cell, T, [OWNER]);
    await cell.gl.openBook(T, B, T, "freelancer", OWNER);
    await cell.gl.execute(T, B, { kind: "PostJournal", journalId: "open-bank", txnDate: "2025-09-30", narration: "Opening", voucherType: "opening",
      lines: [{ accountId: "BANK", amount: "12500000", dimensions: {} }, { accountId: "OPENING", amount: "-12500000", dimensions: {} }] }, { principal: OWNER });
    for (let i = 0; i < 30; i++) await post(i, i % 7 === 0 ? { provisional: true } : {});
    await cell.gl.execute(T, B, { kind: "ReverseJournal", journalId: "sj-7", reversalJournalId: "rev-7", reason: "test" }, { principal: OWNER });
    await cell.channels.submitStatement(T, B, readFileSync(join(ROOT, "samples", "hdfc_2026_10.csv"), "utf8"), OWNER);
    await cell.settle();
  });
  afterAll(async () => { await stop(); });

  it("loads from a sealed snapshot plus the tail and gets the same state; the chain still verifies", async () => {
    const gl = new GeneralLedger(cell.store, { snapshotEvery: 10 });
    const full = await gl.state(T, B);                                  // cold: full replay, then snapshot
    await gl.flushSnapshots();
    const [row] = await cell.store.tenantTx(T, (tx) => tx<{ stream_version: number; schema: string; state: unknown }[]>`
      SELECT stream_version, schema, state FROM es.snapshots WHERE stream_id = ${`${T}/book/${B}`}`);
    expect(row!.stream_version).toBeGreaterThan(30);
    expect(JSON.stringify(row!.state)).not.toContain("secret narration");   // sealed
    await post(100);                                                   // a tail after the snapshot

    const reads: number[] = [];
    const orig = cell.store.readStream.bind(cell.store);
    cell.store.readStream = (async (...a: Parameters<typeof orig>) => { reads.push(a[2] ?? 0); return orig(...a); }) as typeof orig;
    try {
      const cold = await new GeneralLedger(cell.store, { snapshotEvery: 10 }).state(T, B);
      expect(reads).toEqual([row!.stream_version]);                      // only the tail was read
      const replay = await new GeneralLedger(cell.store, { snapshotEvery: 0 }).state(T, B);
      expect(json(serialize(cold, null))).toBe(json(serialize(replay, null)));
      expect(cold.seq).toBe(full.seq + 1);
    } finally { cell.store.readStream = orig; }
    expect(await cell.gl.verify(T, B)).toBeNull();
  });

  it("ignores snapshots of another schema, or whose anchor no longer matches the stream", async () => {
    const stream = `${T}/book/${B}`;
    const other = new SnapshotStore(cell.store, "book.0.old");
    expect(await cell.store.tenantTx(T, (tx) => other.load(T, stream, tx))).toBeNull();
    const cur = new SnapshotStore(cell.store);
    expect(await cell.store.tenantTx(T, (tx) => cur.load(T, stream, tx))).not.toBeNull();
    // a row moved to another version no longer opens (context-bound) or anchors
    await cell.store.systemTx((tx) => tx`UPDATE es.snapshots SET stream_version = stream_version - 1 WHERE stream_id = ${stream}`);
    expect(await cell.store.tenantTx(T, (tx) => cur.load(T, stream, tx))).toBeNull();
    // and the ledger answer is unchanged: a miss is a full replay
    const gl = new GeneralLedger(cell.store, { snapshotEvery: 10 });
    expect(json(serialize(await gl.state(T, B), null))).toBe(json(serialize(await new GeneralLedger(cell.store, { snapshotEvery: 0 }).state(T, B), null)));
    await gl.flushSnapshots();
    expect(await cell.store.tenantTx(T, (tx) => cur.load(T, stream, tx))).not.toBeNull();   // rewritten
  });

  it("keeps snapshots tenant-private", async () => {
    const rows = await cell.store.tenantTx("someone-else", (tx) => tx`SELECT stream_id FROM es.snapshots`);
    expect(rows).toHaveLength(0);
  });

  it("bounds the book cache by bytes", async () => {
    const gl = new GeneralLedger(cell.store, { cacheBytes: 40_000, snapshotEvery: 0 });
    for (let b = 0; b < 6; b++) { await gl.execute(T, `lru${b}`, { kind: "OpenBook", bookId: `lru${b}`, entityId: T, entityType: "company", accounts: [acc("BANK"), acc("CASH")] }, { principal: OWNER }); }
    for (let b = 0; b < 6; b++) await gl.state(T, `lru${b}`);
    await gl.state(T, B);
    const st = gl.cacheStats();
    expect(st.bytes).toBeLessThanOrEqual(40_000);
    expect(st.entries).toBeLessThan(7);
  });

  it("every operation plans byte-identically from the indexed state and from a journal scan", async () => {
    const s = await cell.gl.state(T, B);
    const scan: BookState = { ...s, journals: new Map(s.journals) };
    const svc = { gl: cell.gl, reporting: cell.reporting, agent: cell.agent, policies: cell.policies };
    const inputs: Record<string, unknown> = {
      balance: {}, dashboard: {}, report: { kind: "trial-balance" },
      reconcile: { account: "BANK", statementBalance: "1000", asOf: "2026-10-31", adjustTo: "BIZEXP" },
      allocate: { from: "BIZEXP", to: [{ account: "LIVING", weight: "40" }, { account: "BIZEXP", weight: "60" }], period: { from: "2026-01-01", to: "2026-10-31" } },
      rebalance: { targets: [{ account: "BANK", pct: "70" }, { account: "CASH", pct: "30" }] },
      close: { periodEnd: "2026-03-31" }, carry_forward: { yearEnd: "2026-03-31" },
      record: { narration: "Plumber", amount: "450", direction: "out", account: "living", via: "CASH" },
      journal: { voucherType: "payment", narration: "Rent and GST", lines: [{ account: "BIZEXP", debit: "1000" }, { account: "GSTIN", debit: "180" }, { account: "BANK", credit: "1180" }] },
      simulate: { entries: [{ narration: "Laptop", amount: "90000", direction: "out", account: "bizexp", via: "BANK" }], monthlyChange: { expenses: 15000 } },
      post: {},
    };
    for (const def of OPERATIONS) {
      const input = def.input.parse(inputs[def.name] ?? {});
      const ctx = (state: BookState): OpContext => ({ tenant: T, book: B, principal: OWNER, today: clock.value, state, svc });
      const a = json(await def.plan(ctx(s), input)), b = json(await def.plan(ctx(scan), input));
      expect(a, def.name).toBe(b);
    }
  });

  it("pages the draft queue, ratifications and open plans without changing their content or order", async () => {
    const all = await cell.agent.queue(T);
    expect(all.length).toBeGreaterThan(2);
    const ids = (await cell.store.tenantTx(T, (tx) => tx<{ draft_id: string }[]>`
      SELECT draft_id FROM agent.drafts WHERE tenant_id = ${T} AND status IN ('queued','awaiting_approval') ORDER BY created_at, draft_id`)).map((r) => r.draft_id);
    expect(all.map((d) => d.draft_id)).toEqual(ids);
    for (const limit of [1, 2, 3]) {
      const pages: unknown[] = [];
      let after: string | undefined;
      for (;;) { const p = await cell.agent.queuePage(T, { limit, after }); pages.push(...p.items); if (!p.next) break; after = p.next; }
      expect(json(pages)).toBe(json(all));
    }
    expect(json(await cell.agent.queue(T, { bookId: B }))).toBe(json(all.filter((d) => d.book_id === B)));
    expect(await cell.agent.queueCounts(T, B)).toEqual({ open: all.length, awaitingApproval: all.filter((d) => d.status === "awaiting_approval").length });
    const rat = await cell.agent.openRatifications(T);
    expect(await cell.agent.openRatificationCount(T)).toBe(rat.length);
    expect(json((await cell.agent.ratificationsPage(T, { limit: 1 })).items)).toBe(json(rat.slice(0, 1)));

    for (let i = 0; i < 3; i++) await cell.ops.plan(T, B, OWNER, "record", { narration: `p${i}`, amount: "10", direction: "out", account: "living", via: "CASH" });
    const plans = await cell.ops.pending(T, B);
    const first = await cell.ops.pendingPage(T, B, { limit: 2 });
    const rest = await cell.ops.pendingPage(T, B, { limit: 2, before: first.next! });
    expect([...first.items, ...rest.items].map((p) => p.planId)).toEqual(plans.map((p) => p.planId));
    expect(await cell.ops.pendingCount(T, B)).toBe(plans.length);
    await expect(cell.agent.queuePage(T, { after: "not-a-cursor" })).rejects.toThrow(/cursor/);
  });

  it("recent journals and drill-through match the whole-history queries they replace", async () => {
    const old = await cell.store.tenantTx(T, (tx) => tx`
      SELECT journal_id, max(seq) AS seq, max(txn_date)::text AS txn_date, max(narration) AS narration,
             bool_or(provisional) AS provisional, max(reverses) AS reverses, max(principal) AS principal, max(voucher_type) AS voucher_type,
             json_agg(json_build_object('accountId', account_id, 'amount', amount::text, 'partyId', party_id, 'memo', dimensions->>'memo') ORDER BY line_no) AS lines
      FROM reporting.lines WHERE tenant_id = ${T} AND book_id = ${B}
      GROUP BY journal_id ORDER BY max(seq) DESC LIMIT 7`);
    const now = await cell.reporting.recentJournals(T, B, 7);
    expect(now.map((j) => ({ ...j, narration: "" }))).toEqual(old.map((j) => ({ ...j, narration: "" })));
    const all = await cell.reporting.drill(T, B, "BANK");
    const pages: unknown[] = [];
    let after: string | undefined;
    for (;;) { const p = await cell.reporting.drillPage(T, B, "BANK", null, null, { limit: 4, after }); pages.push(...p.items); if (!p.next) break; after = p.next; }
    expect(canonical(pages)).toBe(canonical(all));
    expect(all.length).toBeGreaterThan(4);
  });
});
