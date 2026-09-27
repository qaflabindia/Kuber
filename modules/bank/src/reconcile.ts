/**
 * FIN-CASH-01..03, pure: statement coverage and balances, which book entries each statement line
 * settles, and the reconciliation statement of one bank account at a period end.
 *
 * Sign convention everywhere: paise, + = money into the bank account (a debit on the asset).
 *
 * Linking a statement line L to book entries:
 *   - explicit links (bank.clearings): matched by the agent or resolved by a person; the amounts are
 *     the parts of each entry's bank line that L settles, and they add up to L;
 *   - otherwise L's origin journal (the entry the agent posts for a new line, journalIdForRequest of
 *     req-<txnId>) when it exists: the line is in the books through its own entry;
 *   - an entry reversed within the period (a correction or a suspense resolution) passes its link to
 *     its replacement (same amount, same narration or "Suspense resolved: …"); a reversed pair with
 *     no replacement nets to nothing, and the line is again "not in the books".
 * An entry dated before the account's opening date with no link is brought forward in the
 * statement's opening balance (a difference between the two shows as unexplained).
 *
 * Reconciliation at D:
 *   adjusted bank = bank balance(D) + deposits in transit − outstanding payments   (= bank + Σ remaining)
 *   adjusted book = book balance(D) + statement lines not yet in the books        (= book + Σ unrecorded)
 *   difference    = adjusted bank − adjusted book; certifiable only when it is exactly zero, no line
 *                   is unrecorded and statements cover the period. "Difference zero" is not "no
 *                   outstanding items": a timing item stays listed, with its age and source.
 */
import { canonical, sha256 } from "@kuber/contracts";
import type { BookState } from "@kuber/gl";

export interface LedgerJournal {
  journalId: string; txnDate: string; narration: string; voucherType: string;
  /** Net of the journal's lines on the bank account. */
  amount: bigint;
  reversedBy?: string; createdBy: string; provisional: boolean;
  otherAccounts: string[]; partyIds: string[];
}

/** Every journal with a (net non-zero) line on `account`, in posting order. */
export function bankJournals(s: BookState, account: string): LedgerJournal[] {
  const out: LedgerJournal[] = [];
  for (const [journalId, j] of s.journals) {
    let amount = 0n, touches = false;
    for (const l of j.lines) if (l.accountId === account) { amount += BigInt(l.amount); touches = true; }
    if (!touches || amount === 0n) continue;
    out.push({ journalId, txnDate: j.txnDate, narration: j.narration, voucherType: j.voucherType, amount, ...(j.reversedBy ? { reversedBy: j.reversedBy } : {}),
      createdBy: j.createdBy, provisional: j.provisional, otherAccounts: [...new Set(j.lines.map((l) => l.accountId).filter((a) => a !== account))],
      partyIds: [...new Set(j.lines.map((l) => l.partyId).filter((p): p is string => !!p))] });
  }
  return out;
}

export interface LineRef { txnId: string; txnDate: string; signed: bigint }
export interface Link { txnId: string; journalId: string; amount: bigint }
export interface LegState { j: LedgerJournal; matched: bigint; remaining: bigint; absorbed: boolean; lines: string[] }
export interface LineState { line: LineRef; matched: bigint; unmatched: bigint; journals: string[] }

export interface SettleOptions {
  /** Only entries and lines dated on or before (null: everything). */
  asOf: string | null;
  /** The account's opening date: unlinked entries before it are in the statement's opening balance. */
  baseline: string | null;
  /** The journal the agent posts for a new line. */
  origin: (txnId: string) => string;
}

export function settle(journals: LedgerJournal[], lines: LineRef[], explicit: Link[], o: SettleOptions): { legs: LegState[]; lines: LineState[] } {
  const all = new Map(journals.map((j) => [j.journalId, j]));
  const inScope = (d: string) => o.asOf === null || d <= o.asOf;
  const scoped = journals.filter((j) => inScope(j.txnDate));
  const scopedIds = new Set(scoped.map((j) => j.journalId));
  const dropped = new Set<string>();
  for (const j of scoped) if (j.reversedBy && scopedIds.has(j.reversedBy)) { dropped.add(j.journalId); dropped.add(j.reversedBy); }

  const byTxn = new Map<string, Link[]>();
  for (const l of explicit) byTxn.set(l.txnId, [...(byTxn.get(l.txnId) ?? []), l]);
  let links: Link[] = [];
  for (const line of lines) {
    const ex = byTxn.get(line.txnId);
    if (ex?.length) links.push(...ex);
    else { const j0 = o.origin(line.txnId); if (all.has(j0)) links.push({ txnId: line.txnId, journalId: j0, amount: line.signed }); }
  }
  const taken = new Set(links.map((l) => l.journalId));
  links = links.map((l) => {
    const j = all.get(l.journalId);
    if (!j?.reversedBy || !scopedIds.has(j.reversedBy)) return l;
    const rep = scoped.find((n) => n.journalId !== j.journalId && n.journalId !== j.reversedBy && !n.reversedBy && n.amount === j.amount
      && !taken.has(n.journalId) && n.txnDate >= j.txnDate && (n.narration === j.narration || n.narration === `Suspense resolved: ${j.narration}`));
    if (!rep) return l;
    taken.add(rep.journalId);
    return { ...l, journalId: rep.journalId };
  });

  const lineDate = new Map(lines.map((l) => [l.txnId, l.txnDate]));
  const live = (id: string) => scopedIds.has(id) && !dropped.has(id);
  const legs: LegState[] = scoped.filter((j) => !dropped.has(j.journalId)).map((j) => {
    const ls = links.filter((l) => l.journalId === j.journalId);
    const matched = ls.filter((l) => inScope(lineDate.get(l.txnId) ?? "9999-12-31")).reduce((a, l) => a + l.amount, 0n);
    const absorbed = !!o.baseline && j.txnDate < o.baseline && ls.length === 0;
    return { j, matched, remaining: absorbed ? 0n : j.amount - matched, absorbed, lines: ls.map((l) => l.txnId) };
  });
  const lineStates: LineState[] = lines.filter((l) => inScope(l.txnDate)).map((line) => {
    const ls = links.filter((l) => l.txnId === line.txnId && live(l.journalId));
    const matched = ls.reduce((a, l) => a + l.amount, 0n);
    return { line, matched, unmatched: line.signed - matched, journals: ls.map((l) => l.journalId) };
  });
  return { legs, lines: lineStates };
}

// ------------------------------------------------------------------ statements and coverage
export interface StatementRow { rowNo: number; txnId: string | null; txnDate: string | null; amount: bigint }
export interface StatementInfo {
  statementId: string; status: "verified" | "held"; provenance: "uploaded" | "authenticated"; identity: string;
  periodFrom: string; periodTo: string; opening: bigint | null; closing: bigint | null; contentHash: string; rows: StatementRow[];
  createdAt?: string;
}
export interface Coverage {
  from: string; to: string; complete: boolean;
  gaps: { from: string; to: string }[];
  overlaps: { from: string; to: string; statements: [string, string] }[];
  /** Held statements for dates in the range: not evidence, listed with their exception. */
  held: string[];
  statements: string[];
}

export const dayBefore = (iso: string) => shift(iso, -1);
export const dayAfter = (iso: string) => shift(iso, 1);
function shift(iso: string, n: number) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function coverage(statements: StatementInfo[], from: string, to: string): Coverage {
  const touching = statements.filter((s) => s.periodTo >= from && s.periodFrom <= to);
  const ok = touching.filter((s) => s.status === "verified").sort((a, b) => a.periodFrom.localeCompare(b.periodFrom) || a.periodTo.localeCompare(b.periodTo));
  const gaps: Coverage["gaps"] = [], overlaps: Coverage["overlaps"] = [];
  let cursor = from, prev: StatementInfo | null = null;
  for (const s of ok) {
    if (s.periodFrom > cursor) gaps.push({ from: cursor, to: dayBefore(s.periodFrom) });
    if (prev && s.periodFrom <= prev.periodTo) overlaps.push({ from: s.periodFrom, to: prev.periodTo < s.periodTo ? prev.periodTo : s.periodTo, statements: [prev.statementId, s.statementId] });
    if (dayAfter(s.periodTo) > cursor) cursor = dayAfter(s.periodTo);
    if (!prev || s.periodTo > prev.periodTo) prev = s;
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return { from, to, complete: gaps.length === 0 && ok.length > 0, gaps, overlaps, held: touching.filter((s) => s.status === "held").map((s) => s.statementId),
    statements: ok.map((s) => s.statementId) };
}

/** The bank's balance at the end of day `d` from a verified statement covering it (null: none does). */
export function bankBalanceAt(statements: StatementInfo[], d: string): { balance: bigint; statementId: string } | null {
  const s = statements.filter((x) => x.status === "verified" && x.opening !== null && dayBefore(x.periodFrom) <= d && d <= x.periodTo)
    .sort((a, b) => b.periodTo.localeCompare(a.periodTo))[0];
  if (!s) return null;
  return { balance: s.opening! + s.rows.filter((r) => r.txnDate !== null && r.txnDate <= d).reduce((a, r) => a + r.amount, 0n), statementId: s.statementId };
}

/** Unique movements (by transaction identity) of the verified statements: overlapping files count once. */
export function movements(statements: StatementInfo[]): LineRef[] {
  const m = new Map<string, LineRef>();
  for (const s of statements) if (s.status === "verified") for (const r of s.rows) {
    if (r.txnId && r.txnDate && r.amount !== 0n && !m.has(r.txnId)) m.set(r.txnId, { txnId: r.txnId, txnDate: r.txnDate, signed: r.amount });
  }
  return [...m.values()].sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.txnId.localeCompare(b.txnId));
}

// ------------------------------------------------------------------ the reconciliation statement
export interface TimingItem {
  journalId: string; txnDate: string; narration: string; amount: string; fullAmount: string; ageDays: number; stale: boolean;
  /** Where the entry came from: voucher type, who posted it, provisional or not. */
  source: { voucherType: string; postedBy: string; provisional: boolean };
}
export interface UnrecordedItem { txnId: string; txnDate: string; narration: string | null; amount: string }
export interface Reconciliation {
  bookId: string; bankAccountId: string; glAccountId: string; masked: string; periodFrom: string; periodEnd: string;
  bankBalance: string | null; bookBalance: string;
  outstandingPayments: TimingItem[]; depositsInTransit: TimingItem[]; unrecorded: UnrecordedItem[];
  adjustedBank: string | null; adjustedBook: string; difference: string | null;
  /** "Reconciliation difference zero" and "no outstanding items" are different facts. */
  differenceZero: boolean; noOutstandingItems: boolean; outstandingCount: number;
  staleItems: string[]; staleDays: number;
  coverage: Coverage;
  statements: { statementId: string; contentHash: string; periodFrom: string; periodTo: string; provenance: string; status: string }[];
  ledger: { seq: number; hash: string | null };
  certifiable: boolean; problems: string[];
  hash: string;
}

export interface ReconInput {
  bookId: string;
  account: { bankAccountId: string; glAccountId: string; masked: string; openingDate: string; staleDays: number };
  periodFrom: string; periodEnd: string;
  journals: LedgerJournal[]; statements: StatementInfo[]; explicit: Link[];
  origin: (txnId: string) => string;
  narrations: ReadonlyMap<string, string>;
  ledger: { seq: number; hash: string | null };
}

export function reconcile(i: ReconInput): Reconciliation {
  const D = i.periodEnd, a = i.account;
  const lines = movements(i.statements).filter((l) => l.txnDate >= a.openingDate);
  const st = settle(i.journals, lines, i.explicit, { asOf: D, baseline: a.openingDate, origin: i.origin });
  const book = i.journals.filter((j) => j.txnDate <= D).reduce((s, j) => s + j.amount, 0n);
  const bank = bankBalanceAt(i.statements, D);
  const item = (l: LegState): TimingItem => {
    const age = daysBetween(l.j.txnDate, D);
    return { journalId: l.j.journalId, txnDate: l.j.txnDate, narration: l.j.narration, amount: l.remaining.toString(), fullAmount: l.j.amount.toString(),
      ageDays: age, stale: age > a.staleDays, source: { voucherType: l.j.voucherType, postedBy: l.j.createdBy, provisional: l.j.provisional } };
  };
  const open = st.legs.filter((l) => l.remaining !== 0n).sort((x, y) => x.j.txnDate.localeCompare(y.j.txnDate) || x.j.journalId.localeCompare(y.j.journalId));
  const outstandingPayments = open.filter((l) => l.remaining < 0n).map(item);
  const depositsInTransit = open.filter((l) => l.remaining > 0n).map(item);
  const unrecorded = st.lines.filter((l) => l.unmatched !== 0n)
    .map((l) => ({ txnId: l.line.txnId, txnDate: l.line.txnDate, narration: i.narrations.get(l.line.txnId) ?? null, amount: l.unmatched.toString() }));
  const sumOpen = open.reduce((s, l) => s + l.remaining, 0n);
  const sumUnrec = st.lines.reduce((s, l) => s + l.unmatched, 0n);
  const adjustedBank = bank ? bank.balance + sumOpen : null;
  const adjustedBook = book + sumUnrec;
  const difference = adjustedBank === null ? null : adjustedBank - adjustedBook;
  const cov = coverage(i.statements, i.periodFrom, D);
  const used = i.statements.filter((s) => cov.statements.includes(s.statementId) || cov.held.includes(s.statementId));
  const problems: string[] = [];
  if (!bank) problems.push(`no verified statement covers ${D}`);
  if (!cov.complete) problems.push(`statements do not cover ${i.periodFrom}..${D}${cov.gaps.length ? `: missing ${cov.gaps.map((g) => `${g.from}..${g.to}`).join(", ")}` : ""}`);
  if (cov.held.length) problems.push(`${cov.held.length} held statement(s) in the period: resolve their exceptions (import a corrected file)`);
  if (unrecorded.length) problems.push(`${unrecorded.length} statement line(s) not yet in the books (record them, or resolve their match reviews)`);
  if (difference !== null && difference !== 0n) problems.push(`unexplained difference of ${difference} paise`);
  const staleItems = [...outstandingPayments, ...depositsInTransit].filter((x) => x.stale).map((x) => x.journalId);
  const body = {
    bookId: i.bookId, bankAccountId: a.bankAccountId, glAccountId: a.glAccountId, masked: a.masked, periodFrom: i.periodFrom, periodEnd: D,
    bankBalance: bank ? bank.balance.toString() : null, bookBalance: book.toString(), outstandingPayments, depositsInTransit, unrecorded,
    adjustedBank: adjustedBank === null ? null : adjustedBank.toString(), adjustedBook: adjustedBook.toString(), difference: difference === null ? null : difference.toString(),
    differenceZero: difference === 0n, noOutstandingItems: open.length === 0, outstandingCount: open.length, staleItems, staleDays: a.staleDays,
    coverage: cov, statements: used.map((s) => ({ statementId: s.statementId, contentHash: s.contentHash, periodFrom: s.periodFrom, periodTo: s.periodTo, provenance: s.provenance, status: s.status })),
    ledger: i.ledger, certifiable: problems.length === 0, problems,
  };
  return { ...body, hash: sha256(canonical(body)) };
}
