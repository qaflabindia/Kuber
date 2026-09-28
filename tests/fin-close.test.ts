/**
 * CFO gate G1 close requirements (modules/close). Each test is named by the requirement it proves:
 *   FIN-CLS-01  close checklist: template, not-applicable features, dependencies, evidence, owner and reviewer, overdue
 *   FIN-CLS-02  account substantiation: sources, aged reconciling items, independent approval, completeness test
 *   FIN-CLS-03  race-safe certified close: one book version, backdated posts refused or stale, snapshot, superuser, signature
 *   FIN-CLS-04  reopen withdraws certifications; hard close immutable; restatement with a comparative bridge
 *   UAT-COM     replay, concurrent submit, crash between approval and posting, revoked approver, switched book
 * A bank reconciliation is cited through the pluggable resolver: these tests replace the bank module's
 * (registered by the cell) with a stand-in that answers for the reconciliations they "certify". The real
 * resolver and withdrawer are exercised end to end in tests/g1-integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sha256, uuid, type Line } from "@kuber/contracts";
import { bookStream } from "@kuber/gl";
import { balancesFromState, type Plan } from "@kuber/ops";
import { EvidenceRegistry, type EvidenceRef } from "@kuber/close";
import { attentionCounts, buildServer, type Cell } from "@kuber/core";
import { shellState, waitingRail } from "../apps/web/src/lib/shell.ts";
import { CORE_AUTH_SECRET, SoftAuthenticator, enrol, signedInject, startCell, type SignedRequest } from "./helpers.ts";

const T = "cls";
const P = { su: "superuser:asha", su2: "superuser:meera", ctrl: "controller:ravi", pia: "staff:pia", kiran: "staff:kiran" };
const PE = "2026-09-30";
const clock = { value: "2026-10-02" };
let cell: Cell, app: FastifyInstance, stop: () => Promise<void>, send: ReturnType<typeof signedInject>;
const asha = new SoftAuthenticator();

// ---------------------------------------------------------------- stand-in bank reconciliation service (FIN-CASH)
const recs = new Map<string, { accountId: string; periodEnd: string; balancePaise: string; hash: string }>();
let failNext = 0;
let recN = 0;
async function certifyRec(book: string, accountId: string, periodEnd = PE): Promise<EvidenceRef> {
  const bal = balancesFromState(await cell.gl.state(T, book), { to: periodEnd }).get(accountId) ?? 0n;
  const id = `rec-${book}-${accountId}-${periodEnd}-${++recN}`;
  const hash = sha256(`${id}|${bal}`);
  recs.set(id, { accountId, periodEnd, balancePaise: bal.toString(), hash });
  return { kind: "bank_reconciliation", id, hash };
}

// ---------------------------------------------------------------- helpers
const L = (accountId: string, amount: bigint | number, partyId?: string): Line => ({ accountId, amount: BigInt(amount).toString(), dimensions: {}, ...(partyId ? { partyId } : {}) });
const post = (book: string, txnDate: string, lines: Line[], principal = P.su) =>
  cell.gl.execute(T, book, { kind: "PostJournal", journalId: uuid(), txnDate, narration: `entry ${txnDate}`, lines }, { principal });
const rupees = (p: bigint) => { const n = p < 0n ? -p : p; return `${p < 0n ? "-" : ""}${n / 100n}.${String(n % 100n).padStart(2, "0")}`; };
const failing = (p: Plan) => JSON.stringify(p.checks.filter((c) => !c.ok && c.blocking));
async function planOk(book: string, op: string, input: unknown, preparer: string) {
  const p = await cell.ops.plan(T, book, preparer, op, input);
  expect(p.blocked, failing(p)).toBe(false);
  return p;
}
async function planCommit(book: string, op: string, input: unknown, preparer: string, committer: string) {
  const p = await planOk(book, op, input, preparer);
  const r = await cell.ops.commit(T, p.planId, committer, p.hash);
  expect(r.status).toBe("committed");
  await cell.settle();
  return { plan: p, result: r as { steps: string[] } };
}
const failed = (p: Plan, label: RegExp) => p.checks.find((c) => label.test(c.label) && !c.ok);
const svc = () => cell.periodClose;
const doc = async (book: string, name: string) => (await svc().registerDocument(T, book, P.pia, { name, contentBase64: Buffer.from(`${book}|${name}|${uuid()}`).toString("base64"), periodEnd: PE })).ref;
const closeEvents = (book: string, periodEnd = PE) => cell.store.readStream(T, `${T}/close/${book}/${periodEnd}`);

/** Complete every open applicable task (owner prepares, a different person reviews). */
async function completeAll(book: string, periodEnd = PE) {
  const c = (await svc().checklist(T, book, periodEnd))!;
  const st = await cell.gl.state(T, book);
  const banks = [...st.accounts.values()].filter((a) => a.isCashLike && a.accountId !== "CASH").map((a) => a.accountId);
  for (const t of c.tasks.filter((x) => x.status === "open")) {
    const evidence: EvidenceRef[] = t.evidenceKinds[0] === "bank_reconciliation" ? await Promise.all(banks.map((b) => certifyRec(book, b, periodEnd)))
      : t.evidenceKinds[0] === "suspense_roll_forward" ? [(await svc().suspenseEvidence(T, book, c.periodStart, periodEnd)).ref]
      : [await doc(book, `${t.taskId} support`)];
    await planCommit(book, "complete_close_task", { periodEnd, taskId: t.taskId, evidence }, t.owner!, t.owner === P.ctrl ? P.su : P.ctrl);
  }
}
/** Substantiate every required account that is not (currently) substantiated. */
async function substantiateAll(book: string, periodEnd = PE) {
  const st = await svc().status(T, book, periodEnd);
  const state = await cell.gl.state(T, book);
  for (const a of st.substantiations.filter((x) => x.status === "missing")) {
    const acc = state.accounts.get(a.accountId)!;
    const input: Record<string, unknown> = { periodEnd, accountId: a.accountId };
    if (acc.isCashLike && acc.accountId !== "CASH") input.evidence = [await certifyRec(book, a.accountId, periodEnd)];
    else if (!acc.isControl && acc.accountId !== "SUSPENSE") {
      const nat = ["asset", "expense"].includes(acc.nature) ? BigInt(a.glBalance) : -BigInt(a.glBalance);
      input.sourceBalance = rupees(nat); input.evidence = [await doc(book, `${a.accountId} support`)]; input.note = "agreed to the supporting document";
    }
    await planCommit(book, "approve_substantiation", input, P.pia, P.ctrl);
  }
}
/** An individual book with September activity, ready to certify. */
async function certifiable(book: string) {
  await cell.gl.openBook(T, book, T, "individual", P.su);
  await post(book, "2026-09-05", [L("BANK", 5_000_000), L("OPENING", -5_000_000)]);
  await post(book, "2026-09-18", [L("LIVING", 250_000), L("BANK", -250_000)]);
  await cell.settle();
  await svc().createChecklist(T, book, P.ctrl, { periodEnd: PE, defaultOwner: P.pia });
  await completeAll(book);
  await substantiateAll(book);
}
const as = (principal: string, method: SignedRequest["method"], url: string, payload?: unknown) => send({ method, url: `/v1/tenants/${T}${url}`, tenant: T, principal, payload });

beforeAll(async () => {
  ({ cell, stop } = await startCell(clock));
  app = buildServer(cell, { clock: () => clock.value, auth: { secret: CORE_AUTH_SECRET } });
  send = signedInject(app);
  // The first superuser claims the empty workspace with a passkey (she signs certified closes on HTTP).
  const o = (await send({ method: "POST", url: `/v1/tenants/${T}/identity/registration/options`, tenant: T, principal: null, payload: { displayName: "Asha" } })).json();
  const reg = await send({ method: "POST", url: `/v1/tenants/${T}/identity/registration/verify`, tenant: T, principal: null, payload: { displayName: "Asha", response: asha.create(o) } });
  expect(reg.json().principal).toBe(P.su);
  await enrol(cell, T, [P.su2, P.ctrl, P.pia, P.kiran]);
  svc().evidence.registerResolver("bank_reconciliation", async (ref) => {
    if (failNext > 0) { failNext--; throw new Error("bank reconciliation service unreachable"); }
    const r = recs.get(ref.id);
    if (!r) return { ok: false, reason: "no such certified bank reconciliation" };
    if (r.hash !== ref.hash) return { ok: false, reason: "not the certified content" };
    return { ok: true, accountId: r.accountId, periodEnd: r.periodEnd, balancePaise: r.balancePaise };
  });
  // The main company book: capital, an expense, a receivable raised and collected in September.
  await cell.gl.openBook(T, "main", T, "company", P.su);
  await post("main", "2026-09-01", [L("BANK", 10_000_000), L("CAPITAL", -10_000_000)]);
  await post("main", "2026-09-10", [L("BIZEXP", 500_000), L("BANK", -500_000)]);
  await post("main", "2026-09-12", [L("DEBTORS", 2_000_000, "cust-1"), L("FEES", -2_000_000)]);
  await post("main", "2026-09-20", [L("BANK", 2_000_000), L("DEBTORS", -2_000_000, "cust-1")]);
  await cell.settle();
});
afterAll(async () => { await app?.close(); await stop?.(); });

// ====================================================================== FIN-CLS-01
describe("FIN-CLS-01 close checklist", () => {
  it("FIN-CLS-01 the checklist is seeded from the template; features not enabled are not applicable with the reason; only a superuser or controller creates it", async () => {
    await expect(svc().createChecklist(T, "main", P.pia, { periodEnd: PE, defaultOwner: P.pia })).rejects.toThrow(/may not plan\.approve\.period/);
    await expect(svc().createChecklist(T, "main", P.ctrl, { periodEnd: "2026-08-31", defaultOwner: "staff:ghost" })).rejects.toThrow(/not a member/);
    const c = await svc().createChecklist(T, "main", P.ctrl, { periodEnd: PE, defaultOwner: P.pia, owners: { tax: P.ctrl } });
    expect(c.tasks.filter((t) => t.applicable).map((t) => t.taskId)).toEqual(["bank", "ar", "ap", "tax", "suspense"]);
    for (const t of c.tasks.filter((x) => !x.applicable)) {
      expect(t.status).toBe("not_applicable");
      expect(t.owner).toBeNull();
      expect(t.reason).toMatch(/^not applicable — feature not enabled: /);
    }
    const byId = new Map(c.tasks.map((t) => [t.taskId, t]));
    expect(byId.get("grni")!.reason).toMatch(/GRNI/);
    expect(byId.get("fx")!.reason).toMatch(/INR only/);
    expect(byId.get("intercompany")!.reason).toMatch(/consolidation group/);
    expect(byId.get("bank")).toMatchObject({ owner: P.pia, deadline: "2026-10-03", dependsOn: [], evidenceKinds: ["bank_reconciliation"], status: "open" });
    expect(byId.get("tax")).toMatchObject({ owner: P.ctrl, dependsOn: ["ap", "ar", "payroll"] });
    await expect(svc().createChecklist(T, "main", P.ctrl, { periodEnd: PE, defaultOwner: P.pia })).rejects.toThrow(/already exists/);
    expect((await closeEvents("main")).map((e) => e.type)).toContain("CloseChecklistCreated");
  });

  it("FIN-CLS-01 a task cannot complete before its dependencies, without its evidence, or with evidence that does not resolve; unsupported modules cannot be represented as reconciled", async () => {
    const plan = (taskId: string, evidence: EvidenceRef[], who = P.pia) => cell.ops.plan(T, "main", who, "complete_close_task", { periodEnd: PE, taskId, evidence });
    const ar = await plan("ar", [await doc("main", "aged receivables")]);
    expect(ar.blocked).toBe(true);
    expect(failed(ar, /Dependencies complete/)?.detail).toMatch(/waiting for bank/);
    expect(ar.status).toBe("preview");                                  // a blocked plan is never stored
    expect(failed(await plan("bank", []), /Evidence of the required kind/)).toBeTruthy();
    expect(failed(await plan("bank", [await doc("main", "a screenshot")]), /Evidence of the required kind/)?.detail).toMatch(/accepts bank_reconciliation/);
    const rec = await certifyRec("main", "BANK");
    expect(failed(await plan("bank", [{ ...rec, hash: "0".repeat(64) }]), /evidence resolves/)?.detail).toMatch(/not the certified content/);
    expect(failed(await plan("grni", [await doc("main", "grni")]), /applies to this book/)?.detail).toMatch(/feature not enabled/);
    // Without a bank reconciliation service (before FIN-CASH is merged), a bank reconciliation cannot be cited at all.
    expect(await new EvidenceRegistry().resolve(rec, { tenant: T, book: "main", periodEnd: PE, periodStart: "2026-09-01" }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/no bank reconciliation service is installed/) });
  });

  it("FIN-CLS-01 completion is by the task's owner and review by a different person", async () => {
    const evidence = [await certifyRec("main", "BANK"), await certifyRec("main", "CARD")];
    const notOwner = await cell.ops.plan(T, "main", P.kiran, "complete_close_task", { periodEnd: PE, taskId: "bank", evidence });
    expect(failed(notOwner, /Completed by the task's owner/)?.detail).toMatch(/owner is staff:pia/);
    const p = await planOk("main", "complete_close_task", { periodEnd: PE, taskId: "bank", evidence }, P.pia);
    expect((await svc().checklistView(T, "main", PE))!.tasks.find((t) => t.taskId === "bank")!.state).toBe("awaiting_review");
    await expect(cell.ops.commit(T, p.planId, P.pia, p.hash)).rejects.toThrow(/may not plan\.approve/);
    expect((await cell.ops.commit(T, p.planId, P.ctrl, p.hash)).status).toBe("committed");
    const bank = (await svc().checklist(T, "main", PE))!.tasks.find((t) => t.taskId === "bank")!;
    expect(bank).toMatchObject({ status: "done", completedBy: P.pia, reviewedBy: P.ctrl, evidence });
    for (const taskId of ["ar", "ap"]) await planCommit("main", "complete_close_task", { periodEnd: PE, taskId, evidence: [await doc("main", `${taskId} ageing`)] }, P.pia, P.ctrl);
    // The controller owns tax: he cannot review his own work.
    const tax = await planOk("main", "complete_close_task", { periodEnd: PE, taskId: "tax", evidence: [await doc("main", "GST return")] }, P.ctrl);
    await expect(cell.ops.commit(T, tax.planId, P.ctrl, tax.hash)).rejects.toThrow(/review is by a different person/);
    expect((await cell.ops.get(T, tax.planId)).status).toBe("proposed");            // nothing applied; still open
    expect((await cell.ops.commit(T, tax.planId, P.su, tax.hash)).status).toBe("committed");
    const done = (await closeEvents("main")).filter((e) => e.type === "CloseTaskCompleted").map((e) => e.data as { taskId: string; completedBy: string; reviewedBy: string });
    expect(done.find((d) => d.taskId === "tax")).toMatchObject({ completedBy: P.ctrl, reviewedBy: P.su });
  });

  it("FIN-CLS-01 overdue tasks surface in attention", async () => {
    clock.value = "2026-10-10";
    expect((await svc().overdue(T, "main")).map((o) => o.taskId)).toEqual(["suspense"]);
    expect((await attentionCounts(cell, T, "main", true)).closeTasksOverdue).toBe(1);
    const r = await as(P.ctrl, "GET", "/books/main/attention");
    expect(r.json()).toMatchObject({ closeTasksOverdue: 1 });
    // The web rail shows it and links to the close page.
    const rail = waitingRail(shellState({ attention: r.json(), journals: [], verify: { intact: true }, me: null }, "controller"));
    expect(rail.state === "items" && rail.items.find((i) => i.href === "/close")).toMatchObject({ count: 1, tone: "clay" });
    const c = (await svc().checklist(T, "main", PE))!;
    expect(c.tasks.find((t) => t.taskId === "suspense")!.overdue).toBe(true);
    const p = await planOk("main", "complete_close_task", { periodEnd: PE, taskId: "suspense", evidence: [(await svc().suspenseEvidence(T, "main", c.periodStart, PE)).ref] }, P.pia);
    expect(p.checks.find((x) => x.label === "On time")).toMatchObject({ ok: false, blocking: false, detail: "overdue since 2026-10-05" });
    expect((await cell.ops.commit(T, p.planId, P.ctrl, p.hash)).status).toBe("committed");
    expect((await attentionCounts(cell, T, "main", true)).closeTasksOverdue).toBe(0);
  });
});

// ====================================================================== FIN-CLS-02
describe("FIN-CLS-02 account substantiation", () => {
  it("FIN-CLS-02 required accounts include a zero balance with activity and every bank account; the completeness test flags missing statements and plans dated in the period", async () => {
    const st = await svc().status(T, "main", PE);
    expect(st.substantiations.map((a) => [a.accountId, a.glBalance, a.status])).toEqual([
      ["BANK", "11500000", "missing"], ["CAPITAL", "-10000000", "missing"], ["CARD", "0", "missing"], ["DEBTORS", "0", "missing"]]);
    expect(st.findings.filter((f) => f.code === "no_statement").map((f) => f.label)).toEqual(["No statement for BANK for the period", "No statement for CARD for the period"]);
    const pending = await cell.ops.plan(T, "main", P.pia, "record", { date: "2026-09-25", narration: "Late supplier bill", amount: "300", direction: "out", account: "BIZEXP", via: "BANK" });
    expect(pending.status).toBe("proposed");
    expect((await svc().status(T, "main", PE)).findings.map((f) => f.code)).toContain("pending_plans");
    const cert = await cell.ops.plan(T, "main", P.ctrl, "certify_close", { periodEnd: PE });
    expect(cert.blocked).toBe(true);
    expect(failed(cert, /Every required account substantiated/)?.detail).toMatch(/BANK \(missing\).*DEBTORS \(missing\)/);
    expect(failed(cert, /Completeness: .*open plan/)).toBeTruthy();
    await cell.ops.discard(T, pending.planId, P.pia, { codes: ["not_needed"] });
    expect((await svc().status(T, "main", PE)).findings.map((f) => f.code)).not.toContain("pending_plans");
  });

  it("FIN-CLS-02 GL against the source with aged reconciling items must be exactly zero, and approval is independent of the preparer", async () => {
    const base = { periodEnd: PE, accountId: "CAPITAL" };
    const noDoc = await cell.ops.plan(T, "main", P.pia, "approve_substantiation", { ...base, sourceBalance: "100000" });
    expect(noDoc.checks.some((c) => !c.ok && /supporting document/.test(c.detail ?? ""))).toBe(true);
    const evidence = [await doc("main", "share register")];
    const off = await cell.ops.plan(T, "main", P.pia, "approve_substantiation", { ...base, sourceBalance: "99000", evidence });
    expect(off.checks.some((c) => !c.ok && /must be exactly zero/.test(c.detail ?? ""))).toBe(true);
    const item = { description: "Share application money pending allotment", amount: "1000", openedOn: "2026-09-15", owner: P.pia };
    const p = await planOk("main", "approve_substantiation", { ...base, sourceBalance: "99000", items: [item], evidence }, P.pia);
    const sub = (p.data as { substantiation: { items: { ageDays: number }[]; source: string; difference: string } }).substantiation;
    expect(sub).toMatchObject({ source: "manual", difference: "0" });
    expect(sub.items[0]!.ageDays).toBe(15);
    await expect(cell.ops.commit(T, p.planId, P.pia, p.hash)).rejects.toThrow(/may not plan\.approve/);
    expect((await cell.ops.commit(T, p.planId, P.ctrl, p.hash)).status).toBe("committed");
    // The bank account against its certified reconciliation; prepared by the controller, so he may not approve it.
    const bank = await planOk("main", "approve_substantiation", { periodEnd: PE, accountId: "BANK", evidence: [await certifyRec("main", "BANK")] }, P.ctrl);
    await expect(cell.ops.commit(T, bank.planId, P.ctrl, bank.hash)).rejects.toThrow(/approval is independent/);
    expect((await cell.ops.commit(T, bank.planId, P.su, bank.hash)).status).toBe("committed");
    // A zero balance with activity: the party subledger, still substantiated and approved.
    const debtors = await planOk("main", "approve_substantiation", { periodEnd: PE, accountId: "DEBTORS" }, P.pia);
    expect((debtors.data as { substantiation: { source: string; glBalance: string; activity: boolean } }).substantiation).toMatchObject({ source: "party_subledger", glBalance: "0", activity: true });
    expect((await cell.ops.commit(T, debtors.planId, P.ctrl, debtors.hash)).status).toBe("committed");
    await substantiateAll("main");                                         // CARD against its (zero) reconciliation
    const st = await svc().status(T, "main", PE);
    expect(st.substantiations.every((a) => a.status === "approved")).toBe(true);
    expect(st.findings).toEqual([]);
    expect(st.substantiations.find((a) => a.accountId === "CAPITAL")).toMatchObject({ preparedBy: P.pia, approvedBy: P.ctrl, items: [expect.objectContaining({ ageDays: 15, owner: P.pia })] });
    const again = await cell.ops.plan(T, "main", P.pia, "approve_substantiation", { periodEnd: PE, accountId: "DEBTORS" });
    expect(failed(again, /Not already substantiated/)).toBeTruthy();
  });
});

// ====================================================================== FIN-CLS-03
describe("FIN-CLS-03 race-safe certified close", () => {
  let closeId: string;

  it("FIN-CLS-03 certification needs every task and substantiation, a superuser approves it, and the certified close snapshot persists the trial balance, journal population, report snapshots and versions", async () => {
    const p = await planOk("main", "certify_close", { periodEnd: PE }, P.ctrl);
    expect(p).toMatchObject({ gate: "human", fence: { periodEnd: PE } });
    await expect(cell.ops.commit(T, p.planId, P.ctrl, p.hash)).rejects.toThrow(/approved by a superuser only/);
    const r = await cell.ops.commit(T, p.planId, P.su, p.hash);
    expect(r.status).toBe("committed");
    expect((r as { steps: string[] }).steps.join(" | ")).toMatch(/certified the close of 2026-09-30.*closed 2026-09-30.*locked soft to 2026-09-30/);
    await cell.settle();
    closeId = (p.data as { closeId: string }).closeId;
    const c = (await svc().getClose(T, closeId))!;
    expect(c).toMatchObject({ status: "certified", version: 1, certifiedBy: P.su, verified: true });
    expect(c.body.population.count).toBe(4);
    expect(c.body.trialBalance.debits).toBe(c.body.trialBalance.credits);
    expect(c.body.trialBalance.rows.map((x) => [x.accountId, x.balance])).toEqual([["BANK", "11500000"], ["BIZEXP", "500000"], ["CAPITAL", "-10000000"], ["FEES", "-2000000"]]);
    expect(c.body.mappingVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(c.body.rulesVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(c.body.reportSnapshots.map((s) => s.kind)).toEqual(["trial-balance", "balance-sheet", "profit-and-loss"]);
    expect(new Set(c.body.reportSnapshots.map((s) => s.seq))).toEqual(new Set([c.body.closeSeq]));  // every report from one ledger position
    expect(c.body.tasks.filter((t) => t.status === "done").map((t) => t.taskId)).toEqual(["bank", "ar", "ap", "tax", "suspense"]);
    expect(c.body.substantiations.map((s) => s.accountId)).toEqual(["BANK", "CAPITAL", "CARD", "DEBTORS"]);
    const listed = (await cell.reporting.listSnapshots(T, "main")).map((s) => s.snapshot_id);
    for (const s of c.body.reportSnapshots) expect(listed).toContain(s.snapshotId);
    expect(await svc().reproduce(T, closeId)).toMatchObject({ matches: true, populationMatches: true, trialBalanceMatches: true });
    const approved = (await cell.store.readStream(T, `${T}/plan/${p.planId}`)).find((e) => e.type === "PlanApproved")!;
    expect(approved.data).toMatchObject({ op: "certify_close", checker: P.su, preparedBy: P.ctrl });
    expect((await closeEvents("main")).some((e) => e.type === "PeriodCloseCertified")).toBe(true);
    expect((await cell.gl.state(T, "main")).closes).toEqual([{ periodEnd: PE, closeId }]);
  });

  it("FIN-CLS-03 once certified, a backdated post is refused for everyone; a post after the period end is accepted", async () => {
    await expect(post("main", "2026-09-29", [L("BIZEXP", 100), L("BANK", -100)], P.su)).rejects.toThrow(/period_closed|closed and certified/);
    await expect(post("main", "2026-09-29", [L("BIZEXP", 100), L("BANK", -100)], P.ctrl)).rejects.toThrow(/closed and certified/);
    await post("main", "2026-10-01", [L("BIZEXP", 100), L("BANK", -100)]);
    await cell.settle();
    expect(await svc().reproduce(T, closeId)).toMatchObject({ matches: true });   // a later journal does not change the certified close
  });

  it("FIN-CLS-03 concurrent close and backdated post: exactly one valid order results", async () => {
    await certifiable("race");
    const p = await planOk("race", "certify_close", { periodEnd: PE }, P.ctrl);
    const [c, q] = await Promise.allSettled([cell.ops.commit(T, p.planId, P.su, p.hash), post("race", "2026-09-15", [L("LIVING", 1_000), L("BANK", -1_000)])]);
    expect([c.status, q.status].filter((s) => s === "fulfilled")).toHaveLength(1);
    const st = await cell.gl.state(T, "race");
    if (c.status === "fulfilled") {
      // close first: the post was refused and the certified population is the one simulated
      expect(String((q as PromiseRejectedResult).reason)).toMatch(/closed and certified/);
      expect(st.closes?.[0]?.periodEnd).toBe(PE);
      expect([...st.journals.values()].filter((j) => j.txnDate === "2026-09-15")).toHaveLength(0);
    } else {
      // post first: the close plan went stale and nothing was certified
      expect(String(c.reason)).toMatch(/changed since this was simulated/);
      expect((await cell.ops.get(T, p.planId)).status).toBe("stale");
      expect(st.closes ?? []).toEqual([]);
      expect((await svc().closes(T, "race"))).toEqual([]);
    }
  });

  it("FIN-CLS-03 a backdated post after the close basis makes the close plan stale; a post after the period end does not (period crossing)", async () => {
    await certifiable("cross");
    const p = await planOk("cross", "certify_close", { periodEnd: PE }, P.ctrl);
    await post("cross", "2026-10-01", [L("LIVING", 1_000), L("BANK", -1_000)]);                    // after the period: no effect on the plan
    await cell.settle();
    expect((await cell.ops.commit(T, p.planId, P.su, p.hash)).status).toBe("committed");
    await cell.settle();

    await certifiable("stale");
    const s = await planOk("stale", "certify_close", { periodEnd: PE }, P.ctrl);
    await post("stale", "2026-09-30", [L("LIVING", 1_000), L("BANK", -1_000)]);                    // in the period, after the basis
    await expect(cell.ops.commit(T, s.planId, P.su, s.hash)).rejects.toThrow(/changed since this was simulated/);
    expect((await cell.ops.get(T, s.planId)).status).toBe("stale");
    await cell.settle();
    // The substantiation of BANK no longer matches the ledger: a new plan shows it.
    const again = await cell.ops.plan(T, "stale", P.ctrl, "certify_close", { periodEnd: PE });
    expect(failed(again, /Every required account substantiated/)?.detail).toMatch(/BANK \(stale\)/);
  });

  it("FIN-CLS-03 on HTTP the certified close is a signed command: the superuser's passkey signs the exact plan", async () => {
    await certifiable("http");
    const planned = await as(P.ctrl, "POST", `/books/http/close/${PE}/certify`);
    expect(planned.statusCode, planned.body).toBe(200);
    const p = planned.json() as Plan;
    expect(p).toMatchObject({ op: "certify_close", status: "proposed", blocked: false });
    const unsigned = await as(P.su, "POST", `/plans/${p.planId}/commit`, { hash: p.hash });
    expect(unsigned.statusCode).toBe(403);
    expect(unsigned.json()).toMatchObject({ error: "step_up_required", signing: { action: "plan.commit" } });
    expect((await as(P.ctrl, "POST", "/signing/options", { action: "plan.commit", planId: p.planId, hash: p.hash })).statusCode).toBe(403);   // a controller may not
    const o = (await as(P.su, "POST", "/signing/options", { action: "plan.commit", planId: p.planId, hash: p.hash })).json();
    expect(o.required).toBe(true);
    expect(o.summary.lines.join("\n")).toMatch(/Certify the close of everything up to 2026-09-30/);
    const ok = await as(P.su, "POST", `/plans/${p.planId}/commit`, { hash: p.hash, assertion: asha.get(o.options) });
    expect(ok.statusCode, ok.body).toBe(200);
    const approved = (await cell.store.readStream(T, `${T}/plan/${p.planId}`)).find((e) => e.type === "PlanApproved")!;
    expect(approved.data).toMatchObject({ signature: { kind: "webauthn", inputs: { action: "plan.commit", subject: p.planId, principal: P.su } } });
    await cell.settle();
    const status = (await as(P.kiran, "GET", `/books/http/close/${PE}`)).json();
    expect(status.certified).toMatchObject({ version: 1, certifiedBy: P.su });
    const got = await as(P.kiran, "GET", `/books/http/close/closes/${status.certified.closeId}/reproduce`);
    expect(got.json()).toMatchObject({ matches: true });
  });

  it("FIN-CLS-03 in a book that keeps a checklist, the hard close waits for a certified close", async () => {
    const blocked = await cell.ops.plan(T, "stale", P.ctrl, "close", { periodEnd: PE });
    expect(failed(blocked, /certified close of the period exists/)).toBeTruthy();
    const { result } = await planCommit("main", "close", { periodEnd: PE }, P.ctrl, P.su);
    expect(result.steps.join()).toMatch(/locked hard to 2026-09-30/);
  });
});

// ====================================================================== FIN-CLS-04
describe("FIN-CLS-04 reopen and restatement", () => {
  it("FIN-CLS-04 reopening a soft close is a superuser-approved plan with a reason that visibly withdraws the close, the substantiations and the bank reconciliations", async () => {
    const old = (await svc().closes(T, "cross")).find((c) => c.status === "certified")!;
    const p = await planOk("cross", "reopen_period", { periodEnd: PE, reason: "Supplier credit note received after close" }, P.ctrl);
    await expect(cell.ops.commit(T, p.planId, P.ctrl, p.hash)).rejects.toThrow(/approved by a superuser only/);
    const r = await cell.ops.commit(T, p.planId, P.su, p.hash);
    expect((r as { steps: string[] }).steps.join()).toMatch(/reopened 2026-09-30.*withdrew close/);
    await cell.settle();
    const was = (await svc().getClose(T, old.closeId))!;
    expect(was).toMatchObject({ status: "withdrawn", withdrawnBy: P.su, withdrawnReason: "Supplier credit note received after close", verified: true });  // still retrievable
    expect((await svc().substantiations(T, "cross", PE, { all: true })).every((s) => s.status === "withdrawn")).toBe(true);
    const bank = (await svc().checklist(T, "cross", PE))!.tasks.find((t) => t.taskId === "bank")!;
    expect(bank.status).toBe("open");
    expect(bank.withdrawnReason).toMatch(/bank reconciliation withdrawn/);
    const kinds = (await closeEvents("cross")).filter((e) => e.type === "CloseCertificationWithdrawn").map((e) => (e.data as { kind: string }).kind);
    expect(new Set(kinds)).toEqual(new Set(["close", "substantiation", "task", "bank_reconciliation"]));
    // The period is soft-locked again, not closed: a controller posts the adjustment, staff may not.
    await expect(post("cross", "2026-09-28", [L("LIVING", -500), L("BANK", 500)], P.pia)).rejects.toThrow(/soft-locked/);
    await post("cross", "2026-09-28", [L("LIVING", -500), L("BANK", 500)], P.ctrl);
    await cell.settle();
    await completeAll("cross");
    await substantiateAll("cross");
    const again = await planCommit("cross", "certify_close", { periodEnd: PE }, P.ctrl, P.su);
    const v2 = (await svc().getClose(T, (again.plan.data as { closeId: string }).closeId))!;
    expect(v2).toMatchObject({ version: 2, status: "certified" });
    expect(v2.body.supersedes).toBe(old.closeId);
    expect(v2.body.population.count).toBe(3);
  });

  it("FIN-CLS-04 hard-closed journals stay immutable; a restatement posts a controlled adjustment in an open period with a comparative bridge, and the original certified close stays retrievable", async () => {
    const reopen = await cell.ops.plan(T, "main", P.ctrl, "reopen_period", { periodEnd: PE, reason: "Try to reopen a hard close" });
    expect(failed(reopen, /Not hard-closed/)?.detail).toMatch(/immutable/);
    const closeId = (await cell.gl.state(T, "main")).closes![0]!.closeId;
    await expect(cell.gl.execute(T, "main", { kind: "ReopenPeriod", periodEnd: PE, closeId, reason: "direct" }, { principal: P.su })).rejects.toThrow(/hard-locked/);
    const before = (await svc().getClose(T, closeId))!;
    // A current-period P&L line in the open-period adjustment is refused.
    const wrong = await cell.ops.plan(T, "main", P.ctrl, "restate", { comparativePeriodEnd: PE, postingDate: "2026-10-05", framework: "Ind AS 8", reason: "Unrecorded September GST on expenses",
      lines: [{ accountId: "BIZEXP", debit: "1000" }, { accountId: "GSTOUT", credit: "1000" }], comparativeLines: [{ accountId: "BIZEXP", debit: "1000" }, { accountId: "GSTOUT", credit: "1000" }] });
    expect(failed(wrong, /touches no current income or expense/)).toBeTruthy();
    const input = { comparativePeriodEnd: PE, postingDate: "2026-10-05", framework: "Ind AS 8", reason: "Unrecorded September GST on expenses",
      lines: [{ accountId: "OPENING", debit: "1000" }, { accountId: "GSTOUT", credit: "1000" }], comparativeLines: [{ accountId: "BIZEXP", debit: "1000" }, { accountId: "GSTOUT", credit: "1000" }] };
    const p = await planOk("main", "restate", input, P.ctrl);
    await expect(cell.ops.commit(T, p.planId, P.ctrl, p.hash)).rejects.toThrow(/approved by a superuser only/);
    expect((await cell.ops.commit(T, p.planId, P.su, p.hash)).status).toBe("committed");
    await cell.settle();
    const [r] = await svc().restatements(T, "main");
    const body = (await svc().getRestatement(T, r!.restatementId))!;
    expect(body).toMatchObject({ comparativePeriodEnd: PE, version: 1, framework: "Ind AS 8", verified: true, supersedes: { closeId, version: 1, contentHash: before.contentHash } });
    expect(body.changed.map((x) => [x.accountId, x.original, x.adjustment, x.restated])).toEqual([["BIZEXP", "500000", "100000", "600000"], ["GSTOUT", "0", "-100000", "-100000"]]);
    expect(body.supersedes.reportSnapshots).toEqual(before.body.reportSnapshots);
    const after = (await svc().getClose(T, closeId))!;
    expect(after).toMatchObject({ status: "certified", contentHash: before.contentHash, verified: true });     // the issued close is unchanged
    const j = (await cell.gl.state(T, "main")).journals.get(body.journalId)!;
    expect(j).toMatchObject({ txnDate: "2026-10-05", voucherType: "restatement" });
    expect(await svc().reproduce(T, closeId)).toMatchObject({ matches: true });
  });
});

// ====================================================================== UAT-COM
describe("UAT-COM close and reopen", () => {
  beforeAll(async () => {
    await cell.gl.openBook(T, "uat", T, "individual", P.su);
    await post("uat", "2026-09-05", [L("BANK", 3_000_000), L("OPENING", -3_000_000)]);
    await cell.settle();
    await svc().createChecklist(T, "uat", P.ctrl, { periodEnd: PE, defaultOwner: P.pia });
  });

  it("UAT-COM replay and concurrent submit of a task completion apply it exactly once", async () => {
    const evidence = [await certifyRec("uat", "BANK"), await certifyRec("uat", "CARD")];
    const p = await planOk("uat", "complete_close_task", { periodEnd: PE, taskId: "bank", evidence }, P.pia);
    const both = await Promise.all([cell.ops.commit(T, p.planId, P.ctrl, p.hash), cell.ops.commit(T, p.planId, P.ctrl, p.hash)]);
    expect(both.map((r) => r.status)).toEqual(["committed", "committed"]);
    expect(both.filter((r) => (r as { replayed?: boolean }).replayed)).toHaveLength(1);
    expect(await cell.ops.commit(T, p.planId, P.ctrl, p.hash)).toMatchObject({ status: "committed", replayed: true });
    expect((await closeEvents("uat")).filter((e) => e.type === "CloseTaskCompleted")).toHaveLength(1);
    const again = await cell.ops.plan(T, "uat", P.pia, "complete_close_task", { periodEnd: PE, taskId: "bank", evidence });
    expect(failed(again, /The task is open/)).toBeTruthy();
  });

  it("UAT-COM evidence from another book is refused (switched book)", async () => {
    const other = (await svc().registerDocument(T, "race", P.pia, { name: "race book statement", sha256: "a".repeat(64) })).ref;
    const c = (await svc().checklist(T, "uat", PE))!;
    const p = await cell.ops.plan(T, "uat", P.pia, "complete_close_task", { periodEnd: PE, taskId: "suspense", evidence: [other] });
    expect(failed(p, /Evidence of the required kind/)).toBeTruthy();
    const sub = await cell.ops.plan(T, "uat", P.pia, "approve_substantiation", { periodEnd: PE, accountId: "OPENING", sourceBalance: "30000", evidence: [other] });
    expect(sub.checks.some((x) => !x.ok && /registered for book race, not uat/.test(x.detail ?? ""))).toBe(true);
    await planCommit("uat", "complete_close_task", { periodEnd: PE, taskId: "suspense", evidence: [(await svc().suspenseEvidence(T, "uat", c.periodStart, PE)).ref] }, P.pia, P.ctrl);
    await substantiateAll("uat");
  });

  it("UAT-COM a revoked approver's approval does not carry the close; a crash between approval and posting leaves nothing applied, and the retry certifies once", async () => {
    const p = await planOk("uat", "certify_close", { periodEnd: PE }, P.ctrl);
    await cell.ops.approve(T, p.planId, P.su2, p.hash);                           // Meera approves now, to execute later
    await cell.identity.addMember(T, "operator:test", { principal: P.su2, books: ["main"] });   // her scope no longer covers the book
    expect((await cell.ops.approvals(T, p.planId))[0]).toMatchObject({ approver: P.su2, status: "invalidated" });
    await expect(cell.ops.commit(T, p.planId, P.ctrl, p.hash)).rejects.toThrow(/approved by a superuser only/);
    expect((await cell.ops.get(T, p.planId)).status).toBe("proposed");

    failNext = 1;                                                                 // the bank reconciliation service fails mid-commit
    await expect(cell.ops.commit(T, p.planId, P.su, p.hash)).rejects.toThrow(/unreachable.*nothing was applied/);
    expect((await cell.ops.get(T, p.planId)).status).toBe("proposed");
    expect(await svc().closes(T, "uat")).toEqual([]);
    expect((await cell.gl.state(T, "uat")).closes ?? []).toEqual([]);
    expect((await cell.store.readStream(T, `${T}/plan/${p.planId}`)).filter((e) => e.type === "PlanApproved")).toHaveLength(0);
    expect((await cell.ops.commit(T, p.planId, P.su, p.hash)).status).toBe("committed");
    expect((await cell.ops.commit(T, p.planId, P.su, p.hash)) as { replayed?: boolean }).toMatchObject({ replayed: true });
    expect(await svc().closes(T, "uat")).toHaveLength(1);
    expect((await cell.store.readStream(T, `${T}/plan/${p.planId}`)).filter((e) => e.type === "PlanApproved")).toHaveLength(1);
    expect((await cell.store.readStream(T, bookStream(T, "uat"))).filter((e) => e.type === "PeriodClosed")).toHaveLength(1);
  });

  it("UAT-COM reopen replays once and a stale reopen plan is refused", async () => {
    const p = await planOk("uat", "reopen_period", { periodEnd: PE, reason: "Bank reconciliation reissued by the bank" }, P.ctrl);
    const q = await planOk("uat", "reopen_period", { periodEnd: PE, reason: "A second reopen prepared in parallel" }, P.ctrl);
    expect((await cell.ops.commit(T, p.planId, P.su, p.hash)).status).toBe("committed");
    expect(await cell.ops.commit(T, p.planId, P.su, p.hash)).toMatchObject({ replayed: true });
    await expect(cell.ops.commit(T, q.planId, P.su, q.hash)).rejects.toThrow(/changed since this was simulated/);
    expect((await closeEvents("uat")).filter((e) => e.type === "CloseCertificationWithdrawn" && (e.data as { kind: string }).kind === "close")).toHaveLength(1);
  });
});
