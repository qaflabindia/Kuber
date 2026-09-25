/**
 * Policy family A: autonomy thresholds per action type (receipt, payment) and entity segment.
 *
 * The candidate policy is an AutonomyTuning (modules/policy). Its action on a recorded decision is
 * computed by the same PolicyEngine.decide() the agent calls at runtime, from the decision's
 * recorded features as of the moment it was made (prefix only: counts, amounts and relax counters
 * use nothing recorded later, the rule open-dream-rsi's rollout harness enforces as issue #1).
 *
 * Objective: straight-through share. An entry the candidate would have posted on its own, and that
 * people later accepted, earns 1 at L4 (no person at all) and RATIFY_CREDIT at L3 (a person still
 * ratifies it afterwards). Hard constraints: counterfactual unsafe auto-posts (entries later
 * corrected, reversed, edited or rejected that the candidate would have posted on its own) may not
 * exceed the incumbent's count nor the owner's cap, and excluded classes are never auto-posted.
 */
import { z } from "zod";
import { RELAX_LOOKBACK, TUNING_MIN_CONFIDENCE, type AutonomyTuning, type Level, type PolicyEngine, type RelaxStats } from "@kuber/policy";
import type { RecordedDecision, ReplayPool } from "../core/pool.ts";
import type { ConstraintCheck, Evaluation, PolicyFamily, StepOutcome } from "../core/simulator.ts";
import type { ParamSpace } from "../core/space.ts";

export const ACTION_TYPES = ["receipt", "payment"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * What a recorded decision was. Everything but `bookkeeping` is excluded from tuning and never
 * auto-postable under any candidate: suspense (nothing matched), above the policy's amount limit,
 * period operations (close, carry forward, allocate, rebalance), payments and master data.
 */
export const DECISION_CLASSES = ["bookkeeping", "suspense", "above_limit", "period_ops", "payments", "master_data"] as const;
export type DecisionClass = (typeof DECISION_CLASSES)[number];
export const EXCLUDED_CLASSES: ReadonlySet<DecisionClass> = new Set(["suspense", "above_limit", "period_ops", "payments", "master_data"]);

/**
 * Eventual truth of a recorded decision.
 *   approved_unchanged  a person approved the draft with the proposed account
 *   edited              a person approved the draft with a different account
 *   rejected            a person rejected the draft
 *   ratified            an auto-posted entry a person ratified
 *   auto_uncorrected    an auto-posted (L4) entry nobody corrected within the correction window
 *   auto_corrected      an auto-posted entry later reclassified by a person
 *   auto_reversed       an auto-posted entry later reversed
 *   corrected_after_approval  a draft approved unchanged whose journal was later corrected or reversed
 *   pending             not resolved yet: no recorded outcome
 */
export const TRUTHS = ["approved_unchanged", "edited", "rejected", "ratified", "auto_uncorrected", "auto_corrected", "auto_reversed",
  "corrected_after_approval", "pending"] as const;
export type Truth = (typeof TRUTHS)[number];
export const CORRECT_TRUTHS: ReadonlySet<Truth> = new Set(["approved_unchanged", "ratified", "auto_uncorrected"]);
export const WRONG_TRUTHS: ReadonlySet<Truth> = new Set(["edited", "rejected", "auto_corrected", "auto_reversed", "corrected_after_approval"]);

/** An L3 post still costs a person a ratification; an L4 post costs nobody anything. */
export const RATIFY_CREDIT = 0.5;
/** Stored for an amount z-score with no spread in the history (amountZScore returned Infinity). */
export const Z_UNBOUNDED = 1e9;

export const RecordedAutonomyAction = z.enum(["auto_l3", "auto_l4", "person"]);
export type AutonomyAction = z.infer<typeof RecordedAutonomyAction>;

const LevelSchema = z.enum(["L0", "L1", "L2", "L3", "L4"]);
export const AutonomyFeatures = z.object({
  eventCode: z.string().regex(/^EVT-[A-Z-]+$/),
  /** Decision date (the agent's clock), which selects the policies in force. */
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actionType: z.enum(ACTION_TYPES),
  /** The book's entity type (e.g. freelancer, company): the entity segment. */
  entitySegment: z.string().regex(/^[a-z_]+$/),
  klass: z.enum(DECISION_CLASSES),
  confidence: z.number().min(0).max(1),
  classifier: z.enum(["rule", "history", "merchant", "llm", "none", "plan"]),
  amountPaise: z.number().int().nonnegative(),
  hasParty: z.boolean(),
  /** Standing journals of the counterparty before this decision. */
  partyPriorPostings: z.number().int().nonnegative(),
  /** A person had approved a draft for this counterparty before this decision. */
  partyConfirmed: z.boolean(),
  /** z-score of the amount against the counterparty's standing journals (null: too few; Z_UNBOUNDED: no spread). */
  amountZ: z.number().nonnegative().nullable(),
  /** Override in force (AutonomyLimited after a correction). */
  overrideMax: LevelSchema.nullable(),
  /** Kill switch on for the book (FIN-OPS-03). */
  halted: z.boolean(),
  /** Relax counters of this book and action type as of the decision. */
  relax: z.object({ consecutiveAccepted: z.number().int().nonnegative(), resolved: z.number().int().nonnegative(), accepted: z.number().int().nonnegative() }),
}).strict();
export type AutonomyFeatures = z.infer<typeof AutonomyFeatures>;
export const AutonomyOutcome = z.object({ truth: z.enum(TRUTHS) }).strict();
export type AutonomyOutcome = z.infer<typeof AutonomyOutcome>;

export type AutonomyDecision = RecordedDecision<AutonomyFeatures, AutonomyAction, AutonomyOutcome>;
export const AutonomyDecisionSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16,64}$/), seq: z.number().int().nonnegative(),
  features: AutonomyFeatures, action: RecordedAutonomyAction, outcome: AutonomyOutcome,
}).strict();

export type AutonomyParams = AutonomyTuning;
export interface AutonomyBounds { maxCeilingPaise: number }

/** Hard bounds of a candidate tuning (every candidate, from any proposer, must pass). */
export function autonomyParamsSchema(b: AutonomyBounds) {
  return z.object({
    l3MinConfidence: z.number().min(TUNING_MIN_CONFIDENCE).max(0.999),
    l4MinConfidence: z.number().min(0.95).max(0.999).nullable(),
    relaxAfterAcceptances: z.number().int().min(10).max(RELAX_LOOKBACK),
    accuracyFloor: z.number().min(0.95).max(1),
    amountCeilingPaise: z.number().int().min(0).max(b.maxCeilingPaise),
    newCounterpartyKnownAfter: z.number().int().min(3).max(12),
    amountZLimit: z.number().min(2).max(8).nullable(),
  }).strict().refine((p) => p.l4MinConfidence === null || p.l4MinConfidence >= p.l3MinConfidence,
    { message: "l4MinConfidence must be at least l3MinConfidence" });
}

export function autonomySpace(b: AutonomyBounds): ParamSpace {
  return [
    { path: ["l3MinConfidence"], min: TUNING_MIN_CONFIDENCE, max: 0.999, step: 0.01, precision: 3 },
    { path: ["l4MinConfidence"], min: 0.95, max: 0.999, step: 0.01, precision: 3, nullable: true },
    { path: ["relaxAfterAcceptances"], min: 10, max: RELAX_LOOKBACK, step: 10, integer: true },
    { path: ["accuracyFloor"], min: 0.95, max: 1, step: 0.01, precision: 3 },
    { path: ["amountCeilingPaise"], min: 0, max: b.maxCeilingPaise, step: Math.max(1, Math.round(b.maxCeilingPaise / 10)), integer: true },
    { path: ["newCounterpartyKnownAfter"], min: 3, max: 12, step: 2, integer: true },
    { path: ["amountZLimit"], min: 2, max: 8, step: 0.5, precision: 2, nullable: true },
  ];
}

export interface AutonomyFamilyOptions {
  /** Owner's cap on counterfactual unsafe auto-posts (default: none beyond the incumbent's count). */
  unsafeCap?: number;
}

/** Is this recorded decision's class excluded from tuning (never auto-postable)? */
export const isExcluded = (d: AutonomyDecision) => EXCLUDED_CLASSES.has(d.features.klass);

export function makeAutonomyFamily(policies: PolicyEngine, bounds: AutonomyBounds, o: AutonomyFamilyOptions = {}):
    PolicyFamily<AutonomyParams, AutonomyDecision, AutonomyAction> {
  return {
    id: "autonomy",
    metric: { id: "autonomy.straight_through_share.v1", description: `share of recorded decisions the candidate would have posted on its own and people accepted (L4 = 1, L3 = ${RATIFY_CREDIT})` },
    schema: autonomyParamsSchema(bounds) as unknown as z.ZodType<AutonomyParams>,
    space: autonomySpace(bounds),
    repair: (p) => (p.l4MinConfidence !== null && p.l4MinConfidence < p.l3MinConfidence ? { ...p, l4MinConfidence: p.l3MinConfidence } : p),
    act: (params, d) => autonomyAction(policies, params, d),
    counterfactual: autonomyOutcome,
    summarize: (pool, actions, outcomes) => summarizeAutonomy(pool, actions, outcomes),
    constraints: (cand, inc) => autonomyConstraints(cand, inc, o.unsafeCap),
  };
}

/** The candidate's action on a recorded decision: exactly what the agent would decide with this tuning. */
export function autonomyAction(policies: PolicyEngine, params: AutonomyParams | null, d: AutonomyDecision): AutonomyAction {
  const f = d.features;
  if (EXCLUDED_CLASSES.has(f.klass) || f.halted) return "person";
  const known = f.hasParty && (f.partyConfirmed || f.partyPriorPostings >= Math.max(3, params?.newCounterpartyKnownAfter ?? 3));
  const dec = policies.decide({
    eventCode: f.eventCode, on: f.on, amountPaise: BigInt(f.amountPaise), confidence: f.confidence, counterpartyKnown: known,
    overrideMax: f.overrideMax as Level | null, tuning: params, relax: f.relax as RelaxStats, amountZ: f.amountZ,
  });
  return dec.level === "L4" ? "auto_l4" : dec.level === "L3" ? "auto_l3" : "person";
}

/**
 * Recorded outcome of an action. Routing to a person: no automation credit and no error (the
 * conservative reading, whatever the person did). Auto-posting: the entry's eventual truth
 * decides, because the classification is the same whichever way it was routed; a pending entry
 * has no recorded outcome.
 */
export function autonomyOutcome(d: AutonomyDecision, a: AutonomyAction): StepOutcome | null {
  if (a === "person") return { credit: 0 };
  const excluded = EXCLUDED_CLASSES.has(d.features.klass) ? { excluded_auto_post: 1 } : null;
  if (CORRECT_TRUTHS.has(d.outcome.truth)) return { credit: a === "auto_l4" ? 1 : RATIFY_CREDIT, ...(excluded ? { violations: excluded } : {}) };
  if (WRONG_TRUTHS.has(d.outcome.truth)) return { credit: 0, violations: { unsafe_auto_post: 1, ...excluded } };
  return excluded ? { credit: 0, violations: excluded } : null;
}

function summarizeAutonomy(pool: ReplayPool<AutonomyDecision>, actions: AutonomyAction[], outcomes: StepOutcome[]) {
  let l3 = 0, l4 = 0, stp = 0, noTouch = 0, eligible = 0, excluded = 0;
  pool.items.forEach((d, i) => {
    const a = actions[i]!, o = outcomes[i]!;
    if (EXCLUDED_CLASSES.has(d.features.klass)) excluded++; else eligible++;
    if (a === "auto_l3") l3++;
    if (a === "auto_l4") l4++;
    if (a !== "person" && o.credit > 0) { stp++; if (a === "auto_l4") noTouch++; }
  });
  const n = pool.size || 1;
  return { decisions: pool.size, eligible, excluded, autoL3: l3, autoL4: l4, person: pool.size - l3 - l4,
    straightThroughShare: stp / n, noTouchShare: noTouch / n };
}

export function autonomyConstraints(cand: Evaluation, inc: Evaluation, cap?: number): ConstraintCheck[] {
  const unsafe = cand.violations.unsafe_auto_post ?? 0, incUnsafe = inc.violations.unsafe_auto_post ?? 0;
  const limit = cap === undefined ? incUnsafe : Math.min(incUnsafe, cap);
  const excluded = cand.violations.excluded_auto_post ?? 0;
  return [
    { name: "unsafe_auto_posts", value: unsafe, limit, ok: unsafe <= limit,
      detail: `entries later corrected, reversed, edited or rejected that this policy would have posted on its own: ${unsafe}; incumbent ${incUnsafe}${cap === undefined ? "" : `, owner cap ${cap}`}` },
    { name: "excluded_class_auto_posts", value: excluded, limit: 0, ok: excluded === 0,
      detail: "period operations, payments, master data, suspense and above-limit entries are never auto-posted" },
  ];
}
