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
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
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

// ------------------------------------------------------------------ GL events
export const GL = {
  BookOpened: z.object({
    bookId: Id, entityId: Id, entityType: z.string(), basis: z.enum(["statutory", "management", "tax", "budget", "scenario"]),
    currency: z.literal("INR"), accounts: z.array(Account),
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
  }),
  JournalReversed: z.object({ bookId: Id, journalId: Id, reversalJournalId: Id, reason: z.string() }),
  PostingRejected: z.object({ bookId: Id, requestId: Id, reason: z.string(), source: z.string().optional() }),
  PeriodLocked: z.object({ bookId: Id, periodEnd: IsoDate, level: z.enum(["soft", "hard"]) }),
} as const;

// ------------------------------------------------------------------ Channels events
export const RawTxn = z.object({
  txnDate: IsoDate, amount: MinorString, direction: z.enum(["in", "out"]),
  narration: z.string(), instrument: Id, reference: z.string().optional(),
  counterpartyHint: z.string().optional(), purposeHint: z.string().optional(),
});
export type RawTxn = z.infer<typeof RawTxn>;

export const CHANNELS = {
  SignalReceived: z.object({ signalId: Id, bookId: Id, channel: z.string(), trust: Trust, contentHash: z.string(), lines: z.number().int() }),
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
  ProvisionalConfirmed: z.object({ txnId: Id, journalId: Id }),
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
} as const;

// ------------------------------------------------------------------ Ops events
export const OPS = {
  /** A principal committed exactly this plan hash; recorded before its actions run (section 13.7). */
  PlanApproved: z.object({
    planId: Id, bookId: Id, op: z.string(), hash: z.string().length(64), basisSeq: z.number().int().nonnegative(),
    gate: z.enum(["policy", "human"]), needsPerson: z.boolean(), actions: z.number().int().nonnegative(),
    preparedBy: Principal,
    policy: z.object({ ids: z.array(z.string()), level: AutonomyLevel, approver: z.string(), reasons: z.array(z.string()) }).nullable(),
  }),
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

export const ALL_EVENTS = { ...GL, ...CHANNELS, ...AGENT, ...OPS, ...EVIDENCE } as const;
export type EventType = keyof typeof ALL_EVENTS;
export type EventData<T extends EventType> = z.infer<(typeof ALL_EVENTS)[T]>;

/** Which module owns (may append) each event type. Enforced by the event store. */
export type Module = "gl" | "channels" | "agent" | "ops" | "evidence";
export const OWNER: Record<EventType, Module> = Object.fromEntries([
  ...Object.keys(GL).map((k) => [k, "gl"]),
  ...Object.keys(CHANNELS).map((k) => [k, "channels"]),
  ...Object.keys(AGENT).map((k) => [k, "agent"]),
  ...Object.keys(OPS).map((k) => [k, "ops"]),
  ...Object.keys(EVIDENCE).map((k) => [k, "evidence"]),
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
