/**
 * FIN-RPT-01 mapped statements: balance sheet, profit and loss, cash-flow statement (indirect, and
 * direct where the cash-account lines allow), statement of changes in equity, and a minimal set of
 * notes, each for a current and a comparative period, each labelled preliminary, certified or
 * unavailable (with the reasons).
 *
 * Everything is driven by the statement mapping of the book's framework label (mapping.ts): an
 * account's taxonomy tag names its line. Accounts the mapping does not cover are never dropped:
 * they appear as exception lines in the preliminary statements and block certification.
 *
 * Cash flow (indirect method). Every journal balances, so for the non-closing journals of a period
 *   net cash movement = − Σ movement of every non-cash account
 *                     = profit + Σ over balance-sheet lines of −movement,
 * with each balance-sheet line classified by the mapping (operating working capital, non-cash
 * adjustment, investing, financing). A journal with no cash line that touches an investing or
 * financing line (an asset bought with a loan) is a non-cash transaction: it is left out of every
 * section, its profit effect (if any) is reversed in operating, and it is disclosed in the notes,
 * so non-cash movements never appear as bank flows. Opening cash + net movement + FX effect
 * (nil: single-currency books, FIN-GL-04) = closing cash holds by construction and is checked.
 * Direct method: every journal touching a cash account, its cash amount attributed to the
 * counter-lines' classes.
 */
import type { JournalAgg, LedgerData } from "./data.ts";
import { resolveAccounts, mappingLabel, type AccountInfo, type Mapped, type MappingLine, type StatementMapping, type Unmapped } from "./mapping.ts";
import { addDays, fiscalYearOf } from "./rational.ts";

export type OutputStatus = "preliminary" | "certified" | "unavailable";
export interface BookInfo { framework: string; basis: string; fiscalYearStartMonth: number; entityType?: string; legalEntityId?: string }
export interface Period { from: string; to: string }
/** A certified close or report snapshot covering a period end (see CertificationSource). */
export interface Certification { source: string; snapshotId: string; kind: string; seq: number; periodEnd: string; contentHash: string; takenBy: string; takenAt: string }
export interface Column { key: "current" | "comparative"; from: string; to: string; label: string; status: OutputStatus; reasons: string[]; certification: Certification | null }
export type RowKind = "line" | "subtotal" | "total" | "exception" | "check" | "note";
export interface StatementRow {
  key: string; label: string; kind: RowKind; group?: string; section?: string;
  /** Paise per column (current, comparative); null where that column is unavailable or has no figure. */
  amounts: (string | null)[];
  accounts?: string[]; text?: string;
}
export type StatementKind = "balance-sheet" | "profit-and-loss" | "cash-flow" | "equity" | "notes";
export interface FinStatement {
  kind: StatementKind; title: string;
  /** Status of the current period (columns[0]); each column carries its own. */
  status: OutputStatus; reasons: string[];
  columns: Column[]; rows: StatementRow[];
  checks: { label: string; ok: boolean; column: string; detail?: string }[];
  exceptions: string[];
}
export interface StatementBundle {
  tenantId: string; bookId: string; book: BookInfo;
  mapping: { id: string; version: number; status: string; label: string; reviewNote: string } | null;
  periods: Period[];
  statements: Record<"balanceSheet" | "profitAndLoss" | "cashFlow" | "equity" | "notes", FinStatement>;
  basis?: unknown;
}

const DEBIT_NORMAL = new Set(["asset", "expense"]);
const PL = new Set(["income", "expense"]);
const g = (m: Map<string, bigint>, id: string) => m.get(id) ?? 0n;
const sum = (xs: Iterable<bigint>) => { let s = 0n; for (const x of xs) s += x; return s; };
const natural = (side: "debit" | "credit", v: bigint) => (side === "debit" ? v : -v);
const naturalOf = (nature: string, v: bigint) => (DEBIT_NORMAL.has(nature) ? v : -v);

/** Figures of one available period, read in the caller's snapshot. */
interface Fig {
  from: string; to: string;
  opening: Map<string, bigint>; closing: Map<string, bigint>;
  /** Movement in the period, closing vouchers excluded; movAll includes them. */
  mov: Map<string, bigint>; movAll: Map<string, bigint>;
  cashJournals: JournalAgg[]; ifJournals: JournalAgg[]; eqJournals: JournalAgg[];
  provisional: number; later: number | null;
}

type Amt = (f: Fig) => bigint | null;
interface RowSpec { key: string; label: string; kind: RowKind; group?: string; section?: string; accounts?: string[]; amt: Amt; text?: string; show?: "always" | "nonzero" }

/** Journals grouped by id: account -> amount. */
function byJournal(rows: JournalAgg[]) {
  const m = new Map<string, { journalId: string; txnDate: string; seq: number; lines: Map<string, bigint> }>();
  for (const r of rows) {
    const j = m.get(r.journalId) ?? { journalId: r.journalId, txnDate: r.txnDate, seq: r.seq, lines: new Map<string, bigint>() };
    j.lines.set(r.accountId, (j.lines.get(r.accountId) ?? 0n) + r.amount);
    m.set(r.journalId, j);
  }
  return [...m.values()];
}

export interface ComputeInput {
  tenantId: string; bookId: string; book: BookInfo; mapping: StatementMapping | null;
  periods: Period[];
  certifications: (Certification | null)[];
  freshness?: { fresh: boolean; contiguous: boolean; lag: number };
}

/** Compute every mapped statement for the periods (current first, then the comparative) from one data source. */
export async function computeStatements(data: LedgerData, input: ComputeInput): Promise<StatementBundle> {
  const { mapping, periods } = input;
  const accounts = await data.accounts();
  const first = await data.firstDate();
  const res = mapping ? resolveAccounts(mapping, accounts) : null;
  const mapped = res?.mapped ?? new Map<string, Mapped>(), unmapped = res?.unmapped ?? new Map<string, Unmapped>();
  const lines = mapping?.lines ?? [];
  const accountsOf = (key: string) => [...mapped.values()].filter((m) => m.line.key === key).map((m) => m.account.accountId);
  const plAccounts = accounts.filter((a) => PL.has(a.nature)).map((a) => a.accountId);
  const cashAccounts = [...mapped.values()].filter((m) => m.line.cashFlow === "cash").map((m) => m.account.accountId);
  const cashSet = new Set(cashAccounts);
  const ifAccounts = [...mapped.values()].filter((m) => m.line.cashFlow === "investing" || m.line.cashFlow === "financing").map((m) => m.account.accountId);
  const eqAccounts = accounts.filter((a) => a.nature === "equity").map((a) => a.accountId);

  // ------------------------------------------------ availability per period, then figures
  const unavailable: string[][] = periods.map((p) => {
    const r: string[] = [];
    if (!mapping) r.push(`no statement mapping serves the book's framework "${input.book.framework}"; set the framework (FIN-MDM-01) to one a mapping covers, or add an approved mapping`);
    if (first === null) r.push("the book has no postings");
    else if (p.to < first) r.push(`no ledger data for this period: the book's first posting is on ${first}`);
    if (input.freshness && !input.freshness.contiguous) r.push("the reporting projection has gaps (journals missing below its checkpoint); rebuild it before reporting");
    return r;
  });
  const figs: (Fig | null)[] = [];
  for (const [i, p] of periods.entries()) {
    if (unavailable[i]!.length) { figs.push(null); continue; }
    const cert = input.certifications[i] ?? null;
    figs.push({
      from: p.from, to: p.to,
      opening: await data.sums(null, addDays(p.from, -1)), closing: await data.sums(null, p.to),
      mov: await data.sums(p.from, p.to, { excludeClosing: true }), movAll: await data.sums(p.from, p.to),
      cashJournals: await data.journals(p.from, p.to, cashAccounts), ifJournals: await data.journals(p.from, p.to, ifAccounts),
      eqJournals: await data.journals(p.from, p.to, eqAccounts),
      provisional: await data.provisionalCount(p.from, p.to), later: cert ? await data.laterPostings(cert.seq, p.to) : null,
    });
  }
  const live = figs.filter((f): f is Fig => !!f);

  // Accounts without a line that carry a figure in some period (exceptions), and those that carry none (listed in the notes).
  const hasFigure = (id: string, f: Fig) => g(f.closing, id) !== 0n || g(f.movAll, id) !== 0n || g(f.opening, id) !== 0n;
  const exceptionAccounts = [...unmapped.values()].filter((u) => live.some((f) => hasFigure(u.account.accountId, f)));
  const blocked = (f: Fig) => [...unmapped.values()].filter((u) => hasFigure(u.account.accountId, f));

  // ------------------------------------------------ shared figures
  const profit = (f: Fig) => -sum(plAccounts.map((a) => g(f.mov, a)));
  const lineClosing = (l: MappingLine, f: Fig, m: Map<string, bigint> = f.closing) =>
    sum(accountsOf(l.key).map((a) => natural(l.side, g(m, a)))) + (l.profit ? -sum(plAccounts.map((a) => g(m, a))) : 0n);
  const excluded = (f: Fig) => byJournal(f.ifJournals).filter((j) => ![...j.lines.keys()].some((a) => cashSet.has(a)));
  const exclMov = (f: Fig) => {
    const m = new Map<string, bigint>();
    for (const j of excluded(f)) for (const [a, v] of j.lines) m.set(a, (m.get(a) ?? 0n) + v);
    return m;
  };
  const exclCache = new WeakMap<Fig, Map<string, bigint>>();
  const ex = (f: Fig) => { let m = exclCache.get(f); if (!m) { m = exclMov(f); exclCache.set(f, m); } return m; };
  /** Cash-flow contribution of accounts: −(movement − movement of excluded non-cash journals). */
  const flow = (ids: string[], f: Fig) => -sum(ids.map((a) => g(f.mov, a) - g(ex(f), a)));
  const cash = (m: Map<string, bigint>) => sum(cashAccounts.map((a) => g(m, a)));

  // ------------------------------------------------ rendering helpers
  const render = (specs: RowSpec[]): StatementRow[] => specs
    .filter((s) => s.show !== "nonzero" || figs.some((f) => f && (s.amt(f) ?? 0n) !== 0n))
    .map((s) => ({ key: s.key, label: s.label, kind: s.kind, ...(s.group ? { group: s.group } : {}), ...(s.section ? { section: s.section } : {}),
      amounts: figs.map((f) => { if (!f) return null; const v = s.amt(f); return v === null ? null : v.toString(); }),
      ...(s.accounts?.length ? { accounts: s.accounts } : {}), ...(s.text ? { text: s.text } : {}) }));
  const labelOf = (p: Period, i: number) => (i === 0 ? `${p.from} to ${p.to}` : `${p.from} to ${p.to} (comparative)`);
  const exceptionText = (u: Unmapped) => `${u.account.accountId} ${u.account.name}: ${u.reason}`;

  /** Reasons a period cannot be certified (empty: certifiable, given a valid certification). */
  const blockers = (i: number, extra: (f: Fig) => string[] = () => []): string[] => {
    const f = figs[i];
    if (!f || !mapping) return [];
    const out: string[] = [];
    if (mapping.status !== "approved") out.push(`statement mapping ${mappingLabel(mapping)}: statements prepared with it cannot be certified until it is reviewed and approved`);
    const um = blocked(f);
    if (um.length) out.push(`${um.length} unmapped account(s) carry figures: ${um.map((u) => u.account.accountId).join(", ")}`);
    for (const l of lines) if (l.blockIfNonZero && lineClosing(l, f) !== 0n) out.push(`${l.label}: ${l.blockIfNonZero}`);
    out.push(...extra(f));
    if (input.freshness && !input.freshness.fresh) out.push(`the reporting projection is ${input.freshness.lag} journal(s) behind the ledger`);
    const cert = input.certifications[i] ?? null;
    if (!cert) out.push(`no certified close snapshot for the period ending ${f.to}`);
    else if ((f.later ?? 0) > 0) out.push(`${f.later} journal(s) dated on or before ${f.to} were posted after certified snapshot ${cert.snapshotId} (ledger position ${cert.seq}); the certification no longer covers the period`);
    return out;
  };
  const columns = (extraUnavailable: (i: number) => string[] = () => [], extraBlock?: (f: Fig) => string[]): Column[] => periods.map((p, i) => {
    const un = [...unavailable[i]!, ...(figs[i] ? extraUnavailable(i) : [])];
    if (un.length) return { key: i === 0 ? "current" : "comparative", from: p.from, to: p.to, label: labelOf(p, i), status: "unavailable", reasons: un, certification: null };
    const b = blockers(i, extraBlock);
    const cert = input.certifications[i] ?? null;
    return { key: i === 0 ? "current" : "comparative", from: p.from, to: p.to, label: labelOf(p, i), status: b.length ? "preliminary" : "certified", reasons: b,
      certification: b.length ? null : cert };
  });
  const finish = (kind: StatementKind, title: string, cols: Column[], rows: StatementRow[], checks: FinStatement["checks"], exceptions: string[]): FinStatement => {
    // An unavailable column shows no figures at all (never zeros).
    const out = rows.map((r) => ({ ...r, amounts: r.amounts.map((a, i) => (cols[i]!.status === "unavailable" ? null : a)) }));
    return { kind, title, status: cols[0]!.status, reasons: cols[0]!.reasons, columns: cols, rows: out, checks: checks.filter((c) => cols.find((x) => x.key === c.column)?.status !== "unavailable"), exceptions };
  };
  const colKey = (i: number) => (i === 0 ? "current" : "comparative");

  // ================================================= balance sheet
  const bsLines = lines.filter((l) => l.statement === "BS");
  const bsSpecs: RowSpec[] = [];
  const groups = [...new Set(bsLines.map((l) => l.group ?? ""))];
  const groupTotals = new Map<string, Amt>();
  const exceptionGroup = (u: Unmapped) => (u.account.nature === "asset" ? groups.find((x) => /asset/i.test(x)) ?? "Assets" : groups.find((x) => /liabilit|equity/i.test(x)) ?? "Equity and liabilities");
  for (const grp of groups) {
    const inGroup = bsLines.filter((l) => (l.group ?? "") === grp);
    const sectionAmts: Amt[] = [];
    for (const sec of [...new Set(inGroup.map((l) => l.section))]) {
      const ls = inGroup.filter((l) => l.section === sec);
      for (const l of ls) bsSpecs.push({ key: `bs:${l.key}`, label: l.label, kind: "line", group: grp, section: sec, accounts: accountsOf(l.key), amt: (f) => lineClosing(l, f),
        show: accountsOf(l.key).length || l.profit ? "always" : "nonzero" });
      const amt: Amt = (f) => sum(ls.map((l) => lineClosing(l, f)));
      sectionAmts.push(amt);
      bsSpecs.push({ key: `bs:${grp}|${sec}|total`, label: `Total ${sec.toLowerCase()}`, kind: "subtotal", group: grp, section: sec, amt });
    }
    const exc = exceptionAccounts.filter((u) => !PL.has(u.account.nature) && exceptionGroup(u) === grp);
    if (exc.length) {
      const sec = "Unmapped accounts (exception)";
      for (const u of exc) bsSpecs.push({ key: `bs:unmapped:${u.account.accountId}`, label: `Unmapped: ${exceptionText(u)}`, kind: "exception", group: grp, section: sec, accounts: [u.account.accountId],
        amt: (f) => naturalOf(u.account.nature, g(f.closing, u.account.accountId)) });
      const amt: Amt = (f) => sum(exc.map((u) => naturalOf(u.account.nature, g(f.closing, u.account.accountId))));
      sectionAmts.push(amt);
      bsSpecs.push({ key: `bs:${grp}|unmapped|total`, label: "Total unmapped accounts (exception)", kind: "subtotal", group: grp, section: sec, amt });
    }
    const total: Amt = (f) => sum(sectionAmts.map((a) => a(f) ?? 0n));
    groupTotals.set(grp, total);
    bsSpecs.push({ key: `bs:${grp}|total`, label: `Total ${grp.toLowerCase()}`, kind: "total", group: grp, amt: total });
  }
  const assetsTotal = (f: Fig) => sum([...groupTotals].filter(([k]) => /asset/i.test(k)).map(([, a]) => a(f) ?? 0n));
  const eqlTotal = (f: Fig) => sum([...groupTotals].filter(([k]) => !/asset/i.test(k)).map(([, a]) => a(f) ?? 0n));
  bsSpecs.push({ key: "bs:check", label: "Total assets − total equity and liabilities (must be 0)", kind: "check", amt: (f) => assetsTotal(f) - eqlTotal(f) });
  const bsCols = columns();
  const bsChecks = figs.flatMap((f, i) => (f ? [{ label: "Balance sheet balances", ok: assetsTotal(f) === eqlTotal(f), column: colKey(i), detail: `difference ${assetsTotal(f) - eqlTotal(f)} paise` }] : []));
  const balanceSheet = finish("balance-sheet", "Balance sheet", bsCols, render(bsSpecs), bsChecks, exceptionAccounts.filter((u) => !PL.has(u.account.nature)).map(exceptionText));

  // ================================================= profit and loss
  const plLines = lines.filter((l) => l.statement === "PL");
  const plSpecs: RowSpec[] = [];
  const plLine = (l: MappingLine): Amt => (f) => sum(accountsOf(l.key).map((a) => natural(l.side, g(f.mov, a))));
  const plSection = (sec: string, nature: string | null, totalLabel: string) => {
    const ls = plLines.filter((l) => l.section === sec);
    for (const l of ls) plSpecs.push({ key: `pl:${l.key}`, label: l.label, kind: "line", section: sec, accounts: accountsOf(l.key), amt: plLine(l), show: accountsOf(l.key).length ? "always" : "nonzero" });
    const exc = nature ? exceptionAccounts.filter((u) => u.account.nature === nature) : [];
    for (const u of exc) plSpecs.push({ key: `pl:unmapped:${u.account.accountId}`, label: `Unmapped: ${exceptionText(u)}`, kind: "exception", section: sec, accounts: [u.account.accountId],
      amt: (f) => naturalOf(u.account.nature, g(f.mov, u.account.accountId)) });
    const amt: Amt = (f) => sum(ls.map((l) => plLine(l)(f) ?? 0n)) + sum(exc.map((u) => naturalOf(u.account.nature, g(f.mov, u.account.accountId))));
    plSpecs.push({ key: `pl:${sec}|total`, label: totalLabel, kind: "subtotal", section: sec, amt });
    return amt;
  };
  const ti = plSection("Income", "income", "Total income");
  const te = plSection("Expenses", "expense", "Total expenses");
  const pbt: Amt = (f) => (ti(f) ?? 0n) - (te(f) ?? 0n);
  plSpecs.push({ key: "pl:pbt", label: "Profit / (loss) before tax", kind: "total", amt: pbt });
  const tax = plSection("Tax expense", null, "Total tax expense");
  const pat: Amt = (f) => (pbt(f) ?? 0n) - (tax(f) ?? 0n);
  plSpecs.push({ key: "pl:profit", label: "Profit / (loss) for the period", kind: "total", amt: pat });
  plSpecs.push({ key: "pl:check", label: "Statement profit − ledger profit (must be 0)", kind: "check", amt: (f) => (pat(f) ?? 0n) - profit(f) });
  const plCols = columns();
  const plChecks = figs.flatMap((f, i) => (f ? [{ label: "Mapped profit equals ledger profit", ok: pat(f) === profit(f), column: colKey(i) }] : []));
  const profitAndLoss = finish("profit-and-loss", "Statement of profit and loss", plCols, render(plSpecs), plChecks, exceptionAccounts.filter((u) => PL.has(u.account.nature)).map(exceptionText));

  // ================================================= cash flow
  const cfSpecs: RowSpec[] = [];
  const bsBy = (cls: string) => bsLines.filter((l) => l.cashFlow === cls);
  const OP = "Operating activities (indirect method)", INV = "Investing activities", FIN = "Financing activities", UNC = "Unclassified: unmapped accounts (exception)";
  cfSpecs.push({ key: "cf:profit", label: "Profit / (loss) for the period", kind: "line", section: OP, amt: profit });
  for (const l of bsBy("noncash")) cfSpecs.push({ key: `cf:noncash:${l.key}`, label: `Add back non-cash movement in ${l.label.replace(/^less:\s*/i, "").toLowerCase()}`, kind: "line", section: OP, accounts: accountsOf(l.key),
    amt: (f) => flow(accountsOf(l.key), f), show: accountsOf(l.key).length ? "always" : "nonzero" });
  const exclProfit: Amt = (f) => sum(plAccounts.map((a) => g(ex(f), a)));
  cfSpecs.push({ key: "cf:excluded-profit", label: "Profit effect of non-cash investing and financing transactions (reversed; see notes)", kind: "line", section: OP, amt: exclProfit, show: "nonzero" });
  for (const l of bsBy("operating")) {
    const lbl = l.side === "debit" ? `(Increase) / decrease in ${l.label.toLowerCase()}` : `Increase / (decrease) in ${l.label.toLowerCase()}`;
    cfSpecs.push({ key: `cf:wc:${l.key}`, label: lbl, kind: "line", section: OP, accounts: accountsOf(l.key), amt: (f) => flow(accountsOf(l.key), f), show: accountsOf(l.key).length ? "always" : "nonzero" });
  }
  const opAmt: Amt = (f) => profit(f) + sum(bsBy("noncash").concat(bsBy("operating")).map((l) => flow(accountsOf(l.key), f))) + (exclProfit(f) ?? 0n);
  cfSpecs.push({ key: "cf:operating", label: "Net cash from / (used in) operating activities", kind: "subtotal", section: OP, amt: opAmt });
  const classSection = (cls: string, sec: string, total: string, key: string) => {
    for (const l of bsBy(cls)) cfSpecs.push({ key: `cf:${cls}:${l.key}`, label: l.label, kind: "line", section: sec, accounts: accountsOf(l.key), amt: (f) => flow(accountsOf(l.key), f),
      show: accountsOf(l.key).length ? "always" : "nonzero" });
    const amt: Amt = (f) => sum(bsBy(cls).map((l) => flow(accountsOf(l.key), f)));
    cfSpecs.push({ key, label: total, kind: "subtotal", section: sec, amt });
    return amt;
  };
  const invAmt = classSection("investing", INV, "Net cash from / (used in) investing activities", "cf:investing");
  const finAmt = classSection("financing", FIN, "Net cash from / (used in) financing activities", "cf:financing");
  const uncBs = exceptionAccounts.filter((u) => !PL.has(u.account.nature));
  for (const u of uncBs) cfSpecs.push({ key: `cf:unmapped:${u.account.accountId}`, label: `Unmapped: ${exceptionText(u)}`, kind: "exception", section: UNC, accounts: [u.account.accountId],
    amt: (f) => flow([u.account.accountId], f) });
  const uncAmt: Amt = (f) => flow(uncBs.map((u) => u.account.accountId), f);
  if (uncBs.length) cfSpecs.push({ key: "cf:unclassified", label: "Net unclassified movement (exception)", kind: "subtotal", section: UNC, amt: uncAmt });
  const net: Amt = (f) => (opAmt(f) ?? 0n) + (invAmt(f) ?? 0n) + (finAmt(f) ?? 0n) + (uncAmt(f) ?? 0n);
  cfSpecs.push({ key: "cf:net", label: "Net increase / (decrease) in cash and cash equivalents", kind: "total", amt: net });
  cfSpecs.push({ key: "cf:opening-cash", label: "Cash and cash equivalents at the beginning of the period", kind: "line", accounts: cashAccounts, amt: (f) => cash(f.opening) });
  cfSpecs.push({ key: "cf:fx", label: "Effect of exchange rate changes on cash (single-currency book, FIN-GL-04: nil)", kind: "line", amt: () => 0n });
  cfSpecs.push({ key: "cf:closing-cash", label: "Cash and cash equivalents at the end of the period", kind: "total", accounts: cashAccounts, amt: (f) => cash(f.closing) });
  const tie = (f: Fig) => cash(f.opening) + (net(f) ?? 0n) + 0n - cash(f.closing);
  cfSpecs.push({ key: "cf:check", label: "Opening cash + net movement + FX effect − closing cash (must be 0)", kind: "check", amt: tie });

  // Direct method: journals touching a cash account, their cash attributed to the counter-lines.
  const classOf = (a: string): { cls: string; key: string; label: string } => {
    const m = mapped.get(a);
    if (!m) return { cls: "unclassified", key: `unmapped:${a}`, label: `Unmapped ${a}` };
    if (m.line.statement === "PL") return { cls: "operating", key: m.line.key, label: m.line.label };
    const cls = m.line.cashFlow === "noncash" ? "operating" : m.line.cashFlow!;
    return { cls, key: m.line.key, label: m.line.label };
  };
  const directLines = (f: Fig) => {
    const out = new Map<string, { cls: string; key: string; label: string; receipts: bigint; payments: bigint }>();
    for (const j of byJournal(f.cashJournals)) for (const [a, v] of j.lines) {
      if (cashSet.has(a) || v === 0n) continue;
      const c = classOf(a), k = `${c.cls}|${c.key}`;
      const cur = out.get(k) ?? { ...c, receipts: 0n, payments: 0n };
      if (-v > 0n) cur.receipts += -v; else cur.payments += -v;
      out.set(k, cur);
    }
    return out;
  };
  const directCache = new WeakMap<Fig, ReturnType<typeof directLines>>();
  const dl = (f: Fig) => { let m = directCache.get(f); if (!m) { m = directLines(f); directCache.set(f, m); } return m; };
  const directUnavailable = (f: Fig) => [...dl(f).values()].filter((x) => x.cls === "unclassified").map((x) => x.key.slice(9));
  const directKeys = new Map<string, { cls: string; key: string; label: string }>();
  for (const f of live) for (const [k, v] of dl(f)) if (!directKeys.has(k)) directKeys.set(k, v);
  const DIRECT: [string, string][] = [["operating", "Operating activities (direct method)"], ["investing", "Investing activities (direct method)"], ["financing", "Financing activities (direct method)"]];
  const directAmt = (f: Fig, fn: () => bigint): bigint | null => (directUnavailable(f).length ? null : fn());
  for (const [cls, sec] of DIRECT) {
    const keys = [...directKeys.values()].filter((x) => x.cls === cls).sort((a, b) => lines.findIndex((l) => l.key === a.key) - lines.findIndex((l) => l.key === b.key));
    for (const k of keys) {
      cfSpecs.push({ key: `cfd:${cls}:${k.key}:in`, label: `Cash received: ${k.label}`, kind: "line", section: sec, amt: (f) => directAmt(f, () => dl(f).get(`${cls}|${k.key}`)?.receipts ?? 0n), show: "nonzero" });
      cfSpecs.push({ key: `cfd:${cls}:${k.key}:out`, label: `Cash paid: ${k.label}`, kind: "line", section: sec, amt: (f) => directAmt(f, () => dl(f).get(`${cls}|${k.key}`)?.payments ?? 0n), show: "nonzero" });
    }
    cfSpecs.push({ key: `cfd:${cls}`, label: `Net cash from / (used in) ${cls} activities (direct)`, kind: "subtotal", section: sec,
      amt: (f) => directAmt(f, () => sum([...dl(f).values()].filter((x) => x.cls === cls).map((x) => x.receipts + x.payments))) });
  }
  const directNet = (f: Fig) => sum([...dl(f).values()].map((x) => x.receipts + x.payments));
  const directOp = (f: Fig) => sum([...dl(f).values()].filter((x) => x.cls === "operating").map((x) => x.receipts + x.payments));
  const noCash = (i: number) => (cashAccounts.length ? [] : [`no account is mapped to a cash and cash equivalents line in ${mapping ? mappingLabel(mapping) : "the mapping"}`]);
  const cfCols = columns(noCash, (f) => (tie(f) === 0n ? [] : [`cash does not tie out: opening + movement + FX − closing = ${tie(f)} paise`]));
  const cfChecks = figs.flatMap((f, i) => {
    if (!f) return [];
    const du = directUnavailable(f);
    return [
      { label: "Opening cash + net cash movement + FX effect = closing cash", ok: tie(f) === 0n, column: colKey(i), detail: `opening ${cash(f.opening)}, net ${net(f)}, FX 0, closing ${cash(f.closing)}` },
      { label: "Direct method net movement equals indirect method net movement", ok: directNet(f) === net(f), column: colKey(i) },
      du.length
        ? { label: "Direct method available", ok: false, column: colKey(i), detail: `cash journals post against unmapped account(s) ${du.join(", ")}` }
        : { label: "Direct and indirect operating cash flows agree", ok: directOp(f) === opAmt(f), column: colKey(i), detail: `direct ${directOp(f)}, indirect ${opAmt(f)}` },
    ];
  });
  const cashFlow = finish("cash-flow", "Cash flow statement", cfCols, render(cfSpecs), cfChecks, uncBs.map(exceptionText));

  // ================================================= statement of changes in equity
  const eqLines = bsLines.filter((l) => l.equity);
  const eqSpecs: RowSpec[] = [];
  const naturalEq = (id: string, v: bigint) => -v;               // equity is credit-normal
  const incDec = (ids: string[], f: Fig) => {
    const set = new Set(ids);
    let inc = 0n, dec = 0n;
    for (const j of byJournal(f.eqJournals)) {
      let n = 0n;
      for (const [a, v] of j.lines) if (set.has(a)) n += naturalEq(a, v);
      if (n > 0n) inc += n; else dec += n;
    }
    return { inc, dec };
  };
  const closingV = (ids: string[], f: Fig) => sum(ids.map((a) => naturalEq(a, g(f.movAll, a) - g(f.mov, a))));
  const allEqIds = eqAccounts;
  const eqColumns: { key: string; label: string; ids: string[]; profit: boolean; line?: MappingLine; exception?: Unmapped }[] = [
    ...eqLines.map((l) => ({ key: l.key, label: l.label, ids: accountsOf(l.key), profit: !!l.profit, line: l })),
    ...exceptionAccounts.filter((u) => u.account.nature === "equity").map((u) => ({ key: `unmapped:${u.account.accountId}`, label: `Unmapped: ${exceptionText(u)}`, ids: [u.account.accountId], profit: false, exception: u })),
  ];
  const opening = (c: (typeof eqColumns)[number], f: Fig) => sum(c.ids.map((a) => naturalEq(a, g(f.opening, a)))) + (c.profit ? -sum(plAccounts.map((a) => g(f.opening, a))) : 0n);
  const closingEq = (c: (typeof eqColumns)[number], f: Fig) => sum(c.ids.map((a) => naturalEq(a, g(f.closing, a)))) + (c.profit ? -sum(plAccounts.map((a) => g(f.closing, a))) : 0n);
  const cvRow = (c: (typeof eqColumns)[number], f: Fig) => closingV(c.ids, f) - (c.profit ? closingV(allEqIds, f) : 0n);
  const rolled = (c: (typeof eqColumns)[number], f: Fig) => { const x = incDec(c.ids, f); return opening(c, f) + (c.profit ? profit(f) : 0n) + cvRow(c, f) + x.inc + x.dec; };
  for (const c of eqColumns) {
    const sec = c.label, kind: RowKind = c.exception ? "exception" : "line";
    const show = c.ids.length || c.profit ? "always" : "nonzero";
    eqSpecs.push({ key: `eq:${c.key}:opening`, label: "Opening balance", kind, section: sec, accounts: c.ids, amt: (f) => opening(c, f), show });
    if (c.profit) eqSpecs.push({ key: `eq:${c.key}:profit`, label: "Profit / (loss) for the period", kind, section: sec, amt: profit });
    eqSpecs.push({ key: `eq:${c.key}:closing-vouchers`, label: "Transfer of profit by closing vouchers", kind, section: sec, amt: (f) => cvRow(c, f), show: "nonzero" });
    eqSpecs.push({ key: `eq:${c.key}:increases`, label: "Contributions and other increases", kind, section: sec, amt: (f) => incDec(c.ids, f).inc, show });
    eqSpecs.push({ key: `eq:${c.key}:decreases`, label: "Distributions, drawings and other decreases", kind, section: sec, amt: (f) => incDec(c.ids, f).dec, show });
    eqSpecs.push({ key: `eq:${c.key}:closing`, label: "Closing balance", kind: "subtotal", section: sec, amt: (f) => rolled(c, f), show });
  }
  const T = "Total equity";
  eqSpecs.push({ key: "eq:total:opening", label: "Opening balance", kind: "total", section: T, amt: (f) => sum(eqColumns.map((c) => opening(c, f))) });
  eqSpecs.push({ key: "eq:total:profit", label: "Profit / (loss) for the period", kind: "total", section: T, amt: profit });
  eqSpecs.push({ key: "eq:total:increases", label: "Contributions and other increases", kind: "total", section: T, amt: (f) => sum(eqColumns.map((c) => incDec(c.ids, f).inc)) });
  eqSpecs.push({ key: "eq:total:decreases", label: "Distributions, drawings and other decreases", kind: "total", section: T, amt: (f) => sum(eqColumns.map((c) => incDec(c.ids, f).dec)) });
  const eqTotal = (f: Fig) => sum(eqColumns.map((c) => rolled(c, f)));
  eqSpecs.push({ key: "eq:total:closing", label: "Closing balance", kind: "total", section: T, amt: eqTotal });
  const bsEquity = (f: Fig) => sum(eqColumns.map((c) => closingEq(c, f)));
  eqSpecs.push({ key: "eq:check", label: "Closing equity − balance sheet equity (must be 0)", kind: "check", amt: (f) => eqTotal(f) - bsEquity(f) });
  const eqCols = columns();
  const eqChecks = figs.flatMap((f, i) => (f ? [{ label: "Equity roll-forward ties to the balance sheet", ok: eqTotal(f) === bsEquity(f), column: colKey(i), detail: `rolled ${eqTotal(f)}, balance sheet ${bsEquity(f)}` },
    ...eqColumns.map((c) => ({ label: `${c.label}: opening + movements = closing`, ok: rolled(c, f) === closingEq(c, f), column: colKey(i) }))] : []));
  const equity = finish("equity", "Statement of changes in equity", eqCols, render(eqSpecs), eqChecks, exceptionAccounts.filter((u) => u.account.nature === "equity").map(exceptionText));

  // ================================================= notes
  const nSpecs: RowSpec[] = [];
  const note = (key: string, label: string, text: string, section: string) => nSpecs.push({ key: `note:${key}`, label, kind: "note", section, text, amt: () => null });
  const fy = (p: Period) => fiscalYearOf(p.to, input.book.fiscalYearStartMonth);
  const B = "1. Basis of preparation";
  note("basis", "Accounting basis", `${input.book.basis} books; accrual basis double-entry ledger in INR, amounts in integer paise`, B);
  note("framework", "Framework label", input.book.framework, B);
  note("mapping", "Statement mapping", mapping ? `${mapping.title} (${mappingLabel(mapping)}). ${mapping.reviewNote}` : "none: no mapping serves this framework label", B);
  note("fiscal-year", "Fiscal year", `${fy(periods[0]!).label} (fiscal year starts in month ${input.book.fiscalYearStartMonth}); current period ${periods[0]!.from} to ${periods[0]!.to}${periods[1] ? `, comparative ${periods[1].from} to ${periods[1].to}` : ""}`, B);
  note("currency", "Functional currency", "INR (exponent 2); single-currency book, so no exchange differences arise (FIN-GL-04)", B);
  nSpecs.push({ key: "note:provisional", label: "Provisional journals (awaiting bank confirmation) included", kind: "note", section: B, amt: (f) => BigInt(f.provisional) });
  // 2. significant accounts: at least 10% of the larger of total assets and total income
  const S = "2. Significant accounts";
  const threshold = (f: Fig) => { const base = [assetsTotal(f), ti(f) ?? 0n].reduce((a, b) => (b > a ? b : a), 0n); return base / 10n; };
  const acctAmount = (a: AccountInfo, f: Fig) => (PL.has(a.nature) ? naturalOf(a.nature, g(f.mov, a.accountId)) : naturalOf(a.nature, g(f.closing, a.accountId)));
  const significant = accounts.filter((a) => live.some((f) => { const v = acctAmount(a, f), t = threshold(f); return t > 0n && (v < 0n ? -v : v) >= t; }));
  nSpecs.push({ key: "note:threshold", label: "Threshold: 10% of the larger of total assets and total income", kind: "note", section: S, amt: threshold });
  for (const a of significant) nSpecs.push({ key: `note:significant:${a.accountId}`, label: `${a.accountId} ${a.name}`, kind: "note", section: S, accounts: [a.accountId],
    text: mapped.get(a.accountId)?.line.label ?? "unmapped", amt: (f) => acctAmount(a, f) });
  // 3. unmapped or excluded accounts
  const U = "3. Unmapped and excluded accounts";
  for (const u of exceptionAccounts) nSpecs.push({ key: `note:unmapped:${u.account.accountId}`, label: `Unmapped (blocks certification): ${u.account.accountId} ${u.account.name}`, kind: "exception", section: U,
    accounts: [u.account.accountId], text: u.reason, amt: (f) => acctAmount(u.account, f) });
  const quiet = accounts.filter((a) => !live.some((f) => hasFigure(a.accountId, f)));
  for (const a of quiet) nSpecs.push({ key: `note:excluded:${a.accountId}`, label: `Excluded (no balance or activity): ${a.accountId} ${a.name}`, kind: "note", section: U, accounts: [a.accountId],
    text: unmapped.get(a.accountId)?.reason ?? `mapped to ${mapped.get(a.accountId)?.line.label ?? "?"}`, amt: () => 0n });
  if (!exceptionAccounts.length) note("unmapped-none", "Unmapped accounts with figures", "none", U);
  // 4. non-cash investing and financing transactions
  const N = "4. Non-cash investing and financing transactions (excluded from the cash flow statement)";
  const exJournals = new Map<string, { journalId: string; txnDate: string }>();
  for (const f of live) for (const j of excluded(f)) exJournals.set(j.journalId, j);
  for (const j of exJournals.values()) nSpecs.push({ key: `note:noncash:${j.journalId}`, label: `Journal ${j.journalId} on ${j.txnDate}`, kind: "note", section: N,
    amt: (f) => { const x = excluded(f).find((y) => y.journalId === j.journalId); return x ? sum([...x.lines.values()].filter((v) => v > 0n)) : null; } });
  if (!exJournals.size) note("noncash-none", "Non-cash investing and financing transactions", "none", N);
  const notes = finish("notes", "Notes to the statements", columns(), render(nSpecs), [], exceptionAccounts.map(exceptionText));

  return {
    tenantId: input.tenantId, bookId: input.bookId, book: input.book,
    mapping: mapping ? { id: mapping.id, version: mapping.version, status: mapping.status, label: mappingLabel(mapping), reviewNote: mapping.reviewNote } : null,
    periods, statements: { balanceSheet, profitAndLoss, cashFlow, equity, notes },
  };
}
