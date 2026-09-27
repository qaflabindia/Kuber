/**
 * FIN-CASH-02: settlement matching for statement lines of a registered bank account.
 *
 * This extends the agent's provisional matching (same evidence: references, counterparty words,
 * the same match reviews) from "open provisional entries" to every book entry on the bank account
 * that no statement line has cleared yet: manual payments and cheques, receipts, transfers,
 * provisional entries. It is a pure function over the candidates the bank module supplies.
 *
 * Evidence per candidate (a book entry's uncleared bank leg, same direction as the line):
 *   reference     a reference of the line (cheque, UTR, settlement id) is in the entry
 *   own_account   the line names (last 4 digits) another own bank account the entry transfers to/from
 *   counterparty  the counterparty words of the entry (narration, party name) overlap the line's
 *   different     both name someone and they share nothing
 *   unknown       one side names nobody: the entry cannot be told apart from others
 *
 * Outcomes, in order:
 *   return        return/reversal wording and an earlier cleared line of the opposite direction
 *                 sharing a reference: a person links the return (review "return")
 *   one-to-one    exactly one candidate of the same amount on the strongest evidence
 *   one-to-many   candidates sharing the line's reference (or, uniquely, one counterparty's
 *                 entries) whose uncleared amounts add up to the line exactly
 *   partial       exactly one reference candidate larger than the line: the line clears part of it
 *                 (the rest stays outstanding and ages); within the account's fee tolerance it is
 *                 a settlement net of a fee instead, which a person confirms (review "fee") so the
 *                 fee is posted as its own journal
 *   transfer      no candidate, transfer wording and another own account's last 4 digits: the line
 *                 is posted as a transfer to that account (its other leg waits for that statement)
 * Two or more candidates on the same evidence, or only "unknown" ones of the same amount, always go
 * to review: amount and date alone never clear anything (two equal same-day payments to different
 * parties cannot auto-match).
 */
import type { TransactionSql } from "postgres";
import type { RawTxn } from "@kuber/contracts";
import { matchWords, refsOf, wordsOverlap } from "./words.ts";

export interface SettlementLine { txnDate: string; signed: bigint; narration: string; reference?: string | null; counterpartyHint?: string | null }
export interface SettlementLeg {
  journalId: string; txnDate: string;
  /** Uncleared part of the entry's line on the bank account (signed, + = money in). */
  remaining: bigint;
  narration: string; partyName?: string | null; provisional: boolean;
  /** Other accounts the journal touches (a transfer names the other own bank account). */
  otherAccounts: string[];
}
/** An earlier statement line of the same account that cleared entries (for returns). */
export interface PriorLine { txnId: string; txnDate: string; signed: bigint; narration: string; reference: string | null; journalIds: string[] }
export interface OwnAccount { glAccountId: string; last4: string }
export interface SettlementContext {
  legs: SettlementLeg[]; prior: PriorLine[];
  /** The book's other registered bank accounts. */
  own: OwnAccount[];
  /** Largest difference a person may confirm as a fee on a net settlement (paise); 0: never a fee. */
  feeTolerance: bigint;
  /** How far back (days) counterparty evidence reaches; references reach any age. */
  windowDays: number;
}

export type Evidence = "reference" | "own_account" | "counterparty" | "different" | "unknown";
export type SettlementOutcome =
  | { kind: "clear"; match: "one_to_one" | "one_to_many" | "partial"; basis: "reference" | "own_account" | "counterparty"; legs: { journalId: string; amount: bigint }[] }
  | { kind: "review"; review: "match" | "fee" | "return" | "partial"; candidates: string[]; reason: string }
  | { kind: "transfer"; toAccount: string }
  | { kind: "none" };

const AHEAD_DAYS = 3;
const MAX_SUBSET = 12;
const RETURN_WORDS = /\b(return|returned|rtn|reversal|reversed|rev|bounce|bounced|unpaid|dishonou?red|rejected|chargeback)\b/i;
const TRANSFER_WORDS = /\b(trf|transfer|self|own|sweep|neft|rtgs|imps|ift)\b/i;
const abs = (x: bigint) => (x < 0n ? -x : x);
const sign = (x: bigint) => (x < 0n ? -1 : x > 0n ? 1 : 0);
const shiftDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Does the text name this own account (its last 4 digits at the end of a digit or mask run)? */
export const namesAccount = (text: string, last4: string) => new RegExp(`(?:^|[^0-9])[x*0-9]*${last4}(?![0-9])`, "i").test(text);

export function judge(line: SettlementLine, leg: SettlementLeg, own: OwnAccount[]): Evidence {
  const lineRefs = refsOf(line.reference ?? undefined, line.narration);
  if ([...refsOf(undefined, leg.narration)].some((r) => lineRefs.has(r))) return "reference";
  if (own.some((o) => leg.otherAccounts.includes(o.glAccountId) && namesAccount(line.narration, o.last4))) return "own_account";
  const theirs = matchWords(leg.narration, leg.partyName);
  const ours = matchWords(line.narration, line.counterpartyHint);
  if (!theirs.size || !ours.size) return "unknown";
  return wordsOverlap(theirs, ours) ? "counterparty" : "different";
}

/** Subsets (size >= 2) of `legs` whose remaining amounts add up to `target`; stops after two. */
function subsets(legs: SettlementLeg[], target: bigint): SettlementLeg[][] {
  const out: SettlementLeg[][] = [];
  const xs = legs.slice(0, MAX_SUBSET);
  const walk = (i: number, acc: SettlementLeg[], sum: bigint) => {
    if (out.length > 1) return;
    if (sum === target && acc.length >= 2) { out.push([...acc]); return; }
    if (i >= xs.length || abs(sum) > abs(target)) return;
    acc.push(xs[i]!); walk(i + 1, acc, sum + xs[i]!.remaining); acc.pop();
    walk(i + 1, acc, sum);
  };
  walk(0, [], 0n);
  return out;
}

export function matchSettlement(line: SettlementLine, ctx: SettlementContext): SettlementOutcome {
  if (line.signed === 0n) return { kind: "none" };
  const lo = shiftDays(line.txnDate, -ctx.windowDays), hi = shiftDays(line.txnDate, AHEAD_DAYS);
  const lineRefs = refsOf(line.reference ?? undefined, line.narration);

  // returns: wording plus an earlier cleared line of the opposite direction and the same amount sharing a reference
  if (RETURN_WORDS.test(line.narration)) {
    const prior = ctx.prior.filter((p) => p.signed === -line.signed && p.journalIds.length && p.txnDate <= line.txnDate
      && [...refsOf(p.reference ?? undefined, p.narration)].some((r) => lineRefs.has(r)));
    if (prior.length) {
      return { kind: "review", review: "return", candidates: [...new Set(prior.flatMap((p) => p.journalIds))],
        reason: `returns ${prior.length === 1 ? "the payment" : `one of ${prior.length} payments`} of ${prior.map((p) => p.txnDate).join(", ")} (shared reference): a person links the return and a new decision follows` };
    }
  }

  const judged = ctx.legs
    .filter((l) => l.remaining !== 0n && sign(l.remaining) === sign(line.signed) && l.txnDate <= hi)
    .map((l) => ({ l, ev: judge(line, l, ctx.own) }))
    .filter((x) => x.ev === "reference" || x.l.txnDate >= lo);

  // one-to-one on the strongest evidence
  const exact = judged.filter((x) => x.l.remaining === line.signed);
  for (const basis of ["reference", "own_account", "counterparty"] as const) {
    const hits = exact.filter((x) => x.ev === basis);
    if (hits.length === 1) return { kind: "clear", match: "one_to_one", basis, legs: [{ journalId: hits[0]!.l.journalId, amount: line.signed }] };
    if (hits.length > 1) return { kind: "review", review: "match", candidates: hits.map((h) => h.l.journalId), reason: `${hits.length} book entries of the same amount match on ${basis.replace("_", " ")}` };
  }
  const unknown = exact.filter((x) => x.ev === "unknown");
  if (unknown.length) {
    return { kind: "review", review: "match", candidates: unknown.map((u) => u.l.journalId),
      reason: unknown.length === 1 ? "same amount as a book entry, but nothing identifies it (no shared reference or counterparty)"
        : `${unknown.length} book entries of the same amount that nothing tells apart (no shared reference or counterparty)` };
  }

  // one-to-many: every entry sharing the reference adds up to the line
  const byRef = judged.filter((x) => x.ev === "reference").map((x) => x.l);
  if (byRef.length >= 2 && byRef.reduce((a, l) => a + l.remaining, 0n) === line.signed) {
    return { kind: "clear", match: "one_to_many", basis: "reference", legs: byRef.map((l) => ({ journalId: l.journalId, amount: l.remaining })) };
  }
  // one-to-many: exactly one combination of one counterparty's entries adds up to the line
  const byParty = judged.filter((x) => x.ev === "counterparty" || x.ev === "own_account").map((x) => x.l);
  if (byParty.length >= 2) {
    const combos = subsets(byParty, line.signed);
    if (combos.length === 1) return { kind: "clear", match: "one_to_many", basis: "counterparty", legs: combos[0]!.map((l) => ({ journalId: l.journalId, amount: l.remaining })) };
    if (combos.length > 1) return { kind: "review", review: "match", candidates: [...new Set(combos.flat().map((l) => l.journalId))], reason: "several combinations of the counterparty's entries add up to this line" };
  }

  // partial settlement, or a settlement net of a fee
  const larger = byRef.filter((l) => abs(l.remaining) > abs(line.signed));
  if (larger.length === 1) {
    const leg = larger[0]!, diff = abs(leg.remaining) - abs(line.signed);
    if (ctx.feeTolerance > 0n && diff <= ctx.feeTolerance) {
      return { kind: "review", review: "fee", candidates: [leg.journalId],
        reason: `settles the entry less ${diff} paise, within the account's fee tolerance: confirm the fee (posted as its own journal) or a partial settlement` };
    }
    return { kind: "clear", match: "partial", basis: "reference", legs: [{ journalId: leg.journalId, amount: line.signed }] };
  }
  if (larger.length > 1) return { kind: "review", review: "partial", candidates: larger.map((l) => l.journalId), reason: `${larger.length} larger entries share the reference: which one does this line settle in part?` };
  const partyLarger = byParty.filter((l) => abs(l.remaining) > abs(line.signed));
  if (partyLarger.length) {
    const fee = ctx.feeTolerance > 0n && partyLarger.length === 1 && abs(partyLarger[0]!.remaining) - abs(line.signed) <= ctx.feeTolerance;
    return { kind: "review", review: fee ? "fee" : "partial", candidates: partyLarger.map((l) => l.journalId),
      reason: fee ? "the counterparty's entry less a difference within the fee tolerance: confirm the fee or a partial settlement"
        : "a larger entry of the same counterparty: a person decides whether this line settles part of it" };
  }

  // own-account transfer with no book entry yet: post it as a transfer (both legs are bank lines)
  if (TRANSFER_WORDS.test(line.narration)) {
    const to = ctx.own.filter((o) => namesAccount(line.narration, o.last4));
    if (to.length === 1) return { kind: "transfer", toAccount: to[0]!.glAccountId };
  }
  return { kind: "none" };
}

/** A clearing the agent records through the hook: legs sum to the line's signed amount. */
export interface Clearing {
  bookId: string; instrument: string; txnId: string; txnDate: string;
  kind: "one_to_one" | "one_to_many" | "partial" | "fee" | "return" | "transfer";
  basis: "reference" | "counterparty" | "user" | "own_account";
  legs: { journalId: string; amount: bigint }[];
  by: string;
}

/**
 * What the bank module provides to the agent (set by the cell). `context` returns null for an
 * instrument that is not a registered bank account of the book: the agent's provisional matching
 * then applies unchanged.
 */
export interface ClearingHook {
  context(tx: TransactionSql, tenantId: string, bookId: string, instrument: string, txnId: string): Promise<(SettlementContext & { bankAccountId: string }) | null>;
  /** Record the line (every line of a registered account, whatever the outcome), in the agent's transaction. */
  noteLine(tx: TransactionSql, tenantId: string, bookId: string, instrument: string, txnId: string, txn: RawTxn): Promise<void>;
  record(tx: TransactionSql, tenantId: string, c: Clearing): Promise<void>;
  /** A journal's lines as posted (a return mirrors them). */
  journal(tenantId: string, bookId: string, journalId: string): Promise<{ txnDate: string; narration: string; lines: import("@kuber/contracts").Line[] } | null>;
}
