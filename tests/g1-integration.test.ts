/**
 * G1 cross-module wiring (merged ws6/g1-close, ws6/g1-cash, ws6/g1-report, ws6/g1-migrate). Named by requirements:
 *   FIN-CLS-01/02 × FIN-CASH-03  the bank module's certified reconciliation is the close's `bank_reconciliation` evidence:
 *                                import a statement, certify the reconciliation, complete the bank close task and
 *                                substantiate the bank account with it; a wrong hash or a withdrawn one is refused
 *   FIN-CLS-04 × FIN-CASH-03     reopening the period withdraws the cited reconciliation in the bank module, visibly
 *   FIN-RPT-01 × FIN-CLS-03/04   a certified close makes the period's mapped statements "certified"; a reopen withdraws it
 *   FIN-MIG-02 × FIN-CASH-01     go-live bank coverage uses the bank module's verified statement periods where registered
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uuid, type EventData, type Line } from "@kuber/contracts";
import type { Plan } from "@kuber/ops";
import { mappingFor, type StatementMapping } from "@kuber/reporting";
import type { EvidenceRef } from "@kuber/close";
import type { Cell } from "@kuber/core";
import { ROOT, enrol, startCell } from "./helpers.ts";

const T = "g1x";
const SU = "superuser:asha", CTRL = "controller:ravi", TREAS = "treasurer:meena", PIA = "staff:pia";
const PE = "2026-09-30";
const PILOT = "Pilot AS (approved mapping, g1 integration)";
const clock = { value: "2026-10-02" };
let cell: Cell, stop: () => Promise<void>;

const R = (rupees: number) => BigInt(Math.round(rupees * 100));
const L = (accountId: string, amount: bigint, partyId?: string): Line => ({ accountId, amount: amount.toString(), dimensions: {}, ...(partyId ? { partyId } : {}) });
async function journal(book: string, txnDate: string, narration: string, lines: Line[], voucherType = "journal") {
  await cell.gl.execute(T, book, { kind: "PostJournal", journalId: uuid(), txnDate, narration, voucherType, lines }, { principal: SU });
}
/** A statement CSV with a running balance: rows are [date, narration, ref, signed rupees]. */
function csv(opening: number, rows: [string, string, string, number][]) {
  let bal = R(opening);
  const out = ["Date,Narration,Ref,Withdrawal,Deposit,Balance"];
  for (const [d, n, ref, amt] of rows) {
    bal += R(amt);
    out.push(`${d},${n},${ref},${amt < 0 ? (-amt).toFixed(2) : ""},${amt > 0 ? amt.toFixed(2) : ""},${(Number(bal) / 100).toFixed(2)}`);
  }
  return out.join("\n");
}
const failing = (p: Plan) => JSON.stringify(p.checks.filter((c) => !c.ok && c.blocking));
async function planCommit(book: string, op: string, input: unknown, preparer: string, committer: string) {
  const p = await cell.ops.plan(T, book, preparer, op, input);
  expect(p.blocked, failing(p)).toBe(false);
  const r = await cell.ops.commit(T, p.planId, committer, p.hash);
  expect(r.status).toBe("committed");
  await cell.settle();
  return p;
}
const close = () => cell.periodClose;
const doc = async (book: string, name: string) => (await close().registerDocument(T, book, PIA, { name, contentBase64: Buffer.from(`${book}|${name}|${uuid()}`).toString("base64"), periodEnd: PE })).ref;

/** A company book with one registered bank account, a verified September statement and a certified September bank reconciliation. */
async function bookWithCertifiedBank(book: string, number: string) {
  await cell.gl.openBook(T, book, T, "company", SU, { framework: PILOT });
  // The seed's credit card (a cash-like liability) cannot be registered in the bank module (asset accounts only), so the
  // close would demand a certified reconciliation nobody can produce for it; this book has no card and closes the account.
  await cell.gl.execute(T, book, { kind: "CloseAccount", accountId: "CARD", reason: "no credit card in this company" }, { principal: SU });
  await journal(book, "2026-08-31", "Opening balance", [L("BANK", R(95_000)), L("CAPITAL", -R(95_000))], "opening");
  await journal(book, "2026-09-05", "Receipt from Lambda Corp INV445566", [L("BANK", R(5_000)), L("FEES", -R(5_000))], "receipt");
  await cell.bank.registerAccount(T, book, TREAS, { bankAccountId: `${book}-hdfc`, glAccountId: "BANK", bankName: "HDFC Bank", accountNumber: number, ifsc: "HDFC0001234", openingDate: "2026-09-01" });
  await cell.settle();
  const st = await cell.bank.importStatement(T, book, PIA, { bankAccountId: `${book}-hdfc`, csv: csv(95_000, [["2026-09-06", "NEFT CR LAMBDA CORP INV445566", "", 5_000]]),
    statementAccount: { accountNumber: number, ifsc: "HDFC0001234" }, periodFrom: "2026-09-01", periodTo: PE });
  await cell.settle();
  expect(st).toMatchObject({ status: "verified" });
  await planCommit(book, "certify_bank_reconciliation", { bankAccountId: `${book}-hdfc`, periodEnd: PE }, PIA, TREAS);
  const [rec] = await cell.bank.reconciliations(T, book, `${book}-hdfc`);
  expect(rec).toMatchObject({ status: "certified", periodEnd: PE });
  return { rec: rec!, ref: { kind: "bank_reconciliation", id: rec!.reconciliationId, hash: rec!.contentHash } as EvidenceRef };
}

/** Complete the checklist: the bank task with the real certified reconciliation, the others with documents / the suspense roll-forward. */
async function completeChecklist(book: string, bankRef: EvidenceRef) {
  const c = (await close().checklist(T, book, PE))!;
  for (const t of c.tasks.filter((x) => x.status === "open")) {
    const evidence: EvidenceRef[] = t.evidenceKinds[0] === "bank_reconciliation" ? [bankRef]
      : t.evidenceKinds[0] === "suspense_roll_forward" ? [(await close().suspenseEvidence(T, book, c.periodStart, PE)).ref]
      : [await doc(book, `${t.taskId} support`)];
    await planCommit(book, "complete_close_task", { periodEnd: PE, taskId: t.taskId, evidence }, t.owner!, t.owner === CTRL ? SU : CTRL);
  }
}
async function substantiateAll(book: string, bankRef: EvidenceRef) {
  const st = await close().status(T, book, PE);
  const state = await cell.gl.state(T, book);
  for (const a of st.substantiations.filter((x) => x.status === "missing")) {
    const acc = state.accounts.get(a.accountId)!;
    const input: Record<string, unknown> = { periodEnd: PE, accountId: a.accountId };
    if (a.accountId === "BANK") input.evidence = [bankRef];
    else if (!acc.isControl && acc.accountId !== "SUSPENSE") {
      const nat = ["asset", "expense"].includes(acc.nature) ? BigInt(a.glBalance) : -BigInt(a.glBalance);
      const n = nat < 0n ? -nat : nat;
      input.sourceBalance = `${nat < 0n ? "-" : ""}${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
      input.evidence = [await doc(book, `${a.accountId} support`)]; input.note = "agreed to the supporting document";
    }
    await planCommit(book, "approve_substantiation", input, PIA, CTRL);
  }
}

beforeAll(async () => {
  ({ cell, stop } = await startCell(clock));
  await enrol(cell, T, [SU, CTRL, TREAS, PIA]);
  // A test copy of the illustrative Schedule III mapping marked approved, so statements can be certified (as in fin-report.test.ts).
  const illustrative = mappingFor(cell.reporting.fin.mappings, "AS (ICAI)")!;
  const approved: StatementMapping = { ...illustrative, id: "schedule-iii-div1-g1-integration", status: "approved", frameworks: [PILOT],
    title: "Schedule III Division I (test copy marked approved)", reviewNote: "Test copy for the G1 integration tests." };
  cell.reporting.fin.addMapping(approved);
}, 120_000);
afterAll(async () => { await stop?.(); });

// ====================================================================== close ↔ bank ↔ report
describe("FIN-CLS × FIN-CASH × FIN-RPT: certified bank reconciliation, certified close, certified statements", () => {
  const B = "intg";
  let bank: Awaited<ReturnType<typeof bookWithCertifiedBank>>;
  let closeId: string;
  beforeAll(async () => {
    bank = await bookWithCertifiedBank(B, "50100099887766");
    await close().createChecklist(T, B, CTRL, { periodEnd: PE, defaultOwner: PIA });
  }, 120_000);

  it("FIN-CLS-01 × FIN-CASH-03 the cell registers the bank module as the close's bank_reconciliation resolver; a wrong hash is refused", async () => {
    expect(close().evidence.has("bank_reconciliation")).toBe(true);
    expect(close().evidence.withdrawer("bank_reconciliation")).toBeTypeOf("function");
    const q = { tenant: T, book: B, periodEnd: PE, periodStart: "2026-09-01", accountId: "BANK" };
    const ok = await close().evidence.resolve(bank.ref, q);
    expect(ok).toMatchObject({ ok: true, accountId: "BANK", periodEnd: PE, balancePaise: R(100_000).toString() });
    expect(await close().evidence.resolve({ ...bank.ref, hash: "0".repeat(64) }, q)).toMatchObject({ ok: false, reason: expect.stringMatching(/not that of the certified reconciliation/) });
    expect(await close().evidence.resolve({ ...bank.ref, id: "no-such-rec" }, q)).toMatchObject({ ok: false, reason: expect.stringMatching(/no such certified bank reconciliation/) });
    expect(await close().evidence.resolve(bank.ref, { ...q, book: "other" })).toMatchObject({ ok: false });
    // the bank task refuses a bogus reference and accepts the certified one
    const bad = await cell.ops.plan(T, B, PIA, "complete_close_task", { periodEnd: PE, taskId: "bank", evidence: [{ ...bank.ref, hash: "1".repeat(64) }] });
    expect(bad.blocked).toBe(true);
    expect(failing(bad)).toMatch(/not that of the certified reconciliation/);
  });

  it("FIN-CLS-01/02 × FIN-CASH-03 import a statement, certify the bank reconciliation, then complete the bank close task and substantiate the bank account with it", async () => {
    await completeChecklist(B, bank.ref);
    const c = (await close().checklist(T, B, PE))!;
    expect(c.tasks.find((t) => t.taskId === "bank")).toMatchObject({ status: "done", evidence: [bank.ref] });
    await substantiateAll(B, bank.ref);
    const s = (await close().substantiations(T, B, PE)).find((x) => x.accountId === "BANK")!;
    expect(s).toMatchObject({ status: "approved", glBalance: R(100_000).toString() });
    expect(s.record).toMatchObject({ source: "bank_reconciliation" });
  });

  it("FIN-RPT-01 × FIN-CLS-03 the certified close makes the period's statements certified (CertificationSource: close.closes)", async () => {
    const before = await cell.reporting.fin.statements(T, B, { from: "2026-09-01", to: PE });
    expect(before.statements.balanceSheet.columns[0]!.status).toBe("preliminary");
    expect(before.statements.balanceSheet.columns[0]!.reasons.join(" ")).toMatch(/no certified close snapshot for the period ending 2026-09-30/);
    const p = await planCommit(B, "certify_close", { periodEnd: PE }, CTRL, SU);
    closeId = (p.data as { closeId: string }).closeId;
    const b = await cell.reporting.fin.statements(T, B, { from: "2026-09-01", to: PE });
    const col = b.statements.balanceSheet.columns[0]!;
    expect(col.reasons).toEqual([]);
    expect(col.status).toBe("certified");
    expect(col.certification).toMatchObject({ source: "close.closes", kind: "close", snapshotId: closeId, periodEnd: PE, takenBy: SU });
    expect(b.statements.profitAndLoss.columns[0]!.status).toBe("certified");
  });

  it("FIN-CLS-04 × FIN-CASH-03 × FIN-RPT-01 a reopen withdraws the cited bank reconciliation in the bank module and the statements' certification", async () => {
    await planCommit(B, "reopen_period", { periodEnd: PE, reason: "Bank reissued the September statement" }, CTRL, SU);
    const [rec] = await cell.bank.reconciliations(T, B, `${B}-hdfc`);
    expect(rec).toMatchObject({ reconciliationId: bank.rec.reconciliationId, status: "withdrawn", withdrawnReason: expect.stringMatching(/reopened: Bank reissued the September statement/) });
    const withdrawn = (await cell.store.readEvents({ tenantId: T, types: ["BankReconciliationWithdrawn"], limit: 100 })).map((e) => e.data as EventData<"BankReconciliationWithdrawn">);
    expect(withdrawn).toEqual([expect.objectContaining({ reconciliationId: bank.rec.reconciliationId, bookId: B, periodEnd: PE })]);
    expect((await cell.bank.exceptions(T, B, { status: "open" })).some((x) => x.cause.includes("certification withdrawn") && x.hold === "certification")).toBe(true);
    // the close's own record of it
    const ev = (await cell.store.readStream(T, `${T}/close/${B}/${PE}`)).filter((e) => e.type === "CloseCertificationWithdrawn").map((e) => (e.data as { kind: string; ref: string }));
    expect(ev).toEqual(expect.arrayContaining([{ ...ev.find((x) => x.kind === "bank_reconciliation")!, ref: bank.rec.reconciliationId }]));
    // the withdrawn reconciliation no longer resolves as evidence
    expect(await close().evidence.resolve(bank.ref, { tenant: T, book: B, periodEnd: PE, periodStart: "2026-09-01", accountId: "BANK" }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/withdrawn/) });
    // statements: no longer certified
    const b = await cell.reporting.fin.statements(T, B, { from: "2026-09-01", to: PE });
    expect(b.statements.balanceSheet.columns[0]!.status).toBe("preliminary");
    expect(b.statements.balanceSheet.columns[0]!.certification).toBeNull();
    // re-certifying the bank reconciliation makes it citable again (a new version)
    await planCommit(B, "certify_bank_reconciliation", { bankAccountId: `${B}-hdfc`, periodEnd: PE }, PIA, TREAS);
    const [again] = await cell.bank.reconciliations(T, B, `${B}-hdfc`);
    expect(again).toMatchObject({ status: "certified", version: 2 });
    expect(await close().evidence.resolve({ kind: "bank_reconciliation", id: again!.reconciliationId, hash: again!.contentHash },
      { tenant: T, book: B, periodEnd: PE, periodStart: "2026-09-01", accountId: "BANK" })).toMatchObject({ ok: true });
  });
});

// ====================================================================== migration ↔ bank
describe("FIN-MIG-02 × FIN-CASH-01 go-live bank coverage from the bank module", () => {
  const B = "migb", NUMBER = "60200011223344";
  let project: string;
  const statement = (from: string, to: string, opening: number, rows: [string, string, string, number][]) =>
    cell.bank.importStatement(T, B, CTRL, { bankAccountId: "MIG-AXIS", csv: csv(opening, rows), statementAccount: { accountNumber: NUMBER, ifsc: "UTIB0000123" }, periodFrom: from, periodTo: to });
  beforeAll(async () => {
    clock.value = "2026-05-02";
    await cell.gl.openBook(T, B, "migb", "company", SU);
    const p = await cell.migration.createProject(T, CTRL, { bookId: B, sourceSystem: "csv", cutoff: "2026-03-31" });
    project = p.projectId;
    await cell.migration.importFile(T, CTRL, project, { name: "generic.csv", content: readFileSync(join(ROOT, "tests", "fixtures", "migration", "generic-template.csv"), "utf8") });
    await cell.migration.approveMapping(T, CTRL, project, { rows: [{ sourceKey: "BNK", accountId: "BANK" }] });
  }, 120_000);
  afterAll(() => { clock.value = "2026-10-02"; });

  it("FIN-MIG-02 an account not registered in the bank module keeps the statement-line check", async () => {
    const cov = await cell.migration.coverage(T, project, { asOf: "2026-04-30" });
    expect(cov.accounts).toEqual([expect.objectContaining({ accountId: "BANK", source: "statement-lines", ok: false })]);
  });

  it("FIN-MIG-02 a registered account is covered only by verified statement periods from the day after the cut-off, with no gap", async () => {
    await cell.bank.registerAccount(T, B, CTRL, { bankAccountId: "MIG-AXIS", glAccountId: "BANK", bankName: "Axis Bank", accountNumber: NUMBER, ifsc: "UTIB0000123", openingDate: "2026-04-01" });
    let cov = await cell.migration.coverage(T, project, { asOf: "2026-04-30" });
    expect(cov).toMatchObject({ ok: false, accounts: [{ accountId: "BANK", source: "bank", bankAccountId: "MIG-AXIS", ok: false, reason: expect.stringMatching(/no verified statement of MIG-AXIS covers 2026-04-01..2026-04-30/) }] });
    expect(await statement("2026-04-01", "2026-04-15", 150_000, [["2026-04-03", "NEFT CR NILA TEXTILES RC-1", "RC-1", 20_000]])).toMatchObject({ status: "verified" });
    await cell.settle();
    cov = await cell.migration.coverage(T, project, { asOf: "2026-04-30" });
    expect(cov.accounts[0]).toMatchObject({ source: "bank", ok: false, gaps: [{ from: "2026-04-16", to: "2026-04-30" }], reason: expect.stringMatching(/leave 2026-04-16..2026-04-30 uncovered/) });
    expect(await statement("2026-04-16", "2026-04-30", 170_000, [["2026-04-28", "BANK CHARGES", "", -500]])).toMatchObject({ status: "verified" });
    await cell.settle();
    cov = await cell.migration.coverage(T, project, { asOf: "2026-04-30" });
    expect(cov).toMatchObject({ ok: true, accounts: [{ accountId: "BANK", source: "bank", ok: true, gaps: [] }] });
    // the go-live checklist's coverage line reads the same result
    expect((await cell.migration.coverage(T, project, { asOf: "2026-05-31" })).ok).toBe(false);
  });
});
