/**
 * The consolidation computation (FIN-GRP-03), pure and deterministic: the same packs, register and
 * stated inputs always give the same journals, in the same order, with the same content hashes.
 *
 * Aggregation: every entity consolidated in full (and the parent) contributes its trial balance,
 * each account mapped to a group account. Associates are not aggregated (equity method). Excluded
 * entities (by the register, or a non-INR functional currency) contribute nothing and are listed.
 *
 * Eliminations (journals for the consolidation book only; local books are never touched):
 *   ic-balance   reciprocal IC balances: the matched amount of A's balance with B against B's with A.
 *                Any difference stays in the group balances as an open item (never plugged).
 *   ic-pl        IC income of the seller against the buyer's IC expense, for the matched amount.
 *   investment   investment in a subsidiary against its equity at acquisition: 100% of that equity
 *                debited, cost credited, NCI credited at its share of that equity; the difference is
 *                goodwill (debit) or capital reserve (credit). Facts from the register.
 *   urp          unrealised profit in the buyer's closing stock bought within the group: stock at
 *                transfer price x margin, debited to profit and credited to stock; when the seller has
 *                NCI (upstream sale), NCI bears its share.
 *   nci          NCI share of the subsidiary's post-acquisition equity movement and of its profit for
 *                the period, at the ownership % in force on the period end.
 *   equity       equity method: the investor's share of the associate's profit (and post-acquisition
 *                reserve movement) added to the investment.
 */
import { canonical, sha256 } from "@kuber/contracts";
import type { Nature } from "./types.ts";
import type { IcSchedule } from "./ic.ts";
import { bp, minus, one, pct, share, type Fraction, type GroupState, type PerimeterEntry, ownershipOn } from "./register.ts";

/** Version of these rules: part of every run's input hash and every group snapshot. */
export const RULES_VERSION = "kuber-consolidation/2";

export interface TbRow { accountId: string; name: string; nature: Nature; taxonomyTag: string | null; balance: bigint }
/** One entity's input: its trial balance at the period end and its IC schedule at the same ledger position. */
export interface EntityPack {
  entityId: string;
  /** certified: a certified local trial balance; linked: a linked tenant's certified pack; live: the ledger now (not certifiable). */
  source: "certified" | "linked" | "live";
  tb: TbRow[]; ic: IcSchedule; packHash: string;
  ref: Record<string, unknown>;
}
export interface StockInput { sellerEntityId: string; buyerEntityId: string; closingStockPaise: bigint; marginBp?: number; buyerInventoryAccount: string }

export interface GroupAccount { accountId: string; name: string; nature: Nature }
export interface ConsolLine { accountId: string; amount: bigint; dimensions: Record<string, string> }
export interface ConsolJournal { key: string; step: string; narration: string; lines: ConsolLine[]; computation: string[]; contentHash: string }
export interface NciRow { entityId: string; nci: string; netAssets: bigint; nciNetAssets: bigint; profit: bigint; nciProfit: bigint; nciBalance: bigint }
export interface OpenIc { kind: "balance" | "pl"; a: string; b: string; aAmount: bigint; bAmount: bigint; difference: bigint; explanation: string }
export interface EngineResult {
  groupAccounts: Map<string, GroupAccount>;
  /** Aggregated (mapped) balances before eliminations, per group account, with each entity's part. */
  aggregate: Map<string, { total: bigint; byEntity: Record<string, bigint> }>;
  journals: ConsolJournal[];
  nci: NciRow[];
  exclusions: { entityId: string; reason: string }[];
  openIc: OpenIc[];
  problems: string[];
  inputHash: string; rulesHash: string;
}

export const SPECIAL: Record<string, GroupAccount> = {
  "GRP.goodwill": { accountId: "GRP.goodwill", name: "Goodwill on consolidation", nature: "asset" },
  "GRP.capital_reserve": { accountId: "GRP.capital_reserve", name: "Capital reserve on consolidation", nature: "equity" },
  "GRP.nci": { accountId: "GRP.nci", name: "Non-controlling interest", nature: "equity" },
  "GRP.nci_profit": { accountId: "GRP.nci_profit", name: "Profit attributable to non-controlling interest", nature: "expense" },
  "GRP.unrealised_profit": { accountId: "GRP.unrealised_profit", name: "Unrealised profit on intra-group stock", nature: "expense" },
  "GRP.equity_investees": { accountId: "GRP.equity_investees", name: "Investments in associates (share of post-acquisition results)", nature: "asset" },
  "GRP.share_of_associates": { accountId: "GRP.share_of_associates", name: "Share of profit of associates", nature: "income" },
  "GRP.associates_reserves": { accountId: "GRP.associates_reserves", name: "Share of post-acquisition reserves of associates", nature: "equity" },
};

const rs = (p: bigint) => { const n = p < 0n ? -p : p; return `${p < 0n ? "-" : ""}₹${(n / 100n).toLocaleString("en-IN")}.${String(n % 100n).padStart(2, "0")}`; };
const abs = (x: bigint) => (x < 0n ? -x : x);
const humanize = (tag: string) => { const t = tag.replace(/^[A-Z]+\./, "").replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

/** The group account of an entity account: the register's override, else the account's statement mapping. */
export function mapAccount(g: GroupState, entityId: string, row: Pick<TbRow, "accountId" | "name" | "taxonomyTag">): { accountId: string; name: string } {
  const o = g.mapping.get(`${entityId}|${row.accountId}`);
  if (o) return { accountId: o.groupAccount, name: o.name };
  if (row.taxonomyTag?.trim()) return { accountId: row.taxonomyTag, name: humanize(row.taxonomyTag) };
  return { accountId: `UNMAPPED.${entityId}.${row.accountId}`, name: `Unmapped: ${row.name} (${entityId})` };
}

export function rulesHashOf(g: GroupState, stock: StockInput[]) {
  return sha256(canonical({ rules: RULES_VERSION, mapping: [...g.mapping].sort(([a], [b]) => a.localeCompare(b)),
    stock: stock.map((s) => ({ ...s, closingStockPaise: s.closingStockPaise.toString() })).sort((a, b) => `${a.sellerEntityId}>${a.buyerEntityId}`.localeCompare(`${b.sellerEntityId}>${b.buyerEntityId}`)) }));
}

export function inputHashOf(g: GroupState, periodEnd: string, perim: PerimeterEntry[], packs: Map<string, EntityPack>, rulesHash: string) {
  return sha256(canonical({ groupId: g.groupId, periodEnd, registerVersion: g.version, rulesHash,
    entities: perim.map((p) => ({ entityId: p.entityId, method: p.method, interest: `${p.interest.num}/${p.interest.den}`, packHash: packs.get(p.entityId)?.packHash ?? null }))
      .sort((a, b) => a.entityId.localeCompare(b.entityId)) }));
}

export const journalContentHash = (j: Pick<ConsolJournal, "key" | "narration" | "lines">, periodEnd: string) =>
  sha256(canonical({ key: j.key, txnDate: periodEnd, narration: j.narration, lines: j.lines.map((l) => ({ accountId: l.accountId, amount: l.amount.toString(), dimensions: l.dimensions })) }));

export function consolidate(g: GroupState, periodEnd: string, periodStart: string, perim: PerimeterEntry[], packs: Map<string, EntityPack>, stock: StockInput[]): EngineResult {
  const problems: string[] = [];
  // End-of-period packs cannot separate pre-acquisition results or calculate disposal gains.
  // Block these cases instead of silently consolidating a whole year's results at closing ownership.
  for (const r of g.ownership) {
    if (r.effectiveFrom <= periodStart || r.effectiveFrom > periodEnd) continue;
    const opening = ownershipOn(g, periodStart, r.childEntityId);
    if (!opening || opening.parentEntityId !== r.parentEntityId || opening.ownershipBp !== r.ownershipBp || opening.method !== r.method) {
      problems.push(`${r.childEntityId}: mid-period ownership change on ${r.effectiveFrom} needs acquisition/disposal stub-period packs; consolidation is blocked until these are supported`);
    }
  }
  for (const p of perim) {
    const acquired = p.record?.acquisition?.date;
    if (p.method !== "excluded" && acquired && acquired > periodStart && acquired <= periodEnd) {
      problems.push(`${p.entityId}: acquisition on ${acquired} needs a post-acquisition stub-period pack; consolidation is blocked until these are supported`);
    }
  }
  const groupAccounts = new Map<string, GroupAccount>();
  const aggregate = new Map<string, { total: bigint; byEntity: Record<string, bigint> }>();
  const exclusions = perim.filter((p) => p.method === "excluded").map((p) => ({ entityId: p.entityId, reason: p.exclusion ?? "excluded" }));
  const consolidated = perim.filter((p) => p.method === "parent" || p.method === "full");
  const byId = new Map(perim.map((p) => [p.entityId, p]));

  // ---------------------------------------------------------------- mapping and aggregation
  const mapped = new Map<string, Map<string, { accountId: string; nature: Nature }>>();   // entity -> entity account -> group account
  const addAccount = (id: string, name: string, nature: Nature, why: string) => {
    const had = groupAccounts.get(id);
    if (had && had.nature !== nature) problems.push(`group account ${id} is mapped from accounts of different natures (${had.nature}, ${nature} from ${why}): fix the group chart mapping`);
    if (!had) groupAccounts.set(id, { accountId: id, name, nature });
  };
  for (const p of perim) {
    const pack = packs.get(p.entityId);
    if (!pack || p.method === "excluded") continue;
    const m = new Map<string, { accountId: string; nature: Nature }>();
    for (const r of pack.tb) {
      const ga = mapAccount(g, p.entityId, r);
      m.set(r.accountId, { accountId: ga.accountId, nature: r.nature });
      if (p.method === "equity") continue;                                // associates are not aggregated
      addAccount(ga.accountId, ga.name, r.nature, `${p.entityId}/${r.accountId}`);
      const a = aggregate.get(ga.accountId) ?? { total: 0n, byEntity: {} };
      a.total += r.balance; a.byEntity[p.entityId] = (a.byEntity[p.entityId] ?? 0n) + r.balance;
      aggregate.set(ga.accountId, a);
    }
    mapped.set(p.entityId, m);
  }
  for (const s of Object.values(SPECIAL)) groupAccounts.set(s.accountId, s);
  const gaOf = (entityId: string, accountId: string, nature?: Nature) => {
    const hit = mapped.get(entityId)?.get(accountId);
    if (hit) return hit.accountId;
    // An account with no balance in the pack (e.g. the buyer's stock account named in a stated input): map it all the same.
    const ga = mapAccount(g, entityId, { accountId, name: accountId, taxonomyTag: null });
    if (nature) addAccount(ga.accountId, ga.name, nature, `${entityId}/${accountId}`);
    return ga.accountId;
  };

  const journals: Omit<ConsolJournal, "contentHash">[] = [];
  const dims = (step: string, subject: string) => ({ grp_step: step, grp_subject: subject });
  const add = (step: string, subject: string, narration: string, lines: [string, bigint][], computation: string[]) => {
    const merged = new Map<string, bigint>();
    for (const [a, v] of lines) merged.set(a, (merged.get(a) ?? 0n) + v);
    const ls = [...merged].filter(([, v]) => v !== 0n).map(([accountId, amount]) => ({ accountId, amount, dimensions: dims(step, subject) }));
    if (ls.length < 2) return;
    const total = ls.reduce((s, l) => s + l.amount, 0n);
    if (total !== 0n) { problems.push(`internal: ${step} ${subject} does not balance by ${total} paise`); return; }
    journals.push({ key: `${step}:${subject}`, step, narration, lines: ls, computation });
  };
  /** Spread `amount` (towards zero of the side's balances) over the side's IC accounts, in account order. */
  const spread = (bals: { accountId: string; balance: bigint }[], amount: bigint): [string, bigint][] => {
    const out: [string, bigint][] = [];
    let left = amount;
    for (const b of bals) {
      if (left === 0n) break;
      const take = abs(b.balance) < left ? abs(b.balance) : left;
      out.push([b.accountId, b.balance > 0n ? -take : take]);
      left -= take;
    }
    return out;
  };

  // ---------------------------------------------------------------- 1. reciprocal IC balances
  const openIc: OpenIc[] = [];
  const ids = consolidated.map((p) => p.entityId).sort();
  for (let i = 0; i < ids.length; i++) for (let k = i + 1; k < ids.length; k++) {
    const a = ids[i]!, b = ids[k]!;
    const side = (x: string, y: string) => (packs.get(x)?.ic.balances ?? []).filter((r) => r.counterpartyEntityId === y)
      .map((r) => ({ accountId: gaOf(x, r.accountId), entityAccount: r.accountId, balance: r.balance }));
    const ab = side(a, b), ba = side(b, a);
    const na = ab.reduce((s, r) => s + r.balance, 0n), nb = ba.reduce((s, r) => s + r.balance, 0n);
    if (na === 0n && nb === 0n) continue;
    const m = na !== 0n && nb !== 0n && (na > 0n) !== (nb > 0n) ? (abs(na) < abs(nb) ? abs(na) : abs(nb)) : 0n;
    if (m > 0n) {
      add("ic-balance", `${a}|${b}`, `Eliminate intercompany balances ${a} / ${b}`, [...spread(ab.filter((r) => (r.balance > 0n) === (na > 0n)), m), ...spread(ba.filter((r) => (r.balance > 0n) === (nb > 0n)), m)], [
        `${a}'s balance with ${b}: ${rs(na)} (${ab.map((r) => `${r.entityAccount} → ${r.accountId} ${rs(r.balance)}`).join(", ")})`,
        `${b}'s balance with ${a}: ${rs(nb)} (${ba.map((r) => `${r.entityAccount} → ${r.accountId} ${rs(r.balance)}`).join(", ")})`,
        `eliminated: the matched amount min(|${rs(na)}|, |${rs(nb)}|) = ${rs(m)}`,
        ...(na + nb !== 0n ? [`not eliminated: ${rs(na + nb)} stays open in the group balances (in transit or disputed; no plug entry)`] : []),
      ]);
    }
    if (na + nb !== 0n) openIc.push({ kind: "balance", a, b, aAmount: na, bAmount: nb, difference: na + nb,
      explanation: `${a} holds ${rs(na)} with ${b}, ${b} holds ${rs(nb)} with ${a}: ${rs(abs(na + nb))} open, shown in the group balances, not plugged` });
  }

  // ---------------------------------------------------------------- 2. IC income and expense
  for (const x of ids) for (const y of ids) {
    if (x === y) continue;
    const inPeriod = (e: string, cp: string) => (packs.get(e)?.ic.txns ?? []).filter((t) => t.counterpartyEntityId === cp && t.txnDate >= periodStart && t.txnDate <= periodEnd);
    const inc = new Map<string, bigint>(), exp = new Map<string, bigint>();
    for (const t of inPeriod(x, y)) for (const l of t.plLines) if (l.nature === "income") inc.set(l.accountId, (inc.get(l.accountId) ?? 0n) + l.amount);
    for (const t of inPeriod(y, x)) for (const l of t.plLines) if (l.nature === "expense") exp.set(l.accountId, (exp.get(l.accountId) ?? 0n) + l.amount);
    const incomeX = -[...inc.values()].reduce((s, v) => s + v, 0n), expenseY = [...exp.values()].reduce((s, v) => s + v, 0n);
    if (incomeX <= 0n || expenseY <= 0n) {
      if (incomeX > 0n) openIc.push({ kind: "pl", a: x, b: y, aAmount: incomeX, bAmount: expenseY, difference: incomeX - expenseY,
        explanation: `${x} recorded ${rs(incomeX)} of income from ${y}; ${y} recorded no matching expense in the period: not eliminated, open` });
      continue;
    }
    const m = incomeX < expenseY ? incomeX : expenseY;
    const incRows = [...inc].map(([a, v]) => ({ accountId: gaOf(x, a, "income"), balance: v })), expRows = [...exp].map(([a, v]) => ({ accountId: gaOf(y, a, "expense"), balance: v }));
    add("ic-pl", `${x}>${y}`, `Eliminate intercompany income of ${x} from ${y} against ${y}'s expense`, [...spread(incRows, m), ...spread(expRows, m)], [
      `${x}'s income from ${y} (${periodStart} to ${periodEnd}): ${rs(incomeX)}`, `${y}'s expense with ${x}: ${rs(expenseY)}`, `eliminated: ${rs(m)}`,
      ...(incomeX !== expenseY ? [`not eliminated: ${rs(abs(incomeX - expenseY))} (open)`] : []),
    ]);
    if (incomeX !== expenseY) openIc.push({ kind: "pl", a: x, b: y, aAmount: incomeX, bAmount: expenseY, difference: incomeX - expenseY,
      explanation: `${x}'s income from ${y} ${rs(incomeX)} against ${y}'s expense ${rs(expenseY)}: ${rs(abs(incomeX - expenseY))} open` });
  }

  // ---------------------------------------------------------------- 3-6: per subsidiary and associate
  const nci: NciRow[] = [];
  const profitOf = (e: string) => -(packs.get(e)?.tb ?? []).filter((r) => r.nature === "income" || r.nature === "expense").reduce((s, r) => s + r.balance, 0n);
  const equityOf = (e: string) => {
    const out = new Map<string, bigint>();
    for (const r of packs.get(e)?.tb ?? []) if (r.nature === "equity") { const ga = gaOf(e, r.accountId); out.set(ga, (out.get(ga) ?? 0n) - r.balance); }
    return out;                                                           // credit positive
  };
  const urpNci = new Map<string, bigint>();                              // upstream URP borne by a subsidiary's NCI

  // 5 first: unrealised profit (its NCI share feeds the NCI row)
  for (const st of stock) {
    const seller = byId.get(st.sellerEntityId), buyer = byId.get(st.buyerEntityId);
    const inFull = (p: PerimeterEntry | undefined) => !!p && (p.method === "parent" || p.method === "full");
    if (st.sellerEntityId === st.buyerEntityId || st.closingStockPaise < 0n) {
      problems.push(`unrealised profit ${st.sellerEntityId} → ${st.buyerEntityId}: needs different entities and non-negative closing stock`); continue;
    }
    const associate = seller?.method === "equity" ? seller : buyer?.method === "equity" ? buyer : undefined;
    if (associate) {
      const other = associate === seller ? buyer : seller;
      // The current packs do not carry subsidiary attribution for an associate held through a chain.
      if (other?.method !== "parent" || associate.investor !== other.entityId) {
        problems.push(`unrealised profit ${st.sellerEntityId} → ${st.buyerEntityId}: associate stock elimination currently requires its direct group parent`); continue;
      }
      const margin = st.marginBp ?? seller?.record?.marginBp;
      if (margin === undefined || !Number.isInteger(margin) || margin < 0 || margin > 10000) {
        problems.push(`unrealised profit ${st.sellerEntityId} → ${st.buyerEntityId}: needs a margin between 0 and 10000 basis points`); continue;
      }
      const totalProfit = share(st.closingStockPaise, bp(margin));
      const eliminated = share(totalProfit, associate.interest);
      const upstream = associate === seller;
      const creditAccount = upstream ? gaOf(st.buyerEntityId, st.buyerInventoryAccount, "asset") : "GRP.equity_investees";
      add("urp-associate", `${st.sellerEntityId}>${st.buyerEntityId}`, `Eliminate the group's share of unrealised profit on ${upstream ? "upstream" : "downstream"} stock with associate ${associate.entityId}`,
        [[upstream ? "GRP.share_of_associates" : "GRP.unrealised_profit", eliminated], [creditAccount, -eliminated]], [
          `closing stock at transfer price ${rs(st.closingStockPaise)} × margin ${(margin / 100).toFixed(2)}% = unrealised profit ${rs(totalProfit)}`,
          `group interest in ${associate.entityId} ${pct(associate.interest)} × ${rs(totalProfit)} = ${rs(eliminated)} eliminated`,
          upstream ? "reduce share of associate profit and the parent's inventory" : "reduce group profit and the investment in the associate",
        ]);
      continue;
    }
    if (!inFull(seller) || !inFull(buyer)) { problems.push(`unrealised profit ${st.sellerEntityId} → ${st.buyerEntityId}: entities must be inside the consolidation perimeter`); continue; }
    const margin = st.marginBp ?? seller!.record?.marginBp;
    if (margin === undefined) { problems.push(`unrealised profit ${st.sellerEntityId} → ${st.buyerEntityId}: no margin in the register or the input`); continue; }
    const urp = share(st.closingStockPaise, bp(margin));
    const stockAcc = gaOf(st.buyerEntityId, st.buyerInventoryAccount, "asset");
    const nciShare = seller!.method === "full" ? share(urp, seller!.nci) : 0n;
    if (nciShare) urpNci.set(st.sellerEntityId, (urpNci.get(st.sellerEntityId) ?? 0n) + nciShare);
    add("urp", `${st.sellerEntityId}>${st.buyerEntityId}`, `Eliminate unrealised profit in ${st.buyerEntityId}'s stock bought from ${st.sellerEntityId}`,
      [["GRP.unrealised_profit", urp], [stockAcc, -urp], ...(nciShare ? [["GRP.nci", nciShare], ["GRP.nci_profit", -nciShare]] as [string, bigint][] : [])], [
        `closing stock in ${st.buyerEntityId} at transfer price: ${rs(st.closingStockPaise)} (${st.buyerInventoryAccount} → ${stockAcc})`,
        `margin: ${(margin / 100).toFixed(2)}% of transfer price (${st.marginBp !== undefined ? "stated input" : "register"})`,
        `unrealised profit = ${rs(st.closingStockPaise)} × ${(margin / 100).toFixed(2)}% = ${rs(urp)}: debit profit, credit stock`,
        ...(nciShare ? [`upstream sale: NCI of ${st.sellerEntityId} (${pct(seller!.nci)}) bears ${rs(nciShare)}`] : [`${seller!.method === "parent" ? "downstream sale by the parent" : "seller has no NCI"}: borne wholly by the owners of the parent`]),
      ]);
  }

  for (const p of perim) {
    const r = p.record;
    if (p.method === "full" && r) {
      const acq = r.acquisition;
      const investor = r.parentEntityId, direct = bp(r.ownershipBp);
      if (!acq) { problems.push(`${p.entityId}: full consolidation needs acquisition facts in the register`); continue; }
      if (!packs.get(investor) && byId.get(investor)?.method !== "excluded") problems.push(`${p.entityId}: no pack for its investor ${investor}`);
      const eqAcq = acq.equity.map((e) => ({ ga: gaOf(p.entityId, e.accountId, "equity"), entityAccount: e.accountId, amount: BigInt(e.amountPaise) }));
      const totalAcq = eqAcq.reduce((s, e) => s + e.amount, 0n);
      const cost = BigInt(acq.costPaise);
      const nciAcq = share(totalAcq, minus(one, direct));
      const diff = cost + nciAcq - totalAcq;
      const invAcc = gaOf(investor, acq.investmentAccount, "asset");
      add("investment", p.entityId, `Eliminate ${investor}'s investment in ${p.entityId} against its equity at acquisition (${acq.date})`, [
        ...eqAcq.map((e) => [e.ga, e.amount] as [string, bigint]), [invAcc, -cost], ["GRP.nci", -nciAcq],
        diff >= 0n ? ["GRP.goodwill", diff] : ["GRP.capital_reserve", diff],
      ], [
        `equity of ${p.entityId} at acquisition: ${eqAcq.map((e) => `${e.entityAccount} → ${e.ga} ${rs(e.amount)}`).join(" + ")} = ${rs(totalAcq)} (debited in full)`,
        `cost of investment in ${investor}'s ${acq.investmentAccount} (→ ${invAcc}): ${rs(cost)} (credited)`,
        `NCI at acquisition = ${pct(minus(one, direct))} × ${rs(totalAcq)} = ${rs(nciAcq)} (credited)`,
        diff >= 0n ? `goodwill = cost ${rs(cost)} + NCI ${rs(nciAcq)} − equity ${rs(totalAcq)} = ${rs(diff)}` : `capital reserve = equity ${rs(totalAcq)} − cost ${rs(cost)} − NCI ${rs(nciAcq)} = ${rs(-diff)}`,
      ]);
      // NCI share of post-acquisition equity movement and of the period's profit.
      const eqNow = equityOf(p.entityId);
      const acqBy = new Map<string, bigint>(); for (const e of eqAcq) acqBy.set(e.ga, (acqBy.get(e.ga) ?? 0n) + e.amount);
      const moveLines: [string, bigint][] = [], moveText: string[] = [];
      let nciMove = 0n;
      for (const ga of [...new Set([...eqNow.keys(), ...acqBy.keys()])].sort()) {
        const move = (eqNow.get(ga) ?? 0n) - (acqBy.get(ga) ?? 0n);
        if (move === 0n) continue;
        const s = share(move, p.nci);
        if (s === 0n) continue;
        moveLines.push([ga, s], ["GRP.nci", -s]); nciMove += s;
        moveText.push(`post-acquisition movement in ${ga}: ${rs(eqNow.get(ga) ?? 0n)} − ${rs(acqBy.get(ga) ?? 0n)} = ${rs(move)}; NCI ${pct(p.nci)} = ${rs(s)}`);
      }
      const profit = profitOf(p.entityId), nciProfit = share(profit, p.nci);
      const netAssets = [...eqNow.values()].reduce((s, v) => s + v, 0n) + profit;
      if (p.nci.num !== 0n) {
        add("nci", p.entityId, `Non-controlling interest in ${p.entityId}: share of post-acquisition equity and profit`, [...moveLines, ["GRP.nci_profit", nciProfit], ["GRP.nci", -nciProfit]], [
          `ownership in force on ${periodEnd}: ${pct(p.interest)} (record ${r.recordId}, effective ${r.effectiveFrom}); NCI ${pct(p.nci)}`,
          ...moveText,
          `profit of ${p.entityId} for the period (income − expenses in its pack): ${rs(profit)}; NCI share ${pct(p.nci)} = ${rs(nciProfit)}`,
        ]);
      }
      const upstream = urpNci.get(p.entityId) ?? 0n;
      const nciBalance = nciAcq + nciMove + nciProfit - upstream;
      nci.push({ entityId: p.entityId, nci: pct(p.nci), netAssets, nciNetAssets: share(netAssets, p.nci), profit, nciProfit: nciProfit - upstream, nciBalance });
    }
    if (p.method === "equity" && r) {
      const profit = profitOf(p.entityId), s = share(profit, p.interest);
      const lines: [string, bigint][] = [["GRP.equity_investees", s], ["GRP.share_of_associates", -s]];
      const text = [`profit of associate ${p.entityId} for the period: ${rs(profit)}`, `investor's share ${pct(p.interest)} = ${rs(s)}: added to the investment, credited to share of profit`];
      if (r.acquisition) {
        const eqNow = equityOf(p.entityId);
        const acqTotal = r.acquisition.equity.reduce((t, e) => t + BigInt(e.amountPaise), 0n);
        const nowTotal = [...eqNow.values()].reduce((t, v) => t + v, 0n);
        const move = share(nowTotal - acqTotal, p.interest);
        if (move) { lines.push(["GRP.equity_investees", move], ["GRP.associates_reserves", -move]); text.push(`share of post-acquisition equity movement ${rs(nowTotal - acqTotal)} × ${pct(p.interest)} = ${rs(move)}`); }
      }
      add("equity", p.entityId, `Equity method: ${r.parentEntityId}'s share of associate ${p.entityId}`, lines, text);
    }
  }

  const rulesHash = rulesHashOf(g, stock);
  const inputHash = inputHashOf(g, periodEnd, perim, packs, rulesHash);
  return { groupAccounts, aggregate, journals: journals.map((j) => ({ ...j, contentHash: journalContentHash(j, periodEnd) })), nci, exclusions, openIc, problems, inputHash, rulesHash };
}

/** Consolidated balances: the aggregate plus elimination lines (debit positive). */
export function consolidatedBalances(res: Pick<EngineResult, "aggregate">, eliminations: Iterable<{ accountId: string; amount: bigint }>) {
  const out = new Map<string, { entities: bigint; eliminations: bigint; consolidated: bigint }>();
  for (const [a, v] of res.aggregate) out.set(a, { entities: v.total, eliminations: 0n, consolidated: v.total });
  for (const l of eliminations) {
    const x = out.get(l.accountId) ?? { entities: 0n, eliminations: 0n, consolidated: 0n };
    x.eliminations += l.amount; x.consolidated += l.amount; out.set(l.accountId, x);
  }
  return out;
}

export interface GroupStatements {
  trialBalance: { accountId: string; name: string; nature: Nature; entities: bigint; eliminations: bigint; consolidated: bigint }[];
  pnl: { income: { accountId: string; name: string; amount: bigint }[]; expenses: { accountId: string; name: string; amount: bigint }[];
    totalIncome: bigint; totalExpenses: bigint; profit: bigint; nci: bigint; owners: bigint };
  balanceSheet: { assets: { accountId: string; name: string; amount: bigint }[]; liabilities: { accountId: string; name: string; amount: bigint }[];
    equity: { accountId: string; name: string; amount: bigint }[]; surplus: bigint; nci: bigint;
    totalAssets: bigint; totalLiabilities: bigint; totalEquity: bigint; check: bigint };
}

/** The group's TB, P&L and balance sheet from consolidated balances (NCI shown separately). */
export function statements(accounts: Map<string, GroupAccount>, bal: Map<string, { entities: bigint; eliminations: bigint; consolidated: bigint }>): GroupStatements {
  const rows = [...bal].map(([id, v]) => ({ accountId: id, name: accounts.get(id)?.name ?? id, nature: accounts.get(id)?.nature ?? "asset" as Nature, ...v }))
    .filter((r) => r.entities !== 0n || r.eliminations !== 0n).sort((a, b) => a.accountId.localeCompare(b.accountId));
  const pick = (n: Nature, sign: bigint, skip: string[] = []) => rows.filter((r) => r.nature === n && r.consolidated !== 0n && !skip.includes(r.accountId))
    .map((r) => ({ accountId: r.accountId, name: r.name, amount: r.consolidated * sign }));
  const income = pick("income", -1n), expenses = pick("expense", 1n, ["GRP.nci_profit"]);
  const totalIncome = income.reduce((s, r) => s + r.amount, 0n), totalExpenses = expenses.reduce((s, r) => s + r.amount, 0n);
  const nciProfit = bal.get("GRP.nci_profit")?.consolidated ?? 0n;
  const profit = totalIncome - totalExpenses;
  const assets = pick("asset", 1n), liabilities = pick("liability", -1n), equity = pick("equity", -1n, ["GRP.nci"]);
  const nciBal = -(bal.get("GRP.nci")?.consolidated ?? 0n);
  const surplus = profit - nciProfit;
  const totalAssets = assets.reduce((s, r) => s + r.amount, 0n), totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0n);
  const totalEquity = equity.reduce((s, r) => s + r.amount, 0n) + surplus;
  return {
    trialBalance: rows,
    pnl: { income, expenses, totalIncome, totalExpenses, profit, nci: nciProfit, owners: profit - nciProfit },
    balanceSheet: { assets, liabilities, equity, surplus, nci: nciBal, totalAssets, totalLiabilities, totalEquity, check: totalAssets - totalLiabilities - totalEquity - nciBal },
  };
}

export type { Fraction };
