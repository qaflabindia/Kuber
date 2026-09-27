/**
 * Finance requirements for cash and banks (CFO gate G1). Each test is named by the requirement it proves:
 *   FIN-CASH-01  statement integrity: retained source and row lineage, account identity, coverage (gaps, overlaps),
 *                opening + signed movements = closing, held statements with visible exceptions, overlap deduplication,
 *                uploaded vs authenticated provenance
 *   FIN-CASH-02  settlement matching: reference, account, direction, amount and counterparty; one-to-many; fees;
 *                own-account transfers (both legs); returns; ambiguity always goes to review
 *   FIN-CASH-03  certified bank reconciliation: timing items with age and source, difference zero vs no outstanding
 *                items, independent certifier, certified snapshot, withdrawal on a later posting, roll-forward, stale items
 *   UAT-03       bank timing item and close, end to end
 *   UAT-COM      the certify workflow: replay, concurrent certify, revoked certifier, period crossing, signed command
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { uuid, type EventData, type Line } from "@kuber/contracts";
import { buildServer, RETENTION, SEALED_COLUMNS, type Cell } from "@kuber/core";
import { matchSettlement, type SettlementLeg } from "@kuber/agent";
import { CORE_AUTH_SECRET, SoftAuthenticator, enrol, signedInject, startCell, type SignedRequest } from "./helpers.ts";

const T = "cash";
const SU = "superuser:ravi", CTRL = "controller:asha", TREAS = "treasurer:meena", STAFF = "staff:pia", AUD = "auditor:aud", TREAS2 = "treasurer:tara";
const clock = { value: "2026-09-30" };
let cell: Cell, stop: () => Promise<void>, ownerUrl: string;

const L = (accountId: string, amount: bigint, extra: Partial<Line> = {}): Line => ({ accountId, amount: amount.toString(), dimensions: {}, ...extra });
const R = (rupees: number) => BigInt(Math.round(rupees * 100));
/** A journal entered directly by the superuser; returns its id. */
async function journal(book: string, txnDate: string, narration: string, lines: Line[], voucherType = "journal") {
  const journalId = uuid();
  await cell.gl.execute(T, book, { kind: "PostJournal", journalId, txnDate, narration, voucherType, lines }, { principal: SU });
  return journalId;
}
const pay = (book: string, date: string, narration: string, rupees: number, bank = "BANK") => journal(book, date, narration, [L("BIZEXP", R(rupees)), L(bank, -R(rupees))], "payment");
const receive = (book: string, date: string, narration: string, rupees: number, bank = "BANK") => journal(book, date, narration, [L(bank, R(rupees)), L("FEES", -R(rupees))], "receipt");

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
const NUMBERS: Record<string, string> = {};
async function openBook(book: string, accounts: { id: string; gl: string; number: string; ifsc?: string; openingDate?: string; staleDays?: number; fee?: string }[], opening: [string, number][] = []) {
  await cell.gl.openBook(T, book, T, "company", SU);
  if (accounts.some((a) => a.gl === "BANK2")) {
    await cell.gl.execute(T, book, { kind: "AddAccount", account: { accountId: "BANK2", name: "Second bank", nature: "asset", taxonomyTag: "BS.cash", isControl: false, isCashLike: true, requiredDims: [] } }, { principal: SU });
  }
  for (const [gl, rupees] of opening) await journal(book, "2026-08-31", "Opening balance", [L(gl, R(rupees)), L("OPENING", -R(rupees))], "opening");
  for (const a of accounts) {
    NUMBERS[a.id] = a.number;
    await cell.bank.registerAccount(T, book, TREAS, { bankAccountId: a.id, glAccountId: a.gl, bankName: "HDFC Bank", accountNumber: a.number, ifsc: a.ifsc ?? "HDFC0001234",
      openingDate: a.openingDate ?? "2026-09-01", staleDays: a.staleDays, feeTolerancePaise: a.fee });
  }
  await cell.settle();
}
async function importCsv(book: string, account: string, text: string, extra: Record<string, unknown> = {}) {
  const r = await cell.bank.importStatement(T, book, STAFF, { bankAccountId: account, csv: text, statementAccount: { accountNumber: NUMBERS[account], ifsc: "HDFC0001234" }, ...extra });
  await cell.settle();
  return r;
}
const txnEvents = async (type: string) => cell.store.readEvents({ tenantId: T, types: [type], limit: 10_000 });
const reviewsOf = async (book: string) => (await cell.agent.openMatchReviews(T)).filter((m) => m.book_id === book);
const draftsOf = async (book: string) => cell.agent.queue(T, { bookId: book });
async function approveAll(book: string, accountId = "BIZEXP") {
  for (const d of await draftsOf(book)) await cell.agent.approveDraft(T, d.draft_id, CTRL, d.proposal.accountId === "SUSPENSE" ? accountId : d.proposal.accountId);
  await cell.settle();
}
const prepare = (book: string, account: string, periodEnd: string, by = STAFF) =>
  cell.ops.plan(T, book, by, "certify_bank_reconciliation", { bankAccountId: account, periodEnd });

beforeAll(async () => {
  const f = await startCell(clock);
  cell = f.cell; stop = f.stop; ownerUrl = f.db.ownerUrl;
  await enrol(cell, T, [SU, CTRL, TREAS, STAFF, AUD, TREAS2]);
});
afterAll(async () => { await stop?.(); });

// ====================================================================== FIN-CASH-01
describe("FIN-CASH-01 statement integrity", () => {
  const B = "c01";
  beforeAll(async () => { await openBook(B, [{ id: "HDFC-OP", gl: "BANK", number: "50100012345678" }], [["BANK", 50_000]]); });

  it("FIN-CASH-01 registers the book's own bank account with the number sealed and shown masked; only bank.manage may", async () => {
    const [a] = await cell.bank.accounts(T, B);
    expect(a).toMatchObject({ bankAccountId: "HDFC-OP", glAccountId: "BANK", masked: "XXXXXXXXXX5678", last4: "5678", currency: "INR", openingDate: "2026-09-01" });
    expect(JSON.stringify(a)).not.toContain("50100012345678");
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      const [row] = await owner`SELECT bank, account_idx FROM bank.accounts WHERE tenant_id = ${T} AND bank_account_id = 'HDFC-OP'`;
      expect(row!.bank).toMatch(/^kb1\./);
      expect(String(row!.bank) + String(row!.account_idx)).not.toContain("50100012345678");
    } finally { await owner.end(); }
    expect(SEALED_COLUMNS.map((c) => `${c.table}.${c.column}`)).toEqual(expect.arrayContaining(["bank.accounts.bank", "bank.statements.original", "bank.lines.detail"]));
    expect(RETENTION).toMatchObject({ "bank.accounts": "purge", "bank.statements": "purge", "bank.reconciliations": "purge" });
    await expect(cell.bank.registerAccount(T, B, STAFF, { bankAccountId: "X", glAccountId: "CASH", bankName: "x", accountNumber: "1234567", ifsc: "HDFC0001234", openingDate: "2026-09-01" }))
      .rejects.toThrow(/staff may not bank.manage/);
    await expect(cell.bank.registerAccount(T, B, TREAS, { bankAccountId: "X", glAccountId: "BIZEXP", bankName: "x", accountNumber: "1234567", ifsc: "HDFC0001234", openingDate: "2026-09-01" }))
      .rejects.toThrow(/not a cash-like asset account/);
    await expect(cell.bank.registerAccount(T, B, TREAS, { bankAccountId: "X", glAccountId: "CASH", bankName: "x", accountNumber: "1234567", ifsc: "HDFC0001234", openingDate: "2026-02-30" }))
      .rejects.toThrow(/not a real calendar date/);
  });

  const sepA = csv(50_000, [["2026-09-02", "NEFT CR ORBIT 401", "401", 1_000], ["2026-09-05", "UPI DR TEA STALL", "402", -120], ["2026-09-12", "NEFT CR NOVA 403", "403", 2_500]]);
  it("FIN-CASH-01 a statement with proven identity and arithmetic is verified: original retained, every row traced to its transaction", async () => {
    const r = await importCsv(B, "HDFC-OP", sepA, { periodFrom: "2026-09-01", periodTo: "2026-09-15" });
    expect(r).toMatchObject({ status: "verified", provenance: "uploaded", identity: "proven", periodFrom: "2026-09-01", periodTo: "2026-09-15",
      opening: "5000000", closing: "5338000", rows: 3, accepted: 3, duplicates: 0, skipped: 0, problems: [] });
    expect(r.signalId).toBeTruthy();
    const s = (await cell.bank.statement(T, r.statementId))!;
    expect(s.original).toEqual({ content: sepA, verified: true });
    expect(s.lineage.map((x) => [x.row, x.txnDate, x.amount, x.disposition])).toEqual([[1, "2026-09-02", "100000", "accepted"], [2, "2026-09-05", "-12000", "accepted"], [3, "2026-09-12", "250000", "accepted"]]);
    expect(s.lineage.every((x) => x.txnId)).toBe(true);
    // the same file again: nothing new
    expect(await importCsv(B, "HDFC-OP", sepA, { periodFrom: "2026-09-01", periodTo: "2026-09-15" })).toMatchObject({ statementId: r.statementId, duplicate: true });
  });

  it("FIN-CASH-01 a missing row, an ambiguous debit/credit or an inconsistent closing balance holds the statement with a visible exception; nothing is submitted", async () => {
    // a row removed between two others: the running balance breaks
    const missing = csv(53_380, [["2026-09-16", "NEFT CR ZEN 404", "404", 700], ["2026-09-18", "UPI DR CAB", "405", -300], ["2026-09-20", "NEFT CR ZEN 406", "406", 900]])
      .split("\n").filter((_, i) => i !== 2).join("\n");
    const m = await importCsv(B, "HDFC-OP", missing, { periodFrom: "2026-09-16", periodTo: "2026-09-30" });
    expect(m).toMatchObject({ status: "held", accepted: 0, signalId: null });
    expect(m.problems.join(" ")).toMatch(/running balance does not follow the movements/);
    // both debit and credit on one row
    const amb = "Date,Narration,Ref,Withdrawal,Deposit,Balance\n2026-09-16,ODD ROW,407,10.00,10.00,53380.00";
    const a = await importCsv(B, "HDFC-OP", amb, { periodFrom: "2026-09-16", periodTo: "2026-09-30" });
    expect(a.status).toBe("held");
    expect(a.problems.join(" ")).toMatch(/row 1: ambiguous debit\/credit/);
    // declared closing that the movements do not reach (no balance column)
    const nobal = "Date,Narration,Withdrawal,Deposit\n2026-09-16,NEFT CR ZEN,,700.00";
    const c = await importCsv(B, "HDFC-OP", nobal, { periodFrom: "2026-09-16", periodTo: "2026-09-30", declared: { opening: "53380", closing: "54000" } });
    expect(c.status).toBe("held");
    expect(c.problems.join(" ")).toMatch(/does not give declared closing/);
    // no way to prove opening and closing at all
    const u = await importCsv(B, "HDFC-OP", nobal, { periodFrom: "2026-09-16", periodTo: "2026-09-30" });
    expect(u.problems.join(" ")).toMatch(/opening and closing balances cannot be proven/);
    const ex = await cell.bank.exceptions(T, B, { status: "open" });
    for (const held of [m, a, c, u]) {
      expect(ex.find((e) => e.sourceId === held.statementId)).toMatchObject({ requirement: "FIN-CASH-01", hold: "import", owner: "Unassigned — Treasurer", status: "open" });
      const s = (await cell.bank.statement(T, held.statementId))!;
      expect(s.original?.verified).toBe(true);                                   // the held original is retained, sealed
      expect(s.lineage.every((x) => x.disposition === "held" && x.txnId === null)).toBe(true);
    }
    // resolution evidence closes the case (bank.manage)
    await expect(cell.bank.resolveException(T, B, ex[0]!.caseId, STAFF, "reimported")).rejects.toThrow(/staff may not bank.manage/);
    expect(await cell.bank.resolveException(T, B, ex[0]!.caseId, TREAS, "corrected statement obtained from the bank")).toMatchObject({ status: "resolved" });
  });

  it("FIN-CASH-01 the statement must prove it is this account's: a missing or different account number holds it", async () => {
    const text = csv(53_380, [["2026-09-16", "NEFT CR ZEN 404", "404", 700]]);
    const none = await cell.bank.importStatement(T, B, STAFF, { bankAccountId: "HDFC-OP", csv: text, periodFrom: "2026-09-16", periodTo: "2026-09-30" });
    expect(none).toMatchObject({ status: "held", identity: "missing" });
    const other = await cell.bank.importStatement(T, B, STAFF, { bankAccountId: "HDFC-OP", csv: text, periodFrom: "2026-09-16", periodTo: "2026-09-30", statementAccount: { accountNumber: "50100099999999" } });
    expect(other).toMatchObject({ status: "held", identity: "mismatch" });
    expect(other.problems.join(" ")).toMatch(/not that of HDFC-OP \(XXXXXXXXXX5678\)/);
    await expect(cell.bank.importStatement(T, B, AUD, { bankAccountId: "HDFC-OP", csv: text })).rejects.toThrow(/auditor may not capture/);
  });

  it("FIN-CASH-01 valid overlapping statements keep every unique movement once; coverage shows periods, the overlap and gaps", async () => {
    // 10..30 September overlaps 1..15: the three shared rows (same running balances) are duplicates
    const sepB = csv(50_880, [["2026-09-12", "NEFT CR NOVA 403", "403", 2_500], ["2026-09-20", "NEFT CR ZEN 406", "406", 900], ["2026-09-25", "UPI DR CAB", "405", -300]]);
    const r = await importCsv(B, "HDFC-OP", sepB, { periodFrom: "2026-09-10", periodTo: "2026-09-30" });
    expect(r).toMatchObject({ status: "verified", rows: 3, accepted: 2, duplicates: 1 });
    // an overlapping file whose balance disagrees at the join is held (a movement is missing between the files)
    const wrong = csv(51_000, [["2026-09-20", "NEFT CR ZEN 406", "406", 900]]);
    const w = await importCsv(B, "HDFC-OP", wrong, { periodFrom: "2026-09-14", periodTo: "2026-09-30" });
    expect(w.status).toBe("held");
    expect(w.problems.join(" ")).toMatch(/balance on 2026-09-13 is 5100000 by this statement but 5338000/);
    // a statement after a gap: verified, and the gap is an exception holding certification
    const oct = csv(54_480, [["2026-10-08", "NEFT CR ORBIT 408", "408", 100]]);
    const o = await importCsv(B, "HDFC-OP", oct, { periodFrom: "2026-10-05", periodTo: "2026-10-31" });
    expect(o.status).toBe("verified");
    const cov = await cell.bank.coverage(T, B, "HDFC-OP");
    expect(cov.gaps).toEqual([{ from: "2026-10-01", to: "2026-10-04" }]);
    expect(cov.overlaps).toEqual([{ from: "2026-09-10", to: "2026-09-15", statements: expect.any(Array) }]);
    expect(cov.complete).toBe(false);
    expect(cov.periods.filter((p) => p.status === "held").length).toBeGreaterThan(0);
    expect((await cell.bank.exceptions(T, B, { status: "open" })).find((e) => e.cause === "no statement covers 2026-10-01..2026-10-04"))
      .toMatchObject({ hold: "certification", requirement: "FIN-CASH-01" });
    // the unique movements, once each, are what the reconciliation's bank balance is built from
    const rec = await cell.bank.reconciliation(T, B, "HDFC-OP", "2026-09-30");
    expect(rec.bankBalance).toBe(R(50_000 + 1_000 - 120 + 2_500 + 900 - 300).toString());
  });

  it("FIN-CASH-01 uploaded vs authenticated: without a bank feed an authenticated import is refused", async () => {
    await expect(cell.bank.importStatement(T, B, STAFF, { bankAccountId: "HDFC-OP", csv: sepA, provenance: "authenticated", feedSignature: "x" }))
      .rejects.toMatchObject({ code: "feed_unavailable" });
    expect((await cell.bank.statements(T, B, "HDFC-OP")).every((s) => s.provenance === "uploaded")).toBe(true);
  });
});

// ====================================================================== FIN-CASH-02
describe("FIN-CASH-02 settlement matching", () => {
  const B = "c02";
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    await openBook(B, [{ id: "M1", gl: "BANK", number: "11112221111", fee: "50000" }, { id: "M2", gl: "BANK2", number: "22221112222" }], [["BANK", 100_000]]);
    ids.alpha = await pay(B, "2026-09-10", "Payment to Alpha Traders", 5_000);
    ids.beta = await pay(B, "2026-09-10", "Payment to Beta Stores", 5_000);
    ids.cheque = await pay(B, "2026-09-05", "Cheque 456789 to Gamma Supplies", 2_000);
    ids.delta = await pay(B, "2026-09-12", "Delta salary BATCH778899", 3_000);
    ids.eps = await pay(B, "2026-09-12", "Epsilon salary BATCH778899", 4_000);
    ids.settle = await receive(B, "2026-09-12", "Card settlement SETL123456", 10_000);
    ids.zeta = await pay(B, "2026-09-14", "Payment to Zeta Ltd UTR 998877665544", 1_500);
    await cell.settle();
    await importCsv(B, "M1", csv(100_000, [
      ["2026-09-06", "CHQ PAID 456789", "456789", -2_000],
      ["2026-09-11", "NEFT DR 5000", "", -5_000],
      ["2026-09-12", "SETTLEMENT SETL123456", "", 9_800],
      ["2026-09-13", "BULK BATCH778899", "", -7_000],
      ["2026-09-14", "TRF TO OWN A/C XXXX2222", "", -20_000],
      ["2026-09-15", "NEFT ZETA 998877665544", "", -1_500],
      ["2026-09-20", "RETURN NEFT 998877665544", "", 1_500],
    ]), { periodFrom: "2026-09-01", periodTo: "2026-09-30" });
  });
  const matched = async () => (await txnEvents("SettlementMatched")).map((e) => e.data as EventData<"SettlementMatched">).filter((d) => d.bookId === B);

  it("FIN-CASH-02 a cheque clears its book entry on the shared reference, account, direction and amount", async () => {
    expect((await matched()).find((m) => m.legs.some((l) => l.journalId === ids.cheque)))
      .toMatchObject({ instrument: "BANK", kind: "one_to_one", basis: "reference", legs: [{ journalId: ids.cheque, amount: "-200000" }] });
  });

  it("FIN-CASH-02 two equal same-day payments to different parties cannot auto-match: the line goes to review", async () => {
    const rv = (await reviewsOf(B)).find((r) => r.detail.narration === "NEFT DR 5000")!;
    expect(rv.candidates.sort()).toEqual([ids.alpha, ids.beta].sort());
    expect((await matched()).some((m) => m.legs.some((l) => l.journalId === ids.alpha || l.journalId === ids.beta))).toBe(false);
    // pure matcher: naming one party clears it; naming neither never does
    const leg = (journalId: string, narration: string): SettlementLeg => ({ journalId, txnDate: "2026-09-10", remaining: -R(5_000), narration, provisional: false, otherAccounts: ["BIZEXP"] });
    const ctx = { legs: [leg("a", "Payment to Alpha Traders"), leg("b", "Payment to Beta Stores")], prior: [], own: [], feeTolerance: 0n, windowDays: 90 };
    expect(matchSettlement({ txnDate: "2026-09-11", signed: -R(5_000), narration: "NEFT DR" }, ctx)).toMatchObject({ kind: "review", candidates: ["a", "b"] });
    expect(matchSettlement({ txnDate: "2026-09-11", signed: -R(5_000), narration: "NEFT DR ALPHA TRADERS" }, ctx)).toMatchObject({ kind: "clear", basis: "counterparty", legs: [{ journalId: "a" }] });
    expect(matchSettlement({ txnDate: "2026-09-11", signed: R(5_000), narration: "NEFT CR ALPHA TRADERS" }, ctx)).toEqual({ kind: "none" });   // direction
    // a person decides
    await expect(cell.agent.resolveSettlement(T, rv.review_id, AUD, { journalIds: [ids.alpha!] })).rejects.toThrow(/may not draft.decide/);
    expect(await cell.agent.resolveSettlement(T, rv.review_id, CTRL, { journalIds: [ids.alpha!] })).toMatchObject({ status: "linked", kind: "one_to_one" });
  });

  it("FIN-CASH-02 one line settling several entries (one-to-many) clears them all on the shared batch reference", async () => {
    const m = (await matched()).find((x) => x.kind === "one_to_many")!;
    expect(m.legs.map((l) => [l.journalId, l.amount]).sort()).toEqual([[ids.delta, "-300000"], [ids.eps, "-400000"]].sort());
  });

  it("FIN-CASH-02 ₹10,000 gross settlement less ₹200 fee reconciles to ₹9,800 bank with separate fee evidence", async () => {
    const rv = (await reviewsOf(B)).find((r) => r.detail.narration === "SETTLEMENT SETL123456")!;
    expect(rv.candidates).toEqual([ids.settle]);
    expect(rv.detail.bank).toMatchObject({ kind: "fee" });
    await expect(cell.agent.resolveSettlement(T, rv.review_id, CTRL, { journalIds: [ids.settle!], fee: { amountPaise: "10000", accountId: "BIZEXP" } }))
      .rejects.toThrow(/come to 990000 paise, the line is 980000/);
    const r = await cell.agent.resolveSettlement(T, rv.review_id, CTRL, { journalIds: [ids.settle!], fee: { amountPaise: "20000", accountId: "BIZEXP" } });
    expect(r.kind).toBe("fee");
    await cell.settle();
    const fee = r.legs.find((l) => l.journalId !== ids.settle)!;
    expect(r.legs).toEqual([{ journalId: ids.settle, amount: "1000000" }, { journalId: fee.journalId, amount: "-20000" }]);
    const st = await cell.gl.state(T, B);
    const fj = st.journals.get(fee.journalId)!;                                  // the fee is its own journal, linked to the line
    expect(fj.lines.map((l) => [l.accountId, l.amount])).toEqual([["BANK", "-20000"], ["BIZEXP", "20000"]]);
    expect(fj.narration).toMatch(/Bank charge deducted from settlement: SETTLEMENT SETL123456/);
  });

  it("FIN-CASH-02 an own-account transfer is posted once and both legs clear: one on each account's statement", async () => {
    const d = (await draftsOf(B)).find((x) => x.proposal.narration === "TRF TO OWN A/C XXXX2222")!;
    expect(d.proposal.accountId).toBe("BANK2");
    const { journalId } = await cell.agent.approveDraft(T, d.draft_id, CTRL);
    await cell.settle();
    await importCsv(B, "M2", csv(0, [["2026-09-14", "TRF FROM A/C XXXX1111", "", 20_000]]), { periodFrom: "2026-09-01", periodTo: "2026-09-30" });
    const m = (await matched()).find((x) => x.instrument === "BANK2")!;
    expect(m).toMatchObject({ kind: "one_to_one", basis: "own_account", legs: [{ journalId, amount: "2000000" }] });
    const r2 = await cell.bank.reconciliation(T, B, "M2", "2026-09-30");
    expect(r2).toMatchObject({ bankBalance: "2000000", bookBalance: "2000000", outstandingCount: 0, unrecorded: [], differenceZero: true });
  });

  it("FIN-CASH-02 a return is linked to the payment it returns, restores the expense/payable, and never double counts", async () => {
    expect((await matched()).find((m) => m.legs.some((l) => l.journalId === ids.zeta))).toMatchObject({ basis: "reference" });
    const rv = (await reviewsOf(B)).find((r) => r.detail.narration === "RETURN NEFT 998877665544")!;
    expect(rv.detail.bank).toMatchObject({ kind: "return" });
    expect(rv.candidates).toEqual([ids.zeta]);
    const r = await cell.agent.resolveSettlement(T, rv.review_id, CTRL, { returnOf: ids.zeta! });
    await cell.settle();
    const ret = (await cell.gl.state(T, B)).journals.get(r.legs[0]!.journalId)!;
    expect(ret.lines.map((l) => [l.accountId, l.amount, l.dimensions?.returns])).toEqual([["BIZEXP", "-150000", ids.zeta], ["BANK", "150000", ids.zeta]]);
    // everything on the statement is now in the books; Beta's payment is the one outstanding item
    const rec = await cell.bank.reconciliation(T, B, "M1", "2026-09-30");
    expect(rec.unrecorded).toEqual([]);
    expect(rec.outstandingPayments.map((x) => x.journalId)).toEqual([ids.beta]);
    expect(rec).toMatchObject({ bankBalance: R(75_800).toString(), bookBalance: R(70_800).toString(), difference: "0", differenceZero: true, noOutstandingItems: false });
  });
});

// ====================================================================== FIN-CASH-03
describe("FIN-CASH-03 certified bank reconciliation", () => {
  it("FIN-CASH-03 an unexplained ₹1 blocks certification", async () => {
    const B = "c03a";
    await openBook(B, [{ id: "X1", gl: "BANK", number: "3333444455" }], [["BANK", 50_001]]);
    await importCsv(B, "X1", csv(50_000, [["2026-09-10", "NEFT CR OMEGA 501", "501", 10]]), { periodFrom: "2026-09-01", periodTo: "2026-09-30" });
    await approveAll(B, "FEES");
    const rec = await cell.bank.reconciliation(T, B, "X1", "2026-09-30");
    expect(rec).toMatchObject({ difference: "-100", differenceZero: false, certifiable: false, unrecorded: [] });
    const p = await prepare(B, "X1", "2026-09-30");
    expect(p).toMatchObject({ blocked: true, status: "preview" });
    expect(p.checks.find((c) => c.label === "Reconciliation difference is zero")).toMatchObject({ ok: false, detail: "unexplained -₹1.00" });
    await expect(cell.ops.commit(T, p.planId, TREAS, p.hash)).rejects.toThrow(/no plan/);
  });

  it("FIN-CASH-03 self-certification fails; the certifier is an independent superuser, controller or treasurer; the preparer's role is checked", async () => {
    const B = "c03b";
    await openBook(B, [{ id: "Y1", gl: "BANK", number: "5555666677" }], [["BANK", 1_000]]);
    await importCsv(B, "Y1", csv(1_000, []), { declared: { opening: "1000", closing: "1000" }, periodFrom: "2026-09-01", periodTo: "2026-09-30" });
    const own = await prepare(B, "Y1", "2026-09-30", TREAS);
    expect(own.blocked).toBe(false);
    await expect(cell.ops.commit(T, own.planId, TREAS, own.hash)).rejects.toMatchObject({ code: "not_independent", status: 403 });
    await expect(cell.ops.commit(T, own.planId, STAFF, own.hash)).rejects.toThrow(/may not plan.approve/);       // staff never certifies
    await expect(cell.ops.commit(T, own.planId, AUD, own.hash)).rejects.toThrow();
    const bySu = await prepare(B, "Y1", "2026-09-30", SU);
    expect(bySu.checks.find((c) => c.label.startsWith("The preparer is"))).toMatchObject({ ok: false });
    // an agent never certifies, whatever the policy: there is no policy event, a person commits
    await enrol(cell, T, ["agent:bot"]);
    expect((await cell.ops.commit(T, own.planId, "agent:bot", own.hash)).status).toBe("awaiting_person");
    expect((await cell.ops.commit(T, own.planId, CTRL, own.hash)).status).toBe("committed");
    const [rc] = await cell.bank.reconciliations(T, B, "Y1");
    expect(rc).toMatchObject({ status: "certified", preparedBy: TREAS, certifiedBy: CTRL, version: 1, periodFrom: "2026-09-01", periodEnd: "2026-09-30" });
    const p2 = await prepare(B, "Y1", "2026-09-30", STAFF);
    expect(p2.blocked).toBe(true);                                              // already certified
  });
});

// ====================================================================== UAT-03
describe("UAT-03 bank timing item and close", () => {
  const B = "u03";
  let cheque: string, certified: string;
  beforeAll(async () => {
    clock.value = "2026-09-30";
    await openBook(B, [{ id: "U1", gl: "BANK", number: "7777888899", staleDays: 30 }], [["BANK", 95_000]]);
    await receive(B, "2026-09-05", "Receipt from Lambda Corp INV445566", 5_000);
    // the approved, issued-but-uncleared cheque: prepared by staff, approved by the treasurer
    const p = await cell.ops.plan(T, B, STAFF, "record", { date: "2026-09-20", narration: "Cheque 111222 to Kappa Supplies", amount: "10000", direction: "out", account: "BIZEXP", via: "BANK" });
    expect((await cell.ops.commit(T, p.planId, TREAS, p.hash)).status).toBe("committed");
    cheque = p.journals[0]!.journalId;
    await cell.settle();
  });

  it("UAT-03 statement import → matching → outstanding cheque → certification → next-period clearance without a second payment", async () => {
    // 1. statement closing ₹100,000; the receipt matches on its invoice reference
    const sep = await importCsv(B, "U1", csv(95_000, [["2026-09-06", "NEFT CR LAMBDA CORP INV445566", "", 5_000]]), { periodFrom: "2026-09-01", periodTo: "2026-09-30" });
    expect(sep).toMatchObject({ status: "verified", closing: R(100_000).toString() });
    // 2. book ₹90,000; bank ₹100,000 less the ₹10,000 cheque = ₹90,000: difference zero, the cheque stays open and aged
    const rec = await cell.bank.reconciliation(T, B, "U1", "2026-09-30");
    expect(rec).toMatchObject({ bankBalance: R(100_000).toString(), bookBalance: R(90_000).toString(), adjustedBank: R(90_000).toString(), adjustedBook: R(90_000).toString(),
      difference: "0", differenceZero: true, noOutstandingItems: false, outstandingCount: 1, unrecorded: [], certifiable: true });
    expect(rec.outstandingPayments).toEqual([expect.objectContaining({ journalId: cheque, amount: R(-10_000).toString(), ageDays: 10, stale: false,
      narration: "Cheque 111222 to Kappa Supplies", source: { voucherType: "journal", postedBy: TREAS, provisional: false } })]);
    // 4. the reviewer (independent) signs coverage, the aged item and the report version
    const p = await prepare(B, "U1", "2026-09-30");
    expect(p.checks.find((c) => c.label === "No outstanding items")).toMatchObject({ ok: false, blocking: false });
    expect(p.sections.find((s) => s.title.startsWith("Timing items"))!.rows[0]).toEqual(["Outstanding payment", "2026-09-20", cheque, "Cheque 111222 to Kappa Supplies", R(-10_000).toString(), 10, `journal by ${TREAS}`, ""]);
    expect((await cell.ops.commit(T, p.planId, TREAS, p.hash)).status).toBe("committed");
    const [rc] = await cell.bank.reconciliations(T, B, "U1");
    certified = rc!.reconciliationId;
    expect(rc).toMatchObject({ status: "certified", preparedBy: STAFF, certifiedBy: TREAS, statementHashes: [sep.contentHash] });
    const snap = (await cell.reporting.getSnapshot(T, rc!.snapshotId))!;
    expect(snap).toMatchObject({ kind: "bank-reconciliation", verified: true, bookId: B, seq: rc!.ledgerSeq });
    expect((snap.params as { reconciliation: { outstandingPayments: { journalId: string }[] } }).reconciliation.outstandingPayments[0]!.journalId).toBe(cheque);
    expect((await cell.bank.verifyCertification(T, B, certified))).toMatchObject({ snapshotVerified: true, figuresUnchanged: true });

    // next period: the cheque clears; an unexplained ₹500 debit arrives
    clock.value = "2026-10-15";
    const before = [...(await cell.gl.state(T, B)).journals.keys()];
    await importCsv(B, "U1", csv(100_000, [["2026-10-10", "MISC DEBIT 500", "", -500], ["2026-10-12", "CHQ PAID 111222", "111222", -10_000]]), { periodFrom: "2026-10-01", periodTo: "2026-10-15" });
    const clr = (await txnEvents("SettlementMatched")).map((e) => e.data as EventData<"SettlementMatched">).find((d) => d.legs.some((l) => l.journalId === cheque));
    expect(clr).toMatchObject({ basis: "reference", kind: "one_to_one" });
    expect((await draftsOf(B)).map((d) => d.proposal.narration)).toEqual(["MISC DEBIT 500"]);   // no second payment for the cheque
    // 3. the ₹500 is not in the books: the October reconciliation cannot certify until it is recorded
    const oct = await cell.bank.reconciliation(T, B, "U1", "2026-10-15");
    expect(oct).toMatchObject({ periodFrom: "2026-10-01", outstandingCount: 0, certifiable: false, unrecorded: [expect.objectContaining({ amount: "-50000", narration: "MISC DEBIT 500" })] });
    expect((await prepare(B, "U1", "2026-10-15")).blocked).toBe(true);
    await approveAll(B, "BIZEXP");
    const after = await cell.bank.reconciliation(T, B, "U1", "2026-10-15");
    expect(after).toMatchObject({ bankBalance: R(89_500).toString(), bookBalance: R(89_500).toString(), differenceZero: true, noOutstandingItems: true, certifiable: true });
    expect([...(await cell.gl.state(T, B)).journals.keys()].length).toBe(before.length + 1);   // only the ₹500 entry
    const p2 = await prepare(B, "U1", "2026-10-15");
    expect((await cell.ops.commit(T, p2.planId, CTRL, p2.hash)).status).toBe("committed");
    // September's certification still stands: nothing was posted into it
    expect((await cell.bank.reconciliations(T, B, "U1")).map((r) => [r.periodEnd, r.status])).toEqual([["2026-10-15", "certified"], ["2026-09-30", "certified"]]);
  });
});

// ====================================================================== UAT-COM for certification
describe("UAT-COM certify workflow (FIN-CASH-03)", () => {
  const B = "ucom";
  let oldCheque: string;
  beforeAll(async () => {
    clock.value = "2026-09-30";
    await openBook(B, [{ id: "C1", gl: "BANK", number: "9999000011", staleDays: 20 }], [["BANK", 20_000]]);
    oldCheque = await pay(B, "2026-09-01", "Cheque 000777 to Sigma Works", 1_000);
    await cell.settle();
    await importCsv(B, "C1", csv(20_000, []), { declared: { opening: "20000", closing: "20000" }, periodFrom: "2026-09-01", periodTo: "2026-09-30" });
  });

  it("UAT-COM replay and concurrent certification certify exactly once", async () => {
    const a = await prepare(B, "C1", "2026-09-30"), b = await prepare(B, "C1", "2026-09-30");
    const out = await Promise.allSettled([cell.ops.commit(T, a.planId, TREAS, a.hash), cell.ops.commit(T, b.planId, CTRL, b.hash)]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(out.find((o) => o.status === "rejected")).toMatchObject({ reason: { code: "already_certified" } });
    const won = out[0]!.status === "fulfilled" ? a : b;
    expect(await cell.ops.commit(T, won.planId, won === a ? TREAS : CTRL, won.hash)).toMatchObject({ status: "committed", replayed: true });
    expect((await cell.bank.reconciliations(T, B, "C1")).filter((r) => r.status === "certified")).toHaveLength(1);
    // the stale timing item (29 days, over 20) was signed with its age and raised an exception
    const ex = (await cell.bank.exceptions(T, B, { status: "open" })).find((e) => e.sourceId === oldCheque);
    expect(ex).toMatchObject({ requirement: "FIN-CASH-03", amount: R(-1_000).toString(), hold: "none" });
    expect(ex!.cause).toMatch(/29 days old \(over 20\)/);
  });

  it("UAT-COM a revoked certifier cannot certify; a plan whose books moved is stale", async () => {
    await importCsv(B, "C1", csv(20_000, []), { declared: { opening: "20000", closing: "20000" }, periodFrom: "2026-10-01", periodTo: "2026-10-31" });
    const p = await prepare(B, "C1", "2026-10-31");
    // the timing item rolls into the next period, still identified and older
    expect(p.sections.find((s) => s.title.startsWith("Timing items"))!.rows.map((r) => [r[2], r[5], r[7]])).toEqual([[oldCheque, 60, "yes"]]);
    await cell.identity.revoke(T, SU, TREAS2);
    await expect(cell.ops.commit(T, p.planId, TREAS2, p.hash)).rejects.toThrow();
    expect((await cell.bank.reconciliations(T, B, "C1")).filter((r) => r.periodEnd === "2026-10-31")).toHaveLength(0);
    await journal(B, "2026-10-20", "Unrelated accrual", [L("BIZEXP", R(1)), L("OPENING", -R(1))]);
    await cell.settle();
    await expect(cell.ops.commit(T, p.planId, CTRL, p.hash)).rejects.toMatchObject({ code: "stale" });
  });

  it("UAT-COM a later posting into a certified period withdraws the certification visibly; a posting elsewhere does not", async () => {
    await journal(B, "2026-09-25", "Accrual", [L("BIZEXP", R(10)), L("OPENING", -R(10))]);    // not on the bank account
    await cell.settle();
    expect((await cell.bank.reconciliations(T, B, "C1"))[0]).toMatchObject({ status: "certified" });
    const late = await pay(B, "2026-09-28", "Late recorded bank charge", 50);
    await cell.settle();
    const [r] = await cell.bank.reconciliations(T, B, "C1");
    expect(r).toMatchObject({ status: "withdrawn", periodEnd: "2026-09-30" });
    expect(r!.withdrawnReason).toContain(late);
    const ev = (await txnEvents("BankReconciliationWithdrawn")).find((e) => (e.data as EventData<"BankReconciliationWithdrawn">).reconciliationId === r!.reconciliationId);
    expect(ev?.data).toMatchObject({ journalId: late, bankAccountId: "C1" });
    expect((await cell.bank.exceptions(T, B, { status: "open" })).find((e) => e.sourceId === r!.reconciliationId)).toMatchObject({ hold: "certification", requirement: "FIN-CASH-03" });
    expect((await cell.bank.verifyCertification(T, B, r!.reconciliationId)).figuresUnchanged).toBe(false);
  });

  describe("signed command over HTTP", () => {
    let app: FastifyInstance, send: ReturnType<typeof signedInject>;
    const H = "treasurer:hema", HB = "http1", key = new SoftAuthenticator();
    const as = (principal: string | null, method: SignedRequest["method"], url: string, payload?: unknown) =>
      send({ method, url: `/v1/tenants/${T}${url}`, tenant: T, principal, payload });
    beforeAll(async () => {
      app = buildServer(cell, { clock: () => clock.value, auth: { secret: CORE_AUTH_SECRET } });
      send = signedInject(app);
      const inv = await cell.identity.invite(T, SU, { role: "treasurer", displayName: "Hema", principal: H });
      const o = (await as(null, "POST", "/identity/registration/options", { displayName: "Hema", enrolment: inv.token })).json();
      expect((await as(null, "POST", "/identity/registration/verify", { displayName: "Hema", enrolment: inv.token, response: key.create(o) })).statusCode).toBe(201);
      await openBook(HB, [], [["BANK", 3_000]]);
    });
    afterAll(async () => { await app?.close(); });

    it("UAT-COM certification over HTTP needs the certifier's passkey signature over the exact plan", async () => {
      const reg = await as(TREAS, "POST", `/books/${HB}/bank/accounts`, { bankAccountId: "H1", glAccountId: "BANK", bankName: "HDFC Bank", accountNumber: "1212343456", ifsc: "HDFC0001234", openingDate: "2026-09-01" });
      expect(reg.statusCode, reg.body).toBe(201);
      expect(reg.json()).toMatchObject({ masked: "XXXXXX3456" });
      const imp = await as(STAFF, "POST", `/books/${HB}/bank/statements`, { bankAccountId: "H1", csv: csv(3_000, []), statementAccount: { accountNumber: "1212343456" }, declared: { opening: "3000", closing: "3000" }, periodFrom: "2026-09-01", periodTo: "2026-09-30" });
      expect(imp.statusCode, imp.body).toBe(201);
      const held = await as(STAFF, "POST", `/books/${HB}/bank/statements`, { bankAccountId: "H1", csv: csv(3_000, []), periodFrom: "2026-10-01", periodTo: "2026-10-31" });
      expect(held.statusCode).toBe(202);
      expect((await as(AUD, "GET", `/books/${HB}/bank/coverage?account=H1`)).json()).toMatchObject({ gaps: [], overlaps: [] });
      expect((await as(AUD, "GET", `/books/${HB}/bank/reconciliations/H1?periodEnd=2026-09-30`)).json()).toMatchObject({ differenceZero: true, certifiable: true });
      const plan = (await as(STAFF, "POST", `/books/${HB}/bank/reconciliations`, { bankAccountId: "H1", periodEnd: "2026-09-30" })).json();
      expect(plan).toMatchObject({ op: "certify_bank_reconciliation", status: "proposed", needsPerson: true });
      // without a signature: refused, on the bank route and on the generic commit route
      expect((await as(H, "POST", `/books/${HB}/bank/certify`, { planId: plan.planId, hash: plan.hash })).json())
        .toMatchObject({ error: "step_up_required", reason: "certifying a bank reconciliation" });
      expect((await as(H, "POST", `/plans/${plan.planId}/commit`, { hash: plan.hash })).statusCode).toBe(403);
      const o = (await as(H, "POST", "/signing/options", { action: "plan.commit", planId: plan.planId, hash: plan.hash })).json();
      expect(o).toMatchObject({ required: true, reason: "certifying a bank reconciliation" });
      const ok = await as(H, "POST", `/books/${HB}/bank/certify`, { planId: plan.planId, hash: plan.hash, assertion: key.get(o.options) });
      expect(ok.statusCode, ok.body).toBe(200);
      const approved = (await cell.store.readStream(T, `${T}/plan/${plan.planId}`)).find((e) => e.type === "PlanApproved")!;
      expect(approved.data).toMatchObject({ signature: { kind: "webauthn" } });
      const recs = (await as(AUD, "GET", `/books/${HB}/bank/reconciliations?account=H1`)).json();
      expect(recs).toEqual([expect.objectContaining({ status: "certified", certifiedBy: H, preparedBy: STAFF })]);
      expect((await as(AUD, "GET", `/books/${HB}/bank/exceptions?status=open`)).json().length).toBeGreaterThan(0);
    });
  });
});
