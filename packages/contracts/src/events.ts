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
/**
 * Principal prefixes (role model v2, design 6.3): the roles, the legacy aliases kept in sealed
 * history (owner, approver, preparer, member), agents and system actors.
 */
export const PRINCIPAL_PREFIXES = ["superuser", "admin", "system_owner", "controller", "treasurer", "staff", "auditor", "customer", "supplier",
  "investor", "guest", "owner", "approver", "preparer", "member", "agent", "system"] as const;
export const Principal = z.string().regex(new RegExp(`^(${PRINCIPAL_PREFIXES.join("|")}):[\\w.@\\-]+$`));
/** Legacy principal prefixes and the role their memberships became (role model v2). */
export const ROLE_ALIASES: Readonly<Record<string, string>> = { owner: "superuser", approver: "superuser", preparer: "staff", member: "staff" };
/** The deterministic policy engine, recorded as checker of agent-made items that policy clears (L3/L4). Never a language model. */
export const POLICY_CHECKER = "agent:policy";
/** The role a principal stands for: its prefix, or the role a legacy prefix maps to (`owner:laksh` → superuser). */
export const principalRole = (principal: string): string => {
  if (principal === POLICY_CHECKER) return "agent_checker";
  const p = principal.slice(0, Math.max(principal.indexOf(":"), 0));
  return ROLE_ALIASES[p] ?? p;
};
/** Superusers and controllers: controlled adjustments, soft-locked periods and account controls (FIN-GL-01, FIN-MDM-02). */
export const isPrivilegedPrincipal = (principal: string) => { const r = principalRole(principal); return r === "superuser" || r === "controller"; };
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
  /** Unused: meta is not sealed. Signed commands carry their assertion in the (sealed) event data: see CommandSignature. */
  signature: z.string().optional(),
});
export type Meta = z.infer<typeof Meta>;

// ------------------------------------------------------------------ Signed commands (design 14.4, 16.4)
/**
 * High-risk commands a person signs on their device: the WebAuthn challenge is the SHA-256 of the
 * canonical `CommandDigestInputs` (tenant, book, action, subject, subject hash, principal, a
 * single-use server nonce and its expiry, and the hash of the summary the person was shown).
 */
export const SIGNED_ACTIONS = ["plan.commit", "plan.approve", "draft.approve", "journal.ratify", "period.lock"] as const;
export type SignedAction = (typeof SIGNED_ACTIONS)[number];
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const B64u = z.string().regex(/^[A-Za-z0-9_-]*$/).max(20_000);
export const CommandDigestInputs = z.object({
  v: z.literal(1), tenant: z.string().min(1), book: z.string().min(1), action: z.enum(SIGNED_ACTIONS),
  subject: z.string().min(1), subjectHash: Hex64, principal: Principal, nonce: z.string().min(16).max(64), expiresAt: z.string(),
  summaryHash: Hex64,
});
export type CommandDigestInputs = z.infer<typeof CommandDigestInputs>;
/** What the person was shown before signing, rendered from the command itself. Amounts are paise. */
export const CommandSummary = z.object({
  action: z.enum(SIGNED_ACTIONS), title: z.string(), book: z.string(),
  amountPaise: z.string().regex(/^\d+$/).nullable(),
  payees: z.array(z.object({ partyId: z.string(), name: z.string().nullable() })),
  accounts: z.array(z.object({ accountId: z.string(), name: z.string(), debitPaise: z.string(), creditPaise: z.string() })),
  periods: z.array(z.object({ periodEnd: z.string(), level: z.string() })),
  lines: z.array(z.string()),
});
export type CommandSummary = z.infer<typeof CommandSummary>;
export const CommandSignature = z.discriminatedUnion("kind", [
  /** A user-verified passkey assertion over the command digest, verifiable offline against the stored public key. */
  z.object({
    kind: z.literal("webauthn"), digest: Hex64, inputs: CommandDigestInputs, summary: CommandSummary,
    credentialId: B64u, authenticatorData: B64u, clientDataJSON: B64u, signature: B64u, userHandle: B64u.optional(),
    rpId: z.string(), origin: z.string(), verifiedAt: z.string(),
  }),
  /** DEVELOPMENT SIGN-IN ONLY: a member without a passkey confirmed with the `su` freshness claim. Not a signature. */
  z.object({ kind: z.literal("dev-step-up"), note: z.string(), stepUpAt: z.number(), principal: Principal }),
]);
export type CommandSignature = z.infer<typeof CommandSignature>;

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
    bookId: Id, entityId: Id, entityType: z.string(),
    /** "consolidation": a group's consolidation book (FIN-GRP-03), holding only eliminations; never statutory. */
    basis: z.enum(["statutory", "management", "tax", "budget", "scenario", "consolidation"]),
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
  /** `signature`: a lock asked for directly (POST …/locks) is a signed command (design 16.4); a close plan's signature is on its PlanApproved. */
  PeriodLocked: z.object({ bookId: Id, periodEnd: IsoDate, level: z.enum(["soft", "hard"]), signature: CommandSignature.optional() }),
  /**
   * FIN-CLS-03: a certified close of the period (modules/close). Nothing dated on or before
   * `periodEnd` posts afterwards, by anyone, until a controlled reopen (PeriodReopened).
   * `populationHash`: the journal population the close certified (journals dated up to periodEnd).
   */
  PeriodClosed: z.object({ bookId: Id, periodEnd: IsoDate, closeId: Id, populationHash: z.string().length(64) }),
  /** FIN-CLS-04: a certified (soft) close withdrawn by an approved reopen plan. Hard locks are never reopened. */
  PeriodReopened: z.object({ bookId: Id, periodEnd: IsoDate, closeId: Id, reason: z.string().min(3) }),
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
  /** `on`: the agent's decision date (selects the policies in force); absent on events recorded before it was added. */
  PolicyDecisionMade: z.object({ txnId: Id, decision: Decision, on: IsoDate.optional() }),
  PostingRequested: z.object({
    requestId: Id, bookId: Id, txnDate: IsoDate, narration: z.string(), voucherType: z.string(),
    lines: z.array(Line).min(2), provisional: z.boolean(), autonomy: z.union([AutonomyLevel, z.literal("human")]),
    confidence: z.number().optional(), sourceStream: z.string(),
    /** Role model v2: the checker of a posting policy cleared for L3/L4, the policy engine (agent:policy), distinct from the maker. */
    checker: Principal.optional(),
  }),
  DraftQueued: z.object({ txnId: Id, draftId: Id, bookId: Id, status: z.enum(["queued", "awaiting_approval"]),
    proposal: z.object({ txnDate: IsoDate, narration: z.string(), voucherType: z.string(), lines: z.array(Line), provisional: z.boolean() }),
    accountId: Id, confidence: z.number(), partyName: z.string().optional(), amount: MinorString, direction: z.enum(["in", "out"]) }),
  /** `signature`: approving a draft above the approval limit over HTTP is a signed command. */
  DraftApproved: z.object({ draftId: Id, accountId: Id, signature: CommandSignature.optional() }),
  DraftRejected: z.object({ draftId: Id, reason: z.string() }),
  RatificationRequested: z.object({ requestId: Id, dueBy: IsoDate }),
  /** `signature`: ratifying an automatic posting above the approval limit is a signed command. */
  Ratified: z.object({ journalId: Id, signature: CommandSignature.optional() }),
  CorrectionRequested: z.object({ requestId: Id, bookId: Id, journalId: Id, fromAccount: Id, toAccount: Id }),
  RuleLearned: z.object({ pattern: z.string(), accountId: Id }),
  AutonomyLimited: z.object({ key: z.string(), maxLevel: AutonomyLevel, until: IsoDate, reason: z.string() }),
  /** FIN-GL-05: an amount posted to suspense is an item-level case until it is resolved. */
  SuspenseItemOpened: z.object({ itemId: Id, bookId: Id, journalId: Id, amount: MinorString, openedOn: IsoDate, source: z.string(), owner: z.string().nullable() }),
  SuspenseItemAssigned: z.object({ itemId: Id, owner: z.string() }),
  /** Resolution links the original, its reversal and the replacement (null when the item was only reversed). */
  SuspenseItemResolved: z.object({ itemId: Id, bookId: Id, journalId: Id, reversalJournalId: Id, replacementJournalId: Id.nullable(),
    toAccount: Id.nullable(), resolvedOn: IsoDate, note: z.string().optional() }),
  /**
   * TAGOF TOL-05, AGT-07, Domain 14: one copilot turn, appended to `<tenant>/agent-turns/<book>`.
   * Inputs and outputs are recorded as SHA-256 hashes, never as text, so personal data in a question
   * or a tool result is not duplicated here; the event is sealed and chained like every other.
   */
  AgentTurnRecorded: z.object({
    turnId: Id, bookId: Id, sessionHash: Hex64.nullable(), principal: Principal, onBehalfOf: Principal,
    engine: z.string().max(200),
    prompt: z.object({ id: z.string(), version: z.string(), hash: Hex64 }),
    /** Compiled DSPy programs and routing policies the turn ran with (id, version, hash). */
    artifacts: z.array(z.object({ id: z.string(), version: z.string(), hash: Hex64 })).default([]),
    input: z.object({ ok: z.boolean(), category: z.enum(["in_scope", "out_of_scope", "injection", "empty", "too_long"]).optional(), reason: z.string().max(500).optional() }),
    inputHash: Hex64,
    tools: z.array(z.object({ tool: z.string().max(100), inputHash: Hex64, outputHash: Hex64, ok: z.boolean(),
      reversibility: z.enum(["none", "simulation", "reversible", "irreversible"]), flags: z.array(z.string().max(200)), ms: z.number().nonnegative(),
      planId: Id.optional() })),
    planIds: z.array(Id),
    /** GEN-01: ungrounded figures as hashes (the figures are output fragments). */
    grounding: z.object({ ok: z.boolean(), ungrounded: z.number().int().nonnegative(), ungroundedHashes: z.array(Hex64) }),
    outcome: z.enum(["answered", "refused", "error", "halted"]),
    steps: z.number().int().nonnegative(), tokensIn: z.number().int().nonnegative().optional(), tokensOut: z.number().int().nonnegative().optional(),
    ms: z.number().nonnegative(),
    /** Derived at record time: tool denials, injection flags, TOL-07 anomalies, HITL bypass (must be false). */
    toolDenials: z.number().int().nonnegative(), injectionFlags: z.number().int().nonnegative(),
    anomalies: z.array(z.string().max(200)), hitlBypass: z.boolean(),
  }),
  /**
   * Dream-RSI (design 7.2): an owner-approved autonomy tuning now governs this book and action type.
   * Appended in the same transaction as the tuning row the agent's decisions read, after the
   * approval (DreamProposalApproved). `tuning` holds thresholds only; no personal data.
   */
  AutonomyTuningApplied: z.object({ bookId: Id, actionType: z.enum(["receipt", "payment"]), proposalId: Id,
    tuning: z.object({ l3MinConfidence: z.number(), l4MinConfidence: z.number().nullable(), relaxAfterAcceptances: z.number().int(),
      accuracyFloor: z.number(), amountCeilingPaise: z.number().int(), newCounterpartyKnownAfter: z.number().int(), amountZLimit: z.number().nullable() }),
    previous: z.record(z.string(), z.unknown()).nullable() }),
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
    /** FIN-MDM-04: the person whose recorded approval this execution carries out (their authority re-checked now). */
    approvedBy: Principal.optional(),
    /** Design 14.4/16.4: the committer's signature over this command (step-up-class plans), verified and stored in the same transaction. */
    signature: CommandSignature.optional(),
    /**
     * Role model v2: whose check let this commit happen. A person (the committer or the recorded
     * approver), or `agent:policy` when an agent committed because policy cleared it (L3/L4). Never
     * the maker, never a language model.
     */
    checker: Principal.optional(),
  }),
  /** FIN-MDM-04: a person approved exactly this plan hash; someone may execute it later (authority re-checked then). */
  PlanApprovalRecorded: z.object({ planId: Id, bookId: Id, hash: z.string().length(64), preparedBy: Principal, amountPaise: z.string().regex(/^\d+$/),
    /** The approver's signature over this command (step-up-class plans). */
    signature: CommandSignature.optional() }),
  /** FIN-MDM-04: an approval no longer stands (the approver's authority or delegation changed); the plan needs re-approval. */
  PlanApprovalInvalidated: z.object({ planId: Id, bookId: Id, approver: Principal, reason: z.string() }),
  /** FIN-MDM-04: a saved plan can no longer be executed as prepared (its preparer's authority changed). */
  PlanMarkedStale: z.object({ planId: Id, bookId: Id, reason: z.string() }),
  /** FIN-OPS-02: financial incident register. Amounts are paise. */
  IncidentOpened: z.object({ incidentId: Id, title: z.string(), description: z.string(), books: z.array(Id), periods: z.array(z.string()),
    possibleLossPaise: z.string().regex(/^\d+$/), duplication: z.boolean(), owner: Principal }),
  IncidentUpdated: z.object({ incidentId: Id, containment: z.string().optional(), corrections: z.array(Id).optional(), owner: Principal.optional(),
    note: z.string().optional(), status: z.enum(["open", "contained"]) }),
  IncidentClosed: z.object({ incidentId: Id, reconciliationRef: z.string().min(1), owner: Principal, approvedBy: Principal, note: z.string().optional() }),
  /** FIN-GL-02/03: a recurring or recognition schedule was defined (it posts nothing until approved by a plan). */
  ScheduleCreated: z.object({ scheduleId: Id, bookId: Id, kind: z.enum(["recurring", "recognition"]), hash: z.string().length(64), policyVersion: z.string() }),
  /** An occurrence could not post as scheduled (locked period, amount above the approval, ledger refusal): a person decides. */
  ScheduleExceptionRaised: z.object({ scheduleId: Id, bookId: Id, occurrenceId: Id, period: z.string(), kind: z.enum(["post", "reverse"]),
    dueOn: IsoDate, reason: z.string() }),
} as const;

// ------------------------------------------------------------------ Consolidation events (FIN-GRP-01..04)
/**
 * Group of companies (design 6.4 group tenancy, 6.5 "Groups of companies"). Stream `<tenant>/group/<groupId>`
 * holds the group register: structure, chart mapping, effective-dated ownership and intercompany party
 * links. Every change except GroupDefined arrives through an approved ops plan on the group's
 * consolidation book (`planId`). Amounts are paise; percentages are basis points (10000 = 100%).
 */
const Bp = z.number().int().min(0).max(10000);
const PaiseStr = MinorString;
export const GroupEntity = z.object({
  entityId: Id, name: z.string().min(1).max(200),
  /** The entity's book in this tenant, or null for a linked tenant or an entity kept outside Kuber. */
  bookId: Id.nullable(),
  /** Linked tenant publishing this entity's certified packs (design 6.4, structure 2), or null. */
  linkedTenant: Id.nullable(),
  /** Declared functional currency. A book's own configuration wins; non-INR entities are excluded, never translated. */
  functionalCurrency: z.string().regex(/^[A-Z]{3}$/),
});
export const Acquisition = z.object({
  date: IsoDate, costPaise: PaiseStr,
  /** The investor's account holding the investment (its entity chart). */
  investmentAccount: Id,
  /** The investee's equity at acquisition, per account of the investee's chart (paise, credit positive). */
  equity: z.array(z.object({ accountId: Id, amountPaise: PaiseStr })).min(1),
});
export const CONSOLIDATION = {
  GroupDefined: z.object({ groupId: Id, name: z.string().min(1).max(200), bookId: Id, parentEntityId: Id }),
  /** The group's entities (the whole list, replacing the previous one). */
  GroupEntitiesSet: z.object({ groupId: Id, entities: z.array(GroupEntity), planId: Id }),
  /** Group chart mapping: an entity account to a group account, overriding the default (the account's statement mapping). */
  GroupMappingSet: z.object({ groupId: Id, entityId: Id, accountId: Id, groupAccount: Id, groupAccountName: z.string().min(1).max(200), planId: Id }),
  /** Effective-dated ownership (FIN-GRP-03). A later record for the same parent and child from a later date supersedes it from then. */
  OwnershipRecorded: z.object({ groupId: Id, recordId: Id, parentEntityId: Id, childEntityId: Id, effectiveFrom: IsoDate,
    ownershipBp: Bp, votingBp: Bp, control: z.enum(["control", "joint_control", "significant_influence", "none"]),
    method: z.enum(["full", "equity", "excluded"]), exclusionReason: z.string().min(3).max(500).optional(),
    acquisition: Acquisition.optional(),
    /** Unrealised-profit margin on this pair's intra-group sales, basis points of the transfer price. */
    marginBp: Bp.optional(), planId: Id }),
  /** A party of `entityId`'s party master IS entity `counterpartyEntityId` (FIN-GRP-01). */
  IcPartyLinked: z.object({ groupId: Id, entityId: Id, partyId: Id, counterpartyEntityId: Id, planId: Id }),
  /** An intercompany difference put in dispute; stream `<tenant>/ic-dispute/<disputeId>`. */
  IcDisputeOpened: z.object({ disputeId: Id, groupId: Id, itemKey: z.string().min(1).max(500), senderEntityId: Id, receiverEntityId: Id,
    sentPaise: PaiseStr, receivedPaise: PaiseStr, classification: z.string(), reason: z.string().min(3).max(2000) }),
  /** One side's approver records its position; resolution needs both sides to agree (bilateral). */
  IcDisputePositionRecorded: z.object({ disputeId: Id, entityId: Id, agreedPaise: PaiseStr, note: z.string().min(3).max(2000) }),
  IcDisputeResolved: z.object({ disputeId: Id, agreedPaise: PaiseStr, positions: z.array(z.object({ entityId: Id, principal: Principal })) }),
  /** A consolidation run was committed (its journals are in the consolidation book); `supersedes`: runs it reversed. */
  ConsolidationRunRecorded: z.object({ groupId: Id, runId: Id, periodEnd: IsoDate, version: z.number().int().positive(), inputHash: z.string().length(64),
    journals: z.array(z.object({ journalId: Id, key: z.string(), contentHash: z.string().length(64) })), supersedes: z.array(Id), planId: Id }),
  /** A certified group close (FIN-GRP-04); a correction is a new version linked to the previous one. */
  GroupCloseCertified: z.object({ groupId: Id, snapshotId: Id, periodEnd: IsoDate, version: z.number().int().positive(), contentHash: z.string().length(64),
    previousSnapshotId: Id.nullable(), runId: Id, planId: Id }),
  /** Linked tenants (design 6.4): consent recorded in both tenants, stream `<tenant>/group-link/<linkId>`. */
  GroupLinkRequested: z.object({ linkId: Id, role: z.enum(["group", "subsidiary"]), groupTenant: Id, subsidiaryTenant: Id, groupId: Id, entityId: Id }),
  GroupLinkAccepted: z.object({ linkId: Id, role: z.enum(["group", "subsidiary"]) }),
  GroupLinkRevoked: z.object({ linkId: Id, role: z.enum(["group", "subsidiary"]), reason: z.string().min(3).max(500) }),
  /** A certified pack published over a link: recorded in the subsidiary's stream and, as received, in the group's. */
  LinkedPackPublished: z.object({ linkId: Id, packId: Id, entityId: Id, periodEnd: IsoDate, packHash: z.string().length(64),
    prevPackHash: z.string().length(64), role: z.enum(["group", "subsidiary"]) }),
} as const;

// ------------------------------------------------------------------ Period close (FIN-CLS-01..04, modules/close)
/**
 * Stream `<tenant>/close/<book>/<periodEnd>`: the checklist, account substantiation, the certified
 * close and its withdrawal on reopen, and restatements. Amounts are paise. Evidence is a reference
 * {kind, id, hash}; its content lives with the module that produced it.
 */
export const CloseEvidenceRef = z.object({ kind: z.enum(["bank_reconciliation", "schedule_reconciliation", "suspense_roll_forward", "document"]), id: z.string().min(1).max(300),
  hash: z.string().regex(/^[0-9a-f]{64}$/) });
export const CLOSE = {
  CloseChecklistCreated: z.object({ bookId: Id, periodEnd: IsoDate, periodStart: IsoDate, templateVersion: z.string(),
    tasks: z.array(z.object({ taskId: Id, area: z.string(), owner: Principal.nullable(), deadline: IsoDate, dependsOn: z.array(Id), applicable: z.boolean(), reason: z.string().nullable() })) }),
  CloseTaskAssigned: z.object({ bookId: Id, periodEnd: IsoDate, taskId: Id, owner: Principal, deadline: IsoDate }),
  /** Completed by the owner (the plan's preparer) with its evidence, reviewed by a different person (the committer). */
  CloseTaskCompleted: z.object({ bookId: Id, periodEnd: IsoDate, taskId: Id, completedBy: Principal, reviewedBy: Principal, evidence: z.array(CloseEvidenceRef), planId: Id }),
  AccountSubstantiated: z.object({ bookId: Id, periodEnd: IsoDate, accountId: Id, glBalance: MinorString, source: z.string(), sourceBalance: MinorString.nullable(),
    items: z.number().int().nonnegative(), preparedBy: Principal, approvedBy: Principal, hash: z.string().length(64), planId: Id }),
  PeriodCloseCertified: z.object({ bookId: Id, periodEnd: IsoDate, closeId: Id, version: z.number().int().positive(), basisSeq: z.number().int().nonnegative(),
    contentHash: z.string().length(64), populationHash: z.string().length(64), reportSnapshots: z.array(z.object({ kind: z.string(), snapshotId: Id, contentHash: z.string().length(64) })),
    planId: Id }),
  /** FIN-CLS-04: a certification withdrawn visibly (close snapshot, substantiation, bank reconciliation dated in the period). */
  CloseCertificationWithdrawn: z.object({ bookId: Id, periodEnd: IsoDate, kind: z.enum(["close", "substantiation", "bank_reconciliation", "task"]), ref: z.string(), reason: z.string(), planId: Id }),
  RestatementRecorded: z.object({ bookId: Id, restatementId: Id, comparativePeriodEnd: IsoDate, supersedesCloseId: Id, journalId: Id, framework: z.string(),
    bridgeHash: z.string().length(64), changed: z.number().int().nonnegative(), planId: Id }),
  CloseDocumentRegistered: z.object({ bookId: Id, documentId: Id, sha256: z.string().length(64), periodEnd: IsoDate.nullable() }),
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
  /** `partyId`: the party a Customer or Supplier membership is bound to (role model v2). */
  MemberAdded: z.object({ principal: Principal, role: z.string(), books: Books, source: z.string(), displayName: z.string(),
    reactivated: z.boolean().default(false), partyId: Id.optional() }),
  MemberRemoved: z.object({ principal: Principal }),
  /**
   * Role or book scope of an active member changed. A role change re-keys the principal (its prefix
   * is its role): `principal` is then the successor and `previousPrincipal` the one it replaced.
   */
  MemberRoleChanged: z.object({ principal: Principal, role: z.string(), books: Books, previousRole: z.string(), previousBooks: Books,
    previousPrincipal: Principal.optional(),
    /** Why, when a migration changed it (role model v2: "role model v2"). */
    reason: z.string().optional() }),
  /** `invitation` is the SHA-256 of the one-time code (the code itself is never recorded). */
  InvitationIssued: z.object({ invitation: z.string(), principal: Principal, role: z.string(), books: Books, expiresAt: z.string(), partyId: Id.optional() }),
  InvitationRedeemed: z.object({ invitation: z.string(), principal: Principal, credentialId: z.string() }),
  CredentialRegistered: z.object({ principal: Principal, credentialId: z.string() }),
  CredentialRevoked: z.object({ principal: Principal, credentialId: z.string() }),
  SettingsChanged: z.object({ soloOwner: z.boolean(), sodLimitPaise: z.string().nullable(), requireTwoAuthenticators: z.boolean().optional(),
    previous: z.object({ soloOwner: z.boolean(), sodLimitPaise: z.string().nullable(), requireTwoAuthenticators: z.boolean().optional() }).nullable() }),
  /**
   * Account recovery (design 16.4): an operator issued a one-time code for an EXISTING member who
   * lost access. `invitation` is the SHA-256 of the code; `reason` why; `revokeExisting` whether
   * redeeming it revokes the member's other passkeys.
   */
  RecoveryIssued: z.object({ invitation: z.string(), principal: Principal, reason: z.string(), revokeExisting: z.boolean(), expiresAt: z.string() }),
  /** The recovery code was redeemed: a new passkey for the same principal, and the passkeys it revoked. */
  RecoveryCompleted: z.object({ invitation: z.string(), principal: Principal, credentialId: z.string(), revokedCredentials: z.array(z.string()) }),
  /** `session` is the SHA-256 of the session id. */
  SessionRevoked: z.object({ session: z.string(), principal: Principal.nullable() }),
  /** FIN-MDM-04: the tenant's authority matrix (amount bands per action, book and role) was switched on or off. */
  AuthorityMatrixChanged: z.object({ enabled: z.boolean(), previous: z.boolean().nullable() }),
  /** FIN-MDM-04: one band: `maxPaise` null means no limit; `removed` falls back to the default (POL-002). */
  AuthorityBandSet: z.object({ action: z.string(), bookId: z.string().nullable(), role: z.string(), maxPaise: z.string().nullable(),
    previousMaxPaise: z.string().nullable(), removed: z.boolean() }),
  DelegationGranted: z.object({ delegationId: Id, grantor: Principal, grantee: Principal, action: z.string(), books: Books,
    maxPaise: z.string().regex(/^\d+$/), validFrom: z.string(), validTo: z.string() }),
  DelegationRevoked: z.object({ delegationId: Id, grantor: Principal, grantee: Principal, reason: z.string() }),
  /** FIN-MDM-04 conflict rule: this member may not approve plans that pay this party. */
  RelatedPartyFlagged: z.object({ principal: Principal, partyId: Id, note: z.string() }),
  RelatedPartyCleared: z.object({ principal: Principal, partyId: Id, note: z.string() }),
  /** FIN-MDM-05: a reviewer's disposition of one access-review item. */
  AccessReviewDisposed: z.object({ itemId: z.string(), kind: z.string(), subject: Principal.nullable(),
    decision: z.enum(["appropriate", "revoke", "investigate", "accepted"]), note: z.string() }),
  /** FIN-OPS-03 kill switch: autonomous posting for the tenant (bookId null) or one book goes to human review. */
  /** AGT-09: `scope` "copilot" halts only the model-driven copilot; absent means "autonomy" (FIN-OPS-03). */
  AutonomyHalted: z.object({ bookId: z.string().nullable(), reason: z.string(), scope: z.enum(["autonomy", "copilot"]).optional() }),
  AutonomyResumed: z.object({ bookId: z.string().nullable(), reason: z.string(), scope: z.enum(["autonomy", "copilot"]).optional() }),
  /** Role model v2: a guest may read this item (a certified snapshot, or a report of a book) until `expiresAt`. */
  ShareGranted: z.object({ shareId: Id, grantee: Principal, itemType: z.enum(["snapshot", "report"]), itemId: z.string(), expiresAt: z.string() }),
  ShareRevoked: z.object({ shareId: Id, grantee: Principal }),
  /** Role model v2: a customer raised a query (a case) about its own records; stream `<tenant>/portal/<partyId>`. */
  PortalQueryOpened: z.object({ queryId: Id, partyId: Id, subject: z.string(), message: z.string(), reference: z.string().optional() }),
  /** Role model v2: a certified snapshot was published to investors, or withdrawn. */
  SnapshotPublished: z.object({ snapshotId: Id, bookId: Id, published: z.boolean() }),
  /** Design 7.3 data use: the owner allowed (or withdrew) the tenant's history for offline policy optimisation (Dream-RSI). */
  OptimisationOptInChanged: z.object({ optIn: z.boolean(), previous: z.boolean().nullable() }),
} as const;

// ------------------------------------------------------------------ Dream-RSI events (design 7.2)
/**
 * Offline policy optimisation. Promotion is not deployment: a winning autonomy policy is recorded
 * as a proposal, and only an approval by a person with autonomy.manage applies it (the agent then
 * appends AutonomyTuningApplied). Payloads carry hashes and thresholds, never personal data.
 */
export const DREAM = {
  DreamProposalRecorded: z.object({ proposalId: Id, family: z.enum(["autonomy"]), bookId: Id, segments: z.array(z.string()).min(1),
    seed: z.number().int(), poolHash: z.string().length(64), reportHash: z.string().length(64), evidence: z.string() }),
  DreamProposalApproved: z.object({ proposalId: Id, family: z.enum(["autonomy"]), bookId: Id, segments: z.array(z.string()).min(1),
    reportHash: z.string().length(64) }),
  DreamProposalRejected: z.object({ proposalId: Id, reason: z.string().min(1) }),
} as const;

export const ALL_EVENTS = { ...GL, ...PARTY, ...CHANNELS, ...AGENT, ...OPS, ...EVIDENCE, ...IDENTITY, ...DREAM, ...CONSOLIDATION, ...CLOSE } as const;
export type EventType = keyof typeof ALL_EVENTS;
export type EventData<T extends EventType> = z.infer<(typeof ALL_EVENTS)[T]>;

/** Which module owns (may append) each event type. Enforced by the event store. */
export type Module = "gl" | "channels" | "agent" | "ops" | "evidence" | "identity" | "dream" | "consolidation" | "close";
export const OWNER: Record<EventType, Module> = Object.fromEntries([
  ...Object.keys(GL).map((k) => [k, "gl"]),
  ...Object.keys(PARTY).map((k) => [k, "gl"]),                  // the GL owns master data (chart and parties)
  ...Object.keys(CHANNELS).map((k) => [k, "channels"]),
  ...Object.keys(AGENT).map((k) => [k, "agent"]),
  ...Object.keys(OPS).map((k) => [k, "ops"]),
  ...Object.keys(EVIDENCE).map((k) => [k, "evidence"]),
  ...Object.keys(IDENTITY).map((k) => [k, "identity"]),
  ...Object.keys(DREAM).map((k) => [k, "dream"]),
  ...Object.keys(CONSOLIDATION).map((k) => [k, "consolidation"]),
  ...Object.keys(CLOSE).map((k) => [k, "close"]),
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
