/**
 * Agent core (AAWDS L1–L3 with L5 hooks): the read-tool catalogue against the reporting services,
 * the deterministic router's coverage, fuzzy account matching and clarifying questions, the bounded
 * model loop over a scripted Reasoner (step bound, screening, grounding fallback, turn records,
 * no kuber_commit, halt behaviour) and book scope.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuid } from "@kuber/contracts";
import { COPILOT } from "@kuber/identity";
import { Copilot, StubGovernance, kuberTools, matchAccounts, periodIn, readTools, resolveAccount, route, type AccountRef, type Cell, type NextStep, type NextStepRequest,
  type ComposeRequest, type Reasoner } from "@kuber/core";
import type { TurnRecord } from "../apps/core/src/copilot/governance/contracts.ts";
import { enrol, startCell } from "./helpers.ts";

// ---------------------------------------------------------------- router (no database)
const TODAY = "2026-11-05";
const ACCOUNTS: AccountRef[] = [
  ["CASH", "Cash in hand", "asset", true], ["BANK", "Bank account", "asset", true], ["INVEST", "Investments", "asset"], ["LOANS", "Loans", "liability"],
  ["CARD", "Credit card", "liability", true], ["OPENING", "Opening balance equity", "equity"], ["SALARY", "Salary income", "income"], ["OTHINC", "Other income", "income"],
  ["LIVING", "Living expenses", "expense"], ["SUSPENSE", "Unclassified (suspense)", "asset"], ["DEBTORS", "Trade receivables", "asset"], ["CREDITORS", "Trade payables", "liability"],
  ["FEES", "Professional fees", "income"], ["BIZEXP", "Business expenses", "expense"], ["DRAWINGS", "Drawings", "equity"],
  ["RENT", "Office rent", "expense"], ["OFFSUP", "Office supplies", "expense"],
].map(([id, name, nature, cash]) => ({ id: id as string, name: name as string, nature: nature as string, cash: Boolean(cash) }));

const FY = { from: "2026-04-01", to: "2027-03-31" }, NOV = { from: "2026-11-01", to: "2026-11-30" }, OCT = { from: "2026-10-01", to: "2026-10-31" };
type Want = { read: string; args?: Record<string, unknown> } | { op: string; input?: Record<string, unknown> } | { kind: "chat" | "clarify" | "help" };
const CASES: [string, Want][] = [
  // the two phrasings that used to fail
  ["Chart of Accounts Please?", { read: "kuber_chart_of_accounts", args: {} }],
  ["Can you show the sales?", { read: "kuber_income_breakdown", args: {} }],
  // chart of accounts
  ["show me the chart of accounts", { read: "kuber_chart_of_accounts" }],
  ["COA", { read: "kuber_chart_of_accounts" }],
  ["list my accounts", { read: "kuber_chart_of_accounts" }],
  ["accounts", { read: "kuber_chart_of_accounts" }],
  ["what are my expense accounts", { read: "kuber_chart_of_accounts", args: { category: "expense" } }],
  // sales, revenue, income
  ["sales this month", { read: "kuber_income_breakdown", args: NOV }],
  ["revenue last month", { read: "kuber_income_breakdown", args: OCT }],
  ["income this FY", { read: "kuber_income_breakdown", args: FY }],
  ["What were sales in October?", { read: "kuber_income_breakdown", args: OCT }],
  ["sales for Sep 2026", { read: "kuber_income_breakdown", args: { from: "2026-09-01", to: "2026-09-30" } }],
  ["how much did I earn last year", { read: "kuber_income_breakdown", args: { from: "2025-04-01", to: "2026-03-31" } }],
  ["revenue from professional fees this year", { read: "kuber_income_breakdown", args: { ...FY, account: "FEES" } }],
  ["turnover in Q1", { read: "kuber_income_breakdown", args: { from: "2026-04-01", to: "2026-06-30" } }],
  ["sales in march", { read: "kuber_income_breakdown", args: { from: "2026-03-01", to: "2026-03-31" } }],
  ["show sales by month for FY 2025-26", { read: "kuber_income_breakdown", args: { from: "2025-04-01", to: "2026-03-31" } }],
  // expenses
  ["expenses this month", { read: "kuber_expense_breakdown", args: NOV }],
  ["show my spending by category", { read: "kuber_expense_breakdown", args: {} }],
  ["how much did I spend on rent last month", { read: "kuber_expense_breakdown", args: { ...OCT, account: "RENT" } }],
  ["where did my money go this year", { read: "kuber_expense_breakdown", args: FY }],
  ["business expenses in Oct 2026", { read: "kuber_expense_breakdown", args: OCT }],
  ["costs for FY 2025-26", { read: "kuber_expense_breakdown", args: { from: "2025-04-01", to: "2026-03-31" } }],
  ["what did we spend on office supplies", { read: "kuber_expense_breakdown", args: { account: "OFFSUP" } }],
  // statements
  ["trial balance", { read: "kuber_trial_balance", args: {} }],
  ["trial balance as of 31 Oct 2026", { read: "kuber_trial_balance", args: { asOf: "2026-10-31" } }],
  ["TB as of 2026-09-30", { read: "kuber_trial_balance", args: { asOf: "2026-09-30" } }],
  ["P&L", { read: "kuber_profit_and_loss", args: {} }],
  ["profit and loss last month", { read: "kuber_profit_and_loss", args: OCT }],
  ["what's my profit this year", { read: "kuber_profit_and_loss", args: FY }],
  ["income statement for FY 2026-27", { read: "kuber_profit_and_loss", args: FY }],
  ["income and expenses this year", { read: "kuber_profit_and_loss", args: FY }],
  ["balance sheet", { read: "kuber_balance_sheet", args: {} }],
  ["balance sheet as of 31 Mar 2027", { read: "kuber_balance_sheet", args: { asOf: "2027-03-31" } }],
  ["what do I own and owe", { read: "kuber_balance_sheet" }],
  // balances and ledgers
  ["balance of BANK", { read: "kuber_ledger", args: { account: "BANK", limit: 10 } }],
  ["What's the balance of my bank account?", { read: "kuber_ledger", args: { account: "BANK", limit: 10 } }],
  ["business expenses balance", { read: "kuber_ledger", args: { account: "BIZEXP", limit: 10 } }],
  ["how much is in cash in hand", { read: "kuber_ledger", args: { account: "CASH", limit: 10 } }],
  ["ledger for BIZEXP", { read: "kuber_ledger", args: { account: "BIZEXP" } }],
  ["show transactions in bank account last month", { read: "kuber_ledger", args: { account: "BANK", ...OCT } }],
  ["statement of salary income", { read: "kuber_ledger", args: { account: "SALARY" } }],
  ["open the drawings ledger", { read: "kuber_ledger", args: { account: "DRAWINGS" } }],
  ["Rent?", { read: "kuber_ledger", args: { account: "RENT", limit: 20 } }],
  // review, attention, plans, lifecycle
  ["drafts", { read: "kuber_review_queue" }],
  ["what's in review?", { read: "kuber_review_queue" }],
  ["show pending entries", { read: "kuber_review_queue" }],
  ["anything pending approval?", { read: "kuber_attention" }],
  ["what needs my attention", { read: "kuber_attention" }],
  ["What needs attention?", { read: "kuber_attention" }],
  ["match reviews", { read: "kuber_match_reviews" }],
  ["open plans", { read: "kuber_plans" }],
  ["failed postings", { read: "kuber_lifecycle", args: { state: "failed" } }],
  ["journal lifecycle", { read: "kuber_lifecycle", args: {} }],
  // cash and runway
  ["cash", { read: "kuber_cash_position" }],
  ["what's my runway", { read: "kuber_cash_position" }],
  ["how long will my money last", { read: "kuber_cash_position" }],
  ["cash position", { read: "kuber_cash_position" }],
  // search
  ["find swiggy", { read: "kuber_search_journals", args: { text: "swiggy" } }],
  ["search amazon over 5000 last month", { read: "kuber_search_journals", args: { text: "amazon", minAmount: "5000", ...OCT } }],
  ["find payments to landlord between 10k and 50k", { read: "kuber_search_journals", args: { text: "landlord", minAmount: "10000", maxAmount: "50000" } }],
  ["look up rent in October", { read: "kuber_search_journals", args: { text: "rent", ...OCT } }],
  // policies and parties
  ["what is the policy for vendor bank change", { read: "kuber_policies", args: { query: "vendor bank change" } }],
  ["POL-501", { read: "kuber_policies", args: { query: "POL-501" } }],
  ["who approves payments above 5 lakh", { read: "kuber_policies" }],
  ["list vendors", { read: "kuber_parties", args: { kind: "vendor" } }],
  ["customers", { read: "kuber_parties", args: { kind: "customer" } }],
  // read operations
  ["suspense items", { op: "suspense", input: {} }],
  ["show schedules", { op: "schedules", input: {} }],
  ["are the books in order?", { op: "balance" }],
  ["show my position", { op: "dashboard" }],
  ["how am I doing", { op: "dashboard" }],
  ["net worth", { op: "dashboard" }],
  // plans
  ["Reconcile bank to 1,30,206.50 as of 31 Oct 2026", { op: "reconcile", input: { account: "BANK", statementBalance: "130206.50", asOf: "2026-10-31" } }],
  ["Post the drafts", { op: "post" }],
  ["close Oct 2026", { op: "close", input: { periodEnd: "2026-10-31" } }],
  ["Carry forward FY 2026-27", { op: "carry_forward", input: { yearEnd: "2027-03-31" } }],
  ["rebalance bank 40 invest 60", { op: "rebalance", input: { targets: [{ account: "BANK", pct: "40" }, { account: "INVEST", pct: "60" }] } }],
  ["Allocate BIZEXP 60 BIZEXP:Chennai 40 BIZEXP:Bengaluru", { op: "allocate", input: { from: "BIZEXP" } }],
  ["What if rent goes up 15000 a month", { op: "simulate", input: { monthlyChange: { expenses: "15000" }, months: 12 } }],
  ["record 1499 printer ink to BIZEXP from bank", { op: "record", input: { narration: "printer ink", amount: "1499", direction: "out", account: "BIZEXP", via: "BANK" } }],
  ["add expense of 1200 for stationery to Office supplies by card", { op: "record", input: { narration: "stationery", amount: "1200", direction: "out", account: "OFFSUP", via: "CARD" } }],
  ["record 5000 received from client to professional fees into bank on 2026-11-02", { op: "record", input: { amount: "5000", direction: "in", account: "FEES", via: "BANK", date: "2026-11-02" } }],
  // capture, clarifications and help
  ["Paid 450 to the plumber in cash", { kind: "chat" }],
  ["record 2500 to office from cash", { kind: "clarify" }],
  ["record 800 taxi", { kind: "clarify" }],
  ["balance of office", { kind: "clarify" }],
  ["balance of xyzzy", { kind: "clarify" }],
  ["close", { kind: "clarify" }],
  ["reconcile bank", { kind: "clarify" }],
  ["help", { kind: "help" }],
  ["tell me a joke", { kind: "help" }],
];

describe("router: static fast path", () => {
  it(`covers ${CASES.length} phrasings with the expected tool or operation and arguments`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    const failures: string[] = [];
    for (const [text, want] of CASES) {
      const r = route(text, TODAY, ACCOUNTS);
      try {
        if ("read" in want) {
          expect(r.kind, text).toBe("read");
          const c = (r as Extract<typeof r, { kind: "read" }>).calls[0]!;
          expect(c.tool, text).toBe(want.read);
          if (want.args) expect(c.args, text).toMatchObject(want.args);
          if (want.args && !Object.keys(want.args).length) expect(c.args, text).toEqual({});
        } else if ("op" in want) {
          expect(r.kind, text).toBe("op");
          const i = (r as Extract<typeof r, { kind: "op" }>).intents[0]!;
          expect(i.op, text).toBe(want.op);
          if (want.input) expect(i.input, text).toMatchObject(want.input);
        } else expect(r.kind, text).toBe(want.kind);
      } catch (e) { failures.push(`${text}: got ${JSON.stringify(r).slice(0, 200)}`); }
    }
    expect(failures).toEqual([]);
  });

  it("never guesses an account for a write: it asks, naming the candidates", () => {
    const r = route("record 2500 to office from cash", TODAY, ACCOUNTS);
    expect(r.kind).toBe("clarify");
    const c = r as Extract<typeof r, { kind: "clarify" }>;
    expect(c.text).toMatch(/Which account/);
    expect(c.text).toMatch(/RENT/);
    expect(c.text).toMatch(/OFFSUP/);
    expect(c.suggestions).toEqual(expect.arrayContaining(["record 2500 to office from cash to RENT", "record 2500 to office from cash to OFFSUP"]));
    // without a money account named and several cash-like accounts, it asks for that too
    const v = route("record 300 courier to BIZEXP", TODAY, ACCOUNTS);
    expect(v.kind).toBe("clarify");
    expect((v as { text: string }).text).toMatch(/which account.*BANK/i);
  });

  it("an unrecognised request gets the grouped list of what the agent can do", () => {
    const r = route("tell me a joke", TODAY, ACCOUNTS) as { kind: string; text: string; reason: string };
    expect(r.reason).toBe("unrecognised");
    for (const g of ["Ask about the books", "What needs doing", "Prepare a change", "Policies"]) expect(r.text).toContain(g);
  });

  it("matches account names fuzzily: id, name, case, plural and token overlap", () => {
    expect(matchAccounts("bank", ACCOUNTS)[0]).toMatchObject({ id: "BANK", score: 1 });
    expect(matchAccounts("Professional Fees", ACCOUNTS)[0]).toMatchObject({ id: "FEES", score: 1 });
    expect(matchAccounts("my business expense account", ACCOUNTS)[0]!.id).toBe("BIZEXP");
    expect(matchAccounts("receivables", ACCOUNTS)[0]!.id).toBe("DEBTORS");
    expect(matchAccounts("zzz", ACCOUNTS)).toEqual([]);
    expect(resolveAccount("office", ACCOUNTS, "read")).toMatchObject({ kind: "ambiguous" });
    expect(resolveAccount("office rent", ACCOUNTS, "read")).toEqual({ kind: "one", id: "RENT" });
    expect(resolveAccount("rent", ACCOUNTS, "write")).toEqual({ kind: "one", id: "RENT" });          // exact id
    expect(resolveAccount("professional", ACCOUNTS, "read")).toEqual({ kind: "one", id: "FEES" });
    expect(resolveAccount("professional", ACCOUNTS, "write").kind).toBe("ambiguous");                 // not exact: a write asks
  });

  it("reads periods against the book's fiscal year", () => {
    expect(periodIn("this year", TODAY)).toMatchObject({ ...FY, label: "FY 2026-27" });
    expect(periodIn("this year", TODAY, 1)).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
    expect(periodIn("last month", "2026-01-10")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(periodIn("Q3", TODAY)).toMatchObject({ from: "2026-10-01", to: "2026-12-31" });
    expect(periodIn("may I see it", TODAY)).toBeNull();
    expect(periodIn("from 2026-05-01 to 2026-05-15", TODAY)).toMatchObject({ from: "2026-05-01", to: "2026-05-15" });
  });
});

// ---------------------------------------------------------------- tools and the copilot on a seeded book
const T = "agentco", B = "main", OTHER = "other", OWNER = "owner:laksh", SCOPED = "preparer:bea", CONTROLLER = "controller:asha";
const clock = { value: TODAY };
let cell: Cell, stop: () => Promise<void>;
const post = (date: string, narration: string, lines: [string, bigint][], book = B) => cell.gl.execute(T, book, { kind: "PostJournal", journalId: uuid(), txnDate: date, narration,
  voucherType: "journal", lines: lines.map(([accountId, a]) => ({ accountId, amount: a.toString(), dimensions: {} })) }, { principal: OWNER });

beforeAll(async () => {
  ({ cell, stop } = await startCell(clock));
  await enrol(cell, T, [OWNER, CONTROLLER]);
  await enrol(cell, T, [SCOPED], [B]);
  await enrol(cell, T, ["agent:mcp-main"], [B]);
  await cell.gl.openBook(T, B, "agentco", "freelancer", OWNER);
  await cell.gl.openBook(T, OTHER, "agentco", "freelancer", OWNER);
  for (const [accountId, name] of [["RENT", "Office rent"], ["OFFSUP", "Office supplies"]] as const)
    await cell.gl.execute(T, B, { kind: "AddAccount", account: { accountId, name, nature: "expense", isControl: false, isCashLike: false, requiredDims: [] } }, { principal: OWNER });
  await post("2026-09-30", "Opening BANK", [["BANK", 12500000n], ["OPENING", -12500000n]]);
  await post("2026-10-03", "Invoice 12 Acme consulting", [["BANK", 5000000n], ["FEES", -5000000n]]);
  await post("2026-10-10", "Printer ink Amazon", [["BIZEXP", 149900n], ["BANK", -149900n]]);
  await post("2026-11-02", "Invoice 13 Beta retainer", [["BANK", 3000000n], ["FEES", -3000000n]]);
  await post("2026-11-03", "Office rent November", [["RENT", 2000000n], ["BANK", -2000000n]]);
  await post("2026-10-05", "Other book income", [["BANK", 99900n], ["FEES", -99900n]], OTHER);
  await cell.gl.execute(T, B, { kind: "CloseAccount", accountId: "OTHINC", reason: "not used" }, { principal: OWNER });
  await cell.settle();
});
afterAll(async () => { await stop?.(); });

const copilotWho = { tenant: T, book: B, principal: COPILOT, onBehalfOf: OWNER };
const run = async (name: string, args: Record<string, unknown> = {}, who: { tenant: string; book: string; principal: string; onBehalfOf?: string } = copilotWho) => {
  const t = readTools(cell, who, () => clock.value).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.run(args);
};
const totals = (d: unknown) => (d as { totals: Record<string, string> }).totals;

describe("read tools: figures exactly as the services compute them", () => {
  it("income and expense breakdowns agree with the profit and loss statement", async () => {
    const pl = await cell.reporting.profitAndLoss(T, B, FY.from, FY.to);
    const inc = await run("kuber_income_breakdown");
    const d = inc.data as { total: string; months: { month: string; total: string }[]; accounts: { accountId: string; total: string }[] };
    expect(d.total).toBe(pl.totals["Total income"]!.toString());
    expect(d.total).toBe("8000000");
    expect(d.months).toEqual([{ month: "2026-10", total: "5000000" }, { month: "2026-11", total: "3000000" }]);
    expect(inc.text).toContain("₹80,000");
    expect(inc.plan).toMatchObject({ kind: "read", op: "income_breakdown", status: "preview" });
    expect(inc.plan!.sections[0]!.money).toEqual([2]);
    const exp = await run("kuber_expense_breakdown");
    expect((exp.data as { total: string }).total).toBe(pl.totals["Total expenses"]!.toString());
    expect((exp.data as { accounts: { accountId: string }[] }).accounts.map((a) => a.accountId)).toEqual(["RENT", "BIZEXP"]);   // largest first
    const oct = await run("kuber_expense_breakdown", OCT);
    expect((oct.data as { total: string }).total).toBe("149900");
    const rentOnly = await run("kuber_expense_breakdown", { account: "office rent" });
    expect((rentOnly.data as { total: string }).total).toBe("2000000");
  });

  it("trial balance, profit and loss and balance sheet match the reporting module", async () => {
    const tb = await run("kuber_trial_balance", { asOf: "2026-10-31" });
    const rtb = await cell.reporting.trialBalance(T, B, "2026-10-31");
    expect(totals(tb.data)).toEqual(Object.fromEntries(Object.entries(rtb.totals).map(([k, v]) => [k, v.toString()])));
    const pl = await run("kuber_profit_and_loss", OCT);
    expect(totals(pl.data)["Surplus / (deficit)"]).toBe((await cell.reporting.profitAndLoss(T, B, OCT.from, OCT.to)).totals["Surplus / (deficit)"]!.toString());
    expect(totals(pl.data)["Surplus / (deficit)"]).toBe("4850100");
    const bs = await run("kuber_balance_sheet");
    const rbs = await cell.reporting.balanceSheet(T, B, null);
    expect(totals(bs.data)["Total assets"]).toBe(rbs.totals["Total assets"]!.toString());
    expect(bs.text).toContain("₹1,83,501");
  });

  it("chart of accounts: tree with category, statement mapping, closed flag and balances", async () => {
    const r = await run("kuber_chart_of_accounts");
    const rows = r.data as { accountId: string; nature: string; statement: string; taxonomyTag: string | null; closed: boolean; balance: string }[];
    expect(rows.find((x) => x.accountId === "BANK")).toMatchObject({ nature: "asset", statement: "balance-sheet", taxonomyTag: "BS.cash", closed: false, balance: "18350100" });
    expect(rows.find((x) => x.accountId === "FEES")).toMatchObject({ statement: "profit-and-loss", balance: "8000000" });
    expect(rows.find((x) => x.accountId === "OTHINC")!.closed).toBe(true);
    expect(r.plan!.summary).toMatch(/1 closed/);
  });

  it("ledger: opening, movements and closing from reporting, lines paged", async () => {
    const r = await run("kuber_ledger", { account: "bank account", from: "2026-10-01", to: "2026-10-31" });
    const d = r.data as { accountId: string; opening: string; debits: string; credits: string; closing: string; lines: unknown[] };
    expect(d).toMatchObject({ accountId: "BANK", opening: "12500000", debits: "5000000", credits: "149900", closing: "17350100" });
    expect(d.lines).toHaveLength(2);
    await expect(run("kuber_ledger", { account: "office" })).rejects.toThrow(/could be .*RENT.*OFFSUP|could be .*OFFSUP.*RENT/);
  });

  it("search journals by text, amount range and account; review queue, attention, lifecycle, cash, policies", async () => {
    const s = await run("kuber_search_journals", { text: "invoice" });
    expect((s.data as { total: number }).total).toBe(2);
    expect((await run("kuber_search_journals", { text: "invoice", minAmount: "40000" })).data).toMatchObject({ total: 1, journals: [{ narration: "Invoice 12 Acme consulting", amount: "5000000" }] });
    expect((await run("kuber_search_journals", { account: "RENT" })).data).toMatchObject({ total: 1 });
    expect((await run("kuber_review_queue")).summary).toMatch(/No drafts/);
    expect((await run("kuber_attention")).data).toMatchObject({ drafts: 0, plans: 0 });
    expect((await run("kuber_lifecycle")).data).toHaveProperty("counts");
    const cash = await run("kuber_cash_position");
    const dash = await cell.ops.plan(T, B, COPILOT, "dashboard", {}, { onBehalfOf: OWNER });
    expect((cash.data as { cash: string }).cash).toBe((dash.data as { kpis: { cash: string } }).kpis.cash);
    const pol = await run("kuber_policies", { query: "vendor bank change" });
    expect((pol.data as { policies: { policyId: string; rules: string[] }[] }).policies[0]).toMatchObject({ policyId: "POL-501" });
    expect((pol.data as { policies: { rules: string[] }[] }).policies[0]!.rules.join(" ")).toMatch(/agent may never approve/);
    expect((await run("kuber_policies", { query: "POL-504" })).data).toMatchObject({ policies: [{ policyId: "POL-504" }] });
  });

  it("parties: bank details masked, holds shown; workspace-wide, so not for a book-scoped person", async () => {
    await cell.parties.register(T, OWNER, { partyId: "V-ACME", entityId: "agentco", kind: "vendor", name: "Acme Traders" });
    const ch = await cell.parties.requestBankChange(T, OWNER, "V-ACME", { bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Acme Traders" }, effectiveFrom: "2026-10-01" });
    await cell.parties.verifyBankChange(T, CONTROLLER, "V-ACME", ch.changeId, { method: "call_back", reference: "call 1" });
    await cell.parties.releaseBankChange(T, CONTROLLER, "V-ACME", ch.changeId);
    const r = await run("kuber_parties", { kind: "vendor" });
    expect((r.data as { parties: unknown[] }).parties).toEqual([expect.objectContaining({ partyId: "V-ACME", name: "Acme Traders", bank: expect.objectContaining({ accountNumber: "••••9012" }) })]);
    expect(r.text).not.toContain("123456789012");
    await expect(run("kuber_parties", {}, { ...copilotWho, onBehalfOf: SCOPED })).rejects.toThrow(/limited to books/);
  });
});

describe("book scope", () => {
  it("tools cannot read another book: not for a book-scoped person, not for an agent grant", async () => {
    await expect(run("kuber_trial_balance", {}, { tenant: T, book: OTHER, principal: COPILOT, onBehalfOf: SCOPED })).rejects.toThrow(/no access to book other/);
    await expect(run("kuber_search_journals", { text: "income" }, { tenant: T, book: OTHER, principal: "agent:mcp-main" })).rejects.toThrow(/not granted book other/);
    // the same person can read their own book; the owner can read the other book, and sees only its figures
    await expect(run("kuber_trial_balance", {}, { tenant: T, book: B, principal: COPILOT, onBehalfOf: SCOPED })).resolves.toBeTruthy();
    const other = await run("kuber_income_breakdown", {}, { tenant: T, book: OTHER, principal: COPILOT, onBehalfOf: OWNER });
    expect((other.data as { total: string }).total).toBe("99900");
    const r = await new Copilot(cell, null, null, () => clock.value).ask({ tenant: T, book: OTHER, principal: SCOPED }, "trial balance");
    expect(r.outcome).toBe("refused");
    expect(r.cards).toEqual([]);
  });
});

describe("copilot, rules path", () => {
  it("answers the two failing questions with read cards, a trace and a complete turn record", async () => {
    const gov = new StubGovernance(cell);
    const c = new Copilot(cell, null, null, () => clock.value, gov);
    const coa = await c.ask({ tenant: T, book: B, principal: OWNER }, "Chart of Accounts Please?");
    expect(coa.cards[0]).toMatchObject({ kind: "read", op: "chart_of_accounts" });
    expect(coa.answeredFrom).toEqual(["kuber_chart_of_accounts"]);
    expect(coa.engine).toBe("rules");
    const sales = await c.ask({ tenant: T, book: B, principal: OWNER }, "Can you show the sales?");
    expect(sales.reply).toMatch(/Income FY 2026-27: ₹80,000/);
    expect(sales.answeredFrom).toEqual(["kuber_income_breakdown"]);
    const rec = gov.records.at(-1)!;
    expect(rec).toMatchObject({ engine: "rules", principal: COPILOT, onBehalfOf: OWNER, outcome: "answered", promptId: "router", grounding: { ok: true }, input: { ok: true } });
    expect(rec.tools).toEqual([expect.objectContaining({ tool: "kuber_income_breakdown", ok: true, reversibility: "none" })]);
    expect(gov.records).toHaveLength(2);
  });

  it("refuses out-of-scope requests through screenInput, and records the refusal", async () => {
    const gov = new StubGovernance(cell);
    const r = await new Copilot(cell, null, null, () => clock.value, gov).ask({ tenant: T, book: B, principal: OWNER }, "write a python script to sort a list");
    expect(r.outcome).toBe("refused");
    expect(r.reply).toMatch(/outside what Kuber does/);
    expect(gov.records.at(-1)).toMatchObject({ outcome: "refused", input: { ok: false, category: "out_of_scope" }, tools: [] });
  });

  it("a clarifying question instead of a guessed account, with nothing planned", async () => {
    const gov = new StubGovernance(cell);
    const r = await new Copilot(cell, null, null, () => clock.value, gov).ask({ tenant: T, book: B, principal: OWNER }, "record 2500 to office from bank");
    expect(r.reply).toMatch(/Which account/);
    expect(r.cards).toEqual([]);
    expect(r.suggestions?.length).toBeGreaterThan(0);
    expect(gov.records.at(-1)!.tools).toEqual([]);
  });
});

// ---------------------------------------------------------------- the bounded model loop
class Scripted implements Reasoner {
  readonly name = "fake:scripted";
  requests: NextStepRequest[] = [];
  composed: ComposeRequest[] = [];
  constructor(private script: (req: NextStepRequest) => NextStep | Promise<NextStep>, private reply?: (req: ComposeRequest) => string) {}
  async nextStep(req: NextStepRequest) { this.requests.push(structuredClone(req)); return this.script(req); }
  async compose(req: ComposeRequest) { this.composed.push(req); return { reply: this.reply ? this.reply(req) : req.draft ?? "" }; }
}
class SpyGovernance extends StubGovernance {
  screened: string[] = [];
  authorized: string[] = [];
  override screenToolOutput(tool: string, text: string) { this.screened.push(tool); return super.screenToolOutput(tool, text); }
  override async authorizeTool(tool: string, ctx: { tenant: string; book: string; onBehalfOf: string }) { this.authorized.push(tool); return super.authorizeTool(tool, ctx); }
}
const OPEN_ENDED = "Tell me something interesting about my finances lately";

describe("copilot, bounded model loop over a Reasoner", () => {
  it("runs only when the router cannot resolve; tools go through authorizeTool and screenToolOutput; the reply is recorded", async () => {
    const gov = new SpyGovernance(cell);
    const rs = new Scripted((req) => req.steps.length === 0 ? { action: "tool", tool: "kuber_search_journals", args: { text: "invoice" } } : { action: "final", draft: "Two invoices this year; the larger was ₹50,000." });
    const c = new Copilot(cell, rs, null, () => clock.value, gov);
    const routed = await c.ask({ tenant: T, book: B, principal: OWNER }, "sales this month");
    expect(routed.engine).toBe("rules");                                          // the fast path: no model call
    expect(rs.requests).toHaveLength(0);
    const r = await c.ask({ tenant: T, book: B, principal: OWNER }, OPEN_ENDED);
    expect(r.engine).toBe("fake:scripted");
    expect(r.outcome).toBe("answered");
    expect(r.reply).toBe("Two invoices this year; the larger was ₹50,000.");
    expect(r.answeredFrom).toEqual(["kuber_search_journals"]);
    expect(gov.authorized).toContain("kuber_search_journals");
    expect(gov.screened).toContain("kuber_search_journals");
    // the model saw the screened output (untrusted narrations wrapped as data), not the raw text
    expect(rs.requests[1]!.steps[0]!.output).toMatch(/^<<UNTRUSTED DATA/);
    expect(rs.requests[0]!.system.id).toBe("copilot.system");
    expect(rs.requests[0]!.system.text).toContain(`tenant ${T}, book ${B}`);
    const rec = gov.records.at(-1)!;
    const keys: (keyof TurnRecord)[] = ["turnId", "sessionId", "tenant", "book", "principal", "onBehalfOf", "engine", "promptId", "promptVersion", "promptHash",
      "input", "inputHash", "tools", "planIds", "grounding", "outcome", "steps", "ms"];
    for (const k of keys) expect(rec, k).toHaveProperty(k);
    expect(rec).toMatchObject({ tenant: T, book: B, principal: COPILOT, onBehalfOf: OWNER, engine: "fake:scripted", promptId: "copilot.system", outcome: "answered", steps: 2,
      grounding: { ok: true, ungrounded: [] }, input: { ok: true } });
    expect(rec.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.tools[0]).toMatchObject({ tool: "kuber_search_journals", ok: true, reversibility: "none" });
    expect(rec.tools[0]!.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never offers kuber_commit, and refuses it if the model asks for it anyway", async () => {
    const gov = new StubGovernance(cell);
    const rs = new Scripted((req) => req.steps.length === 0 ? { action: "tool", tool: "kuber_commit", args: { planId: "x", hash: "y" } } : { action: "final", draft: "I cannot commit plans." });
    const r = await new Copilot(cell, rs, null, () => clock.value, gov).ask({ tenant: T, book: B, principal: OWNER }, OPEN_ENDED);
    const offered = rs.requests[0]!.tools.map((t) => t.name);
    expect(offered).not.toContain("kuber_commit");
    expect(offered).toEqual(expect.arrayContaining(["kuber_chart_of_accounts", "kuber_income_breakdown", "kuber_record", "kuber_policies"]));
    expect(r.trace).toEqual([{ tool: "kuber_commit", ok: false }]);
    expect(gov.records.at(-1)!.tools[0]!.flags[0]).toMatch(/^denied:/);
    expect(rs.requests[1]!.steps[0]!.output).toMatch(/^Refused/);
  });

  it("stops at the step bound (8) and composes from what the tools returned", async () => {
    const gov = new StubGovernance(cell);
    const rs = new Scripted(() => ({ action: "tool", tool: "kuber_attention", args: {} }), (req) => `Stopped (${req.stopped}) after ${req.steps.length} steps.`);
    const r = await new Copilot(cell, rs, null, () => clock.value, gov).ask({ tenant: T, book: B, principal: OWNER }, OPEN_ENDED);
    expect(rs.requests).toHaveLength(8);
    expect(rs.composed[0]!.stopped).toBe("step_limit");
    expect(r.reply).toBe("Stopped (step_limit) after 8 steps.");
    expect(gov.records.at(-1)).toMatchObject({ steps: 8 });
    expect(gov.records.at(-1)!.tools).toHaveLength(8);
  });

  it("replaces an ungrounded reply with a grounded summary from tool data", async () => {
    const gov = new StubGovernance(cell);
    const rs = new Scripted((req) => req.steps.length === 0 ? { action: "tool", tool: "kuber_income_breakdown", args: {} } : { action: "final", draft: "You earned ₹99,999 this year." });
    const r = await new Copilot(cell, rs, null, () => clock.value, gov).ask({ tenant: T, book: B, principal: OWNER }, OPEN_ENDED);
    expect(r.reply).not.toContain("₹99,999");
    expect(r.reply).toContain("₹80,000");
    expect(r.reply).toMatch(/could not be verified/);
    expect(gov.records.at(-1)).toMatchObject({ outcome: "answered", grounding: { ok: false, ungrounded: ["₹99,999"] } });
    // with no tool data at all, nothing is stated and the outcome is an error
    const bare = new Scripted(() => ({ action: "final", draft: "Your cash is ₹12,34,567." }));
    const r2 = await new Copilot(cell, bare, null, () => clock.value, gov).ask({ tenant: T, book: B, principal: OWNER }, OPEN_ENDED);
    expect(r2.reply).not.toContain("12,34,567");
    expect(r2.outcome).toBe("error");
  });

  it("bounds the turn by time", async () => {
    const gov = new StubGovernance(cell);
    const slow: Reasoner = { name: "fake:slow", nextStep: () => new Promise(() => undefined), compose: async () => ({ reply: "never" }) };
    const r = await new Copilot(cell, slow, null, () => clock.value, gov, { turnTimeoutMs: 150 }).ask({ tenant: T, book: B, principal: OWNER }, OPEN_ENDED);
    expect(r.reply).toMatch(/ran out of time/);
    expect(gov.records.at(-1)!.engine).toBe("fake:slow");
  });

  it("when halted: reads are answered from rules, writes are refused, the model is not called", async () => {
    const gov = new StubGovernance(cell, { halted: () => true });
    const rs = new Scripted(() => ({ action: "final", draft: "should not run" }));
    const c = new Copilot(cell, rs, null, () => clock.value, gov);
    const who = { tenant: T, book: B, principal: OWNER };
    const read = await c.ask(who, "sales this month");
    expect(read).toMatchObject({ outcome: "answered", engine: "rules" });
    expect(read.reply).toContain("₹30,000");
    const write = await c.ask(who, "record 1499 printer ink to BIZEXP from bank");
    expect(write.outcome).toBe("halted");
    expect(write.reply).toMatch(/halted/);
    expect(write.cards).toEqual([]);
    expect((await c.ask(who, "Paid 450 to the plumber in cash")).outcome).toBe("halted");
    const open = await c.ask(who, OPEN_ENDED);
    expect(open.outcome).toBe("halted");
    expect(rs.requests).toHaveLength(0);
    expect(gov.records.map((x) => x.outcome)).toEqual(["answered", "halted", "halted", "halted"]);
  });

  it("the MCP catalogue keeps every tool, including kuber_commit, and the new read tools", () => {
    const names = kuberTools(cell, { tenant: T, book: B, principal: "agent:mcp-main" }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["kuber_commit", "kuber_accounts", "kuber_plans", "kuber_record", "kuber_chart_of_accounts", "kuber_trial_balance", "kuber_profit_and_loss",
      "kuber_balance_sheet", "kuber_ledger", "kuber_search_journals", "kuber_review_queue", "kuber_match_reviews", "kuber_income_breakdown", "kuber_expense_breakdown",
      "kuber_cash_position", "kuber_parties", "kuber_policies", "kuber_lifecycle", "kuber_attention", "kuber_schedules", "kuber_suspense"]));
  });
});
