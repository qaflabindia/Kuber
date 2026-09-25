/**
 * Finance requirements for the G0 general ledger. Each test is named by the requirement it proves:
 *   FIN-GL-01  journal lifecycle states; control accounts; rejected postings have no effect and stay visible
 *   FIN-GL-02  recurring journals: approval once, at-most-once occurrences, auto-reversal, locked-period exceptions
 *   FIN-GL-03  prepaid / accrual recognition schedules, cancellation, reconciliation to the GL by period
 *   FIN-GL-04  foreign currency deferred: INR-only assertion and explicit exponent
 *   FIN-GL-05  suspense items as cases, resolution links, balancing journals refused, roll-forward
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { BOOK_CURRENCY, CURRENCY_EXPONENT, JOURNAL_STATES, draftLifecycle, planLifecycle, uuid, type Account, type EventData, type Line } from "@kuber/contracts";
import { bookStream, schedules as S } from "@kuber/gl";
import { balancesFromState } from "@kuber/ops";
import { OpsAdmin, buildServer, type Cell } from "@kuber/core";
import { CORE_AUTH_SECRET, enrol, signed, startCell } from "./helpers.ts";

const T = "fin";
const OWNER = "owner:fin", CONTROLLER = "controller:fin", PREPARER = "preparer:fin", APPROVER = "approver:fin";
const clock = { value: "2026-10-01" };
let cell: Cell, stop: () => Promise<void>, ownerUrl: string;

const acct = (accountId: string, nature: Account["nature"], extra: Partial<Account> = {}): Account =>
  ({ accountId, name: accountId, nature, isControl: false, isCashLike: false, requiredDims: [], ...extra });
const L = (accountId: string, amount: bigint | string, extra: Partial<Line> = {}): Line => ({ accountId, amount: amount.toString(), dimensions: {}, ...extra });
const openBook = async (book: string, extra: Account[] = []) => {
  await cell.gl.openBook(T, book, T, "company", OWNER);
  for (const a of extra) await cell.gl.execute(T, book, { kind: "AddAccount", account: a }, { principal: OWNER });
  await cell.settle();
};
const bookEvents = async (book: string) => cell.store.readStream(T, bookStream(T, book));
const posted = async (book: string) => (await bookEvents(book)).filter((e) => e.type === "JournalPosted");
/** Plan as `preparer`, commit as `approver`. */
async function planCommit(book: string, op: string, input: unknown, preparer: string, approver: string) {
  const p = await cell.ops.plan(T, book, preparer, op, input);
  expect(p.blocked, JSON.stringify(p.checks.filter((c) => !c.ok))).toBe(false);
  const r = await cell.ops.commit(T, p.planId, approver, p.hash);
  expect(r.status).toBe("committed");
  await cell.settle();
  return { plan: p, result: r };
}

beforeAll(async () => {
  const f = await startCell(clock);
  cell = f.cell; stop = f.stop; ownerUrl = f.db.ownerUrl;
  await enrol(cell, T, [OWNER, CONTROLLER, PREPARER, APPROVER]);
});
afterAll(async () => { await stop?.(); });

// ====================================================================== FIN-GL-01
describe("FIN-GL-01: journal lifecycle and posting controls", () => {
  const B = "gl01";
  let app: ReturnType<typeof buildServer>;
  const journal = (payload: unknown, principal = OWNER, key?: string) => app.inject(signed({ method: "POST", url: `/v1/tenants/${T}/books/${B}/journals`,
    headers: { "x-kuber-tenant": T, "x-kuber-principal": principal, ...(key ? { "idempotency-key": key } : {}) }, payload }));
  const get = (url: string, principal = OWNER) => app.inject(signed({ method: "GET", url, headers: { "x-kuber-tenant": T, "x-kuber-principal": principal } }));

  beforeAll(async () => {
    clock.value = "2026-10-15";
    await openBook(B, [acct("PROJEXP", "expense", { requiredDims: ["project"] })]);
    app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
  });
  afterAll(async () => { await app?.close(); });

  it("FIN-GL-01 maps agent draft and ops plan states onto draft/submitted/approved/posting/posted/failed", () => {
    expect(JOURNAL_STATES).toEqual(["draft", "submitted", "approved", "posting", "posted", "failed"]);
    expect(["queued", "awaiting_approval", "approved", "posted", "rejected_by_gl", "rejected"].map(draftLifecycle))
      .toEqual(["draft", "submitted", "posting", "posted", "failed", "failed"]);
    expect(planLifecycle("preview")).toBe("draft");
    expect(planLifecycle("proposed")).toBe("submitted");
    expect(planLifecycle("proposed", { error: "period_hard_locked" })).toBe("failed");
    expect(planLifecycle("committed")).toBe("posted");
    expect(planLifecycle("committed", { viaDrafts: true })).toBe("posting");
    expect(planLifecycle("committed", { approvalOnly: true })).toBe("approved");
    expect(planLifecycle("stale")).toBe("failed");
    expect(planLifecycle("discarded")).toBe("failed");
  });

  it("FIN-GL-01 unbalanced, invalid-date, locked-period and incomplete-dimension journals have no effect and leave a visible failed state", async () => {
    await cell.gl.execute(T, B, { kind: "LockPeriod", periodEnd: "2026-09-30", level: "hard" }, { principal: OWNER });
    const before = await cell.gl.state(T, B);
    const ok = [{ accountId: "BANK", debit: "100" }, { accountId: "OPENING", credit: "100" }];
    const attempts = [
      { key: "fin01-unbalanced", body: { txnDate: "2026-10-10", narration: "Unbalanced", lines: [{ accountId: "BANK", debit: "100" }, { accountId: "OPENING", credit: "90" }] }, status: 422, reason: /unbalanced/ },
      { key: "fin01-bad-date", body: { txnDate: "2026-02-30", narration: "No such day", lines: ok }, status: 400, reason: /invalid_request: txnDate/ },
      { key: "fin01-locked", body: { txnDate: "2026-09-15", narration: "Into a closed month", lines: ok }, status: 422, reason: /period_hard_locked/ },
      { key: "fin01-dims", body: { txnDate: "2026-10-10", narration: "No project", lines: [{ accountId: "PROJEXP", debit: "100" }, { accountId: "BANK", credit: "100" }] }, status: 422, reason: /missing_dimensions/ },
    ];
    for (const a of attempts) {
      const r = await journal(a.body, OWNER, a.key);
      expect(r.statusCode, a.key).toBe(a.status);
      expect(r.headers["x-kuber-rejection"]).toBe(a.key);
    }
    await cell.settle();
    // no effect: no event on the book, nothing in reports
    const after = await cell.gl.state(T, B);
    expect(after.seq).toBe(before.seq);
    expect(after.version).toBe(before.version);
    expect((await cell.reporting.trialBalance(T, B)).totals["Total debits"] ?? 0n).toBe(0n);
    // visible: each attempt is a failed journal with its reason
    const lc = (await get(`/v1/tenants/${T}/books/${B}/journal-lifecycle`)).json() as { states: string[]; counts: Record<string, number>; items: { id: string; source: string; state: string; reason: string }[] };
    expect(lc.states).toEqual([...JOURNAL_STATES]);
    for (const a of attempts) expect(lc.items.find((i) => i.id === a.key)).toMatchObject({ source: "ledger", state: "failed", reason: expect.stringMatching(a.reason) });
    expect(lc.counts.failed).toBeGreaterThanOrEqual(4);
  });

  it("FIN-GL-01 a manual journal to a control account is refused unless it is a controlled adjustment by an owner or controller with the party", async () => {
    const lines = (party?: string) => [{ accountId: "DEBTORS", debit: "500", ...(party ? { partyId: party } : {}) }, { accountId: "FEES", credit: "500" }];
    const plain = await journal({ txnDate: "2026-10-12", narration: "Invoice by hand", lines: lines("p.acme") });
    expect(plain.statusCode).toBe(422);
    expect(plain.json()).toMatchObject({ error: "control_account_manual" });
    const noParty = await journal({ txnDate: "2026-10-12", narration: "Adjustment", lines: lines(), controlledAdjustment: { reason: "write-back" } });
    expect(noParty.statusCode).toBe(422);
    expect(noParty.json()).toMatchObject({ error: "control_needs_party" });
    // the ledger itself refuses the flag from anyone but an owner or controller
    await expect(cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-12", narration: "x", entry: "manual",
      controlledAdjustment: { reason: "write-back" }, lines: [L("DEBTORS", 500n, { partyId: "p.acme" }), L("FEES", -500n)] }, { principal: PREPARER })).rejects.toThrow(/only an owner or controller/);
    const good = await journal({ txnDate: "2026-10-12", narration: "Adjustment", lines: lines("p.acme"), controlledAdjustment: { reason: "invoice missed by billing" } }, CONTROLLER);
    expect(good.statusCode).toBe(201);
    const ev = (await posted(B)).at(-1)!.data as EventData<"JournalPosted">;
    expect(ev.controlledAdjustment).toEqual({ reason: "invoice missed by billing" });
    expect(ev.lines.find((l) => l.accountId === "DEBTORS")!.partyId).toBe("p.acme");
  });

  it("FIN-GL-01 ops record to a control account is refused unless flagged as a controlled adjustment by an owner or controller", async () => {
    const base = { date: "2026-10-13", narration: "Customer paid", amount: "250", direction: "in", account: "DEBTORS", via: "BANK" };
    const unflagged = await cell.ops.plan(T, B, OWNER, "record", base);
    expect(unflagged.blocked).toBe(true);
    expect(unflagged.checks.find((c) => !c.ok)!.detail).toMatch(/control account/);
    const byPreparer = await cell.ops.plan(T, B, PREPARER, "record", { ...base, controlledAdjustment: { reason: "unapplied receipt", partyId: "p.acme" } });
    expect(byPreparer.blocked).toBe(true);
    expect(byPreparer.checks.find((c) => !c.ok)!.label).toMatch(/owner or controller/);
    const p = await cell.ops.plan(T, B, CONTROLLER, "record", { ...base, controlledAdjustment: { reason: "unapplied receipt", partyId: "p.acme" } });
    expect(p.blocked).toBe(false);
    // committing it also needs an owner or controller
    await expect(cell.ops.commit(T, p.planId, APPROVER, p.hash)).rejects.toThrow(/owner or controller/);
    expect((await cell.ops.commit(T, p.planId, OWNER, p.hash)).status).toBe("committed");
    const ev = (await posted(B)).at(-1)!.data as EventData<"JournalPosted">;
    expect(ev.lines.find((l) => l.accountId === "DEBTORS")).toMatchObject({ partyId: "p.acme", amount: "-25000" });
    expect(ev.controlledAdjustment).toEqual({ reason: "unapplied receipt" });
  });

  it("FIN-GL-01 ops post refuses drafts to a control account unless flagged by an owner or controller, and drafts show lifecycle states", async () => {
    const csv = "Date,Narration,Withdrawal Amt,Deposit Amt\n14/10/2026,NEFT/CR/ZYLOQUIX TRADERS/INV 77,,7500\n";
    await cell.channels.submitStatement(T, B, csv, OWNER);
    await cell.settle();
    const [d] = await cell.agent.queue(T, { bookId: B });
    expect(d).toBeTruthy();
    const id = d!.draft_id;
    const refused = await cell.ops.plan(T, B, OWNER, "post", { overrides: { [id]: "DEBTORS" } });
    expect(refused.blocked).toBe(true);
    expect(refused.checks.find((c) => c.label.startsWith("Control accounts"))!.detail).toMatch(/not flagged/);
    const byPreparer = await cell.ops.plan(T, B, PREPARER, "post", { overrides: { [id]: "DEBTORS" }, controlled: [id] });
    expect(byPreparer.checks.find((c) => c.label.startsWith("Control accounts"))!.detail).toMatch(/only an owner or controller/);
    const lcBefore = await cell.agent.lifecycle(T, B);
    expect(lcBefore.find((x) => x.id === id)!.state).toMatch(/^(draft|submitted)$/);
    const { plan } = await planCommit(B, "post", { overrides: { [id]: "DEBTORS" }, controlled: [id] }, CONTROLLER, OWNER);
    const lc = (await get(`/v1/tenants/${T}/books/${B}/journal-lifecycle`)).json() as { items: { id: string; state: string; source: string }[] };
    expect(lc.items.find((x) => x.id === id)).toMatchObject({ source: "draft", state: "posted" });
    expect(lc.items.find((x) => x.id === plan.planId)).toMatchObject({ source: "plan", state: "posting" });   // drafts post through the agent
    const ev = (await posted(B)).at(-1)!.data as EventData<"JournalPosted">;
    expect(ev.lines.find((l) => l.accountId === "DEBTORS")!.partyId).toBeTruthy();
  });

  it("FIN-GL-01 a plan whose commit is refused stays visible as failed with its reason", async () => {
    const p = await cell.ops.plan(T, B, CONTROLLER, "record", { date: "2026-10-14", narration: "Stationery", amount: "40", direction: "out", account: "BIZEXP", via: "BANK" });
    await cell.gl.execute(T, B, { kind: "LockPeriod", periodEnd: "2026-10-14", level: "soft" }, { principal: OWNER });   // the book moves
    await expect(cell.ops.commit(T, p.planId, OWNER, p.hash)).rejects.toThrow(/changed since/);
    const item = (await cell.ops.lifecycle(T, B)).find((x) => x.id === p.planId)!;
    expect(item).toMatchObject({ storedStatus: "stale", state: "failed", reason: expect.stringMatching(/changed/) });
  });
});

// ====================================================================== FIN-GL-04
describe("FIN-GL-04: single currency (foreign currency deferred)", () => {
  const B = "gl04";
  beforeAll(async () => { clock.value = "2026-10-15"; await openBook(B, [acct("ACCRUED", "liability")]); });

  it("FIN-GL-04 the currency exponent and the INR-only assertion are explicit; a non-INR journal is refused with a clear error", async () => {
    expect(BOOK_CURRENCY).toBe("INR");
    expect(CURRENCY_EXPONENT.INR).toBe(2);
    const lines = [L("BANK", 100n), L("OPENING", -100n)];
    await expect(cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-01", narration: "USD", currency: "USD", lines }, { principal: OWNER }))
      .rejects.toThrow(/currency USD is not supported: this book is INR only.*exponent 2/);
    expect(await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-01", narration: "INR", currency: "INR", lines }, { principal: OWNER })).toHaveLength(1);
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    try {
      const r = await app.inject(signed({ method: "POST", url: `/v1/tenants/${T}/books/${B}/journals`, headers: { "x-kuber-tenant": T, "x-kuber-principal": OWNER },
        payload: { txnDate: "2026-10-02", narration: "Invoice in dollars", currency: "USD", lines: [{ accountId: "BANK", debit: "10" }, { accountId: "OPENING", credit: "10" }] } }));
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ error: "currency_not_supported" });
    } finally { await app.close(); }
    const p = await cell.ops.plan(T, B, OWNER, "record", { narration: "Euro lunch", amount: "10", direction: "out", account: "BIZEXP", via: "BANK", currency: "EUR" });
    expect(p.blocked).toBe(true);
    expect(p.checks.find((c) => !c.ok)!.detail).toMatch(/EUR is not supported/);
    await expect(cell.ops.schedules.create(T, B, PREPARER, { name: "USD accrual", kind: "recurring", start: "2026-10-01", end: "2026-12-31", currency: "USD",
      lines: [L("BIZEXP", 100n), L("ACCRUED", -100n)] })).rejects.toThrow(/currency USD is not supported/);
  });
});

// ====================================================================== FIN-GL-02
describe("FIN-GL-02: recurring journals", () => {
  const B = "gl02";
  const ACCRUAL = 1_200_000n;                                             // ₹12,000 in paise
  const def = { name: "Audit fee accrual", kind: "recurring", start: "2026-10-01", end: "2026-12-31", autoReverse: true,
    lines: [L("BIZEXP", ACCRUAL), L("ACCRUED", -ACCRUAL)] };
  let scheduleId = "", approvalPlan = "";

  beforeAll(async () => { clock.value = "2026-10-01"; await openBook(B, [acct("ACCRUED", "liability")]); });

  it("FIN-GL-02 a schedule is approved once through an ops plan by someone other than its preparer", async () => {
    const s = await cell.ops.schedules.create(T, B, PREPARER, def);
    scheduleId = s.scheduleId;
    expect(s).toMatchObject({ status: "submitted", kind: "recurring", policyVersion: expect.stringMatching(/^POL-000@\d+$/) });
    expect(s.occurrences.filter((o) => o.kind === "post").map((o) => o.dueOn)).toEqual(["2026-10-31", "2026-11-30", "2026-12-31"]);
    expect(s.occurrences.filter((o) => o.kind === "reverse").map((o) => o.dueOn)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    // business occurrence ids: schedule + period + kind
    expect(new Set(s.occurrences.map((o) => o.occurrenceId)).size).toBe(6);
    expect(s.occurrences[0]!.occurrenceId).toBe(S.occurrenceId(T, scheduleId, "2026-10", "post"));
    // nothing runs before approval
    expect((await cell.ops.runSchedules(T, "2026-11-01")).posted).toEqual([]);
    const p = await cell.ops.plan(T, B, PREPARER, "schedule_approve", { scheduleId });
    expect(p).toMatchObject({ gate: "human", needsPerson: true, blocked: false });
    expect(p.data).toMatchObject({ approvedAmount: ACCRUAL.toString() });
    await expect(cell.ops.commit(T, p.planId, PREPARER, p.hash)).rejects.toThrow(/may not plan\.approve\.period/);
    expect((await cell.ops.commit(T, p.planId, CONTROLLER, p.hash)).status).toBe("committed");
    approvalPlan = p.planId;
    expect(await cell.ops.schedules.get(T, scheduleId)).toMatchObject({ status: "approved", approvedBy: CONTROLLER, approvalPlanId: p.planId, approvedAmount: ACCRUAL.toString() });
  });

  it("FIN-GL-02 a ₹12,000 monthly accrual posts once and reverses once, even when rerun or run concurrently", async () => {
    clock.value = "2026-11-01";
    const runs = await Promise.all([1, 2, 3].map(() => cell.ops.runSchedules(T, "2026-11-01")));
    expect(runs.flatMap((r) => r.posted)).toEqual([S.occurrenceJournalId(T, scheduleId, "2026-10", "post")]);
    expect(runs.flatMap((r) => r.reversed)).toEqual([S.occurrenceJournalId(T, scheduleId, "2026-10", "reverse")]);
    const again = await cell.ops.runSchedules(T, "2026-11-01");
    expect([again.posted, again.reversed, again.exceptions]).toEqual([[], [], []]);
    await cell.settle();
    const journals = (await posted(B)).map((e) => ({ data: e.data as EventData<"JournalPosted">, meta: e.meta }));
    expect(journals).toHaveLength(2);
    const [post, rev] = journals;
    expect(post!.data).toMatchObject({ txnDate: "2026-10-31", voucherType: "recurring", source: { stream: `${T}/schedule/${scheduleId}` } });
    expect(rev!.data).toMatchObject({ txnDate: "2026-11-01", reverses: post!.data.journalId });
    // executed as the system principal, under the approval
    expect(journals.map((j) => j.meta.principal)).toEqual(["system:scheduler", "system:scheduler"]);
    expect(journals.map((j) => j.meta.commandId)).toEqual([approvalPlan, approvalPlan]);
    const s = await cell.gl.state(T, B);
    expect(balancesFromState(s, { to: "2026-10-31" }).get("BIZEXP")).toBe(ACCRUAL);
    expect(balancesFromState(s, { to: "2026-10-31" }).get("ACCRUED")).toBe(-ACCRUAL);
    expect(balancesFromState(s).get("ACCRUED")).toBe(0n);
    const v = await cell.ops.schedules.get(T, scheduleId);
    expect(v.occurrences.filter((o) => o.status === "posted").map((o) => `${o.period}/${o.kind}`)).toEqual(["2026-10/post", "2026-10/reverse"]);
  });

  it("FIN-GL-02 an auto-reversal whose date falls in a locked period becomes an exception case; the date is not moved", async () => {
    clock.value = "2026-12-01";
    expect((await cell.ops.runSchedules(T, "2026-11-30")).posted).toEqual([S.occurrenceJournalId(T, scheduleId, "2026-11", "post")]);
    await cell.gl.execute(T, B, { kind: "LockPeriod", periodEnd: "2026-12-05", level: "soft" }, { principal: OWNER });
    const r = await cell.ops.runSchedules(T, "2026-12-01");
    expect(r.reversed).toEqual([]);
    expect(r.exceptions).toEqual([{ occurrenceId: S.occurrenceId(T, scheduleId, "2026-11", "reverse"), reason: expect.stringMatching(/soft-locked.*the date is not moved/) }]);
    // at most once: a rerun raises nothing new and still posts nothing
    expect(await cell.ops.runSchedules(T, "2026-12-01")).toMatchObject({ posted: [], reversed: [], exceptions: [] });
    await cell.settle();
    const s = await cell.gl.state(T, B);
    expect(s.journals.has(S.occurrenceJournalId(T, scheduleId, "2026-11", "reverse"))).toBe(false);
    expect([...s.journals.values()].some((j) => j.narration.includes("auto-reversal") && j.txnDate > "2026-12-01")).toBe(false);
    const ex = await cell.ops.schedules.exceptions(T, B);
    expect(ex).toMatchObject([{ kind: "reverse", due_on: "2026-12-01", status: "exception" }]);
    const events = await cell.store.readStream(T, `${T}/schedule/${scheduleId}`);
    expect(events.map((e) => e.type)).toEqual(["ScheduleCreated", "ScheduleExceptionRaised"]);
    const lc = await cell.ops.lifecycle(T, B);
    expect(lc.find((x) => x.op === "schedule_approve")!.state).toBe("approved");
  });

  it("FIN-GL-02 the approver's authority is re-checked on every run; revoking it stops execution", async () => {
    await cell.identity.revoke(T, OWNER, CONTROLLER);
    try {
      const r = await cell.ops.runSchedules(T, "2026-12-31");
      expect(r.posted).toEqual([]);
      expect(r.skipped).toEqual([{ scheduleId, reason: expect.stringMatching(/approval no longer valid/) }]);
    } finally { await enrol(cell, T, [CONTROLLER]); }
    const r = await cell.ops.runSchedules(T, "2026-12-31");
    expect(r.posted).toEqual([S.occurrenceJournalId(T, scheduleId, "2026-12", "post")]);
  });

  it("FIN-GL-02 schedules are created and listed through the core API and run by the ops runner (ops run-schedules)", async () => {
    const B2 = "gl02api";
    clock.value = "2026-10-01";
    await openBook(B2, [acct("ACCRUED", "liability")]);
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    const owner = postgres(ownerUrl, { max: 2, onnotice: () => undefined });
    try {
      const h = (p: string) => ({ "x-kuber-tenant": T, "x-kuber-principal": p });
      const created = await app.inject(signed({ method: "POST", url: `/v1/tenants/${T}/books/${B2}/schedules`, headers: h(PREPARER), payload: {
        name: "Rent accrual", kind: "recurring", start: "2026-10-01", end: "2026-11-30", autoReverse: true,
        lines: [{ accountId: "BIZEXP", debit: "12,000" }, { accountId: "ACCRUED", credit: "12,000" }] } }));
      expect(created.statusCode).toBe(201);
      const s = created.json() as { scheduleId: string; status: string; definition: { lines: Line[] } };
      expect(s.status).toBe("submitted");
      expect(s.definition.lines[0]!.amount).toBe("1200000");                 // stored in paise
      const bad = await app.inject(signed({ method: "POST", url: `/v1/tenants/${T}/books/${B2}/schedules`, headers: h(PREPARER), payload: { name: "x" } }));
      expect(bad.statusCode).toBe(400);
      const list = await app.inject(signed({ method: "GET", url: `/v1/tenants/${T}/books/${B2}/schedules`, headers: h(OWNER) }));
      expect((list.json() as { scheduleId: string }[]).map((x) => x.scheduleId)).toEqual([s.scheduleId]);
      await planCommit(B2, "schedule_approve", { scheduleId: s.scheduleId }, PREPARER, OWNER);
      const admin = new OpsAdmin(owner, cell);
      const [r] = await admin.runSchedules("2026-11-01", T);
      expect(r).toMatchObject({ tenant: T, asOf: "2026-11-01" });
      expect(r!.posted).toContain(S.occurrenceJournalId(T, s.scheduleId, "2026-10", "post"));
      expect(r!.reversed).toContain(S.occurrenceJournalId(T, s.scheduleId, "2026-10", "reverse"));
      const again = await admin.runSchedules("2026-11-01");
      expect(again.flatMap((x) => [...x.posted, ...x.reversed])).toEqual([]);
    } finally { await app.close(); await owner.end(); }
  });
});

// ====================================================================== FIN-GL-03
describe("FIN-GL-03: prepaid and accrual recognition schedules", () => {
  const B = "gl03";
  const TOTAL = 12_000_000n;                                              // ₹120,000
  let scheduleId = "";

  beforeAll(async () => {
    clock.value = "2026-04-01";
    await openBook(B, [acct("PREPAID", "asset"), acct("REFUNDREC", "asset")]);
    await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-04-01", narration: "Annual insurance paid in advance",
      lines: [L("PREPAID", TOTAL), L("BANK", -TOTAL)] }, { principal: OWNER });
  });

  it("FIN-GL-03 straight-line monthly recognition splits exactly to the paisa", () => {
    expect(S.straightLine(TOTAL, 12)).toEqual(Array(12).fill(1_000_000n));
    expect(S.straightLine(100_000n, 3)).toEqual([33_333n, 33_333n, 33_334n]);
    expect(S.periodsBetween("2026-04-01", "2027-03-31")).toHaveLength(12);
  });

  it("FIN-GL-03 ₹120,000 over 12 months recognizes ₹10,000 per month and reconciles to the GL by period", async () => {
    const s = await cell.ops.schedules.create(T, B, PREPARER, { name: "Insurance FY27", kind: "recognition", start: "2026-04-01", end: "2027-03-31",
      recognition: { type: "prepaid", total: TOTAL.toString(), expenseAccount: "BIZEXP", balanceAccount: "PREPAID" } });
    scheduleId = s.scheduleId;
    expect(s.occurrences).toHaveLength(12);
    expect(new Set(s.occurrences.map((o) => o.amount))).toEqual(new Set(["1000000"]));
    expect(s.balance).toEqual({ total: "12000000", recognized: "0", released: "0", remaining: "12000000" });
    await planCommit(B, "schedule_approve", { scheduleId }, PREPARER, CONTROLLER);
    clock.value = "2026-07-01";
    const r = await cell.ops.runSchedules(T, "2026-06-30");
    expect(r.posted).toHaveLength(3);
    expect(await cell.ops.runSchedules(T, "2026-06-30")).toMatchObject({ posted: [], exceptions: [] });
    await cell.settle();
    const st = await cell.gl.state(T, B);
    for (const p of ["2026-04", "2026-05", "2026-06"]) {
      const j = st.journals.get(S.occurrenceJournalId(T, scheduleId, p, "post"))!;
      expect(j.txnDate).toBe(S.periodEnd(p));
      expect(j.lines.map((l) => [l.accountId, l.amount])).toEqual([["BIZEXP", "1000000"], ["PREPAID", "-1000000"]]);
    }
    const v = await cell.ops.schedules.get(T, scheduleId);
    expect(v.balance).toEqual({ total: "12000000", recognized: "3000000", released: "0", remaining: "9000000" });
    const rec = await cell.ops.schedules.reconciliation(T, B, { to: "2026-06-30" });
    expect(rec.rows.map((x) => [x.period, x.scheduleBalance, x.glBalance, x.recognizedInGl, x.difference])).toEqual([
      ["2026-04", "11000000", "11000000", "1000000", "0"], ["2026-05", "10000000", "10000000", "1000000", "0"], ["2026-06", "9000000", "9000000", "1000000", "0"]]);
    expect(rec.reconciled).toBe(true);
    // the reconciliation is exposed as a report (ops `schedules`) and over HTTP
    const report = await cell.ops.plan(T, B, OWNER, "schedules", { to: "2026-06-30" });
    expect(report.checks.find((c) => c.label.includes("agree with the GL"))!.ok).toBe(true);
    expect(report.sections.find((x) => x.title === "Reconciliation to the GL")!.rows).toHaveLength(3);
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    try {
      const h = await app.inject(signed({ method: "GET", url: `/v1/tenants/${T}/books/${B}/schedules/reconciliation?to=2026-06-30`, headers: { "x-kuber-tenant": T, "x-kuber-principal": OWNER } }));
      expect(h.statusCode).toBe(200);
      expect(h.json()).toMatchObject({ reconciled: true });
    } finally { await app.close(); }
  });

  it("FIN-GL-03 a missed recognition shows as a reconciliation difference for its period", async () => {
    // July is due but has not run yet: the schedule says 8,000,000, the GL still holds 9,000,000
    const rec = await cell.ops.schedules.reconciliation(T, B, { to: "2026-07-31" });
    expect(rec.rows.at(-1)).toMatchObject({ period: "2026-07", scheduled: "1000000", recognizedInGl: "0", scheduleBalance: "8000000", glBalance: "9000000", difference: "1000000", reconciled: false });
  });

  it("FIN-GL-03 cancellation with approval recalculates the remaining balance", async () => {
    // cannot cancel past an occurrence that has not run
    const early = await cell.ops.plan(T, B, PREPARER, "schedule_cancel", { scheduleId, effective: "2026-07-31", releaseTo: "REFUNDREC" });
    expect(early.blocked).toBe(true);
    const { plan } = await planCommit(B, "schedule_cancel", { scheduleId, effective: "2026-06-30", releaseTo: "REFUNDREC" }, PREPARER, CONTROLLER);
    expect(plan.sections[0]!.rows).toEqual([["Total", "12000000"], ["Recognized to date", "3000000"], ["Future recognition cancelled", "9000000"],
      ["Remaining before release", "9000000"], ["Released", "9000000"], ["Remaining after cancellation", "0"]]);
    const v = await cell.ops.schedules.get(T, scheduleId);
    expect(v).toMatchObject({ status: "cancelled", cancelledOn: "2026-06-30", balance: { total: "12000000", recognized: "3000000", released: "9000000", remaining: "0" } });
    expect(v.occurrences.filter((o) => o.status === "cancelled")).toHaveLength(9);
    // nothing more is recognized
    clock.value = "2027-04-01";
    const ours = new Set(v.occurrences.map((o) => o.journalId));
    expect((await cell.ops.runSchedules(T, "2027-03-31")).posted.filter((id) => ours.has(id))).toEqual([]);
    await cell.settle();
    const st = await cell.gl.state(T, B);
    expect(balancesFromState(st).get("PREPAID")).toBe(0n);
    expect(balancesFromState(st).get("REFUNDREC")).toBe(9_000_000n);
    expect(balancesFromState(st).get("BIZEXP")).toBe(3_000_000n);
    const rec = await cell.ops.schedules.reconciliation(T, B, { to: "2026-08-31" });
    expect(rec.reconciled).toBe(true);
    expect(rec.rows.at(-1)).toMatchObject({ period: "2026-08", scheduleBalance: "0", glBalance: "0" });
  });

  it("FIN-GL-03 an accrual schedule builds up its liability straight-line", async () => {
    const B2 = "gl03acc";
    clock.value = "2026-04-01";
    await openBook(B2, [acct("ACCRUED", "liability")]);
    const s = await cell.ops.schedules.create(T, B2, PREPARER, { name: "Bonus accrual", kind: "recognition", start: "2026-04-01", end: "2026-06-30",
      recognition: { type: "accrual", total: "300000", expenseAccount: "BIZEXP", balanceAccount: "ACCRUED" } });
    await planCommit(B2, "schedule_approve", { scheduleId: s.scheduleId }, PREPARER, OWNER);
    await cell.ops.runSchedules(T, "2026-06-30");
    const rec = await cell.ops.schedules.reconciliation(T, B2, { to: "2026-06-30" });
    expect(rec.rows.map((x) => x.scheduleBalance)).toEqual(["-100000", "-200000", "-300000"]);
    expect(rec.reconciled).toBe(true);
    await expect(cell.ops.schedules.create(T, B2, PREPARER, { name: "Wrong side", kind: "recognition", start: "2026-04-01", end: "2026-06-30",
      recognition: { type: "prepaid", total: "300000", expenseAccount: "BIZEXP", balanceAccount: "ACCRUED" } })).rejects.toThrow(/draws on an asset account/);
  });
});

// ====================================================================== FIN-GL-05
describe("FIN-GL-05: suspense", () => {
  const B = "gl05";
  let j1 = "", j2 = "", item1 = "", item2 = "";

  beforeAll(async () => {
    clock.value = "2026-10-31";
    await openBook(B);
    j1 = uuid(); j2 = uuid();
    // an unexplained payment and an unexplained receipt, from a statement import
    await cell.gl.execute(T, B, { kind: "PostJournal", journalId: j1, txnDate: "2026-10-05", narration: "UPI/DR/UNKNOWN", source: { stream: `${T}/txn/unknown-1` },
      lines: [L("SUSPENSE", 50_000n), L("BANK", -50_000n)] }, { principal: "agent:kuber" });
    await cell.gl.execute(T, B, { kind: "PostJournal", journalId: j2, txnDate: "2026-10-20", narration: "NEFT/CR/UNKNOWN",
      lines: [L("BANK", 30_000n), L("SUSPENSE", -30_000n)] }, { principal: OWNER });
    await cell.settle();
  });

  it("FIN-GL-05 suspense items are item-level cases with source, owner, age and resolution", async () => {
    const items = await cell.agent.suspense.list(T, B, { asOf: "2026-10-31" });
    expect(items.map((i) => ({ j: i.journalId, amount: i.amount, source: i.source, owner: i.owner, age: i.ageDays, status: i.status, resolution: i.resolution }))).toEqual([
      { j: j1, amount: "50000", source: `${T}/txn/unknown-1`, owner: null, age: 26, status: "open", resolution: null },
      { j: j2, amount: "-30000", source: `manual:${OWNER}`, owner: OWNER, age: 11, status: "open", resolution: null },
    ]);
    [item1, item2] = items.map((i) => i.itemId) as [string, string];
    expect(await cell.agent.suspense.assign(T, item1, CONTROLLER, OWNER)).toEqual({ itemId: item1, owner: CONTROLLER });
    await expect(cell.agent.suspense.assign(T, item1, CONTROLLER, PREPARER)).rejects.toThrow(/may not draft\.decide/);
    expect((await cell.agent.suspense.get(T, item1))!.owner).toBe(CONTROLLER);
    const events = await cell.store.readStream(T, `${T}/suspense/${item1}`);
    expect(events.map((e) => e.type)).toEqual(["SuspenseItemOpened", "SuspenseItemAssigned"]);
  });

  it("FIN-GL-05 a balancing journal that clears suspense without resolving items is refused", async () => {
    const before = (await cell.gl.state(T, B)).version;
    // a person's balancing entry, whatever its size
    await expect(cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-31", narration: "Clear suspense", entry: "manual",
      lines: [L("BIZEXP", 50_000n), L("SUSPENSE", -50_000n)] }, { principal: OWNER })).rejects.toThrow(/suspense is cleared only by resolving its items/);
    // any entry that moves the balance towards zero against non-money accounts
    await expect(cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-31", narration: "Net off",
      lines: [L("BIZEXP", 20_000n), L("SUSPENSE", -20_000n)] }, { principal: OWNER })).rejects.toThrow(/without resolving its items/);
    // a back-dated reclassification of the original
    await expect(cell.gl.execute(T, B, { kind: "CorrectJournal", journalId: j1, fromAccount: "SUSPENSE", toAccount: "BIZEXP", reversalJournalId: uuid(), newJournalId: uuid() },
      { principal: OWNER })).rejects.toThrow(/holds a suspense item/);
    // over HTTP and through ops
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    try {
      const r = await app.inject(signed({ method: "POST", url: `/v1/tenants/${T}/books/${B}/journals`, headers: { "x-kuber-tenant": T, "x-kuber-principal": OWNER },
        payload: { txnDate: "2026-10-31", narration: "Clear", lines: [{ accountId: "BIZEXP", debit: "500" }, { accountId: "SUSPENSE", credit: "500" }] } }));
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ error: "suspense_unresolved" });
    } finally { await app.close(); }
    const alloc = await cell.ops.plan(T, B, OWNER, "allocate", { from: "SUSPENSE", amount: "200", to: [{ account: "BIZEXP", weight: 100 }], date: "2026-10-31" });
    await expect(cell.ops.commit(T, alloc.planId, CONTROLLER, alloc.hash)).rejects.toThrow(/suspense/);
    expect((await cell.gl.state(T, B)).version).toBe(before);
    expect((await cell.agent.suspense.list(T, B)).every((i) => i.status === "open")).toBe(true);
  });

  it("FIN-GL-05 a correction links the original, reversal and replacement", async () => {
    clock.value = "2026-11-10";
    const { plan, result } = await planCommit(B, "resolve_suspense", { itemId: item1, toAccount: "BIZEXP", note: "vendor identified" }, PREPARER, OWNER);
    const links = (plan.data as { links: { original: string; reversal: string; replacement: string } }).links;
    expect(links.original).toBe(j1);
    expect(plan.journals.map((j) => j.journalId)).toEqual([links.reversal, links.replacement]);
    expect((result as { steps: string[] }).steps).toEqual([`reversed ${j1} as ${links.reversal}, reposted as ${links.replacement}`, `resolved suspense item ${item1}`]);
    const item = (await cell.agent.suspense.get(T, item1))!;
    expect(item).toMatchObject({ status: "resolved", resolvedOn: "2026-11-10", resolvedBy: OWNER,
      resolution: { original: j1, reversal: links.reversal, replacement: links.replacement, toAccount: "BIZEXP", note: "vendor identified", planId: plan.planId } });
    const byId = new Map((await posted(B)).map((e) => [(e.data as EventData<"JournalPosted">).journalId, e.data as EventData<"JournalPosted">]));
    expect(byId.get(links.reversal)).toMatchObject({ reverses: j1, txnDate: "2026-11-10" });
    expect(byId.get(links.replacement)).toMatchObject({ replaces: j1, txnDate: "2026-11-10" });
    expect(byId.get(links.replacement)!.lines.map((l) => l.accountId)).toEqual(["BIZEXP", "BANK"]);
    expect((await cell.gl.state(T, B)).journals.get(j1)!.reversedBy).toBe(links.reversal);
    const events = await cell.store.readStream(T, `${T}/suspense/${item1}`);
    expect(events.at(-1)).toMatchObject({ type: "SuspenseItemResolved", data: { journalId: j1, reversalJournalId: links.reversal, replacementJournalId: links.replacement } });
    // a resolved item cannot be resolved again
    const again = await cell.ops.plan(T, B, PREPARER, "resolve_suspense", { itemId: item1, toAccount: "BIZEXP" });
    expect(again.blocked).toBe(true);
    // a plain reversal of the other original resolves its item as reversed, on the reversal date
    await cell.gl.execute(T, B, { kind: "ReverseJournal", journalId: j2, reversalJournalId: uuid(), reason: "duplicate receipt", onDate: "2026-11-15" }, { principal: OWNER });
    await cell.settle();
    expect(await cell.agent.suspense.get(T, item2)).toMatchObject({ status: "resolved", resolvedOn: "2026-11-15", resolution: { original: j2, replacement: null, note: "reversed" } });
  });

  it("FIN-GL-05 roll-forward: opening + additions − resolved = closing, and historic reports keep the original position", async () => {
    const oct = await cell.agent.suspense.rollForward(T, B, "2026-10-01", "2026-10-31");
    expect(oct).toMatchObject({ opening: "0", additions: "20000", resolved: "0", closing: "20000", balanced: true, counts: { additions: 2, closing: 2 } });
    const nov = await cell.agent.suspense.rollForward(T, B, "2026-11-01", "2026-11-30");
    expect(nov).toMatchObject({ opening: "20000", additions: "0", resolved: "20000", closing: "0", balanced: true, counts: { opening: 2, resolved: 2, closing: 0 } });
    // October, reported after both resolutions, still shows October's position in the items and in the GL
    const st = await cell.gl.state(T, B);
    expect(balancesFromState(st, { to: "2026-10-31" }).get("SUSPENSE")).toBe(20_000n);
    expect(balancesFromState(st).get("SUSPENSE") ?? 0n).toBe(0n);
    const tb = await cell.reporting.trialBalance(T, B, "2026-10-31");
    expect(tb.rows.find((r) => r.accountId === "SUSPENSE")!.amount).toBe(20_000n);
    const octItems = await cell.agent.suspense.list(T, B, { asOf: "2026-10-31" });
    expect(octItems.map((i) => i.ageDays)).toEqual([26, 11]);
    const report = await cell.ops.plan(T, B, OWNER, "suspense", { from: "2026-10-01", to: "2026-10-31" });
    expect(report.checks.every((c) => c.ok)).toBe(true);                   // adds up, and ties to the GL at 31 October
    expect((report.data as { rollForward: { closing: string }; glBalance: string })).toMatchObject({ rollForward: { closing: "20000" }, glBalance: "20000" });
    expect(report.sections[1]!.rows.map((r) => r[4])).toEqual(["open", "open"]);
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    try {
      const r = await app.inject(signed({ method: "GET", url: `/v1/tenants/${T}/books/${B}/suspense/roll-forward?from=2026-11-01&to=2026-11-30`, headers: { "x-kuber-tenant": T, "x-kuber-principal": OWNER } }));
      expect(r.json()).toMatchObject({ opening: "20000", resolved: "20000", closing: "0" });
    } finally { await app.close(); }
  });
});

// ====================================================================== with the party master (FIN-MDM-03)
describe("FIN-GL-01/02 with the party master", () => {
  const B = "glmdm";
  const BANK = { accountNumber: "50100099998888", ifsc: "HDFC0001234", holderName: "Vendor V" };
  beforeAll(async () => {
    clock.value = "2026-10-01";
    await openBook(B, [acct("RENT", "expense")]);
    await cell.parties.register(T, PREPARER, { partyId: "V-FIN", entityId: T, kind: "vendor", name: "Vendor V" });
  });

  it("FIN-GL-01 a control-account line naming a registered master party is a subledger posting; an unregistered party still needs a controlled adjustment", async () => {
    await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-02", narration: "Bill", lines: [L("BIZEXP", 50_000n), L("CREDITORS", -50_000n, { partyId: "V-FIN" })] }, { principal: OWNER });
    const pay = { date: "2026-10-03", narration: "Pay vendor", amount: "500", direction: "out", account: "CREDITORS", via: "BANK" };
    const registered = await cell.ops.plan(T, B, OWNER, "record", { ...pay, party: "V-FIN" });
    expect(registered.blocked).toBe(false);
    expect(registered.checks.find((c) => c.label.startsWith("Control account"))).toBeUndefined();
    const unregistered = await cell.ops.plan(T, B, OWNER, "record", { ...pay, party: "p.unknown" });
    expect(unregistered.blocked).toBe(true);
    expect(unregistered.checks.find((c) => !c.ok)!.detail).toMatch(/control account/);
    // the ledger applies the same rule to manual journals
    const manual = (party: string) => cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-10-03", narration: "x", entry: "manual",
      lines: [L("CREDITORS", 100n, { partyId: party }), L("BANK", -100n)] }, { principal: OWNER });
    await expect(manual("p.unknown")).rejects.toThrow(/controlled adjustment/);
    expect(await manual("V-FIN")).toHaveLength(1);
  });

  it("FIN-GL-02 a scheduled payment to a party on hold waits, unclaimed, until the bank change is released", async () => {
    const s = await cell.ops.schedules.create(T, B, PREPARER, { name: "Office rent", kind: "recurring", start: "2026-10-01", end: "2026-11-30", day: 5,
      lines: [L("RENT", 2_000_000n, { partyId: "V-FIN" }), L("BANK", -2_000_000n)] });
    await planCommit(B, "schedule_approve", { scheduleId: s.scheduleId }, PREPARER, CONTROLLER);
    const ch = await cell.parties.requestBankChange(T, PREPARER, "V-FIN", { bank: BANK });
    const held = await cell.ops.runSchedules(T, "2026-10-05");
    expect(held.posted).toEqual([]);
    expect(held.skipped).toEqual([{ scheduleId: s.scheduleId, reason: expect.stringMatching(/held \(POL-501\)/) }]);
    expect(held.exceptions).toEqual([]);
    await cell.parties.verifyBankChange(T, APPROVER, "V-FIN", ch.changeId, { method: "call_back", reference: "number on file" });
    await cell.parties.releaseBankChange(T, OWNER, "V-FIN", ch.changeId);
    const r = await cell.ops.runSchedules(T, "2026-10-05");
    expect(r.posted).toEqual([S.occurrenceJournalId(T, s.scheduleId, "2026-10", "post")]);
    expect((await cell.gl.state(T, B)).journals.get(r.posted[0]!)!.txnDate).toBe("2026-10-05");   // its own date, not moved
  });

  it("FIN-GL-05 the suspense roll-forward defaults to the book's fiscal year", async () => {
    const B2 = "glcal";
    await cell.gl.openBook(T, B2, T, "company", OWNER, { fiscalYearStartMonth: 1 });
    await cell.gl.execute(T, B2, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-02-10", narration: "Unknown", lines: [L("SUSPENSE", 700n), L("BANK", -700n)] }, { principal: OWNER });
    await cell.settle();
    clock.value = "2026-10-01";
    const p = await cell.ops.plan(T, B2, OWNER, "suspense", {});
    expect((p.data as { rollForward: { from: string; additions: string } }).rollForward).toMatchObject({ from: "2026-01-01", additions: "700" });
    const s = await cell.ops.schedules.reconciliation(T, B2);
    expect(s.rows).toEqual([]);
  });
});
