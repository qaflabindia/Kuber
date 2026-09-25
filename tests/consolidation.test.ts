/**
 * Group-of-companies consolidation (CFO requirements FIN-GRP-01..04; design 6.4 group tenancy,
 * 6.5 "Groups of companies").
 *
 * The controlled fixture, in one group tenant (all amounts in rupees):
 *
 *   P  parent            capital 10,00,000; buys goods 40,000 and sells them to S for 50,000 (INV-100);
 *                        external sales 2,00,000, expenses 1,20,000; invests 1,00,000 in S and 20,000 in A;
 *                        sends S 10,000 cash (TRF-1)                                    profit 90,000
 *   S  80% subsidiary    equity at acquisition: capital 1,00,000 + reserves 20,000; buys P's goods 50,000,
 *                        20,000 of them unsold at the period end (closing stock); sales 1,00,000,
 *                        expenses 30,000; receives only 9,800 of TRF-1 (bank charges)     profit 40,000
 *   A  30% associate     capital 50,000; sales 60,000, expenses 20,000                    profit 40,000
 *   F  100%, functional currency USD: excluded (never translated)
 *
 * Expected figures are computed by hand here, not by the module (see HAND below).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { uuid, type Line } from "@kuber/contracts";
import { Keyring } from "@kuber/crypto";
import { EventStore } from "@kuber/eventstore";
import { consolidate as engine, matchIc, perimeter, emptyGroup, type EntityPack, type GroupState } from "@kuber/consolidation";
import type { Plan } from "@kuber/ops";
import { KeyAdmin, buildServer, kuberTools, type Cell } from "@kuber/core";
import type { FastifyInstance } from "fastify";
import { CORE_AUTH_SECRET, enrol, signedInject, startCell } from "./helpers.ts";

const T = "grp", SUB = "subco";
const PE = "2026-09-30";
const P = { owner: "owner:ravi", ctl: "controller:asha", pAppr: "approver:pia", sAppr: "approver:sam", scoped: "controller:narrow", subOwner: "owner:lina", subCtl: "controller:lee" };
const BOOK = { P: "p-main", S: "s-main", A: "a-main", G: "grp-consol", L: "l-main" };
const R = (rupees: number) => BigInt(Math.round(rupees * 100));
const L = (accountId: string, rupees: number, extra: Partial<Line> = {}): Line => ({ accountId, amount: R(rupees).toString(), dimensions: {}, ...extra });
const clock = { value: "2026-10-05" };
let cell: Cell, stop: () => Promise<void>, dbOwnerUrl: string;
let app: FastifyInstance, send: ReturnType<typeof signedInject>;

const post = (tenant: string, book: string, date: string, lines: Line[], narration = "fixture") =>
  cell.gl.execute(tenant, book, { kind: "PostJournal", journalId: uuid(), txnDate: date, narration, lines }, { principal: P.owner.startsWith("owner") && tenant === SUB ? P.subOwner : P.owner });
const plan = (op: string, input: unknown, who = P.ctl, book = BOOK.G) => cell.ops.plan(T, book, who, op, input);
const commit = (p: Plan, who = P.owner) => cell.ops.commit(T, p.planId, who, p.hash);
const planCommit = async (op: string, input: unknown) => {
  const p = await plan(op, input);
  expect(p.checks.filter((c) => c.blocking && !c.ok)).toEqual([]);
  expect((await commit(p)).status).toBe("committed");
  return p;
};
const data = <T>(p: Plan) => p.data as T;
const EXTRA = [
  { accountId: "STOCK", name: "Stock in trade", nature: "asset", taxonomyTag: "BS.inventories" },
  { accountId: "SALES", name: "Sales", nature: "income", taxonomyTag: "PL.revenue" },
  { accountId: "PURCH", name: "Purchases", nature: "expense", taxonomyTag: "PL.purchases" },
  { accountId: "RESERVES", name: "Reserves and surplus", nature: "equity", taxonomyTag: "BS.reserves" },
] as const;

async function openCompany(tenant: string, book: string, entity: string, who: string) {
  await cell.gl.openBook(tenant, book, entity.toLowerCase(), "company", who, { legalEntityId: entity, framework: "Ind AS" });
  for (const a of EXTRA) await cell.gl.execute(tenant, book, { kind: "AddAccount", account: { ...a, isControl: false, isCashLike: false, requiredDims: [] } }, { principal: who });
}
async function certifyTb(tenant: string, book: string, who = P.owner) {
  await cell.settle();
  return cell.reporting.certify(tenant, book, "trial-balance", { asOf: PE }, who);
}
/** Seq, version, chain head and verification of each local book: must not change through consolidation. */
async function fingerprint(books: string[]) {
  const out: Record<string, unknown> = {};
  for (const b of books) { const s = await cell.gl.state(T, b); out[b] = { seq: s.seq, version: s.version, lastHash: s.lastHash, broken: await cell.gl.verify(T, b, { full: true }) }; }
  return out;
}

// ----------------------------------------------------------------------------- hand-computed expectations
/**
 * Aggregate (P + S, mapped by statement mapping), debit positive:
 *   cash 9,10,000 + 1,99,800 = 11,09,800   investments 1,20,000   receivables 60,000   stock 20,000
 *   share capital -11,00,000   reserves -20,000   payables -59,800   revenue -3,50,000   purchases 70,000   other expenses 1,50,000
 * Eliminations:
 *   ic-balance P|S   matched min(60,000, 59,800) = 59,800: Cr receivables, Dr payables. 200 stays open (TRF-1).
 *   ic-pl P>S        P's income from S 50,000 vs S's expense with P 50,000: Dr revenue 50,000, Cr purchases 50,000
 *   urp P>S          stock 20,000 x 20% margin = 4,000: Dr unrealised profit, Cr stock (downstream: no NCI share)
 *   investment S     Dr capital 1,00,000, Dr reserves 20,000, Cr investment 1,00,000, Cr NCI 20% x 1,20,000 = 24,000,
 *                    goodwill = 1,00,000 + 24,000 - 1,20,000 = 4,000
 *   nci S            NCI 20% x S profit 40,000 = 8,000 (ownership in force on 30 Sep: 80%, although 90% from 1 Oct)
 *   equity A         30% x A profit 40,000 = 12,000 to investments in associates / share of profit
 * Consolidated: income 3,00,000 + 12,000 = 3,12,000; expenses 20,000 + 1,50,000 + 4,000 = 1,74,000; profit 1,38,000;
 *   NCI 8,000; owners 1,30,000 (= P 90,000 + 80% x 40,000 + 30% x 40,000 - 4,000).
 *   Assets 11,09,800 + 20,000 + 200 + 16,000 + 4,000 + 12,000 = 11,62,000; owners' equity 10,00,000 + 1,30,000; NCI 32,000 (= 20% x 1,60,000).
 */
const HAND = {
  journals: {
    "ic-balance:P|S": { "BS.trade_receivables": -59800, "BS.trade_payables": 59800 },
    "ic-pl:P>S": { "PL.revenue": 50000, "PL.purchases": -50000 },
    "urp:P>S": { "GRP.unrealised_profit": 4000, "BS.inventories": -4000 },
    "investment:S": { "BS.share_capital": 100000, "BS.reserves": 20000, "BS.investments": -100000, "GRP.nci": -24000, "GRP.goodwill": 4000 },
    "nci:S": { "GRP.nci_profit": 8000, "GRP.nci": -8000 },
    "equity:A": { "GRP.equity_investees": 12000, "GRP.share_of_associates": -12000 },
  } as Record<string, Record<string, number>>,
  tb: { "BS.cash": 1109800, "BS.investments": 20000, "BS.trade_receivables": 200, "BS.inventories": 16000, "GRP.goodwill": 4000, "GRP.equity_investees": 12000,
    "BS.share_capital": -1000000, "GRP.nci": -32000, "PL.revenue": -300000, "PL.purchases": 20000, "PL.other_expenses": 150000,
    "GRP.unrealised_profit": 4000, "GRP.share_of_associates": -12000, "GRP.nci_profit": 8000 } as Record<string, number>,
  pnl: { totalIncome: 312000, totalExpenses: 174000, profit: 138000, nci: 8000, owners: 130000 },
  bs: { totalAssets: 1162000, totalLiabilities: 0, totalEquity: 1130000, nci: 32000, check: 0 },
};

beforeAll(async () => {
  const f = await startCell(clock);
  cell = f.cell; stop = f.stop; dbOwnerUrl = f.db.ownerUrl;
  await enrol(cell, T, [P.owner, P.ctl]);
  await enrol(cell, T, [P.pAppr], [BOOK.P]);
  await enrol(cell, T, [P.sAppr], [BOOK.S]);
  await enrol(cell, T, [P.scoped], [BOOK.G, BOOK.P, BOOK.A]);
  await enrol(cell, SUB, [P.subOwner, P.subCtl]);
  for (const [book, ent] of [[BOOK.P, "P"], [BOOK.S, "S"], [BOOK.A, "A"]] as const) await openCompany(T, book, ent, P.owner);
  await cell.parties.register(T, P.owner, { partyId: "p-s", entityId: "P", kind: "customer", name: "S Ltd (group)", effectiveFrom: "2026-04-01" });
  await cell.parties.register(T, P.owner, { partyId: "s-p", entityId: "S", kind: "vendor", name: "P Ltd (group)", effectiveFrom: "2026-04-01" });
  // P
  await post(T, BOOK.P, "2026-04-01", [L("BANK", 1000000), L("CAPITAL", -1000000)]);
  await post(T, BOOK.P, "2026-04-01", [L("INVEST", 100000), L("BANK", -100000)], "investment in S");
  await post(T, BOOK.P, "2026-04-01", [L("INVEST", 20000), L("BANK", -20000)], "investment in A");
  await post(T, BOOK.P, "2026-05-15", [L("PURCH", 40000), L("BANK", -40000)]);
  await post(T, BOOK.P, "2026-06-10", [L("DEBTORS", 50000, { partyId: "p-s", dimensions: { ic_ref: "INV-100" } }), L("SALES", -50000)], "goods to S");
  await post(T, BOOK.P, "2026-07-01", [L("BANK", 200000), L("SALES", -200000)]);
  await post(T, BOOK.P, "2026-08-01", [L("BIZEXP", 120000), L("BANK", -120000)]);
  await post(T, BOOK.P, "2026-09-20", [L("DEBTORS", 10000, { partyId: "p-s", dimensions: { ic_ref: "TRF-1" } }), L("BANK", -10000)], "cash to S");
  // S
  await post(T, BOOK.S, "2026-04-01", [L("BANK", 120000), L("CAPITAL", -100000), L("RESERVES", -20000)]);
  await post(T, BOOK.S, "2026-06-12", [L("PURCH", 50000), L("CREDITORS", -50000, { partyId: "s-p", dimensions: { ic_ref: "INV-100" } })], "goods from P");
  await post(T, BOOK.S, "2026-07-10", [L("BANK", 100000), L("SALES", -100000)]);
  await post(T, BOOK.S, "2026-08-10", [L("BIZEXP", 30000), L("BANK", -30000)]);
  await post(T, BOOK.S, "2026-09-22", [L("BANK", 9800), L("CREDITORS", -9800, { partyId: "s-p", dimensions: { ic_ref: "TRF-1" } })], "cash from P, net of bank charges");
  await post(T, BOOK.S, PE, [L("STOCK", 20000), L("PURCH", -20000)], "closing stock (bought from P at transfer price)");
  // A
  await post(T, BOOK.A, "2026-04-01", [L("BANK", 50000), L("CAPITAL", -50000)]);
  await post(T, BOOK.A, "2026-07-01", [L("BANK", 60000), L("SALES", -60000)]);
  await post(T, BOOK.A, "2026-08-01", [L("BIZEXP", 20000), L("BANK", -20000)]);

  // The group, its register (every change a plan a person commits).
  await cell.consolidation.defineGroup(T, P.owner, { groupId: "g1", name: "P Group", bookId: BOOK.G, parentEntityId: "P" });
  await planCommit("group_structure", { entities: [
    { entityId: "P", name: "P Ltd", bookId: BOOK.P, linkedTenant: null, functionalCurrency: "INR" },
    { entityId: "S", name: "S Ltd", bookId: BOOK.S, linkedTenant: null, functionalCurrency: "INR" },
    { entityId: "A", name: "A Ltd", bookId: BOOK.A, linkedTenant: null, functionalCurrency: "INR" },
    { entityId: "F", name: "F Inc (USA)", bookId: null, linkedTenant: null, functionalCurrency: "USD" }] });
  const acqS = { date: "2026-04-01", costPaise: R(100000).toString(), investmentAccount: "INVEST", equity: [{ accountId: "CAPITAL", amountPaise: R(100000).toString() }, { accountId: "RESERVES", amountPaise: R(20000).toString() }] };
  await planCommit("group_ownership", { parentEntityId: "P", childEntityId: "S", effectiveFrom: "2026-04-01", ownershipBp: 8000, votingBp: 8000, control: "control", method: "full", acquisition: acqS });
  // A later step acquisition, effective after the period end: it must not change the 30 September NCI.
  await planCommit("group_ownership", { parentEntityId: "P", childEntityId: "S", effectiveFrom: "2026-10-01", ownershipBp: 9000, votingBp: 9000, control: "control", method: "full", acquisition: acqS });
  await planCommit("group_ownership", { parentEntityId: "P", childEntityId: "A", effectiveFrom: "2026-04-01", ownershipBp: 3000, votingBp: 3000, control: "significant_influence", method: "equity",
    acquisition: { date: "2026-04-01", costPaise: R(20000).toString(), investmentAccount: "INVEST", equity: [{ accountId: "CAPITAL", amountPaise: R(50000).toString() }] } });
  await planCommit("group_ownership", { parentEntityId: "P", childEntityId: "F", effectiveFrom: "2026-04-01", ownershipBp: 10000, votingBp: 10000, control: "control", method: "full",
    acquisition: { date: "2026-04-01", costPaise: "0", investmentAccount: "INVEST", equity: [{ accountId: "CAPITAL", amountPaise: "0" }] } });
  await planCommit("group_ic_link", { entityId: "P", partyId: "p-s", counterpartyEntityId: "S" });
  await planCommit("group_ic_link", { entityId: "S", partyId: "s-p", counterpartyEntityId: "P" });
  app = buildServer(cell, { clock: () => clock.value, auth: { secret: CORE_AUTH_SECRET } });
  send = signedInject(app);
}, 120_000);
afterAll(async () => { await app?.close(); await stop(); });

const STOCK = [{ sellerEntityId: "P", buyerEntityId: "S", closingStockPaise: R(20000).toString(), marginBp: 2000, buyerInventoryAccount: "STOCK" }];
const byAccount = (lines: { accountId: string; amount: string | bigint }[]) => Object.fromEntries(lines.map((l) => [l.accountId, Number(BigInt(l.amount)) / 100]));

describe("FIN-GRP-03 group structure, perimeter and consolidation", () => {
  let before: Record<string, unknown>;
  let run: Plan;

  it("FIN-GRP-03 the register is effective-dated, and plans change it only when a person commits", async () => {
    const g = await cell.consolidation.group(T, "g1");
    expect(g.entities.map((e) => e.entityId)).toEqual(["P", "S", "A", "F"]);
    const perim = perimeter(g, PE);
    const s = perim.find((p) => p.entityId === "S")!;
    expect([s.method, s.ownershipBp, Number(s.nci.num * 10000n / s.nci.den)]).toEqual(["full", 8000, 2000]);
    expect(perimeter(g, "2026-10-15").find((p) => p.entityId === "S")!.ownershipBp).toBe(9000);
    expect(perimeter(g, PE).find((p) => p.entityId === "A")!.method).toBe("equity");
    // The method must follow the control assessment; an agent may prepare but never commit a register change.
    const bad = await plan("group_ownership", { parentEntityId: "P", childEntityId: "A", effectiveFrom: "2026-11-01", ownershipBp: 3000, votingBp: 3000, control: "significant_influence", method: "full" });
    expect(bad.blocked).toBe(true);
    expect(bad.checks.filter((c) => !c.ok).map((c) => c.detail).join(" ")).toMatch(/full consolidation needs control/);
    const ok = await plan("group_ownership", { parentEntityId: "P", childEntityId: "A", effectiveFrom: "2026-11-01", ownershipBp: 2000, votingBp: 2000, control: "none", method: "excluded", exclusionReason: "influence lost" });
    expect(ok.gate).toBe("human");
    await cell.ops.discard(T, ok.planId, P.ctl);
  });

  it("FIN-GRP-03 a foreign-currency entity is excluded with a visible line, never translated", async () => {
    const p = await plan("group_perimeter", { asOf: PE });
    const f = data<{ perimeter: { entityId: string; method: string; exclusion: string | null }[] }>(p).perimeter.find((x) => x.entityId === "F")!;
    expect(f.method).toBe("excluded");
    expect(f.exclusion).toMatch(/functional currency USD is not INR.*never translated/);
    expect(p.sections.find((s) => s.title.startsWith("Excluded entities"))!.rows.map((r) => r[0])).toContain("F");
  });

  it("FIN-GRP-03 the three-entity fixture reproduces the hand-computed eliminations, group balances and NCI; journals post only to the consolidation book", async () => {
    for (const b of [BOOK.P, BOOK.S, BOOK.A]) await certifyTb(T, b);
    before = await fingerprint([BOOK.P, BOOK.S, BOOK.A]);
    run = await plan("consolidate", { periodEnd: PE, stock: STOCK });
    expect(run.checks.filter((c) => c.blocking && !c.ok)).toEqual([]);
    expect(run.bookId).toBe(BOOK.G);
    const js = run.journals.filter((j) => j.voucherType === "consolidation");
    const got = Object.fromEntries(data<{ journals: { journalId: string; key: string }[] }>(run).journals.map((j) => [j.key, byAccount(js.find((x) => x.journalId === j.journalId)!.lines)]));
    expect(got).toEqual(HAND.journals);
    // every computation is shown
    expect(run.sections.find((s) => s.title.includes("[investment:S]"))!.rows.flat().join("\n")).toMatch(/goodwill = cost ₹1,00,000.00 \+ NCI ₹24,000.00 − equity ₹1,20,000.00 = ₹4,000.00/);
    expect(run.sections.find((s) => s.title.includes("[urp:P>S]"))!.rows.flat().join("\n")).toMatch(/₹20,000.00 × 20.00% = ₹4,000.00/);
    // an agent can never commit it; a person does
    expect(run.needsPerson).toBe(true);
    expect((await commit(run)).status).toBe("committed");
    const s = await cell.gl.state(T, BOOK.G);
    expect(s.config.basis).toBe("consolidation");
    expect([...s.journals.values()].every((j) => j.voucherType === "consolidation")).toBe(true);
    // group statements
    const tb = data<{ trialBalance: { accountId: string; consolidated: string }[] }>(await plan("group_trial_balance", { periodEnd: PE }));
    expect(Object.fromEntries(tb.trialBalance.filter((r) => r.consolidated !== "0").map((r) => [r.accountId, Number(BigInt(r.consolidated)) / 100]))).toEqual(HAND.tb);
    const pnl = data<Record<string, string>>(await plan("group_pnl", { periodEnd: PE }));
    expect(Object.fromEntries(Object.entries(HAND.pnl).map(([k]) => [k, Number(BigInt(pnl[k]!)) / 100]))).toEqual(HAND.pnl);
    const bs = data<Record<string, string>>(await plan("group_balance_sheet", { periodEnd: PE }));
    expect(Object.fromEntries(Object.entries(HAND.bs).map(([k]) => [k, Number(BigInt(bs[k]!)) / 100]))).toEqual(HAND.bs);
    const nci = data<{ nci: { entityId: string; nciBalance: string; nciProfit: string; netAssets: string }[] }>(await plan("nci", { periodEnd: PE })).nci;
    expect(nci.map((n) => [n.entityId, Number(BigInt(n.netAssets)) / 100, Number(BigInt(n.nciProfit)) / 100, Number(BigInt(n.nciBalance)) / 100])).toEqual([["S", 160000, 8000, 32000]]);
  });

  it("FIN-GRP-03 local books are unchanged by eliminations (seq, version, chain head and digests)", async () => {
    expect(await fingerprint([BOOK.P, BOOK.S, BOOK.A])).toEqual(before);
    // and the ledger keeps consolidation vouchers and local books apart
    await expect(cell.gl.execute(T, BOOK.P, { kind: "PostJournal", journalId: uuid(), txnDate: PE, narration: "x", voucherType: "consolidation", lines: [L("BANK", 1), L("CAPITAL", -1)] }, { principal: P.owner }))
      .rejects.toThrow(/consolidation vouchers post only to a consolidation book/);
    await expect(cell.gl.execute(T, BOOK.G, { kind: "PostJournal", journalId: uuid(), txnDate: PE, narration: "x", lines: [L("GRP.goodwill", 1), L("GRP.nci", -1)] }, { principal: P.owner }))
      .rejects.toThrow(/consolidation book: it accepts only consolidation vouchers/);
  });

  it("FIN-GRP-03 unrealised profit: downstream is borne by the owners, upstream shares it with NCI (engine, hand figures)", () => {
    // Upstream: S (80%) sells to P; 10,000 of stock at 25% margin in P's closing stock = 2,500, NCI 20% = 500.
    const g: GroupState = { ...emptyGroup(), exists: true, groupId: "u", parentEntityId: "P", entities: [
      { entityId: "P", name: "P", bookId: "p", linkedTenant: null, functionalCurrency: "INR" }, { entityId: "S", name: "S", bookId: "s", linkedTenant: null, functionalCurrency: "INR" }],
      ownership: [{ recordId: "r", parentEntityId: "P", childEntityId: "S", effectiveFrom: "2026-04-01", ownershipBp: 8000, votingBp: 8000, control: "control", method: "full", marginBp: 2500, planId: "x", principal: "owner:x",
        acquisition: { date: "2026-04-01", costPaise: "8000", investmentAccount: "INVEST", equity: [{ accountId: "CAPITAL", amountPaise: "10000" }] } }] };
    const tb = (rows: [string, string, number][]) => rows.map(([accountId, nature, bal]) => ({ accountId, name: accountId, nature: nature as never, taxonomyTag: null, balance: R(bal) }));
    const pack = (entityId: string, rows: [string, string, number][]): EntityPack => ({ entityId, source: "certified", tb: tb(rows), ic: { balances: [], txns: [] }, packHash: entityId, ref: {} });
    const packs = new Map([["P", pack("P", [["INVEST", "asset", 80], ["STOCK", "asset", 10000], ["BANK", "asset", -10080], ["CAPITAL", "equity", 0]])],
      ["S", pack("S", [["BANK", "asset", 100], ["CAPITAL", "equity", -100]])]]);
    const r = engine(g, PE, "2026-04-01", perimeter(g, PE), packs, [{ sellerEntityId: "S", buyerEntityId: "P", closingStockPaise: R(10000), buyerInventoryAccount: "STOCK" }]);
    const urp = r.journals.find((j) => j.key === "urp:S>P")!;
    expect(byAccount(urp.lines)).toEqual({ "GRP.unrealised_profit": 2500, "UNMAPPED.P.STOCK": -2500, "GRP.nci": 500, "GRP.nci_profit": -500 });
    expect(urp.computation.join("\n")).toMatch(/margin: 25.00% of transfer price \(register\)/);
  });
});

describe("FIN-GRP-01/02 intercompany matching and disputes", () => {
  let disputeId = "";
  const items = async () => data<{ items: { key: string; status: string; classification: string; sent: string; received: string; difference: string; explanation: string }[] }>(await plan("ic_mismatches", { periodEnd: PE })).items;

  it("FIN-GRP-01 ₹10,000 sent against ₹9,800 received leaves ₹200 open and visible; no plug entry", async () => {
    const it2 = await items();
    expect(it2.find((i) => i.key === "P>S|INV-100|INR")).toMatchObject({ status: "matched", sent: String(R(50000)), received: String(R(50000)) });
    const trf = it2.find((i) => i.key === "P>S|TRF-1|INR")!;
    expect(trf).toMatchObject({ status: "in_transit", classification: "amount", sent: String(R(10000)), received: String(R(9800)), difference: String(R(200)) });
    expect(trf.explanation).toMatch(/₹200.00 open .*no plug entry/);
    // the group balances keep it open too: receivables 200 after elimination, and it is listed
    const run = (await cell.consolidation.runs(T, "g1")).find((r) => r.status === "active")!;
    expect(run.journals.map((j) => j.key)).not.toContain("plug");
    const tb = data<{ trialBalance: { accountId: string; consolidated: string }[] }>(await plan("group_trial_balance", { periodEnd: PE }));
    expect(tb.trialBalance.find((r) => r.accountId === "BS.trade_receivables")!.consolidated).toBe(String(R(200)));
  });

  it("FIN-GRP-02 mismatches in period, tax and FX are classified (matching engine)", () => {
    const t = (entityId: string, cp: string, ref: string, control: number, extra: Record<string, unknown> = {}) => ({ entityId, counterpartyEntityId: cp, journalId: uuid(), seq: 1,
      txnDate: "2026-09-10", period: "2026-09", docRef: ref, currency: "INR", control: R(control), tax: 0n, pl: 0n, plLines: [], ...extra });
    const r = matchIc([
      t("P", "S", "D1", 1000), t("S", "P", "D1", -1000, { txnDate: "2026-10-02", period: "2026-10" }),
      t("P", "S", "D2", 1180, { tax: R(-180) }), t("S", "P", "D2", -1000),
      t("P", "S", "D3", 500, { currency: "USD" }), t("S", "P", "D3", -480, { currency: "USD" }),
    ]);
    expect(r.map((i) => [i.docRef, i.status, i.classification])).toEqual([["D1", "mismatch", "period"], ["D2", "mismatch", "tax"], ["D3", "mismatch", "fx"]]);
  });

  it("FIN-GRP-02 a dispute is resolved only when both sides' approvers record the same position; one person cannot do both", async () => {
    ({ disputeId } = await cell.consolidation.openDispute(T, P.ctl, "g1", { itemKey: "P>S|TRF-1|INR", periodEnd: PE, reason: "S says it received 9,800" }));
    expect((await items()).find((i) => i.key === "P>S|TRF-1|INR")!.status).toBe("disputed");
    // P's approver cannot speak for S (no rights in S's book)
    await expect(cell.consolidation.recordPosition(T, P.pAppr, disputeId, { entityId: "S", agreedPaise: R(10000), note: "S owes the full amount" })).rejects.toThrow(/no access to book s-main/);
    // a person with both books records P's position; the same person may not also record S's
    await cell.consolidation.recordPosition(T, P.owner, disputeId, { entityId: "P", agreedPaise: R(10000), note: "we sent 10,000" });
    await expect(cell.consolidation.recordPosition(T, P.owner, disputeId, { entityId: "S", agreedPaise: R(10000), note: "agree" })).rejects.toThrow(/bilateral resolution/);
    // S's approver disagrees first: still open
    expect((await cell.consolidation.recordPosition(T, P.sAppr, disputeId, { entityId: "S", agreedPaise: R(9800), note: "only 9,800 arrived" })).status).toBe("open");
    const r = await cell.consolidation.recordPosition(T, P.sAppr, disputeId, { entityId: "S", agreedPaise: R(10000), note: "200 was our bank's charge" });
    expect(r.status).toBe("resolved");
    expect((await items()).find((i) => i.key === "P>S|TRF-1|INR")!.status).toBe("resolved");
  });

  it("FIN-GRP-02 no entry is ever created in another entity: the engine only proposes each side's plan in its own book", async () => {
    const fp = await fingerprint([BOOK.P, BOOK.S, BOOK.A]);
    const { plans, skipped } = await cell.consolidation.proposeAdjustments(T, P.ctl, disputeId, { P: "BIZEXP", S: "BIZEXP" }, { date: PE });
    expect(skipped).toEqual([]);
    const byBook = Object.fromEntries(plans.map((p) => [p.bookId, p]));
    // P already holds the agreed amount: nothing to do there (preview, blocked); S's plan is proposed in S's own book.
    expect(byBook[BOOK.P]!.status).toBe("preview");
    expect(byBook[BOOK.S]!.status).toBe("proposed");
    expect(byBook[BOOK.S]!.journals.map((j) => byAccount(j.lines))).toEqual([{ CREDITORS: -200, BIZEXP: 200 }]);
    // proposing changed nothing anywhere
    expect(await fingerprint([BOOK.P, BOOK.S, BOOK.A])).toEqual(fp);
    // P's people cannot approve S's adjustment; S's approver can
    await expect(cell.ops.commit(T, byBook[BOOK.S]!.planId, P.pAppr, byBook[BOOK.S]!.hash)).rejects.toThrow(/no access to book s-main|s-main/);
    expect((await cell.ops.commit(T, byBook[BOOK.S]!.planId, P.sAppr, byBook[BOOK.S]!.hash)).status).toBe("committed");
    const after = await fingerprint([BOOK.P, BOOK.A]);
    expect(after).toEqual({ [BOOK.P]: fp[BOOK.P], [BOOK.A]: fp[BOOK.A] });
    expect((await items()).find((i) => i.key === "P>S|TRF-1|INR")!.status).toBe("matched");
  });
});

describe("FIN-GRP-04 certified group close", () => {
  let v1 = { snapshotId: "", contentHash: "" };

  it("FIN-GRP-04 a missing or uncertified entity pack blocks certification, naming the entity", async () => {
    const p = await plan("certify_group", { periodEnd: "2026-08-31" });
    expect(p.blocked).toBe(true);
    const failed = p.checks.filter((c) => c.blocking && !c.ok).map((c) => c.label);
    expect(failed).toEqual(expect.arrayContaining(["Certified pack from P", "Certified pack from S", "Certified pack from A"]));
    expect(p.checks.find((c) => c.label === "Certified pack from S")!.detail).toMatch(/no certified trial balance of s-main as of 2026-08-31/);
  });

  it("FIN-GRP-04 certification ties to the certified packs, the register, the rules and the eliminations; a rerun reproduces the same hash", async () => {
    // S changed (its IC adjustment): its old certified pack no longer matches the run, so certification is blocked until the run is redone.
    await certifyTb(T, BOOK.S);
    const stale = await plan("certify_group", { periodEnd: PE });
    expect(stale.checks.find((c) => c.label.startsWith("The run used exactly"))!.ok).toBe(false);
    const rerun = await plan("consolidate", { periodEnd: PE, stock: STOCK });
    expect(rerun.journals.filter((j) => j.narration.startsWith("Reverse consolidation run v1")).length).toBe(6);
    expect((await commit(rerun)).status).toBe("committed");
    const c = await plan("certify_group", { periodEnd: PE });
    expect(c.checks.filter((x) => x.blocking && !x.ok)).toEqual([]);
    const body = data<{ contentHash: string; body: { inputs: { entityId: string; packHash: string; source: string }[]; registerVersion: number; rulesVersion: string; eliminations: unknown[] } }>(c);
    expect(body.body.inputs.map((i) => [i.entityId, i.source])).toEqual([["A", "certified"], ["P", "certified"], ["S", "certified"]]);
    expect(body.body.inputs.every((i) => /^[0-9a-f]{64}$/.test(i.packHash))).toBe(true);
    expect(body.body.rulesVersion).toBe("kuber-consolidation/1");
    expect(body.body.eliminations).toHaveLength(6);
    expect((await commit(c)).status).toBe("committed");
    const closes = await cell.consolidation.closes(T, "g1");
    expect(closes.map((x) => [x.version, x.previous_snapshot_id])).toEqual([[1, null]]);
    v1 = { snapshotId: closes[0]!.snapshot_id, contentHash: closes[0]!.content_hash };
    expect(v1.contentHash).toBe(body.contentHash);
    // rerun on identical packs and rules: the same hash, and no new version
    const again = await plan("certify_group", { periodEnd: PE });
    expect(data<{ contentHash: string }>(again).contentHash).toBe(v1.contentHash);
    expect(((await commit(again)) as { steps: string[] }).steps.join()).toMatch(/already certified as version 1/);
    expect((await cell.consolidation.reproduce(T, v1.snapshotId)).matches).toBe(true);
    // after the IC adjustment: S profit 39,800, NCI 20% = 7,960; owners 90,000 + 31,840 + 12,000 - 4,000 = 1,29,840
    const pnl = data<Record<string, string>>(await plan("group_pnl", { periodEnd: PE }));
    expect([pnl.nci, pnl.owners].map((x) => Number(BigInt(x!)) / 100)).toEqual([7960, 129840]);
  });

  it("FIN-GRP-04 a later correction is a new version linked to the previous one", async () => {
    await post(T, BOOK.A, PE, [L("BIZEXP", 1000), L("BANK", -1000)], "late invoice");
    await certifyTb(T, BOOK.A);
    expect((await commit(await plan("consolidate", { periodEnd: PE, stock: STOCK }))).status).toBe("committed");
    const c = await plan("certify_group", { periodEnd: PE });
    expect(c.title).toMatch(/correction of v1/);
    expect((await commit(c)).status).toBe("committed");
    const closes = await cell.consolidation.closes(T, "g1");
    expect(closes.map((x) => [x.version, x.previous_snapshot_id])).toEqual([[1, null], [2, v1.snapshotId]]);
    expect(closes[1]!.content_hash).not.toBe(v1.contentHash);
    // A's profit 39,000 x 30% = 11,700 in the corrected version
    const snap = await cell.consolidation.close(T, closes[1]!.snapshot_id);
    expect(snap!.verified).toBe(true);
    expect(snap!.body.eliminations.map((e) => e.key)).toContain("equity:A");
    expect(Number(BigInt((snap!.body.statements as { pnl: { totalIncome: string } }).pnl.totalIncome)) / 100).toBe(300000 + 11700);
  });
});

describe("FIN-GRP scope: the acting person's scope must cover every entity", () => {
  it("FIN-GRP reads return the permitted subset and name the excluded entities; plans are blocked", async () => {
    const tb = await plan("group_trial_balance", { periodEnd: PE }, P.scoped);
    const d = data<{ excluded: { entityId: string; reason: string }[] }>(tb);
    expect(d.excluded).toEqual(expect.arrayContaining([{ entityId: "S", reason: "outside your book scope" }]));
    expect(tb.checks.find((c) => c.label.includes("book scope"))!.detail).toMatch(/S \(s-main\)/);
    const run = await plan("consolidate", { periodEnd: PE, stock: STOCK }, P.scoped);
    expect(run.blocked).toBe(true);
    expect(run.status).toBe("preview");
    // the copilot works within the person it acts for
    const tools = kuberTools(cell, { tenant: T, book: BOOK.G, principal: "agent:copilot", onBehalfOf: P.scoped });
    const names = tools.map((t) => t.name);
    for (const n of ["kuber_group_trial_balance", "kuber_group_pnl", "kuber_group_balance_sheet", "kuber_ic_mismatches", "kuber_nci", "kuber_group_perimeter", "kuber_consolidate", "kuber_certify_group"]) expect(names).toContain(n);
    const r = await tools.find((t) => t.name === "kuber_group_perimeter")!.run({ asOf: PE });
    expect(r.text).toMatch(/outside your book scope/);
  });

  it("FIN-GRP the group routes answer under /v1/tenants/:t/groups", async () => {
    const res = await send({ method: "GET", url: `/v1/tenants/${T}/groups/g1/reports/balance-sheet?periodEnd=${PE}`, tenant: T, principal: P.ctl });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.check).toBe("0");
    const closes = await send({ method: "GET", url: `/v1/tenants/${T}/groups/g1/closes`, tenant: T, principal: P.ctl });
    expect(closes.json()).toHaveLength(2);
    const denied = await send({ method: "POST", url: `/v1/tenants/${T}/groups/g1/links`, tenant: T, principal: P.ctl, payload: { subsidiaryTenant: SUB, entityId: "L" } });
    expect(denied.statusCode).toBe(403);                                    // settings.manage: the owner
  });
});

describe("FIN-GRP-04 linked tenants", () => {
  let link1 = "", link2 = "";
  const groupPlan = (op: string, input: unknown) => cell.ops.plan(T, "grp2-consol", P.ctl, op, input);

  beforeAll(async () => {
    await openCompany(SUB, BOOK.L, "L", P.subOwner);
    await cell.gl.execute(SUB, BOOK.L, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-04-01", narration: "capital", lines: [L("BANK", 40000), L("CAPITAL", -40000)] }, { principal: P.subOwner });
    await cell.gl.execute(SUB, BOOK.L, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-08-01", narration: "sales", lines: [L("BANK", 8000), L("SALES", -8000)] }, { principal: P.subOwner });
    await certifyTb(SUB, BOOK.L, P.subOwner);
    await cell.consolidation.defineGroup(T, P.owner, { groupId: "g2", name: "P Group with a linked associate", bookId: "grp2-consol", parentEntityId: "P" });
    const s1 = await groupPlan("group_structure", { entities: [{ entityId: "P", name: "P Ltd", bookId: BOOK.P, linkedTenant: null, functionalCurrency: "INR" },
      { entityId: "L", name: "L Ltd (own tenant)", bookId: null, linkedTenant: SUB, functionalCurrency: "INR" }] });
    await cell.ops.commit(T, s1.planId, P.owner, s1.hash);
    const o = await groupPlan("group_ownership", { parentEntityId: "P", childEntityId: "L", effectiveFrom: "2026-04-01", ownershipBp: 2500, votingBp: 2500, control: "significant_influence", method: "equity" });
    await cell.ops.commit(T, o.planId, P.owner, o.hash);
  });

  it("FIN-GRP-04 linking needs consent in both tenants: the group's owner requests, the subsidiary's owner accepts", async () => {
    await expect(cell.consolidation.links.request(T, P.ctl, { subsidiaryTenant: SUB, groupId: "g2", entityId: "L" })).rejects.toThrow(/may not settings.manage/);
    ({ linkId: link1 } = await cell.consolidation.links.request(T, P.owner, { subsidiaryTenant: SUB, groupId: "g2", entityId: "L" }));
    expect((await cell.consolidation.links.list(SUB)).map((l) => [l.role, l.status])).toEqual([["subsidiary", "requested"]]);
    // nothing can be published before acceptance; the subsidiary's controller cannot accept
    await expect(cell.consolidation.links.publish(SUB, P.subOwner, link1, { bookId: BOOK.L, periodEnd: PE })).rejects.toThrow(/link is requested/);
    await expect(cell.consolidation.links.accept(SUB, P.subCtl, link1)).rejects.toThrow(/may not settings.manage/);
    await cell.consolidation.links.accept(SUB, P.subOwner, link1);
    expect((await cell.consolidation.links.list(T)).find((l) => l.linkId === link1)!.status).toBe("active");
    expect((await cell.consolidation.links.list(SUB)).find((l) => l.linkId === link1)!.status).toBe("active");
  });

  it("FIN-GRP-04 the subsidiary publishes a signed, hash-chained pack; it counts as the entity's certified pack and the group never reads the subsidiary's ledger", async () => {
    const pub = await cell.consolidation.links.publish(SUB, P.subOwner, link1, { bookId: BOOK.L, periodEnd: PE });
    expect(pub.prevPackHash).toBe("0".repeat(64));
    const pub2 = await cell.consolidation.links.publish(SUB, P.subOwner, link1, { bookId: BOOK.L, periodEnd: PE });
    expect(pub2.prevPackHash).toBe(pub.packHash);                          // hash chain
    const opened = await cell.consolidation.links.open(T, pub2.packId);
    expect(opened.available).toBe(true);
    // Everything the group does from here touches only the group tenant's data.
    const touched = new Set<string>();
    const spy = <K extends keyof typeof cell.store>(k: K) => {
      const orig = (cell.store[k] as (...a: unknown[]) => unknown).bind(cell.store);
      const at = k === "append" ? 1 : 0;                                  // append(module, tenant, …); the others take the tenant first
      (cell.store as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { if (typeof a[at] === "string") touched.add(a[at] as string); return orig(...a); };
      return () => { (cell.store as unknown as Record<string, unknown>)[k] = orig; };
    };
    const glState = cell.gl.state.bind(cell.gl);
    cell.gl.state = (t: string, b: string) => { touched.add(t); return glState(t, b); };
    const undo = [spy("tenantTx"), spy("readStream"), spy("append")];
    try {
      const run = await groupPlan("consolidate", { periodEnd: PE });
      expect(run.checks.filter((c) => c.blocking && !c.ok)).toEqual([]);
      expect(run.sections[0]!.rows.find((r) => r[0] === "L")![5]).toBe("linked");
      await cell.ops.commit(T, run.planId, P.owner, run.hash);
      const cert = await groupPlan("certify_group", { periodEnd: PE });
      expect(cert.checks.find((c) => c.label === "Certified pack from L")!.ok).toBe(true);
      await groupPlan("group_trial_balance", { periodEnd: PE });
    } finally { undo.forEach((u) => u()); cell.gl.state = glState; }
    expect([...touched]).toEqual([T]);
    // L's profit 8,000 x 25% = 2,000 under the equity method, from the pack alone
    const eq = (await groupPlan("consolidate", { periodEnd: PE })).sections.find((s) => s.title.includes("[equity:L]"))!;
    expect(eq.rows.flat().join("\n")).toMatch(/25.00% = ₹2,000.00/);
  });

  it("FIN-GRP-04 either side can revoke: publishing stops and the link's packs no longer count", async () => {
    await cell.consolidation.links.revoke(SUB, P.subOwner, link1, "board decision");
    expect((await cell.consolidation.links.list(T)).find((l) => l.linkId === link1)!.status).toBe("revoked");
    await expect(cell.consolidation.links.publish(SUB, P.subOwner, link1, { bookId: BOOK.L, periodEnd: PE })).rejects.toThrow(/link is revoked/);
    const cert = await groupPlan("certify_group", { periodEnd: PE });
    expect(cert.checks.find((c) => c.label === "Certified pack from L")).toMatchObject({ ok: false, detail: expect.stringMatching(/link is revoked/) });
  });

  it("FIN-GRP-04 a crypto-shredded subsidiary's packs become unreadable in the group", async () => {
    ({ linkId: link2 } = await cell.consolidation.links.request(T, P.owner, { subsidiaryTenant: SUB, groupId: "g2", entityId: "L" }));
    await cell.consolidation.links.accept(SUB, P.subOwner, link2);
    const pub = await cell.consolidation.links.publish(SUB, P.subOwner, link2, { bookId: BOOK.L, periodEnd: PE });
    expect((await cell.consolidation.links.open(T, pub.packId)).available).toBe(true);
    const owner = postgres(dbOwnerUrl, { max: 2, onnotice: () => undefined });
    try {
      const keyring = new Keyring(owner, cell.keyring.kms, 0);
      await new KeyAdmin(owner, keyring, new EventStore(owner, "admin", { keyring }), 0).shred(SUB, "operator:test", "tenant exit");
    } finally { await owner.end(); }
    cell.keyring.invalidate(SUB);
    const o = await cell.consolidation.links.open(T, pub.packId);
    expect(o).toMatchObject({ available: false, reason: expect.stringMatching(/crypto-shredded/) });
    const cert = await groupPlan("certify_group", { periodEnd: PE });
    expect(cert.checks.find((c) => c.label === "Certified pack from L")).toMatchObject({ ok: false, detail: expect.stringMatching(/crypto-shredded/) });
    // the group itself is unaffected: its own pack metadata and group reads still work
    expect((await cell.consolidation.links.packs(T)).length).toBe(3);
  });
});
