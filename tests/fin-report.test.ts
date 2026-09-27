/**
 * G1 reporting (Kuber CFO requirements §3.10):
 *   FIN-RPT-01  mapped balance sheet, P&L, cash flow, changes in equity and notes, with comparatives,
 *               labelled preliminary / certified / unavailable
 *   FIN-RPT-02  versioned KPI catalogue, one evaluator, drill-down, credit-sales DSO and purchase DPO,
 *               unavailable never zero; export equals report
 *
 * The golden book (modules/reporting/src/metrics/golden/company-small.json) is hand-computed; its
 * figures are in the fixture's description and repeated below.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sha256, uuid, type Account } from "@kuber/contracts";
import {
  MemoryLedgerData, certifyMetricVersions, computeStatements, definitionHash, drillMetric, evaluateMetric, loadFixture, loadMappings, loadMetrics,
  mappingFor, parseCsv, snapshotCtx, stable, validateMapping, validateMetric, type LedgerFixture, type StatementBundle, type StatementMapping,
} from "@kuber/reporting";
import { buildServer, kuberTools, type Cell } from "@kuber/core";
import { route } from "../apps/core/src/copilot/router.ts";
import { CORE_AUTH_SECRET, enrol, signedInject, startCell } from "./helpers.ts";

const T = "rpt", OWNER = "owner:ravi", CONTROLLER = "controller:asha";
const FY = { from: "2026-04-01", to: "2027-03-31" }, PRIOR = { from: "2025-04-01", to: "2026-03-31" };
const APPROVED = "Pilot AS (approved mapping)";
const golden = loadFixture("company-small") as LedgerFixture & { framework: string };
const mappings = loadMappings();
const illustrative = mappingFor(mappings, "AS (ICAI)")!;
const approvedMapping: StatementMapping = { ...illustrative, id: "schedule-iii-div1-pilot-approved", status: "approved", frameworks: [APPROVED],
  title: "Schedule III Division I (test copy marked approved)", reviewNote: "Test copy of the illustrative mapping, marked approved for certification tests." };
const clock = { value: "2027-04-10" };
let cell: Cell, stop: () => Promise<void>, app: FastifyInstance, send: ReturnType<typeof signedInject>;

const accountsOf = (extra: Account[] = []): Account[] => [
  ...golden.accounts.map((a) => ({ accountId: a.accountId, name: a.name, nature: a.nature as Account["nature"], taxonomyTag: a.taxonomyTag ?? undefined,
    isControl: false, isCashLike: a.accountId === "BANK", requiredDims: [] })), ...extra];
async function post(book: string, journalId: string, txnDate: string, lines: { accountId: string; amount: string; partyId?: string }[], voucherType = "journal") {
  await cell.gl.execute(T, book, { kind: "PostJournal", journalId: `${book}-${journalId}`, txnDate, narration: journalId, voucherType,
    lines: lines.map((l) => ({ ...l, dimensions: {} })) }, { principal: OWNER });
}
async function openGolden(book: string, framework: string, extra: Account[] = []) {
  await cell.gl.execute(T, book, { kind: "OpenBook", bookId: book, entityId: book, entityType: "company", basis: "statutory", accounts: accountsOf(extra), framework }, { principal: OWNER });
  for (const j of golden.journals) await post(book, j.journalId, j.date, j.lines);
}
/** A certified close snapshot for a period end, as the close workflow (FIN-CLS) will store it. */
async function certifyClose(book: string, periodEnd: string) {
  await cell.settle();
  const seq = (await cell.reporting.freshness(T, book)).projectedSeq, id = uuid();
  const body = (await cell.store.keys(T)).seal(JSON.stringify({ kind: "close", bookId: book, periodEnd, seq }), snapshotCtx(id));
  await cell.store.tenantTx(T, (tx) => tx`INSERT INTO reporting.snapshots (tenant_id, snapshot_id, book_id, kind, seq, content_hash, body, taken_by)
    VALUES (${T}, ${id}, ${book}, 'close', ${seq}, ${sha256(id)}, ${body}, ${CONTROLLER})`);
  return id;
}
const statements = (book: string, p: Record<string, unknown> = {}) => cell.reporting.fin.statements(T, book, { ...FY, ...p });
const amount = (b: StatementBundle, st: keyof StatementBundle["statements"], key: string) => b.statements[st].rows.find((r) => r.key === key)?.amounts;
const L = (accountId: string, rupees: number, partyId?: string) => ({ accountId, amount: String(rupees * 100), ...(partyId ? { partyId } : {}) });

beforeAll(async () => {
  ({ cell, stop } = await startCell(clock));
  await enrol(cell, T, [OWNER, CONTROLLER]);
  await cell.identity.setSettings(T, OWNER, { soloOwner: true, sodLimitPaise: null });
  cell.reporting.fin.addMapping(approvedMapping);
  await openGolden("golden", "AS (ICAI)");
  await openGolden("approved", APPROVED);
  await openGolden("unmapped", APPROVED, [
    { accountId: "MISC", name: "Miscellaneous", nature: "expense", isControl: false, isCashLike: false, requiredDims: [] },
    { accountId: "ODDTAG", name: "Deposit with odd tag", nature: "asset", taxonomyTag: "BS.not_in_mapping", isControl: false, isCashLike: false, requiredDims: [] },
  ]);
  await post("unmapped", "misc-1", "2026-11-05", [L("MISC", 5000), L("BANK", -5000)]);
  await cell.gl.execute(T, "plain", { kind: "OpenBook", bookId: "plain", entityId: "plain", entityType: "company", basis: "statutory", accounts: accountsOf() }, { principal: OWNER });
  await post("plain", "p-1", "2026-05-01", [L("BANK", 1000), L("CAPITAL", -1000)]);
  await cell.settle();
  app = buildServer(cell, { clock: () => clock.value, auth: { secret: CORE_AUTH_SECRET } });
  send = signedInject(app);
}, 120_000);
afterAll(async () => { await app?.close(); await stop(); });

// =================================================================== FIN-RPT-01
describe("FIN-RPT-01 mapped statements", () => {
  it("FIN-RPT-01 cash flow ties out on the hand-computed golden book; loan-financed equipment is not a bank flow", async () => {
    const b = await statements("golden");
    const cf = (k: string) => amount(b, "cashFlow", k);
    // FY 2026-27 (current) | FY 2025-26 (comparative), paise
    expect(cf("cf:profit")).toEqual(["73000000", "15000000"]);
    expect(cf("cf:noncash:NCA.ACC_DEP")).toEqual(["3000000", "0"]);
    expect(cf("cf:wc:CA.TRADE_RECEIVABLES")).toEqual(["-59000000", "0"]);
    expect(cf("cf:wc:CA.INVENTORIES")).toEqual(["-10000000", "0"]);
    expect(cf("cf:wc:CL.TRADE_PAYABLES")).toEqual(["15000000", "0"]);
    expect(cf("cf:wc:CL.OTHER")).toEqual(["18000000", "0"]);
    expect(cf("cf:operating")).toEqual(["40000000", "15000000"]);
    expect(cf("cf:investing")).toEqual(["0", "0"]);                         // equipment bought with the loan: non-cash
    expect(cf("cf:financing")).toEqual(["3000000", "50000000"]);            // capital 1,00,000 − loan repaid 50,000 − dividend 20,000
    expect(cf("cf:net")).toEqual(["43000000", "65000000"]);
    expect(cf("cf:opening-cash")).toEqual(["65000000", "0"]);
    expect(cf("cf:fx")).toEqual(["0", "0"]);
    expect(cf("cf:closing-cash")).toEqual(["108000000", "65000000"]);
    expect(cf("cf:check")).toEqual(["0", "0"]);
    // Direct method from the cash-account lines agrees with the indirect method.
    expect(cf("cfd:operating")).toEqual(["40000000", "15000000"]);
    expect(cf("cfd:operating:CA.TRADE_RECEIVABLES:in")).toEqual(["59000000", "0"]);
    expect(cf("cfd:financing")).toEqual(["3000000", "50000000"]);
    expect(b.statements.cashFlow.checks.every((c) => c.ok)).toBe(true);
    // The non-cash transaction is disclosed in the notes, never as a bank flow.
    expect(b.statements.notes.rows.find((r) => r.key === "note:noncash:golden-g-03")?.amounts[0]).toBe("30000000");
    expect(b.statements.cashFlow.rows.some((r) => r.key.startsWith("cfd:investing:"))).toBe(false);
  });

  it("FIN-RPT-01 statement of changes in equity rolls opening + profit + contributions − distributions to closing and ties to the balance sheet", async () => {
    const b = await statements("golden");
    const eq = (k: string) => amount(b, "equity", k);
    expect(eq("eq:EQ.SHARE_CAPITAL:opening")).toEqual(["50000000", "0"]);
    expect(eq("eq:EQ.SHARE_CAPITAL:increases")).toEqual(["10000000", "50000000"]);
    expect(eq("eq:EQ.SHARE_CAPITAL:closing")).toEqual(["60000000", "50000000"]);
    expect(eq("eq:EQ.RESERVES:opening")).toEqual(["15000000", "0"]);
    expect(eq("eq:EQ.RESERVES:profit")).toEqual(["73000000", "15000000"]);
    expect(eq("eq:EQ.RESERVES:decreases")).toEqual(["-2000000", "0"]);   // dividend paid
    expect(eq("eq:EQ.RESERVES:closing")).toEqual(["86000000", "15000000"]);
    expect(eq("eq:total:closing")).toEqual(["146000000", "65000000"]);
    expect(eq("eq:check")).toEqual(["0", "0"]);
    expect(amount(b, "balanceSheet", "bs:Equity and liabilities|Shareholders' funds|total")).toEqual(["146000000", "65000000"]);
    expect(b.statements.equity.checks.every((c) => c.ok)).toBe(true);
  });

  it("FIN-RPT-01 a closing voucher moves profit into reserves without changing the equity roll-forward", async () => {
    const book = "closed";
    await cell.gl.execute(T, book, { kind: "OpenBook", bookId: book, entityId: book, entityType: "company", basis: "statutory", accounts: accountsOf(), framework: "AS (ICAI)" }, { principal: OWNER });
    await post(book, "c-1", "2025-04-01", [L("BANK", 1000), L("CAPITAL", -1000)]);
    await post(book, "c-2", "2025-06-01", [L("BANK", 400), L("SALES", -400)]);
    await post(book, "c-3", "2026-03-31", [L("SALES", 400), L("RETAINED", -400)], "closing");
    await post(book, "c-4", "2026-05-01", [L("BANK", 100), L("SALES", -100)]);
    await cell.settle();
    const b = await statements(book);
    expect(amount(b, "profitAndLoss", "pl:profit")).toEqual(["10000", "40000"]);        // closing vouchers are added back
    expect(amount(b, "equity", "eq:EQ.RESERVES:opening")).toEqual(["40000", "0"]);
    expect(amount(b, "equity", "eq:EQ.RESERVES:closing")).toEqual(["50000", "40000"]);
    expect(amount(b, "cashFlow", "cf:financing")).toEqual(["0", "100000"]);             // the closing credit to reserves is not a cash flow
    expect([...b.statements.equity.checks, ...b.statements.cashFlow.checks].every((c) => c.ok)).toBe(true);
  });

  it("FIN-RPT-01 balance sheet and P&L are grouped by the framework's statement mapping, with comparative columns", async () => {
    const b = await statements("golden");
    expect(b.mapping).toMatchObject({ id: "schedule-iii-div1-illustrative", status: "illustrative" });
    expect(b.mapping!.label).toContain("illustrative, needs CA review");
    expect(b.statements.balanceSheet.columns.map((c) => [c.key, c.from, c.to])).toEqual([["current", FY.from, FY.to], ["comparative", PRIOR.from, PRIOR.to]]);
    const bs = (k: string) => amount(b, "balanceSheet", k);
    expect(bs("bs:EQ.RESERVES")).toEqual(["86000000", "15000000"]);
    expect(bs("bs:NCL.BORROWINGS")).toEqual(["25000000", "0"]);
    expect(bs("bs:NCA.ACC_DEP")).toEqual(["-3000000", "0"]);
    expect(bs("bs:CA.CASH")).toEqual(["108000000", "65000000"]);
    expect(bs("bs:Assets|total")).toEqual(["204000000", "65000000"]);
    expect(bs("bs:Equity and liabilities|total")).toEqual(["204000000", "65000000"]);
    expect(bs("bs:check")).toEqual(["0", "0"]);
    const pl = (k: string) => amount(b, "profitAndLoss", k);
    expect(pl("pl:PL.REVENUE")).toEqual(["120000000", "20000000"]);
    expect(pl("pl:PL.COGS")).toEqual(["30000000", "0"]);                  // purchases 4,00,000 less closing stock 1,00,000
    expect(pl("pl:Expenses|total")).toEqual(["48000000", "5000000"]);
    expect(pl("pl:profit")).toEqual(["73000000", "15000000"]);
    // Notes: basis, framework, fiscal year, significant accounts.
    const note = (k: string) => b.statements.notes.rows.find((r) => r.key === k);
    expect(note("note:framework")?.text).toBe("AS (ICAI)");
    expect(note("note:fiscal-year")?.text).toContain("FY 2026-27");
    expect(note("note:basis")?.text).toContain("statutory");
    expect(note("note:significant:BANK")?.amounts[0]).toBe("108000000");
    expect(note("note:excluded:OD")?.label).toContain("no balance or activity");
    // A requested comparative, and strict dates.
    const c = await statements("golden", { compareFrom: "2026-04-01", compareTo: "2026-09-30" });
    expect(amount(c, "profitAndLoss", "pl:PL.REVENUE")).toEqual(["120000000", "120000000"]);   // both sales fall before 30 Sep 2026
    await expect(statements("golden", { to: "2027-02-30" })).rejects.toThrow(/real calendar date/);
    await expect(statements("golden", { from: "2027-04-01", to: "2027-03-31" })).rejects.toThrow(/after/);
  });

  it("FIN-RPT-01 unmapped accounts show as exception lines in preliminary statements and block certification", async () => {
    await certifyClose("unmapped", FY.to);
    let b = await statements("unmapped");
    expect(b.statements.profitAndLoss.status).toBe("preliminary");
    expect(b.statements.profitAndLoss.reasons.join(" ")).toMatch(/1 unmapped account\(s\) carry figures: MISC/);
    const exc = b.statements.profitAndLoss.rows.find((r) => r.key === "pl:unmapped:MISC")!;
    expect(exc).toMatchObject({ kind: "exception", amounts: ["500000", "0"] });
    expect(exc.label).toContain("no statement mapping");
    expect(amount(b, "profitAndLoss", "pl:profit")).toEqual(["72500000", "15000000"]);   // still in profit: nothing is dropped
    expect(b.statements.cashFlow.rows.find((r) => r.key === "cf:check")!.amounts[0]).toBe("0");
    expect(b.statements.notes.rows.find((r) => r.key === "note:unmapped:MISC")?.label).toContain("blocks certification");
    // ODDTAG has a tag the mapping does not know, but no figures: listed, not an exception.
    expect(b.statements.notes.rows.find((r) => r.key === "note:excluded:ODDTAG")?.text).toContain("BS.not_in_mapping");
    // Mapping the account (FIN-MDM-02) lifts the block: the certified close now covers the period.
    await cell.gl.execute(T, "unmapped", { kind: "ChangeAccountControls", accountId: "MISC", taxonomyTag: "PL.other_expenses", reason: "map to other expenses" }, { principal: CONTROLLER });
    await cell.settle();
    b = await statements("unmapped");
    expect(b.statements.profitAndLoss.status).toBe("certified");
    expect(amount(b, "profitAndLoss", "pl:PL.OTHER_EXPENSES")).toEqual(["500000", "5000000"]);
  });

  it("FIN-RPT-01 outputs are labelled preliminary, certified or unavailable, with the reasons", async () => {
    // Approved mapping, no close yet: preliminary.
    let b = await statements("approved");
    expect(b.statements.balanceSheet.status).toBe("preliminary");
    expect(b.statements.balanceSheet.reasons).toEqual([`no certified close snapshot for the period ending ${FY.to}`]);
    // A certified close covers the current period: every statement of that column is certified; the comparative is not.
    const snap = await certifyClose("approved", FY.to);
    b = await statements("approved");
    for (const s of Object.values(b.statements)) {
      expect(s.status, s.kind).toBe("certified");
      expect(s.columns[0]!.certification).toMatchObject({ snapshotId: snap, kind: "close", periodEnd: FY.to });
      expect(s.columns[1]!.status).toBe("preliminary");
    }
    // A journal back-dated into the certified period withdraws the certification.
    await post("approved", "late", "2027-03-15", [L("RENT", 1000), L("BANK", -1000)]);
    await cell.settle();
    b = await statements("approved");
    expect(b.statements.cashFlow.status).toBe("preliminary");
    expect(b.statements.cashFlow.reasons.join(" ")).toMatch(/posted after certified snapshot/);
    // The illustrative mapping never certifies, even with a close snapshot.
    await certifyClose("golden", FY.to);
    b = await statements("golden");
    expect(b.statements.profitAndLoss.status).toBe("preliminary");
    expect(b.statements.profitAndLoss.reasons.join(" ")).toMatch(/illustrative, needs CA review/);
    // Unavailable: no mapping for the framework ("unspecified"), and a comparative before the first posting. No zeros.
    b = await statements("plain");
    for (const s of Object.values(b.statements)) {
      expect(s.status).toBe("unavailable");
      expect(s.reasons.join(" ")).toMatch(/no statement mapping serves the book's framework "unspecified"/);
      expect(s.rows.every((r) => r.amounts.every((a) => a === null))).toBe(true);
    }
    b = await statements("golden", { compareFrom: "2024-04-01", compareTo: "2025-03-31" });
    expect(b.statements.balanceSheet.columns[1]).toMatchObject({ status: "unavailable", reasons: ["no ledger data for this period: the book's first posting is on 2025-04-01"] });
    expect(amount(b, "balanceSheet", "bs:CA.CASH")).toEqual(["108000000", null]);
    // The operation carries the label in its title and data.
    const p = await cell.ops.plan(T, "golden", OWNER, "financial_statements", FY);
    expect(p.kind).toBe("read");
    expect(p.title).toContain("preliminary");
    expect((p.data as StatementBundle).statements.balanceSheet.status).toBe("preliminary");
  });
});

// =================================================================== FIN-RPT-02
const metrics = loadMetrics(undefined, mappings);
const EXPECTED: Record<string, [string, string | null]> = {
  // current FY 2026-27, comparative FY 2025-26 (null: unavailable)
  gross_margin: ["75.00", "100.00"], operating_margin: ["62.50", "75.00"], current_ratio: ["5.36", null], quick_ratio: ["5.06", null],
  cash_runway: ["54.0", null], dso: ["182.5", null], dpo: ["136.9", null], working_capital: ["144000000", "65000000"], debt_to_equity: ["0.17", "0.00"],
};

describe("FIN-RPT-02 KPI catalogue", () => {
  it("FIN-RPT-02 the catalogue publishes each metric's definition, grain, sign, filters, period, source, owner, freshness and version, validated on load", () => {
    expect(metrics.map((m) => m.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const m of metrics) {
      expect(validateMetric(m, new Set(mappings.flatMap((x) => x.lines.map((l) => l.key))))).toEqual([]);
      for (const k of ["formula", "grain", "sign", "filters", "period", "source", "owner", "freshness", "version"] as const) expect(m[k], `${m.id}.${k}`).toBeDefined();
      expect(m.owner).toBe("Financial Controller");
    }
    expect(metrics.find((m) => m.id === "dso")!.basis).toMatch(/Credit-sales basis.*Proxy/s);
    expect(metrics.find((m) => m.id === "dpo")!.basis).toMatch(/Purchase basis.*Proxy/s);
    expect(validateMetric({ ...metrics[0], formula: "revenue / nothing" })).toContain("formula uses nothing, which is neither an input nor a built-in");
    expect(validateMetric({ ...metrics[0], owner: undefined })).toContain("owner required");
    expect(validateMapping({ ...illustrative, tags: { "BS.x": "NO.SUCH" } })).toContain("tags.BS.x: unknown line NO.SUCH");
  });

  it("FIN-RPT-02 each KPI matches its hand-computed value; the report, the golden test and the in-memory evaluator agree", async () => {
    const r = await cell.reporting.fin.kpis(T, "golden", FY);
    for (const m of r.metrics) {
      expect([m.columns[0]!.value, m.columns[1]!.value], m.id).toEqual(EXPECTED[m.id]);
      expect(m.columns[0]!.status, m.id).toBe("preliminary");               // illustrative mapping
      const def = metrics.find((d) => d.id === m.id)!;
      expect(m.columns[0]!.value).toBe(def.test.expected);
      const mem = new MemoryLedgerData(golden);
      expect((await evaluateMetric(mem, def, { mapping: illustrative, ...FY, firstDate: await mem.firstDate() })).exact).toBe(m.current.exact);
    }
    // Exact rationals, formatted only at the end.
    expect(r.metrics.find((m) => m.id === "current_ratio")!.current.exact).toBe("59/11");
    expect(r.metrics.find((m) => m.id === "dso")!.current.exact).toBe("365/2");
  });

  it("FIN-RPT-02 DSO uses the credit-sales basis and DPO the purchase basis; joins cannot duplicate sales; a proxy is disclosed", async () => {
    const r = await cell.reporting.fin.kpis(T, "golden", { ...FY, ids: ["dso", "dpo"] });
    const dso = r.metrics.find((m) => m.id === "dso")!, dpo = r.metrics.find((m) => m.id === "dpo")!;
    expect(dso.current.inputs.find((x) => x.name === "credit_sales")!.value).toBe("118000000");   // the cash sale of 2,00,000 does not count
    expect(dso.current.notes.join(" ")).toMatch(/credit sales: invoice value/);
    expect(dpo.current.inputs.find((x) => x.name === "credit_purchases")!.value).toBe("40000000"); // the payment of 2,50,000 does not count
    const def = (id: string) => metrics.find((m) => m.id === id)!;
    const book = (journals: LedgerFixture["journals"]) => new MemoryLedgerData({ accounts: golden.accounts, journals });
    // One invoice with two receivable lines and two revenue lines counts once: 800, not 1,600 or 3,200.
    const dup = book([
      { journalId: "o", date: "2026-04-01", lines: [L("BANK", 1000), L("CAPITAL", -1000)] },
      { journalId: "inv", date: "2026-05-01", lines: [L("DEBTORS", 500, "a"), L("DEBTORS", 300, "b"), L("SALES", -400), L("SALES", -400)] },
      { journalId: "cash", date: "2026-05-02", lines: [L("BANK", 900), L("SALES", -900)] },
      { journalId: "bill", date: "2026-05-03", lines: [L("PURCH", 200), L("RENT", 100), L("CREDITORS", -300, "s")] },
      { journalId: "cashbuy", date: "2026-05-04", lines: [L("PURCH", 700), L("BANK", -700)] },
    ]);
    const ctx = { mapping: illustrative, ...FY, firstDate: "2026-04-01" };
    const d1 = await evaluateMetric(dup, def("dso"), ctx);
    expect(d1.inputs.find((x) => x.name === "credit_sales")!.value).toBe("80000");
    expect(d1.value).toBe("365.0");                                         // 800 / 800 × 365
    const p1 = await evaluateMetric(dup, def("dpo"), ctx);
    expect(p1.inputs.find((x) => x.name === "credit_purchases")!.value).toBe("30000");
    expect(p1.value).toBe("365.0");
    // Receivables carried in by an opening entry, only cash sales in the period: credit sales cannot be separated -> proxy, disclosed.
    const proxy = book([
      { journalId: "o", date: "2026-04-01", lines: [L("DEBTORS", 1000, "a"), L("CAPITAL", -1000)] },
      { journalId: "cash", date: "2026-05-02", lines: [L("BANK", 4000), L("SALES", -4000)] },
    ]);
    const d2 = await evaluateMetric(proxy, def("dso"), ctx);
    expect(d2.value).toBe("91.3");                                          // 1,000 / 4,000 × 365 = 91.25
    expect(d2.notes.join(" ")).toMatch(/PROXY: credit sales cannot be separated.*Revenue from operations/);
  });

  it("FIN-RPT-02 unavailable data never appears as zero", async () => {
    // No mapping for the framework: every metric unavailable, no value.
    const plain = await cell.reporting.fin.kpis(T, "plain", FY);
    for (const m of plain.metrics) expect(m.columns[0]).toMatchObject({ status: "unavailable", value: null });
    expect(plain.metrics[0]!.columns[0]!.reasons[0]).toMatch(/no statement mapping/);
    // The comparative year has no current liabilities and no credit sales: unavailable with the reason, not 0.
    const r = await cell.reporting.fin.kpis(T, "golden", FY);
    const cr = r.metrics.find((m) => m.id === "current_ratio")!.columns[1]!;
    expect(cr).toMatchObject({ status: "unavailable", value: null, exact: null });
    expect(cr.reasons).toEqual(["current liabilities are nil or in debit: the current ratio is not meaningful"]);
    expect(r.metrics.find((m) => m.id === "dso")!.columns[1]!.reasons).toEqual(["no credit sales in 2025-04-01 to 2026-03-31"]);
    // No account mapped to cost of sales: gross margin unavailable (not 100%).
    const noCogs = new MemoryLedgerData({ accounts: golden.accounts.filter((a) => a.accountId !== "PURCH"),
      journals: [{ journalId: "s", date: "2026-05-01", lines: [L("BANK", 100), L("SALES", -100)] }] });
    const gm = await evaluateMetric(noCogs, metrics.find((m) => m.id === "gross_margin")!, { mapping: illustrative, ...FY, firstDate: "2026-05-01" });
    expect(gm).toMatchObject({ available: false, value: null, reasons: ["Cost of sales: no account is mapped to Cost of materials consumed and purchases of stock-in-trade"] });
    // The CSV export shows an empty value and "unavailable", never 0.
    const csv = parseCsv(cell.reporting.fin.exportKpis(plain, "csv").content);
    const head = csv[0]!;
    for (const row of csv.slice(1).filter((x) => x.length > 1)) {
      expect(row[head.indexOf("status")]).toBe("unavailable");
      expect(row[head.indexOf("value")]).toBe("");
    }
  });

  it("FIN-RPT-02 drill-down items sum exactly to each metric input, and the metric follows from its inputs", async () => {
    for (const m of metrics) {
      const d = await cell.reporting.fin.kpiDrill(T, "golden", m.id, FY);
      for (const [name, t] of Object.entries(d.totals)) expect(t.items, `${m.id}.${name}`).toBe(t.input);
      expect(d.metric.value).toBe(EXPECTED[m.id]![0]);
    }
    const dso = await cell.reporting.fin.kpiDrill(T, "golden", "dso", FY);
    expect(dso.items.filter((x) => x.input === "credit_sales").map((x) => [x.journalId, x.amount])).toEqual([["golden-g-06", "118000000"]]);
    expect(dso.items.filter((x) => x.input === "receivables").map((x) => [x.accountId, x.partyId, x.amount])).toEqual([["DEBTORS", "cus-1", "59000000"]]);
    const mem = await drillMetric(new MemoryLedgerData(golden), metrics.find((m) => m.id === "gross_margin")!, { mapping: illustrative, ...FY, firstDate: "2025-04-01" });
    expect(mem.items.filter((x) => x.input === "cogs").map((x) => x.amount).sort()).toEqual(["-10000000", "40000000"]);
    // The drill operation says so too.
    const p = await cell.ops.plan(T, "golden", OWNER, "kpi_drill", { metric: "dpo", ...FY });
    expect(p.checks).toEqual([{ label: "Drill-down items sum to each input", ok: true, blocking: false }]);
  });

  it("FIN-RPT-02 metric versions are certified when their golden test passes, recorded once; a changed definition under the same version is refused", async () => {
    expect((await cell.reporting.fin.catalogue()).every((m) => m.status === "draft")).toBe(true);
    const res = await cell.reporting.fin.certifyMetricVersions("ci:golden-tests");
    expect(res.every((x) => x.passed && x.certified), JSON.stringify(res.filter((x) => !x.passed))).toBe(true);
    const cat = await cell.reporting.fin.catalogue();
    expect(cat.every((m) => m.status === "certified" && m.certification?.certifiedBy === "ci:golden-tests")).toBe(true);
    // Certified metric version + certified period = certified KPI.
    const k = await cell.reporting.fin.kpis(T, "unmapped", { ...FY, ids: ["current_ratio"] });
    expect(k.metrics[0]!).toMatchObject({ definitionStatus: "certified", columns: [{ status: "certified" }, { status: "unavailable" }] });
    const gm = metrics.find((m) => m.id === "gross_margin")!;
    const changed = { ...gm, formula: "(revenue - cogs) / revenue * 1" };
    expect(definitionHash(changed)).not.toBe(definitionHash(gm));
    const [again] = await certifyMetricVersions(cell.sql, [changed], mappings, "ci:golden-tests");
    expect(again).toMatchObject({ certified: false, problem: "gross_margin v1 was certified with a different definition; a changed formula needs a new version" });
    const failing = { ...gm, version: 99, test: { ...gm.test, expected: "12.34" } };
    const [f] = await certifyMetricVersions(cell.sql, [failing], mappings, "ci:golden-tests");
    expect(f).toMatchObject({ passed: false, certified: false, actual: "75.00" });
  });
});

// =================================================================== export, API, agent
describe("FIN-RPT-01/02 export, API and agent surfaces", () => {
  const as = (url: string) => send({ method: "GET", url, tenant: T, principal: OWNER });
  const q = `from=${FY.from}&to=${FY.to}`;

  it("FIN-RPT-01/02 export equals the report: CSV and JSON of statements and KPIs carry the report's figures and a stable SHA-256", async () => {
    const b = await statements("golden");
    const json = cell.reporting.fin.exportStatements(b, "json");
    expect(json.sha256).toBe(sha256(json.content));
    expect(JSON.parse(json.content)).toEqual(stable(b));
    const csv = cell.reporting.fin.exportStatements(b, "csv");
    const rows = parseCsv(csv.content), head = rows[0]!;
    for (const s of Object.values(b.statements)) for (const r of s.rows) {
      const line = rows.find((x) => x[0] === s.kind && x[head.indexOf("key")] === r.key)!;
      expect([line[head.indexOf("current_paise")], line[head.indexOf("comparative_paise")]], r.key).toEqual(r.amounts.map((a) => a ?? ""));
    }
    expect(rows.find((x) => x[0] === "cash-flow" && x[3] === "status")![6]).toBe("preliminary");
    // Over HTTP: the export equals the report the API returns at the same ledger position, and the hash header is the body's.
    const api = (await as(`/v1/tenants/${T}/books/golden/statements?${q}`)).json();
    const res = await as(`/v1/tenants/${T}/books/golden/statements/export?${q}&format=json`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-sha256"]).toBe(sha256(res.body));
    expect(JSON.parse(res.body)).toEqual(stable(api));
    expect(res.body).toBe(json.content);                                   // same position, same bytes, same hash
    const k = await cell.reporting.fin.kpis(T, "golden", FY);
    const kcsv = parseCsv(cell.reporting.fin.exportKpis(k, "csv").content), kh = kcsv[0]!;
    for (const m of k.metrics) for (const c of m.columns) {
      const row = kcsv.find((x) => x[0] === m.id && x[kh.indexOf("column")] === c.key)!;
      expect([row[kh.indexOf("value")], row[kh.indexOf("exact")], row[kh.indexOf("status")]]).toEqual([c.value ?? "", c.exact ?? "", c.status]);
    }
    const kres = await as(`/v1/tenants/${T}/books/golden/metrics/export?${q}&format=csv`);
    expect(kres.headers["x-content-sha256"]).toBe(sha256(kres.body));
    expect(kres.body).toBe(cell.reporting.fin.exportKpis(k, "csv").content);
  });

  it("FIN-RPT-01/02 routes, read operations, agent tools and copilot intents", async () => {
    const cf = await as(`/v1/tenants/${T}/books/golden/statements/cash-flow?${q}`);
    expect(cf.statusCode).toBe(200);
    expect(cf.json().statement).toMatchObject({ kind: "cash-flow", status: "preliminary" });
    expect((await as(`/v1/tenants/${T}/books/golden/statements/nope`)).statusCode).toBe(404);
    expect((await as(`/v1/tenants/${T}/books/golden/statements?from=2027-02-30`)).statusCode).toBe(400);
    const one = (await as(`/v1/tenants/${T}/books/golden/metrics/dso?${q}`)).json();
    expect(one.metrics.map((m: { id: string; columns: { value: string }[] }) => [m.id, m.columns[0]!.value])).toEqual([["dso", "182.5"]]);
    expect((await as(`/v1/tenants/${T}/books/golden/metrics/dso/drill?${q}`)).json().totals.credit_sales).toEqual({ input: "118000000", items: "118000000" });
    expect((await as(`/v1/tenants/${T}/books/golden/metrics/catalogue`)).json().length).toBe(metrics.length);
    expect((await as(`/v1/tenants/${T}/books/golden/metrics/nope?${q}`)).statusCode).toBe(404);
    // Default period: the book's fiscal year to date (clock 2027-04-10 -> FY 2027-28 from 1 April).
    expect((await as(`/v1/tenants/${T}/books/golden/statements`)).json().periods[0]).toEqual({ from: "2027-04-01", to: "2027-04-10" });
    // Read operations.
    for (const op of ["financial_statements", "cash_flow", "equity_statement", "kpis", "kpi_drill"]) {
      const p = await cell.ops.plan(T, "golden", OWNER, op, op === "kpi_drill" ? { metric: "current_ratio", ...FY } : FY);
      expect(p, op).toMatchObject({ kind: "read", blocked: false, journals: [] });
    }
    const k = await cell.ops.plan(T, "golden", OWNER, "kpis", { ...FY, metrics: ["working_capital"] });
    expect(k.summary).toBe("Working capital ₹14,40,000");
    const names = kuberTools(cell, { tenant: T, book: "golden", principal: OWNER }).map((t) => t.name);
    for (const n of ["kuber_financial_statements", "kuber_cash_flow", "kuber_equity_statement", "kuber_kpis", "kuber_kpi_drill"]) expect(names).toContain(n);
    // Copilot router: additive intents.
    const r = (t: string) => route(t, "2027-04-10", ["BANK", "CASH"]);
    expect(r("Show the cash flow statement")).toEqual({ kind: "op", intents: [{ op: "cash_flow", input: {} }] });
    expect(r("cash flow for last FY")).toEqual({ kind: "op", intents: [{ op: "cash_flow", input: { from: "2026-04-01", to: "2027-03-31" } }] });
    expect(r("What is our current ratio?")).toEqual({ kind: "op", intents: [{ op: "kpis", input: { metrics: ["current_ratio"] } }] });
    expect(r("DSO")).toEqual({ kind: "op", intents: [{ op: "kpis", input: { metrics: ["dso"] } }] });
    expect(r("debtor days")).toEqual({ kind: "op", intents: [{ op: "kpis", input: { metrics: ["dso"] } }] });
    expect(r("DPO this year")).toEqual({ kind: "op", intents: [{ op: "kpis", input: { metrics: ["dpo"], from: "2027-04-01", to: "2028-03-31" } }] });
    expect(r("why is DSO so high? show what makes it up")).toEqual({ kind: "op", intents: [{ op: "kpi_drill", input: { metric: "dso" } }] });
    expect(r("quick ratio")).toEqual({ kind: "op", intents: [{ op: "kpis", input: { metrics: ["quick_ratio"] } }] });
    expect(r("gross margin")).toEqual({ kind: "op", intents: [{ op: "kpis", input: { metrics: ["gross_margin"] } }] });
    expect(r("KPIs")).toEqual({ kind: "op", intents: [{ op: "kpis", input: {} }] });
    expect(r("statement of changes in equity")).toEqual({ kind: "op", intents: [{ op: "equity_statement", input: {} }] });
    expect(r("financial statements")).toEqual({ kind: "op", intents: [{ op: "financial_statements", input: {} }] });
    // Unchanged: runway alone is still the cash position read; balance sheet still the report read.
    expect(r("Cash and runway")).toEqual({ kind: "read", calls: [{ tool: "kuber_cash_position", args: {} }] });
    expect(r("Balance sheet")).toEqual({ kind: "read", calls: [{ tool: "kuber_balance_sheet", args: {} }] });
  });
});
