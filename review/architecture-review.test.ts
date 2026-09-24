/** Audit reproductions: passing means the documented defect was reproduced, NOT fixed.
 * Uses the repository's isolated temporary-database helper. No live tenant data is used.
 * Run: bash scripts/test-docker.sh --config review/vitest.config.ts
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildServer, kuberTools, KeyAdmin, type Cell } from "@kuber/core";
import postgres from "postgres";
import { Keyring } from "@kuber/crypto";
import { EventStore, openEnvelope } from "@kuber/eventstore";
import { uuid } from "@kuber/contracts";
import { startCell } from "../tests/helpers.ts";

let cell: Cell, stop: (() => Promise<void>) | undefined, ownerUrl: string;
const tenant = "audit", book = "main", owner = "owner:audit";
const csv = (...rows: string[]) => "Date,Narration,Withdrawal Amt,Deposit Amt\n" + rows.join("\n") + "\n";
const recordInput = { date: "2026-10-01", narration: "Audit expense", amount: "100", direction: "out", account: "LIVING", via: "BANK" };
const post = (amount = "10000") => cell.gl.execute(tenant, book, {
  kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-01", narration: "Audit opening",
  lines: [{ accountId: "BANK", amount, dimensions: {} }, { accountId: "OPENING", amount: (-BigInt(amount)).toString(), dimensions: {} }],
}, { principal: owner });

beforeEach(async () => {
  stop = undefined;
  const fixture = await startCell({ value: "2026-11-25" });
  ({ cell, stop } = fixture); ownerUrl = fixture.db.ownerUrl;
  await cell.gl.openBook(tenant, book, tenant, "individual", owner);
  await cell.settle();
});
afterEach(async () => { vi.restoreAllMocks(); await stop?.(); });

it("A01: an unsigned caller claiming auditor can post a journal through HTTP", async () => {
  const app = buildServer(cell);
  try {
    const res = await app.inject({ method: "POST", url: `/v1/tenants/${tenant}/books/${book}/journals`,
      headers: { "x-kuber-tenant": tenant, "x-kuber-principal": "auditor:outsider" },
      payload: { txnDate: "2026-10-01", narration: "Unauthorized audit proof", lines: [{ accountId: "BANK", debit: "100" }, { accountId: "OPENING", credit: "100" }] } });
    expect(res.statusCode).toBe(201);
    expect((await cell.gl.state(tenant, book)).seq).toBe(1);
  } finally { await app.close(); }
});

it("A02: repeating the same HTTP journal command posts twice", async () => {
  const app = buildServer(cell);
  try {
    const request = { method: "POST" as const, url: `/v1/tenants/${tenant}/books/${book}/journals`,
      headers: { "x-kuber-tenant": tenant, "x-kuber-principal": owner, "idempotency-key": "audit-retry" },
      payload: { txnDate: "2026-10-01", narration: "Retry proof", lines: [{ accountId: "BANK", debit: "100" }, { accountId: "OPENING", credit: "100" }] } };
    const first = await app.inject(request), second = await app.inject(request);
    expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201);
    expect(first.json().journalId).not.toBe(second.json().journalId);
    expect((await cell.gl.state(tenant, book)).seq).toBe(2);
  } finally { await app.close(); }
});

it("A03: posting rejection leaves an approved draft marked posted and absent from review", async () => {
  await cell.channels.submitStatement(tenant, book, csv("01/10/2026,Unknown vendor,100,"), owner);
  await cell.settle();
  const [draft] = await cell.agent.queue(tenant);
  await cell.gl.execute(tenant, book, { kind: "LockPeriod", periodEnd: "2026-10-31", level: "hard" }, { principal: owner });
  await cell.agent.approveDraft(tenant, draft!.draft_id, owner, "LIVING");
  await cell.settle();
  expect((await cell.gl.state(tenant, book)).seq).toBe(0);
  expect(await cell.agent.queue(tenant)).toHaveLength(0);
  const rows = await cell.store.tenantTx(tenant, tx => tx`SELECT status FROM agent.drafts WHERE tenant_id = ${tenant}`);
  expect(rows[0]!.status).toBe("posted");
  expect((await cell.store.readStream(tenant, `${tenant}/gl-rejections/${book}`))[0]!.type).toBe("PostingRejected");
});

it("A04: another posting between plan validation and execution does not invalidate the commit", async () => {
  const plan = await cell.ops.plan(tenant, book, owner, "record", recordInput);
  const execute = cell.gl.execute.bind(cell.gl);
  vi.spyOn(cell.gl, "execute").mockImplementationOnce(async (...args) => {
    await execute(tenant, book, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-01", narration: "Interleaving writer",
      lines: [{ accountId: "BANK", amount: "50000", dimensions: {} }, { accountId: "OPENING", amount: "-50000", dimensions: {} }] }, { principal: owner });
    return execute(...args);
  });
  expect((await cell.ops.commit(tenant, plan.planId, owner, plan.hash)).status).toBe("committed");
  expect(plan.basisSeq).toBe(0);
  expect((await cell.gl.state(tenant, book)).seq).toBe(2);
});

it("A05: failure after one of two plan postings makes its retry stale", async () => {
  await post("1000000");
  const plan = await cell.ops.plan(tenant, book, owner, "rebalance", {
    targets: [{ account: "BANK", pct: 40 }, { account: "CASH", pct: 30 }, { account: "INVEST", pct: 30 }],
    minTransfer: "1", date: "2026-10-01",
  });
  expect(plan.journals).toHaveLength(2);
  const execute = cell.gl.execute.bind(cell.gl);
  let n = 0;
  const spy = vi.spyOn(cell.gl, "execute").mockImplementation(async (...args) => {
    if (++n === 2) throw new Error("Injected connection failure");
    return execute(...args);
  });
  await expect(cell.ops.commit(tenant, plan.planId, owner, plan.hash)).rejects.toThrow("after 1 of 2 steps");
  spy.mockRestore();
  await expect(cell.ops.commit(tenant, plan.planId, owner, plan.hash)).rejects.toThrow("books changed");
  expect((await cell.ops.get(tenant, plan.planId)).status).toBe("stale");
  expect((await cell.gl.state(tenant, book)).seq).toBe(2);
});

it("A06: concurrent overlapping imports silently omit a unique transaction", async () => {
  const original = cell.store.existingStreams.bind(cell.store);
  let calls = 0, release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  vi.spyOn(cell.store, "existingStreams").mockImplementation(async (...args) => {
    const found = await original(...args);
    if (++calls === 2) release();
    await barrier;
    return found;
  });
  const common = "01/10/2026,Shared row,100,";
  const results = await Promise.all([
    cell.channels.submitStatement(tenant, book, csv(common, "02/10/2026,Unique A,200,"), owner),
    cell.channels.submitStatement(tenant, book, csv(common, "03/10/2026,Unique B,300,"), owner),
  ]);
  expect(results.filter(r => r.duplicate)).toHaveLength(1);
  const rows = await cell.store.tenantTx(tenant, tx => tx`SELECT count(*)::int AS n FROM es.events WHERE type = 'TransactionExtracted'`);
  expect(rows[0]!.n).toBe(2); // Three distinct transactions were supplied.
});

it("A07: unrelated bank line with same amount/date confirms a provisional payment", async () => {
  await cell.channels.submitChat(tenant, book, "Paid 100 to Alice via bank", owner, "2026-10-01");
  await cell.settle();
  await cell.channels.submitStatement(tenant, book, csv("01/10/2026,Payment to Bob reference B,100,"), owner);
  await cell.settle();
  const rows = await cell.store.tenantTx(tenant, tx => tx`SELECT confirmed FROM agent.journal_index WHERE tenant_id = ${tenant}`);
  expect(rows[0]!.confirmed).toBe(true);
  expect(await cell.agent.queue(tenant)).toHaveLength(0);
  expect((await cell.gl.state(tenant, book)).seq).toBe(1);
});

it("A08: a confirmed provisional journal remains a timing item in reconciliation", async () => {
  await cell.channels.submitChat(tenant, book, "Paid 100 to Alice via bank", owner, "2026-10-01");
  await cell.settle();
  await cell.channels.submitStatement(tenant, book, csv("01/10/2026,Payment to Alice,100,"), owner);
  await cell.settle();
  const state = await cell.gl.state(tenant, book);
  expect([...state.journals.values()][0]!.provisional).toBe(true);
  expect((await cell.reporting.recentJournals(tenant, book))[0]!.provisional).toBe(true);
});

it("A09: invalid calendar date in the ledger is silently normalized in reporting", async () => {
  const events = await cell.gl.execute(tenant, book, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-02-31", narration: "Invalid calendar date",
    lines: [{ accountId: "BANK", amount: "100", dimensions: {} }, { accountId: "OPENING", amount: "-100", dimensions: {} }] }, { principal: owner });
  expect(events[0]!.type).toBe("JournalPosted");
  await cell.reporting.handler(events[0]!);
  const rows = await cell.store.tenantTx(tenant, tx => tx`SELECT txn_date::text AS date FROM reporting.lines WHERE tenant_id = ${tenant} LIMIT 1`);
  expect(rows[0]!.date).toBe("2026-03-03");
  expect([...((await cell.gl.state(tenant, book)).journals.values())][0]!.txnDate).toBe("2026-02-31");
  expect((await cell.gl.state(tenant, book)).seq).toBe(1);
});

it("A10: auditor principal can approve a write plan without separation of duties", async () => {
  const plan = await cell.ops.plan(tenant, book, "auditor:alice", "record", recordInput);
  expect((await cell.ops.commit(tenant, plan.planId, "auditor:alice", plan.hash)).status).toBe("committed");
});

it("A11: losing commit response prevents idempotent plan result lookup through retry", async () => {
  const plan = await cell.ops.plan(tenant, book, owner, "record", recordInput);
  await cell.ops.commit(tenant, plan.planId, owner, plan.hash);
  await expect(cell.ops.commit(tenant, plan.planId, owner, plan.hash)).rejects.toThrow("plan is committed");
});

it("A12: a book-scoped MCP tool can commit another book's policy-eligible plan if given its id/hash", async () => {
  await cell.gl.openBook(tenant, "restricted", tenant, "individual", owner);
  const plan = await cell.ops.plan(tenant, "restricted", owner, "record", recordInput);
  expect(plan.needsPerson).toBe(false);
  const commit = kuberTools(cell, { tenant, book, principal: "agent:main-only" }).find(t => t.name === "kuber_commit")!;
  const result = await commit.run({ planId: plan.planId, hash: plan.hash });
  expect(result.text).toContain("Committed:");
  expect((await cell.gl.state(tenant, "restricted")).seq).toBe(1);
});

it("A13: reencrypt drops a key still needed by a previously published sealed envelope", async () => {
  const sql = postgres(ownerUrl, { max: 3, onnotice: () => undefined });
  try {
    const keyring = new Keyring(sql, cell.keyring.kms, 0);
    const store = new EventStore(sql, "audit", { keyring });
    const admin = new KeyAdmin(sql, keyring, store, 0); // No clock wait: isolate missing broker-reference accounting.
    const [row] = await sql`SELECT envelope FROM es.outbox ORDER BY id LIMIT 1`;
    const publishedCopy = row!.envelope;
    await keyring.rotateTenant(tenant);
    const result = await admin.reencrypt(tenant);
    expect(result.dropped).toContain(1);
    await expect(openEnvelope(keyring, publishedCopy)).rejects.toThrow("no data key v1");
  } finally { await sql.end(); }
});

it("A14: crypto-shred leaves readable evidence account balances", async () => {
  await post(); await cell.settle();
  const sql = postgres(ownerUrl, { max: 3, onnotice: () => undefined });
  try {
    const keyring = new Keyring(sql, cell.keyring.kms, 0);
    const admin = new KeyAdmin(sql, keyring, new EventStore(sql, "audit", { keyring }));
    await admin.shred(tenant, "operator:audit", "Synthetic audit tenant only");
    const rows = await sql`SELECT account_id, balance::text FROM evidence.balances WHERE tenant_id = ${tenant}`;
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.account_id === "BANK")!.balance).toBe("10000");
  } finally { await sql.end(); }
});
