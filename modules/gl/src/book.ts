/**
 * The Book aggregate: the GL's consistency boundary.
 *
 * decide(state, command) -> events   (pure; throws DomainError when an invariant would break)
 * evolve(state, event)   -> state    (pure; replays history)
 *
 * Invariants: every journal balances in integer paise; accounts exist; control accounts carry
 * a party; required dimensions are present; hard-locked periods reject postings; soft-locked
 * periods accept only owner or controller; every journal extends the book's hash chain.
 */
import {
  GENESIS_HASH, canonical, isIsoDate, sha256, type Account, type Envelope, type EventData, type Line,
} from "@kuber/contracts";
import type { NewEvent } from "@kuber/eventstore";
import { JournalMap } from "./journals.ts";

export class DomainError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface JournalRecord {
  lines: Line[]; txnDate: string; narration: string; voucherType: string; provisional: boolean; reversedBy?: string; createdBy: string;
  /** Source that confirmed a provisional journal (JournalConfirmed); the journal is then no longer provisional. */
  confirmedBy?: string;
}

export interface BookState {
  exists: boolean;
  bookId: string;
  entityId: string;
  accounts: Map<string, Account>;
  locks: { periodEnd: string; level: "soft" | "hard" }[];
  /** Journals posted (the journal chain position). */
  seq: number;
  /** Events applied: changes with every journal, account and lock, so it fences the whole aggregate. */
  version: number;
  lastHash: string;
  /**
   * Every journal in posting order. A persistent JournalMap in states built by `evolve` (updates
   * share structure, and it carries balance/provisional indexes); any ReadonlyMap is accepted,
   * e.g. a what-if copy, and readers then fall back to scanning it.
   */
  journals: ReadonlyMap<string, JournalRecord>;
}

export const emptyBook = (): BookState => ({
  exists: false, bookId: "", entityId: "", accounts: new Map(), locks: [], seq: 0, version: 0, lastHash: GENESIS_HASH, journals: JournalMap.empty(),
});

/** Set one journal, sharing structure with the previous map (O(log n), not a copy of the book). */
const withJournal = (m: ReadonlyMap<string, JournalRecord>, id: string, j: JournalRecord) =>
  (m instanceof JournalMap ? m : JournalMap.from(m)).with(id, j);

export type BookCommand =
  | { kind: "OpenBook"; bookId: string; entityId: string; entityType: string; basis?: "statutory"; accounts: Account[] }
  | { kind: "AddAccount"; account: Account }
  | { kind: "PostJournal"; journalId: string; txnDate: string; narration: string; voucherType?: string; lines: Line[];
      provisional?: boolean; source?: { stream: string; eventId?: string }; autonomy?: "L0" | "L1" | "L2" | "L3" | "L4" | "human"; confidence?: number }
  | { kind: "ReverseJournal"; journalId: string; reversalJournalId: string; reason: string; onDate?: string }
  | { kind: "CorrectJournal"; journalId: string; fromAccount: string; toAccount: string; reversalJournalId: string; newJournalId: string }
  | { kind: "LockPeriod"; periodEnd: string; level: "soft" | "hard" }
  | { kind: "ConfirmJournal"; journalId: string; source: string; basis?: string };

const PRIVILEGED = new Set(["owner", "controller"]);
const roleOf = (principal: string) => principal.split(":")[0] ?? "";

export const evolve = (s: BookState, e: Envelope): BookState => ({ ...apply(s, e), version: e.streamVersion });

function apply(s: BookState, e: Envelope): BookState {
  switch (e.type) {
    case "BookOpened": {
      const d = e.data as EventData<"BookOpened">;
      return { ...s, exists: true, bookId: d.bookId, entityId: d.entityId, accounts: new Map(d.accounts.map((a) => [a.accountId, a])) };
    }
    case "AccountAdded": {
      const d = e.data as EventData<"AccountAdded">;
      const accounts = new Map(s.accounts); accounts.set(d.account.accountId, d.account);
      return { ...s, accounts };
    }
    case "JournalPosted": {
      const d = e.data as EventData<"JournalPosted">;
      const journals = withJournal(s.journals, d.journalId, { lines: d.lines, txnDate: d.txnDate, narration: d.narration, voucherType: d.voucherType,
        provisional: d.provisional, createdBy: e.meta.principal });
      return { ...s, seq: d.seq, lastHash: d.hash, journals };
    }
    case "JournalReversed": {
      const d = e.data as EventData<"JournalReversed">;
      const j = s.journals.get(d.journalId);
      return j ? { ...s, journals: withJournal(s.journals, d.journalId, { ...j, reversedBy: d.reversalJournalId }) } : s;
    }
    case "JournalConfirmed": {
      const d = e.data as EventData<"JournalConfirmed">;
      const j = s.journals.get(d.journalId);
      return j ? { ...s, journals: withJournal(s.journals, d.journalId, { ...j, provisional: false, confirmedBy: d.source }) } : s;
    }
    case "PeriodLocked": {
      const d = e.data as EventData<"PeriodLocked">;
      return { ...s, locks: [...s.locks.filter((l) => !(l.periodEnd === d.periodEnd && l.level === d.level)), { periodEnd: d.periodEnd, level: d.level }] };
    }
    default:
      return s;
  }
}

export const fold = (events: Envelope[]) => events.reduce(evolve, emptyBook());

/** The source of the fold (for the snapshot schema fingerprint): any change to it invalidates snapshots. */
export const FOLD_SOURCE = () => [emptyBook, evolve, apply].map(String).join("\n");

export function decide(s: BookState, c: BookCommand, principal: string): NewEvent[] {
  if (c.kind === "OpenBook") {
    if (s.exists) throw new DomainError("book_exists", `book ${c.bookId} already exists`);
    return [{ type: "BookOpened", data: { bookId: c.bookId, entityId: c.entityId, entityType: c.entityType, basis: c.basis ?? "statutory", currency: "INR", accounts: c.accounts } }];
  }
  if (!s.exists) throw new DomainError("no_book", "book does not exist");

  switch (c.kind) {
    case "AddAccount": {
      const a = c.account;
      if (s.accounts.has(a.accountId)) throw new DomainError("account_exists", `account ${a.accountId} already exists`);
      if (a.parentId) {
        const p = s.accounts.get(a.parentId);
        if (!p) throw new DomainError("no_parent", `unknown parent ${a.parentId}`);
        if (p.nature !== a.nature) throw new DomainError("nature_mismatch", "a child account must have the same nature as its parent");
      }
      return [{ type: "AccountAdded", data: { bookId: s.bookId, account: { ...a, taxonomyTag: a.taxonomyTag ?? (a.parentId ? s.accounts.get(a.parentId)?.taxonomyTag : undefined) } } }];
    }
    case "PostJournal": {
      if (s.journals.has(c.journalId)) return [];                    // idempotent retry
      validateJournal(s, c.txnDate, c.lines, principal);
      return [journalEvent(s, s.seq + 1, s.lastHash, c.journalId, c.txnDate, c.narration, c.voucherType ?? "journal", c.lines,
        { provisional: c.provisional ?? false, source: c.source, autonomy: c.autonomy, confidence: c.confidence })];
    }
    case "ReverseJournal": {
      if (s.journals.has(c.reversalJournalId)) return [];
      return reversal(s, c.journalId, c.reversalJournalId, c.reason, c.onDate, principal).events;
    }
    case "CorrectJournal": {
      if (s.journals.has(c.newJournalId)) return [];
      const orig = s.journals.get(c.journalId);
      if (!orig) throw new DomainError("no_journal", `no journal ${c.journalId}`);
      if (!orig.lines.some((l) => l.accountId === c.fromAccount)) throw new DomainError("no_line", `${c.journalId} has no line on ${c.fromAccount}`);
      if (!s.accounts.has(c.toAccount)) throw new DomainError("no_account", `unknown account ${c.toAccount}`);
      const r = reversal(s, c.journalId, c.reversalJournalId, `reclassified to ${c.toAccount}`, undefined, principal);
      const lines = orig.lines.map((l) => (l.accountId === c.fromAccount ? { ...l, accountId: c.toAccount } : l));
      validateJournal(s, orig.txnDate, lines, principal);
      const repost = journalEvent(s, r.seq + 1, r.hash, c.newJournalId, orig.txnDate, orig.narration, orig.voucherType, lines,
        { provisional: orig.provisional, autonomy: "human" });
      return [...r.events, repost];
    }
    case "ConfirmJournal": {
      // Confirmation changes no amount, account or date: it records that an authoritative source
      // line evidences the journal, so it is allowed in locked periods and the journal is not rewritten.
      const j = s.journals.get(c.journalId);
      if (!j) throw new DomainError("no_journal", `no journal ${c.journalId}`);
      if (!j.provisional) return [];                                  // idempotent (already confirmed, or never provisional)
      if (j.reversedBy) throw new DomainError("already_reversed", `${c.journalId} is reversed; it cannot be confirmed`);
      return [{ type: "JournalConfirmed", data: { bookId: s.bookId, journalId: c.journalId, source: c.source, ...(c.basis ? { basis: c.basis } : {}) } }];
    }
    case "LockPeriod": {
      if (!isIsoDate(c.periodEnd)) throw new DomainError("bad_date", `bad period end ${c.periodEnd}`);
      if (!PRIVILEGED.has(roleOf(principal))) throw new DomainError("forbidden", "only an owner or controller can lock a period");
      return [{ type: "PeriodLocked", data: { bookId: s.bookId, periodEnd: c.periodEnd, level: c.level } }];
    }
  }
}

function reversal(s: BookState, journalId: string, reversalJournalId: string, reason: string, onDate: string | undefined, principal: string) {
  const j = s.journals.get(journalId);
  if (!j) throw new DomainError("no_journal", `no journal ${journalId}`);
  if (j.reversedBy) throw new DomainError("already_reversed", `${journalId} is already reversed`);
  const lines = j.lines.map((l) => ({ ...l, amount: (-BigInt(l.amount)).toString() }));
  const date = onDate ?? j.txnDate;
  validateJournal(s, date, lines, principal);
  const posted = journalEvent(s, s.seq + 1, s.lastHash, reversalJournalId, date, `Reversal of ${journalId}: ${reason}`, j.voucherType, lines,
    { provisional: false, reverses: journalId, autonomy: "human" });
  const data = posted.data as EventData<"JournalPosted">;
  return {
    events: [posted, { type: "JournalReversed", data: { bookId: s.bookId, journalId, reversalJournalId, reason } } as NewEvent],
    seq: data.seq, hash: data.hash,
  };
}

function journalEvent(s: BookState, seq: number, prevHash: string, journalId: string, txnDate: string, narration: string,
                      voucherType: string, lines: Line[], extra: Partial<EventData<"JournalPosted">>): NewEvent<"JournalPosted"> {
  // normalise exactly as the stored event will look, so the hash is reproducible from storage
  const norm = lines.map((l) => ({ accountId: l.accountId, amount: BigInt(l.amount).toString(),
    ...(l.partyId ? { partyId: l.partyId } : {}), dimensions: { ...(l.dimensions ?? {}) } }));
  const body = { journalId, seq, txnDate, narration, voucherType, lines: norm, provisional: extra.provisional ?? false, reverses: extra.reverses };
  const hash = sha256(prevHash + canonical(body));
  return { type: "JournalPosted", data: { bookId: s.bookId, ...body, ...extra, provisional: body.provisional, prevHash, hash } as EventData<"JournalPosted"> };
}

export function validateJournal(s: BookState, txnDate: string, lines: Line[], principal: string) {
  if (lines.length < 2) throw new DomainError("too_few_lines", "a journal needs at least two lines");
  let total = 0n;
  for (const l of lines) {
    const amt = BigInt(l.amount);
    if (amt === 0n) throw new DomainError("zero_line", "zero-amount lines are not allowed");
    total += amt;
    const a = s.accounts.get(l.accountId);
    if (!a) throw new DomainError("no_account", `unknown account ${l.accountId}`);
    if (a.isControl && !l.partyId) throw new DomainError("control_needs_party", `${l.accountId} is a control account: every line needs a party`);
    const missing = a.requiredDims.filter((d) => !(d in (l.dimensions ?? {})));
    if (missing.length) throw new DomainError("missing_dimensions", `${l.accountId} requires dimensions ${missing.join(", ")}`);
  }
  if (total !== 0n) throw new DomainError("unbalanced", `journal does not balance: debits minus credits = ${total} paise`);
  if (!isIsoDate(txnDate)) throw new DomainError("bad_date", `bad transaction date ${txnDate}`);
  for (const lock of s.locks) {
    if (txnDate > lock.periodEnd) continue;
    if (lock.level === "hard") throw new DomainError("period_hard_locked", `period ending ${lock.periodEnd} is hard-locked`);
    if (!PRIVILEGED.has(roleOf(principal))) throw new DomainError("period_soft_locked", `period ending ${lock.periodEnd} is soft-locked; only owner or controller may post`);
  }
}

/** Recompute the chain from events. Returns the first broken journal, or null if intact. */
export function verifyChain(events: Envelope[]): string | null {
  let prev = GENESIS_HASH;
  for (const e of events) {
    if (e.type !== "JournalPosted") continue;
    const d = e.data as EventData<"JournalPosted">;
    const body = { journalId: d.journalId, seq: d.seq, txnDate: d.txnDate, narration: d.narration, voucherType: d.voucherType,
      lines: d.lines, provisional: d.provisional, reverses: d.reverses };
    if (d.prevHash !== prev || sha256(prev + canonical(body)) !== d.hash) return d.journalId;
    prev = d.hash;
  }
  return null;
}
