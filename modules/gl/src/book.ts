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
  GENESIS_HASH, bookConfigOf, canonical, isIsoDate, sha256, type Account, type BookConfig, type CommandSignature, type Envelope, type EventData, type Line,
} from "@kuber/contracts";
import type { NewEvent } from "@kuber/eventstore";
import { JournalMap } from "./journals.ts";
import { assertBookCurrency, checkManualControl, checkNotSuspenseOriginal, checkSuspenseClearing, isSuspense, suspenseLines } from "./controls.ts";

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
  /** FIN-MDM-01: legal entity, framework, basis, currency, fiscal year, purpose (defaults for older books). */
  config: BookConfig;
  /** FIN-MDM-02: closed accounts (no new ordinary entries; reversals and corrections still post). */
  closed: ReadonlySet<string>;
}

/** Facts from outside the book that `decide` needs (loaded by the GL before deciding; decide stays pure). */
export interface DecideContext {
  /** Legal entity of each registered party named on the command's lines (FIN-MDM-01/03). Unregistered parties are absent. */
  partyEntities?: ReadonlyMap<string, string>;
}

export const emptyBook = (): BookState => ({
  exists: false, bookId: "", entityId: "", accounts: new Map(), locks: [], seq: 0, version: 0, lastHash: GENESIS_HASH, journals: JournalMap.empty(),
  config: bookConfigOf({ entityId: "", entityType: "", basis: "statutory" }), closed: new Set(),
});

/** Set one journal, sharing structure with the previous map (O(log n), not a copy of the book). */
const withJournal = (m: ReadonlyMap<string, JournalRecord>, id: string, j: JournalRecord) =>
  (m instanceof JournalMap ? m : JournalMap.from(m)).with(id, j);

export type BookCommand =
  | { kind: "OpenBook"; bookId: string; entityId: string; entityType: string; basis?: "statutory" | "management" | "tax" | "budget" | "scenario" | "consolidation"; accounts: Account[];
      legalEntityId?: string; framework?: string; fiscalYearStartMonth?: number; purpose?: "personal" | "business"; functionalCurrency?: { code: "INR"; exponent: 2 } }
  | { kind: "AddAccount"; account: Account }
  | { kind: "PostJournal"; journalId: string; txnDate: string; narration: string; voucherType?: string; lines: Line[];
      provisional?: boolean; source?: { stream: string; eventId?: string }; autonomy?: "L0" | "L1" | "L2" | "L3" | "L4" | "human"; confidence?: number;
      /** FIN-GL-04: absent means the book currency; any other currency is refused. */
      currency?: string;
      /** FIN-GL-01: a journal entered by a person (API, ops record); control accounts then need a controlled adjustment. */
      entry?: "manual"; controlledAdjustment?: { reason: string } }
  | { kind: "ReverseJournal"; journalId: string; reversalJournalId: string; reason: string; onDate?: string }
  | { kind: "CorrectJournal"; journalId: string; fromAccount: string; toAccount: string; reversalJournalId: string; newJournalId: string }
  /** `signature`: the person's signature over a directly requested lock (design 16.4), recorded on PeriodLocked. */
  | { kind: "LockPeriod"; periodEnd: string; level: "soft" | "hard"; signature?: CommandSignature }
  | { kind: "ConfirmJournal"; journalId: string; source: string; basis?: string }
  | { kind: "CloseAccount"; accountId: string; reason: string }
  | { kind: "ChangeAccountControls"; accountId: string; taxonomyTag?: string; requiredDims?: string[]; reason?: string }
  /**
   * FIN-GL-05: clear a suspense item. Reverses the original on `onDate` (not its own date, so earlier
   * periods keep their position) and, with `toAccount`, reposts it with the suspense line(s) moved there.
   */
  | { kind: "ResolveSuspense"; itemId: string; journalId: string; reversalJournalId: string; newJournalId?: string; toAccount?: string;
      partyId?: string; dimensions?: Record<string, string>; onDate: string };

const PRIVILEGED = new Set(["owner", "controller"]);
const roleOf = (principal: string) => principal.split(":")[0] ?? "";

export const evolve = (s: BookState, e: Envelope): BookState => ({ ...apply(s, e), version: e.streamVersion });

function apply(s: BookState, e: Envelope): BookState {
  switch (e.type) {
    case "BookOpened": {
      const d = e.data as EventData<"BookOpened">;
      return { ...s, exists: true, bookId: d.bookId, entityId: d.entityId, accounts: new Map(d.accounts.map((a) => [a.accountId, a])), config: bookConfigOf(d) };
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
    case "AccountClosed": {
      const d = e.data as EventData<"AccountClosed">;
      return { ...s, closed: new Set([...s.closed, d.accountId]) };
    }
    case "AccountControlsChanged": {
      const d = e.data as EventData<"AccountControlsChanged">;
      const a = s.accounts.get(d.accountId);
      if (!a) return s;
      const accounts = new Map(s.accounts);
      accounts.set(d.accountId, { ...a, ...(d.taxonomyTag !== undefined ? { taxonomyTag: d.taxonomyTag } : {}), ...(d.requiredDims !== undefined ? { requiredDims: d.requiredDims } : {}) });
      return { ...s, accounts };
    }
    default:
      return s;
  }
}

export const fold = (events: Envelope[]) => events.reduce(evolve, emptyBook());

/** The source of the fold (for the snapshot schema fingerprint): any change to it invalidates snapshots. */
export const FOLD_SOURCE = () => [emptyBook, evolve, apply].map(String).join("\n");

export function decide(s: BookState, c: BookCommand, principal: string, ctx: DecideContext = {}): NewEvent[] {
  if (c.kind === "OpenBook") {
    if (s.exists) throw new DomainError("book_exists", `book ${c.bookId} already exists`);
    if (c.fiscalYearStartMonth !== undefined && !(Number.isInteger(c.fiscalYearStartMonth) && c.fiscalYearStartMonth >= 1 && c.fiscalYearStartMonth <= 12))
      throw new DomainError("bad_fiscal_year", "fiscal year start month must be 1 to 12");
    if (c.functionalCurrency && (c.functionalCurrency.code !== "INR" || c.functionalCurrency.exponent !== 2))
      throw new DomainError("bad_currency", "the functional currency is INR with 2 decimal places");
    const cfg = { ...(c.legalEntityId ? { legalEntityId: c.legalEntityId } : {}), ...(c.framework ? { framework: c.framework } : {}),
      ...(c.fiscalYearStartMonth ? { fiscalYearStartMonth: c.fiscalYearStartMonth } : {}), ...(c.purpose ? { purpose: c.purpose } : {}),
      ...(c.functionalCurrency ? { functionalCurrency: c.functionalCurrency } : {}) };
    return [{ type: "BookOpened", data: { bookId: c.bookId, entityId: c.entityId, entityType: c.entityType, basis: c.basis ?? "statutory", currency: "INR", accounts: c.accounts, ...cfg } }];
  }
  if (!s.exists) throw new DomainError("no_book", "book does not exist");

  switch (c.kind) {
    case "AddAccount": {
      const a = c.account;
      if (s.accounts.has(a.accountId)) throw new DomainError("account_exists", `account ${a.accountId} already exists`);
      if (a.parentId) {
        const p = s.accounts.get(a.parentId);
        if (!p) throw new DomainError("no_parent", `unknown parent ${a.parentId}`);
        if (s.closed.has(a.parentId)) throw new DomainError("account_closed", `parent ${a.parentId} is closed`);
        if (p.nature !== a.nature) throw new DomainError("nature_mismatch", "a child account must have the same nature as its parent");
      }
      return [{ type: "AccountAdded", data: { bookId: s.bookId, account: { ...a, taxonomyTag: a.taxonomyTag ?? (a.parentId ? s.accounts.get(a.parentId)?.taxonomyTag : undefined) } } }];
    }
    case "PostJournal": {
      if (s.journals.has(c.journalId)) return [];                    // idempotent retry
      assertBookCurrency(c.currency);
      checkConsolidationVoucher(s, c.voucherType);
      validateJournal(s, c.txnDate, c.lines, principal);
      checkEntity(s, c.lines, ctx);
      // A control line naming a registered master party is a subledger posting; any other manual
      // control line must be a controlled adjustment (FIN-GL-01 with the FIN-MDM-03 party master).
      if (c.entry === "manual") checkManualControl(s, c.lines, principal, c.controlledAdjustment, ctx.partyEntities);
      checkSuspenseClearing(s, c.lines, c.entry === "manual");
      return [journalEvent(s, s.seq + 1, s.lastHash, c.journalId, c.txnDate, c.narration, c.voucherType ?? "journal", c.lines,
        { provisional: c.provisional ?? false, source: c.source, autonomy: c.autonomy, confidence: c.confidence,
          ...(c.entry === "manual" && c.controlledAdjustment ? { controlledAdjustment: { reason: c.controlledAdjustment.reason } } : {}) })];
    }
    case "ReverseJournal": {
      if (s.journals.has(c.reversalJournalId)) return [];
      return reversal(s, c.journalId, c.reversalJournalId, c.reason, c.onDate, principal).events;
    }
    case "CorrectJournal": {
      if (s.journals.has(c.newJournalId)) return [];
      checkNotSuspenseOriginal(s, c.journalId);
      const orig = s.journals.get(c.journalId);
      if (!orig) throw new DomainError("no_journal", `no journal ${c.journalId}`);
      if (!orig.lines.some((l) => l.accountId === c.fromAccount)) throw new DomainError("no_line", `${c.journalId} has no line on ${c.fromAccount}`);
      if (!s.accounts.has(c.toAccount)) throw new DomainError("no_account", `unknown account ${c.toAccount}`);
      if (s.closed.has(c.toAccount)) throw new DomainError("account_closed", `${c.toAccount} is closed: nothing can be reclassified into it`);
      const r = reversal(s, c.journalId, c.reversalJournalId, `reclassified to ${c.toAccount}`, undefined, principal);
      const lines = orig.lines.map((l) => (l.accountId === c.fromAccount ? { ...l, accountId: c.toAccount } : l));
      // A correction may still touch the original journal's other (possibly since closed) accounts.
      validateJournal(s, orig.txnDate, lines, principal, { historical: new Set(orig.lines.map((l) => l.accountId).filter((id) => id !== c.toAccount)) });
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
    case "ResolveSuspense": {
      if (s.journals.has(c.reversalJournalId)) return [];             // idempotent retry
      const orig = s.journals.get(c.journalId);
      if (!orig) throw new DomainError("no_journal", `no journal ${c.journalId}`);
      if (!suspenseLines(s, orig.lines).length) throw new DomainError("not_suspense", `${c.journalId} has no suspense line`);
      if (!isIsoDate(c.onDate)) throw new DomainError("bad_date", `bad resolution date ${c.onDate}`);
      if (c.toAccount !== undefined) {
        if (!s.accounts.has(c.toAccount)) throw new DomainError("no_account", `unknown account ${c.toAccount}`);
        if (isSuspense(s.accounts.get(c.toAccount))) throw new DomainError("suspense_unresolved", "a suspense item cannot be resolved into suspense");
        if (s.closed.has(c.toAccount)) throw new DomainError("account_closed", `${c.toAccount} is closed: a suspense item cannot be resolved into it`);
        if (!c.newJournalId) throw new DomainError("bad_command", "a reclassification needs the replacement journal id");
      }
      const r = reversal(s, c.journalId, c.reversalJournalId, `suspense item ${c.itemId} resolved${c.toAccount ? ` to ${c.toAccount}` : " (reversed)"}`, c.onDate, principal);
      if (c.toAccount === undefined) return r.events;
      const lines = orig.lines.map((l) => (isSuspense(s.accounts.get(l.accountId))
        ? { ...l, accountId: c.toAccount!, ...(c.partyId ? { partyId: c.partyId } : {}), dimensions: { ...(l.dimensions ?? {}), ...(c.dimensions ?? {}) } } : l));
      // the original's other lines (e.g. the bank line) are copied: they may be on a since-closed account
      validateJournal(s, c.onDate, lines, principal, { historical: new Set(orig.lines.map((l) => l.accountId).filter((id) => id !== c.toAccount)) });
      const repost = journalEvent(s, r.seq + 1, r.hash, c.newJournalId!, c.onDate, `Suspense resolved: ${orig.narration}`, orig.voucherType, lines,
        { provisional: false, autonomy: "human", replaces: c.journalId });
      return [...r.events, repost];
    }
    case "LockPeriod": {
      if (!isIsoDate(c.periodEnd)) throw new DomainError("bad_date", `bad period end ${c.periodEnd}`);
      if (!PRIVILEGED.has(roleOf(principal))) throw new DomainError("forbidden", "only an owner or controller can lock a period");
      return [{ type: "PeriodLocked", data: { bookId: s.bookId, periodEnd: c.periodEnd, level: c.level, ...(c.signature ? { signature: c.signature } : {}) } }];
    }
    case "CloseAccount": {
      if (!PRIVILEGED.has(roleOf(principal))) throw new DomainError("forbidden", "only an owner or controller can close an account");
      if (!s.accounts.has(c.accountId)) throw new DomainError("no_account", `unknown account ${c.accountId}`);
      if (s.closed.has(c.accountId)) return [];                        // idempotent
      if (!c.reason.trim()) throw new DomainError("reason_required", "closing an account needs a reason");
      const openChild = [...s.accounts.values()].find((a) => a.parentId === c.accountId && !s.closed.has(a.accountId));
      if (openChild) throw new DomainError("open_children", `close ${openChild.accountId} (a child of ${c.accountId}) first`);
      const bal = accountBalance(s, c.accountId);
      if (bal !== 0n) throw new DomainError("account_has_balance", `${c.accountId} has a balance of ${bal} paise: clear it before closing`);
      return [{ type: "AccountClosed", data: { bookId: s.bookId, accountId: c.accountId, reason: c.reason } }];
    }
    case "ChangeAccountControls": {
      if (!PRIVILEGED.has(roleOf(principal))) throw new DomainError("forbidden", "only an owner or controller can change account controls");
      const a = s.accounts.get(c.accountId);
      if (!a) throw new DomainError("no_account", `unknown account ${c.accountId}`);
      if (c.taxonomyTag === undefined && c.requiredDims === undefined) return [];
      if (c.taxonomyTag !== undefined && !c.taxonomyTag.trim()) throw new DomainError("bad_mapping", "a statement mapping cannot be empty");
      const dims = c.requiredDims === undefined ? undefined : [...new Set(c.requiredDims.map((d) => d.trim()))];
      if (dims?.some((d) => !d)) throw new DomainError("bad_dimension", "dimension names cannot be empty");
      const same = (c.taxonomyTag === undefined || c.taxonomyTag === a.taxonomyTag) && (dims === undefined || canonical(dims) === canonical(a.requiredDims));
      if (same) return [];
      return [{ type: "AccountControlsChanged", data: { bookId: s.bookId, accountId: c.accountId,
        ...(c.taxonomyTag !== undefined ? { taxonomyTag: c.taxonomyTag } : {}), ...(dims !== undefined ? { requiredDims: dims } : {}),
        previous: { taxonomyTag: a.taxonomyTag ?? null, requiredDims: a.requiredDims }, ...(c.reason ? { reason: c.reason } : {}) } }];
    }
  }
}

/** Balance of one account over all journals (debit positive). */
function accountBalance(s: BookState, accountId: string): bigint {
  const idx = s.journals instanceof JournalMap ? s.journals.balances() : null;
  if (idx) return idx.get(accountId) ?? 0n;
  let b = 0n;
  for (const j of s.journals.values()) for (const l of j.lines) if (l.accountId === accountId) b += BigInt(l.amount);
  return b;
}

/**
 * Two legal entities never share a posting by accident (FIN-MDM-01): a line may not name a
 * registered party of another legal entity, nor carry an entity dimension other than the book's.
 */
export function checkEntity(s: BookState, lines: Line[], ctx: DecideContext) {
  const own = s.config.legalEntityId;
  for (const l of lines) {
    for (const k of ENTITY_DIMENSIONS) {
      const v = l.dimensions?.[k];
      if (v !== undefined && v !== own) throw new DomainError("cross_entity", `line on ${l.accountId} names entity ${v}; this book belongs to ${own}`);
    }
    const pe = l.partyId ? ctx.partyEntities?.get(l.partyId) : undefined;
    if (pe !== undefined && pe !== own) throw new DomainError("cross_entity", `party ${l.partyId} belongs to entity ${pe}; this book belongs to ${own}`);
  }
}
/**
 * FIN-GRP-03: a consolidation book (basis "consolidation") holds only consolidation vouchers
 * (eliminations, NCI, equity accounting), and a consolidation voucher never lands in a local book.
 */
export function checkConsolidationVoucher(s: BookState, voucherType: string | undefined) {
  const consolidation = s.config.basis === "consolidation", voucher = (voucherType ?? "journal") === "consolidation";
  if (consolidation && !voucher) throw new DomainError("consolidation_book", `${s.bookId} is a consolidation book: it accepts only consolidation vouchers from an approved consolidation plan`);
  if (!consolidation && voucher) throw new DomainError("consolidation_book", `consolidation vouchers post only to a consolidation book; ${s.bookId} is a ${s.config.basis} book`);
}
/** Dimension keys that would name a legal entity. The entity is book configuration, never a dimension. */
const ENTITY_DIMENSIONS = ["entity", "legalEntity", "legal_entity"];

function reversal(s: BookState, journalId: string, reversalJournalId: string, reason: string, onDate: string | undefined, principal: string) {
  const j = s.journals.get(journalId);
  if (!j) throw new DomainError("no_journal", `no journal ${journalId}`);
  if (j.reversedBy) throw new DomainError("already_reversed", `${journalId} is already reversed`);
  const lines = j.lines.map((l) => ({ ...l, amount: (-BigInt(l.amount)).toString() }));
  const date = onDate ?? j.txnDate;
  validateJournal(s, date, lines, principal, { historical: new Set(j.lines.map((l) => l.accountId)) });
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

/**
 * `opts.historical`: accounts whose lines are copied from an earlier journal (a reversal or the
 * untouched lines of a correction). They may post to a closed account and are not re-checked for
 * dimensions made mandatory later; everything else is validated as a new entry.
 */
export function validateJournal(s: BookState, txnDate: string, lines: Line[], principal: string, opts: { historical?: ReadonlySet<string> } = {}) {
  if (lines.length < 2) throw new DomainError("too_few_lines", "a journal needs at least two lines");
  let total = 0n;
  for (const l of lines) {
    const amt = BigInt(l.amount);
    if (amt === 0n) throw new DomainError("zero_line", "zero-amount lines are not allowed");
    total += amt;
    const a = s.accounts.get(l.accountId);
    if (!a) throw new DomainError("no_account", `unknown account ${l.accountId}`);
    if (s.closed?.has(l.accountId) && !opts.historical?.has(l.accountId))
      throw new DomainError("account_closed", `${l.accountId} is closed: only reversals and corrections of earlier journals may post to it`);
    if (a.isControl && !l.partyId) throw new DomainError("control_needs_party", `${l.accountId} is a control account: every line needs a party`);
    // Lines copied from an earlier journal (reversal, correction) keep the dimensions they were posted with.
    const missing = opts.historical?.has(l.accountId) ? [] : a.requiredDims.filter((d) => !((l.dimensions ?? {})[d] ?? "").trim());
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

/** Recompute the chain from events (continuing from hash `from`). Returns the first broken journal, or null if intact. */
export function verifyChain(events: Envelope[], from: string = GENESIS_HASH): string | null {
  let prev = from;
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
