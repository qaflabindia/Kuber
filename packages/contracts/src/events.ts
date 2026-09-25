/**
 * Event and command contracts shared by every module. Zod schemas are the single
 * source of truth; JSON Schema for the Python workers is generated from them.
 *
 * Rules: events are facts in the past tense and never change. Adding a field is a
 * compatible change; renaming or removing one needs a new schemaVersion plus an upcaster.
 */
import { z } from "zod";
import { MinorString } from "./money.ts";

export const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:@+\-]+$/);
/**
 * A real calendar date, YYYY-MM-DD. The shape alone is not enough: "2026-02-31" would be kept as
 * text by the ledger but normalised to 2026-03-03 by PostgreSQL, so the two would disagree on the
 * period (F08). Every date that enters the system passes through this.
 */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
}
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine(isIsoDate, "not a real calendar date");
export const Principal = z.string().regex(/^(owner|controller|preparer|approver|member|auditor|agent|system):[\w.@\-]+$/);
export const AutonomyLevel = z.enum(["L0", "L1", "L2", "L3", "L4"]);
export const Nature = z.enum(["asset", "liability", "equity", "income", "expense"]);
export const Trust = z.enum(["authoritative", "provisional", "user"]);

export const Line = z.object({
  accountId: Id,
  amount: MinorString,                 // paise; debit positive, credit negative
  partyId: Id.optional(),
  dimensions: z.record(z.string(), z.string()).default({}),
});
export type Line = z.infer<typeof Line>;

export const Account = z.object({
  accountId: Id,
  name: z.string().min(1),
  nature: Nature,
  parentId: Id.optional(),
  isControl: z.boolean().default(false),
  isCashLike: z.boolean().default(false),
  taxonomyTag: z.string().optional(),
  requiredDims: z.array(z.string()).default([]),
});
export type Account = z.infer<typeof Account>;

/** Metadata carried by every event (the envelope). */
export const Meta = z.object({
  tenantId: Id,
  cellId: z.string().default("local"),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().optional(),
  principal: Principal,
  occurredAt: z.string(),
  commandId: z.string().optional(),
  policyIds: z.array(z.string()).optional(),
  signature: z.string().optional(),     // passkey assertion over the command hash (phase 1)
});
export type Meta = z.infer<typeof Meta>;

// ------------------------------------------------------------------ Book configuration (FIN-MDM-01)
export const BookPurpose = z.enum(["personal", "business"]);
export const FunctionalCurrency = z.object({ code: z.literal("INR"), exponent: z.literal(2) });
const BookConfigFields = {
  /** The legal (reporting) entity the book belongs to: not a branch and not a dimension. */
  legalEntityId: Id.optional(),
  /** Accounting framework label, e.g. "Ind AS", "AS (ICAI)", "ITR"; free text, "unspecified" by default. */
  framework: z.string().min(1).max(60).optional(),
  functionalCurrency: FunctionalCurrency.optional(),
  /** Month the fiscal year starts (1 = January, 4 = April). */
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  purpose: BookPurpose.optional(),
};
export interface BookConfig {
  legalEntityId: string; entityType: string; basis: string; framework: string;
  functionalCurrency: { code: "INR"; exponent: 2 }; fiscalYearStartMonth: number; purpose: "personal" | "business";
}
const PERSONAL_ENTITY_TYPES = new Set(["individual", "household"]);
/** Configuration of a book from its BookOpened data, applying the defaults for books opened before FIN-MDM-01. */
export function bookConfigOf(d: { entityId: string; entityType: string; basis: string; legalEntityId?: string; framework?: string;
  functionalCurrency?: { code: "INR"; exponent: 2 }; fiscalYearStartMonth?: number; purpose?: "personal" | "business" }): BookConfig {
  return {
    legalEntityId: d.legalEntityId ?? d.entityId, entityType: d.entityType, basis: d.basis, framework: d.framework ?? "unspecified",
    functionalCurrency: d.functionalCurrency ?? { code: "INR", exponent: 2 }, fiscalYearStartMonth: d.fiscalYearStartMonth ?? 4,
    purpose: d.purpose ?? (PERSONAL_ENTITY_TYPES.has(d.entityType) ? "personal" : "business"),
  };
}

// ------------------------------------------------------------------ GL events
export const GL = {
  BookOpened: z.object({
    bookId: Id, entityId: Id, entityType: z.string(), basis: z.enum(["statutory", "management", "tax", "budget", "scenario"]),
    currency: z.literal("INR"), accounts: z.array(Account),
    // FIN-MDM-01 book configuration. Optional: books opened before these existed replay with the
    // defaults in BOOK_DEFAULTS (legal entity = entityId, INR/2, April fiscal year, framework
    // "unspecified", purpose from the entity type).
    ...BookConfigFields,
  }),
  AccountAdded: z.object({ bookId: Id, account: Account }),
  JournalPosted: z.object({
    bookId: Id, journalId: Id, seq: z.number().int().positive(),
    txnDate: IsoDate, narration: z.string(), voucherType: z.string(),
    lines: z.array(Line).min(2),
    provisional: z.boolean().default(false),
    reverses: Id.optional(),
    source: z.object({ stream: z.string(), eventId: z.string().uuid().optional() }).optional(),
    autonomy: z.union([AutonomyLevel, z.literal("human")]).optional(),
    confidence: z.number().min(0).max(1).optional(),
    prevHash: z.string().length(64), hash: z.string().length(64),
    /** FIN-GL-05: the journal a suspense resolution replaces (the original; `reverses` is on the reversal). */
    replaces: Id.optional(),
    /** FIN-GL-01: a manual entry to a control account, allowed only as a controlled adjustment by an owner or controller. */
    controlledAdjustment: z.object({ reason: z.string().min(1) }).optional(),
  }),
  JournalReversed: z.object({ bookId: Id, journalId: Id, reversalJournalId: Id, reason: z.string() }),
  /**
   * A provisional journal was matched to an authoritative source line (bank statement). The
   * original JournalPosted is not rewritten; state and read models stop treating it as provisional.
   */
  JournalConfirmed: z.object({ bookId: Id, journalId: Id, source: z.string(), basis: z.string().optional() }),
  PostingRejected: z.object({ bookId: Id, requestId: Id, reason: z.string(), source: z.string().optional() }),
  PeriodLocked: z.object({ bookId: Id, periodEnd: IsoDate, level: z.enum(["soft", "hard"]) }),
  /** FIN-MDM-02: no new ordinary entries; reversals and corrections of earlier journals still post. */
  AccountClosed: z.object({ bookId: Id, accountId: Id, reason: z.string().min(1) }),
  /**
   * FIN-MDM-02: an account's statement mapping or mandatory dimensions changed. The previous values
   * are recorded, so the history of the chart is the event stream (nothing is overwritten).
   */
  AccountControlsChanged: z.object({ bookId: Id, accountId: Id, taxonomyTag: z.string().min(1).optional(), requiredDims: z.array(z.string().min(1)).optional(),
    previous: z.object({ taxonomyTag: z.string().nullable(), requiredDims: z.array(z.string()) }), reason: z.string().optional() }),
} as const;

// ------------------------------------------------------------------ Party master (FIN-MDM-03)
/** Beneficiary bank details. Sealed at rest in events and in the party projection. */
export const BankDetails = z.object({
  accountNumber: z.string().regex(/^[0-9]{6,20}$/, "account number: 6 to 20 digits"),
  ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "not an IFSC code"),
  holderName: z.string().min(1).max(200),
});
export type BankDetails = z.infer<typeof BankDetails>;
export const PartyTerms = z.object({ creditDays: z.number().int().min(0).max(3650), msme: z.boolean().optional() });
export const TaxStatus = z.object({
  gstin: z.string().regex(/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/, "not a GSTIN").optional(),
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "not a PAN").optional(),
  gstRegistered: z.boolean(), tdsSection: z.string().optional(),
});
export const PartyKind = z.enum(["vendor", "customer", "both"]);
export const PARTY = {
  /** A counterparty of one legal entity. Identity, terms and tax status are effective-dated from `effectiveFrom`. */
  PartyRegistered: z.object({ partyId: Id, entityId: Id, kind: PartyKind, name: z.string().min(1).max(200), effectiveFrom: IsoDate,
    terms: PartyTerms.optional(), taxStatus: TaxStatus.optional() }),
  /** New identity, terms or tax status from `effectiveFrom`; earlier versions stay in force for earlier dates. */
  PartyDetailsChanged: z.object({ partyId: Id, effectiveFrom: IsoDate, name: z.string().min(1).max(200).optional(),
    terms: PartyTerms.optional(), taxStatus: TaxStatus.optional() }),
  /** Maker: new beneficiary bank details requested. Payments to the party are held until released (POL-501). */
  BankChangeRequested: z.object({ partyId: Id, changeId: Id, effectiveFrom: IsoDate, bank: BankDetails,
    /** Keyed blind index of the account (no plaintext): finds shared identifiers across parties. */
    accountIdx: z.string(), source: z.string().max(500).optional() }),
  /** Checker: out-of-band verification recorded by a different person from the maker. */
  BankChangeVerified: z.object({ partyId: Id, changeId: Id, method: z.enum(["call_back", "penny_drop", "name_match", "document"]), reference: z.string().min(1).max(200) }),
  /** Fresh approval after verification: the new details are in force and the hold lifts. */
  BankChangeReleased: z.object({ partyId: Id, changeId: Id }),
  BankChangeRejected: z.object({ partyId: Id, changeId: Id, reason: z.string().min(1) }),
  /** Two parties share an identifier (the same bank account): a person reviews; parties are never merged. */
  PartyReviewRaised: z.object({ reviewId: Id, partyId: Id, otherPartyId: Id, reason: z.enum(["shared_bank_account"]) }),
} as const;

// ------------------------------------------------------------------ Channels events
export const RawTxn = z.object({
  txnDate: IsoDate, amount: MinorString, direction: z.enum(["in", "out"]),
  narration: z.string(), instrument: Id, reference: z.string().optional(),
  counterpartyHint: z.string().optional(), purposeHint: z.string().optional(),
  /** Running balance after this line, when the source provides one (signed paise; negative = overdrawn). */
  balance: MinorString.optional(),
  /** 1-based data row in the source file (row lineage for evidence). */
  sourceRow: z.number().int().positive().optional(),
});
export type RawTxn = z.infer<typeof RawTxn>;

export const CHANNELS = {
  SignalReceived: z.object({ signalId: Id, bookId: Id, channel: z.string(), trust: Trust, contentHash: z.string(), lines: z.number().int(),
    /** Disposition of every source row: rows = accepted + duplicates + skipped. */
    rows: z.number().int().optional(), accepted: z.number().int().optional(), duplicates: z.number().int().optional(),
    skipped: z.number().int().optional(),
    /** sha256 of the retained original bytes (channels.signals), and the parser that read them. */
    originalHash: z.string().optional(), parser: z.string().optional(),
    controls: z.object({
      status: z.enum(["reconciled", "unverifiable", "mismatch"]),
      debits: MinorString, credits: MinorString, opening: MinorString.optional(), closing: MinorString.optional(),
      problems: z.array(z.string()),
    }).optional(),
  }),
  TransactionExtracted: z.object({ txnId: Id, signalId: Id, bookId: Id, trust: Trust, channel: z.string(), txn: RawTxn }),
} as const;

// ------------------------------------------------------------------ Agent events
export const Decision = z.object({
  policyIds: z.array(z.string()), level: AutonomyLevel,
  action: z.enum(["inform", "draft", "await_approval", "post_then_ratify", "post"]),
  approver: z.string(), reasons: z.array(z.string()),
});
export type Decision = z.infer<typeof Decision>;

export const AGENT = {
  PartyResolved: z.object({ txnId: Id, partyId: Id, partyName: z.string(), isNew: z.boolean() }),
  ProvisionalConfirmed: z.object({ txnId: Id, journalId: Id, bookId: Id.optional(),
    /** Why the lines match: a shared reference, a shared counterparty, or a person linked them. */
    basis: z.enum(["reference", "counterparty", "user"]).optional() }),
  /** A statement line could be (or could not be told apart from) a provisional entry: a person decides. */
  MatchReviewQueued: z.object({ txnId: Id, reviewId: Id, bookId: Id, candidates: z.array(Id), reason: z.string() }),
  /** `journalId` null: the line is a different transaction and is processed as new. */
  MatchReviewResolved: z.object({ reviewId: Id, txnId: Id, journalId: Id.nullable() }),
  TransactionClassified: z.object({ txnId: Id, accountId: Id, confidence: z.number(), source: z.string() }),
  PolicyDecisionMade: z.object({ txnId: Id, decision: Decision }),
  PostingRequested: z.object({
    requestId: Id, bookId: Id, txnDate: IsoDate, narration: z.string(), voucherType: z.string(),
    lines: z.array(Line).min(2), provisional: z.boolean(), autonomy: z.union([AutonomyLevel, z.literal("human")]),
    confidence: z.number().optional(), sourceStream: z.string(),
  }),
  DraftQueued: z.object({ txnId: Id, draftId: Id, bookId: Id, status: z.enum(["queued", "awaiting_approval"]),
    proposal: z.object({ txnDate: IsoDate, narration: z.string(), voucherType: z.string(), lines: z.array(Line), provisional: z.boolean() }),
    accountId: Id, confidence: z.number(), partyName: z.string().optional(), amount: MinorString, direction: z.enum(["in", "out"]) }),
  DraftApproved: z.object({ draftId: Id, accountId: Id }),
  DraftRejected: z.object({ draftId: Id, reason: z.string() }),
  RatificationRequested: z.object({ requestId: Id, dueBy: IsoDate }),
  Ratified: z.object({ journalId: Id }),
  CorrectionRequested: z.object({ requestId: Id, bookId: Id, journalId: Id, fromAccount: Id, toAccount: Id }),
  RuleLearned: z.object({ pattern: z.string(), accountId: Id }),
  AutonomyLimited: z.object({ key: z.string(), maxLevel: AutonomyLevel, until: IsoDate, reason: z.string() }),
  /** FIN-GL-05: an amount posted to suspense is an item-level case until it is resolved. */
  SuspenseItemOpened: z.object({ itemId: Id, bookId: Id, journalId: Id, amount: MinorString, openedOn: IsoDate, source: z.string(), owner: z.string().nullable() }),
  SuspenseItemAssigned: z.object({ itemId: Id, owner: z.string() }),
  /** Resolution links the original, its reversal and the replacement (null when the item was only reversed). */
  SuspenseItemResolved: z.object({ itemId: Id, bookId: Id, journalId: Id, reversalJournalId: Id, replacementJournalId: Id.nullable(),
    toAccount: Id.nullable(), resolvedOn: IsoDate, note: z.string().optional() }),
} as const;

// ------------------------------------------------------------------ Ops events
export const OPS = {
  /** A principal committed exactly this plan hash; recorded before its actions run (section 13.7). */
  PlanApproved: z.object({
    planId: Id, bookId: Id, op: z.string(), hash: z.string().length(64), basisSeq: z.number().int().nonnegative(),
    basisVersion: z.number().int().nonnegative().optional(),
    gate: z.enum(["policy", "human"]), needsPerson: z.boolean(), actions: z.number().int().nonnegative(),
    preparedBy: Principal,
    policy: z.object({ ids: z.array(z.string()), level: AutonomyLevel, approver: z.string(), reasons: z.array(z.string()) }).nullable(),
  }),
  /** FIN-GL-02/03: a recurring or recognition schedule was defined (it posts nothing until approved by a plan). */
  ScheduleCreated: z.object({ scheduleId: Id, bookId: Id, kind: z.enum(["recurring", "recognition"]), hash: z.string().length(64), policyVersion: z.string() }),
  /** An occurrence could not post as scheduled (locked period, amount above the approval, ledger refusal): a person decides. */
  ScheduleExceptionRaised: z.object({ scheduleId: Id, bookId: Id, occurrenceId: Id, period: z.string(), kind: z.enum(["post", "reverse"]),
    dueOn: IsoDate, reason: z.string() }),
} as const;

// ------------------------------------------------------------------ Evidence events
export const EVIDENCE = {
  /**
   * One evidence record per committed action (section 14.7), assembled from the events it cites.
   * `recordHash` is SHA-256 over the canonical record; the event itself is sealed and chained.
   */
  EvidenceRecorded: z.object({
    evidenceId: Id, bookId: Id,
    subject: z.object({ kind: z.enum(["journal", "period_lock"]), id: z.string() }),
    recordHash: z.string().length(64),
    record: z.record(z.string(), z.unknown()),
  }),
} as const;

// ------------------------------------------------------------------ Identity events (audit trail)
/**
 * Membership, invitations, passkeys, sessions and separation settings, appended to the tenant's
 * identity stream (`<tenant>/identity`) in the same transaction as the change they record. The
 * actor is the event's meta.principal. Payloads are sealed like every event.
 */
const Books = z.array(z.string()).nullable();
export const IDENTITY = {
  MemberAdded: z.object({ principal: Principal, role: z.string(), books: Books, source: z.string(), displayName: z.string(),
    reactivated: z.boolean().default(false) }),
  MemberRemoved: z.object({ principal: Principal }),
  /**
   * Role or book scope of an active member changed. A role change re-keys the principal (its prefix
   * is its role): `principal` is then the successor and `previousPrincipal` the one it replaced.
   */
  MemberRoleChanged: z.object({ principal: Principal, role: z.string(), books: Books, previousRole: z.string(), previousBooks: Books,
    previousPrincipal: Principal.optional() }),
  /** `invitation` is the SHA-256 of the one-time code (the code itself is never recorded). */
  InvitationIssued: z.object({ invitation: z.string(), principal: Principal, role: z.string(), books: Books, expiresAt: z.string() }),
  InvitationRedeemed: z.object({ invitation: z.string(), principal: Principal, credentialId: z.string() }),
  CredentialRegistered: z.object({ principal: Principal, credentialId: z.string() }),
  CredentialRevoked: z.object({ principal: Principal, credentialId: z.string() }),
  SettingsChanged: z.object({ soloOwner: z.boolean(), sodLimitPaise: z.string().nullable(),
    previous: z.object({ soloOwner: z.boolean(), sodLimitPaise: z.string().nullable() }).nullable() }),
  /** `session` is the SHA-256 of the session id. */
  SessionRevoked: z.object({ session: z.string(), principal: Principal.nullable() }),
} as const;

export const ALL_EVENTS = { ...GL, ...PARTY, ...CHANNELS, ...AGENT, ...OPS, ...EVIDENCE, ...IDENTITY } as const;
export type EventType = keyof typeof ALL_EVENTS;
export type EventData<T extends EventType> = z.infer<(typeof ALL_EVENTS)[T]>;

/** Which module owns (may append) each event type. Enforced by the event store. */
export type Module = "gl" | "channels" | "agent" | "ops" | "evidence" | "identity";
export const OWNER: Record<EventType, Module> = Object.fromEntries([
  ...Object.keys(GL).map((k) => [k, "gl"]),
  ...Object.keys(PARTY).map((k) => [k, "gl"]),                  // the GL owns master data (chart and parties)
  ...Object.keys(CHANNELS).map((k) => [k, "channels"]),
  ...Object.keys(AGENT).map((k) => [k, "agent"]),
  ...Object.keys(OPS).map((k) => [k, "ops"]),
  ...Object.keys(EVIDENCE).map((k) => [k, "evidence"]),
  ...Object.keys(IDENTITY).map((k) => [k, "identity"]),
]) as Record<EventType, Module>;

export const SCHEMA_VERSION = 1;

/** NATS subject for an event: kuber.<cell>.<module>.<type>.<tenant> */
export const subjectFor = (cellId: string, type: EventType, tenantId: string) =>
  `kuber.${cellId}.${OWNER[type]}.${type}.${tenantId}`;

/** A stored event as consumers see it. */
export interface Envelope<T extends EventType = EventType> {
  eventId: string;
  globalPosition: string;        // bigint as string
  streamId: string;
  streamVersion: number;
  type: T;
  schemaVersion: number;
  data: EventData<T>;
  meta: Meta;
  recordedAt: string;
}

export function validateEvent<T extends EventType>(type: T, data: unknown): EventData<T> {
  const schema = ALL_EVENTS[type];
  if (!schema) throw new Error(`unknown event type ${type}`);
  return schema.parse(data) as EventData<T>;
}
