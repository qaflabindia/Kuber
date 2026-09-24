/**
 * Scale check (F09-F11): write/read throughput and cold-load cost for one mature book, plus
 * tenant fairness on the in-memory bus. Needs PostgreSQL (TEST_DATABASE_ADMIN_URL, as for tests).
 *
 *   npx tsx scripts/scale-bench.ts [journals=5000]
 *
 * Indicative only: one process, database on the same machine, no network between them.
 */
import { performance } from "node:perf_hooks";
import { GeneralLedger } from "@kuber/gl";
import { enrol, startCell } from "../tests/helpers.ts";

const N = Number(process.argv[2] ?? 5000);
const T = "bench", B = "main", OWNER = "owner:bench";
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(2); };
const ms = async (f: () => Promise<unknown>) => { const t = performance.now(); await f(); return performance.now() - t; };

const clock = { value: "2026-10-25" };
const { cell, stop } = await startCell(clock);
try {
  await enrol(cell, T, [OWNER]);                                         // ops plans run under identity
  await cell.gl.openBook(T, B, T, "freelancer", OWNER);
  const day = (i: number) => { const d = new Date(Date.UTC(2025, 3, 1) + (i % 540) * 86_400_000); return d.toISOString().slice(0, 10); };
  const post = (i: number) => cell.gl.execute(T, B, { kind: "PostJournal", journalId: `j-${i}`, txnDate: day(i), narration: `Synthetic journal ${i} with a narration`,
    lines: [{ accountId: i % 3 ? "LIVING" : "BIZEXP", amount: String(100 + (i % 977)), dimensions: {} }, { accountId: i % 2 ? "BANK" : "CASH", amount: String(-(100 + (i % 977))), dimensions: {} }] },
    { principal: OWNER });

  // 1. sequential writes to one book (warm cache): throughput and latency as the book grows
  const lat: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < N; i++) lat.push(await ms(() => post(i)));
  const seqSecs = (performance.now() - t0) / 1000;
  const tail = lat.slice(-Math.min(500, lat.length));

  // 2. cold load of the whole book by a fresh GL instance (a new replica), then a warm write on it
  const gl2 = new GeneralLedger(cell.store);
  const cold = await ms(() => gl2.state(T, B));
  const coldAgain = await ms(() => new GeneralLedger(cell.store).state(T, B));
  const coldNoSnapshot = await ms(() => new GeneralLedger(cell.store, { snapshotEvery: 0 }).state(T, B));   // full replay
  const heap = process.memoryUsage().heapUsed / 1e6;

  // 3. project everything, then interactive reads
  const tp = performance.now();
  for (;;) { try { await cell.settle(); break; } catch (e) { if (!/idle/.test(String(e))) throw e; } }   // idle() gives up after ~10 s
  const projectSecs = (performance.now() - tp) / 1000;
  const reads = async (label: string, f: () => Promise<unknown>, n = 30) => {
    await f();
    const xs: number[] = [];
    for (let i = 0; i < n; i++) xs.push(await ms(f));
    return { [label]: { p50: pct(xs, 0.5), p95: pct(xs, 0.95) } };
  };
  const readStats = {
    ...(await reads("ops.balance", () => cell.ops.plan(T, B, OWNER, "balance", {}), 10)),
    // the balance check verifies from the last checkpoint; a full verification re-reads the whole book
    ...(await reads("gl.verify (incremental)", () => cell.gl.verify(T, B), 10)),
    ...(await reads("gl.verify --full", () => cell.gl.verify(T, B, { full: true }), 3)),
    ...(await reads("ops.dashboard", () => cell.ops.plan(T, B, OWNER, "dashboard", {}))),
    ...(await reads("ops.reconcile", () => cell.ops.plan(T, B, OWNER, "reconcile", { account: "BANK", statementBalance: "0", asOf: "2026-09-30" }))),
    ...(await reads("reporting.trialBalance", () => cell.reporting.trialBalance(T, B))),
    ...(await reads("reporting.recentJournals(20)", () => cell.reporting.recentJournals(T, B, 20))),
    ...(await reads("agent.queue", () => cell.agent.queue(T))),
  };

  // 4. concurrent writers across 8 books (different-book concurrency)
  for (let b = 0; b < 8; b++) await cell.gl.openBook(T, `b${b}`, T, "individual", OWNER);
  const M = 400;
  const tc = performance.now();
  await Promise.all(Array.from({ length: 8 }, async (_, b) => {
    for (let i = 0; i < M / 8; i++) await cell.gl.execute(T, `b${b}`, { kind: "PostJournal", journalId: `c-${b}-${i}`, txnDate: "2026-10-01", narration: "concurrent",
      lines: [{ accountId: "LIVING", amount: "100", dimensions: {} }, { accountId: "CASH", amount: "-100", dimensions: {} }] }, { principal: OWNER });
  }));
  const concurrentPerSec = M / ((performance.now() - tc) / 1000);

  console.log(JSON.stringify({
    node: process.version, journals: N,
    sequentialWrites: { perSec: +(N / seqSecs).toFixed(1), p50ms: pct(lat, 0.5), lastWritesP50ms: pct(tail, 0.5), lastWritesP95ms: pct(tail, 0.95) },
    concurrentWrites8Books: { perSec: +concurrentPerSec.toFixed(1) },
    coldLoadMs: +cold.toFixed(1), coldLoadAgainMs: +coldAgain.toFixed(1), coldReplayWithoutSnapshotMs: +coldNoSnapshot.toFixed(1), heapMB: +heap.toFixed(0),
    projectAllSecs: +projectSecs.toFixed(1),
    readsMs: readStats,
  }, null, 2));
} finally {
  await stop();
}
