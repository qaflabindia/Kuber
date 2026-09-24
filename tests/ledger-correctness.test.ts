/**
 * Ledger correctness (review findings F03, F04, F07, F08): each test asserts the corrected
 * behaviour, i.e. the defect reproduced in review/architecture-review.test.ts no longer exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer, type Cell } from "@kuber/core";
import { IsoDate, isIsoDate, uuid, validateEvent, type Envelope } from "@kuber/contracts";
import { parseDate } from "@kuber/channels";
import { bookStream } from "@kuber/gl";
import { CORE_AUTH_SECRET, enrol, signed, startCell } from "./helpers.ts";

const T = "ledger", B = "main", OWNER = "owner:ledger";
let cell: Cell, stop: (() => Promise<void>) | undefined;
const csv = (...rows: string[]) => "Date,Narration,Withdrawal Amt,Deposit Amt\n" + rows.join("\n") + "\n";
const recordInput = { date: "2026-10-01", narration: "Stationery", amount: "100", direction: "out", account: "LIVING", via: "BANK" };
const post = (amount = "10000", principal = OWNER) => cell.gl.execute(T, B, {
  kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-01", narration: "Opening",
  lines: [{ accountId: "BANK", amount, dimensions: {} }, { accountId: "OPENING", amount: (-BigInt(amount)).toString(), dimensions: {} }],
}, { principal });
const journals = async () => (await cell.store.readStream(T, bookStream(T, B))).filter((e) => e.type === "JournalPosted")
  .map((e) => e.data as { journalId: string; seq: number });
const draftRow = async (draftId: string) => (await cell.store.tenantTx(T, (tx) => tx<{ status: string; journal_id: string | null }[]>`
  SELECT status, journal_id FROM agent.drafts WHERE tenant_id = ${T} AND draft_id = ${draftId}`))[0]!;

beforeEach(async () => {
  stop = undefined;
  const fixture = await startCell({ value: "2026-11-25" });
  ({ cell, stop } = fixture);
  // The only person in this workspace: owner with the explicit single-owner exception (identity.test.ts covers maker-checker).
  await enrol(cell, T, [OWNER]);
  await cell.identity.setSettings(T, OWNER, { soloOwner: true, sodLimitPaise: null });
  await cell.gl.openBook(T, B, T, "individual", OWNER);
  await cell.settle();
});
afterEach(async () => { vi.restoreAllMocks(); await stop?.(); });

// ------------------------------------------------------------------------------------ F04
describe("F04: retried commands have exactly one effect", () => {
  const journalReq = (key: string | undefined, payload: Record<string, unknown> = {}) => ({
    method: "POST" as const, url: `/v1/tenants/${T}/books/${B}/journals`,
    headers: { "x-kuber-tenant": T, "x-kuber-principal": OWNER, ...(key ? { "idempotency-key": key } : {}) },
    payload: { txnDate: "2026-10-01", narration: "Retry proof", lines: [{ accountId: "BANK", debit: "100" }, { accountId: "OPENING", credit: "100" }], ...payload },
  });

  it("a repeated HTTP journal with the same Idempotency-Key posts once and returns the original result", async () => {
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    try {
      const first = await app.inject(signed(journalReq("retry-1"))), second = await app.inject(signed(journalReq("retry-1")));
      expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201);
      expect(second.json()).toEqual(first.json());
      expect(first.json()).toMatchObject({ seq: 1 });
      expect(first.headers["idempotent-replayed"]).toBe("false");
      expect(second.headers["idempotent-replayed"]).toBe("true");
      expect((await cell.gl.state(T, B)).seq).toBe(1);
    } finally { await app.close(); }
  });

  it("concurrent submissions with one key post once; a different key posts again", async () => {
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    try {
      const rs = await Promise.all([1, 2, 3, 4].map(() => app.inject(signed(journalReq("burst-1")))));
      expect(rs.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
      expect(new Set(rs.map((r) => r.json().journalId)).size).toBe(1);
      expect((await cell.gl.state(T, B)).seq).toBe(1);
      expect((await app.inject(signed(journalReq("burst-2")))).json()).toMatchObject({ seq: 2 });
    } finally { await app.close(); }
  });

  it("commandId in the body works like the header; reusing a key for a different request is a 409", async () => {
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    try {
      const a = await app.inject(signed(journalReq(undefined, { commandId: "body-key-1" })));
      const b = await app.inject(signed(journalReq("body-key-1")));
      expect(b.json().journalId).toBe(a.json().journalId);
      const changed = await app.inject(signed(journalReq("body-key-1", { narration: "Something else" })));
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error).toBe("idempotency_conflict");
      await enrol(cell, T, ["controller:ledger"]);                  // a second person who may post journals
      const other = await app.inject(signed({ ...journalReq("body-key-1"), headers: { ...journalReq("body-key-1").headers, "x-kuber-principal": "controller:ledger" } }));
      expect(other.statusCode).toBe(409);                            // same key, different requester
      const mismatch = await app.inject(signed(journalReq("key-a", { commandId: "key-b" })));
      expect(mismatch.statusCode).toBe(400);
      expect((await cell.gl.state(T, B)).seq).toBe(1);
    } finally { await app.close(); }
  });

  it("opening balances are idempotent under a key", async () => {
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    try {
      const req = { method: "POST" as const, url: `/v1/tenants/${T}/books/${B}/opening-balances`,
        headers: { "x-kuber-tenant": T, "x-kuber-principal": OWNER, "idempotency-key": "open-bank" },
        payload: { accountId: "BANK", amount: "5000", asOf: "2026-04-01" } };
      const first = await app.inject(signed(req)), second = await app.inject(signed(req));
      expect(second.json().journalId).toBe(first.json().journalId);
      expect((await cell.gl.state(T, B)).seq).toBe(1);
    } finally { await app.close(); }
  });

  it("a plan commit whose response was lost can be retried and returns the original outcome", async () => {
    const plan = await cell.ops.plan(T, B, OWNER, "record", recordInput);
    const first = await cell.ops.commit(T, plan.planId, OWNER, plan.hash);
    const retry = await cell.ops.commit(T, plan.planId, OWNER, plan.hash);
    expect(first.status).toBe("committed");
    expect(retry).toMatchObject({ status: "committed", replayed: true, steps: (first as { steps: string[] }).steps });
    expect((await cell.gl.state(T, B)).seq).toBe(1);
    await expect(cell.ops.commit(T, plan.planId, OWNER, "0".repeat(64))).rejects.toThrow(/plan is committed/);
  });

  it("two concurrent commits of one plan post once and both report committed", async () => {
    const plan = await cell.ops.plan(T, B, OWNER, "record", recordInput);
    const rs = await Promise.all([cell.ops.commit(T, plan.planId, OWNER, plan.hash), cell.ops.commit(T, plan.planId, OWNER, plan.hash)]);
    expect(rs.map((r) => r.status)).toEqual(["committed", "committed"]);
    expect(rs.filter((r) => "replayed" in r && r.replayed)).toHaveLength(1);
    expect((await cell.gl.state(T, B)).seq).toBe(1);
  });
});

// ------------------------------------------------------------------------------------ F03
describe("F03: plan validation and execution share one consistency boundary", () => {
  it("a posting that lands between simulation and execution makes the commit stale", async () => {
    const plan = await cell.ops.plan(T, B, OWNER, "record", recordInput);
    const transact = cell.gl.transact.bind(cell.gl);
    vi.spyOn(cell.gl, "transact").mockImplementationOnce(async (...args) => { await post("50000"); return transact(...(args as Parameters<typeof transact>)); });
    await expect(cell.ops.commit(T, plan.planId, OWNER, plan.hash)).rejects.toThrow(/books changed/);
    expect((await cell.ops.get(T, plan.planId)).status).toBe("stale");
    expect((await cell.gl.state(T, B)).seq).toBe(1);                  // only the interleaving writer
  });

  it("a writer racing the commit waits for it: the plan's journal lands exactly on its basis", async () => {
    await post();
    const plan = await cell.ops.plan(T, B, OWNER, "record", recordInput);
    const append = cell.store.append.bind(cell.store);
    let racer: Promise<Envelope[]> | undefined;
    vi.spyOn(cell.store, "append").mockImplementation(async (...args) => {
      if (args[0] === "ops" && !racer) { racer = post("777"); await new Promise((r) => setTimeout(r, 50)); }
      return append(...args);
    });
    expect((await cell.ops.commit(T, plan.planId, OWNER, plan.hash)).status).toBe("committed");
    await racer;
    const js = await journals();
    expect(js.find((j) => j.journalId === plan.journals[0]!.journalId)!.seq).toBe(plan.basisSeq + 1);
    expect(js).toHaveLength(3);
  });

  it("a change that is not a journal (a new account) also invalidates the plan", async () => {
    const plan = await cell.ops.plan(T, B, OWNER, "record", recordInput);
    await cell.gl.execute(T, B, { kind: "AddAccount", account: { accountId: "GIFTS", name: "Gifts", nature: "expense", isControl: false, isCashLike: false, requiredDims: [] } }, { principal: OWNER });
    await expect(cell.ops.commit(T, plan.planId, OWNER, plan.hash)).rejects.toThrow(/books changed/);
    expect((await cell.gl.state(T, B)).seq).toBe(0);
  });

  it("a failure part-way through a two-journal plan applies nothing, and the retry commits both", async () => {
    await post("1000000");
    const plan = await cell.ops.plan(T, B, OWNER, "rebalance", {
      targets: [{ account: "BANK", pct: 40 }, { account: "CASH", pct: 30 }, { account: "INVEST", pct: 30 }], minTransfer: "1", date: "2026-10-01",
    });
    expect(plan.journals).toHaveLength(2);
    const append = cell.store.append.bind(cell.store);
    let gl = 0;
    const spy = vi.spyOn(cell.store, "append").mockImplementation(async (...args) => {
      if (args[0] === "gl" && ++gl === 2) throw new Error("Injected connection failure");
      return append(...args);
    });
    await expect(cell.ops.commit(T, plan.planId, OWNER, plan.hash)).rejects.toThrow(/nothing was applied/);
    spy.mockRestore();
    expect((await cell.gl.state(T, B)).seq).toBe(1);                  // the first journal was rolled back too
    expect((await cell.ops.get(T, plan.planId)).status).toBe("proposed");
    expect(await cell.store.readStream(T, `${T}/plan/${plan.planId}`)).toHaveLength(0);   // no approval without effects
    expect((await cell.ops.commit(T, plan.planId, OWNER, plan.hash)).status).toBe("committed");
    expect((await cell.gl.state(T, B)).seq).toBe(3);
  });

  it("concurrent commit and discard: exactly one wins", async () => {
    const plan = await cell.ops.plan(T, B, OWNER, "record", recordInput);
    const [c, d] = await Promise.allSettled([cell.ops.commit(T, plan.planId, OWNER, plan.hash), cell.ops.discard(T, plan.planId, OWNER)]);
    expect([c.status, d.status].filter((s) => s === "fulfilled")).toHaveLength(1);
    const status = (await cell.ops.get(T, plan.planId)).status;
    expect((await cell.gl.state(T, B)).seq).toBe(status === "committed" ? 1 : 0);
  });
});

// ------------------------------------------------------------------------------------ F07
describe("F07: a draft is posted only when the GL accepts its journal", () => {
  const draft = async (narration = "Unknown vendor") => {
    await cell.channels.submitStatement(T, B, csv(`01/10/2026,${narration},100,`), OWNER);
    await cell.settle();
    return (await cell.agent.queue(T)).find((d) => d.proposal.narration === narration)!;
  };

  it("approval requests a posting; the draft is 'approved' until JournalPosted, then 'posted'", async () => {
    const d = await draft();
    const r = await cell.agent.approveDraft(T, d.draft_id, OWNER, "LIVING");
    expect(r.status).toBe("approved");
    expect((await draftRow(d.draft_id)).status).toBe("approved");
    expect(await cell.agent.inFlight(T, B)).toHaveLength(1);
    await cell.settle();
    expect(await draftRow(d.draft_id)).toEqual({ status: "posted", journal_id: r.journalId });
    expect((await cell.gl.state(T, B)).journals.has(r.journalId)).toBe(true);
    expect(await cell.agent.inFlight(T, B)).toHaveLength(0);
  });

  it("a GL rejection returns the draft to review with the reason; nothing is posted or learned", async () => {
    const d = await draft();
    await cell.gl.execute(T, B, { kind: "LockPeriod", periodEnd: "2026-10-31", level: "hard" }, { principal: OWNER });
    await cell.agent.approveDraft(T, d.draft_id, OWNER, "LIVING");
    await cell.settle();
    expect((await cell.gl.state(T, B)).seq).toBe(0);
    const [back] = await cell.agent.queue(T);
    expect(back).toMatchObject({ draft_id: d.draft_id, status: "rejected_by_gl" });
    expect(back!.gl_rejection).toMatch(/period_hard_locked/);
    const learned = await cell.store.tenantTx(T, (tx) => tx`SELECT 1 FROM agent.rules WHERE tenant_id = ${T}`);
    expect(learned).toHaveLength(0);
    // A person can still decide it: rejecting it closes it.
    await cell.agent.rejectDraft(T, d.draft_id, OWNER, "belongs to a closed period");
    expect(await cell.agent.queue(T)).toHaveLength(0);
  });

  it("a rejected posting can be fixed and approved again, and then posts once", async () => {
    const d = await draft();
    await cell.gl.execute(T, B, { kind: "LockPeriod", periodEnd: "2026-10-31", level: "soft" }, { principal: OWNER });
    await cell.agent.approveDraft(T, d.draft_id, "preparer:pat", "LIVING");   // soft lock: preparers may not post
    await cell.settle();
    expect((await draftRow(d.draft_id)).status).toBe("rejected_by_gl");
    expect((await cell.agent.queue(T))[0]!.gl_rejection).toMatch(/period_soft_locked/);
    const r = await cell.agent.approveDraft(T, d.draft_id, OWNER, "LIVING");
    await cell.settle();
    expect((await draftRow(d.draft_id)).status).toBe("posted");
    expect((await journals()).map((j) => j.journalId)).toEqual([r.journalId]);
    expect(await cell.agent.queue(T)).toHaveLength(0);
  });

  it("a period close waits while approved drafts are still in flight", async () => {
    const d = await draft();
    await cell.agent.approveDraft(T, d.draft_id, OWNER, "LIVING");
    const blocked = await cell.ops.plan(T, B, OWNER, "close", { periodEnd: "2026-10-31" });
    expect(blocked.checks.find((c) => c.label === "No postings in flight")).toMatchObject({ ok: false });
    expect(blocked.blocked).toBe(true);
    await cell.settle();
    const ready = await cell.ops.plan(T, B, OWNER, "close", { periodEnd: "2026-10-31" });
    expect(ready.checks.find((c) => c.label === "No postings in flight")).toMatchObject({ ok: true });
  });
});

// ------------------------------------------------------------------------------------ F08
describe("F08: impossible calendar dates are refused wherever a date enters", () => {
  const bad = ["2026-02-30", "2026-02-31", "2026-13-01", "2026-00-10", "2026-04-31", "2026-02-29", "2100-02-29", "2026-1-01"];
  const good = ["2026-02-28", "2028-02-29", "2000-02-29", "2026-12-31", "2027-03-31"];

  it("the IsoDate contract accepts real dates only", () => {
    for (const d of bad) { expect(isIsoDate(d)).toBe(false); expect(IsoDate.safeParse(d).success).toBe(false); }
    for (const d of good) { expect(isIsoDate(d)).toBe(true); expect(IsoDate.safeParse(d).success).toBe(true); }
  });

  it("the ledger refuses the date, so no event (and no report row) ever carries it", async () => {
    await expect(cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-02-31", narration: "Invalid",
      lines: [{ accountId: "BANK", amount: "100", dimensions: {} }, { accountId: "OPENING", amount: "-100", dimensions: {} }] }, { principal: OWNER }))
      .rejects.toThrow(/bad transaction date/);
    await expect(cell.gl.execute(T, B, { kind: "LockPeriod", periodEnd: "2026-09-31", level: "soft" }, { principal: OWNER })).rejects.toThrow(/bad period end/);
    expect((await cell.gl.state(T, B)).version).toBe(1);             // only BookOpened
    expect(() => validateEvent("PeriodLocked", { bookId: B, periodEnd: "2026-13-01", level: "soft" })).toThrow();
  });

  it("HTTP, operations and statement imports refuse it", async () => {
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    try {
      const res = await app.inject(signed({ method: "POST", url: `/v1/tenants/${T}/books/${B}/journals`,
        headers: { "x-kuber-tenant": T, "x-kuber-principal": OWNER },
        payload: { txnDate: "2026-02-30", narration: "Invalid", lines: [{ accountId: "BANK", debit: "1" }, { accountId: "OPENING", credit: "1" }] } }));
      expect(res.statusCode).toBe(400);
      const report = await app.inject(signed({ method: "GET", url: `/v1/tenants/${T}/books/${B}/reports/trial-balance?asOf=2026-02-30`,
        headers: { "x-kuber-tenant": T, "x-kuber-principal": OWNER } }));
      expect(report.statusCode).toBe(400);
    } finally { await app.close(); }
    await expect(cell.ops.plan(T, B, OWNER, "record", { ...recordInput, date: "2026-13-01" })).rejects.toThrow(/calendar date/);
    expect(() => parseDate("31/02/2026")).toThrow(/invalid date/);
    expect(parseDate("29/02/2028")).toBe("2028-02-29");
    await expect((async () => cell.channels.submitStatement(T, B, csv("30/02/2026,Impossible,100,"), OWNER))()).rejects.toThrow(/invalid date/);
    expect((await cell.gl.state(T, B)).seq).toBe(0);
  });
});
