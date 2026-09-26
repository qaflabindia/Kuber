/**
 * Policy family B: copilot routing.
 *
 * Parameters: the router's resolve threshold (below it the turn falls back to the model), the
 * clarification threshold (below it the copilot asks instead of calling anything), the fuzzy
 * account-match threshold, and tool-selection priors per intent family (weights applied when the
 * router ranks its candidates). Intent families follow the deterministic router's operations
 * (apps/core/src/copilot/router.ts).
 *
 * Objective: correct resolution, the share of recorded turns the candidate would have resolved
 * correctly (the person's next action confirmed the tool, and the account when one was needed).
 * Hard constraints, absolute: zero ungrounded answers and zero guessed accounts. Committing to an
 * account the person did not confirm is a guess, whether it later turned out wrong or was never
 * checked; ambiguity (a second candidate also above the threshold) means asking.
 *
 * This objective and its evaluation set are separate from the autonomy family's (design 7.3,
 * ASDGF relation A3): different metric id, different pool kind.
 */
import { z } from "zod";
import type { RecordedDecision, ReplayPool } from "../core/pool.ts";
import type { ConstraintCheck, Evaluation, PolicyFamily, StepOutcome } from "../core/simulator.ts";
import type { Dim, ParamSpace } from "../core/space.ts";

export const INTENT_FAMILIES = ["position", "books_check", "reconcile", "period_close", "post_drafts", "rebalance", "allocate",
  "simulate", "report", "capture", "other"] as const;
export type IntentFamily = (typeof INTENT_FAMILIES)[number];

const Hash = z.string().regex(/^[0-9a-f]{16,64}$/);
const Tool = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const RoutingFeatures = z.object({
  /** The router's scored candidates for the turn (score in [0, 1]); empty when nothing matched. */
  router: z.object({ candidates: z.array(z.object({ family: z.enum(INTENT_FAMILIES), tool: Tool, score: z.number().min(0).max(1) })).max(20) }),
  /** Account candidates when the turn names an account (hashed ids, similarity in [0, 1]); null when none is needed. */
  account: z.object({ candidates: z.array(z.object({ id: Hash, similarity: z.number().min(0).max(1) })).max(50) }).nullable(),
}).strict();
export type RoutingFeatures = z.infer<typeof RoutingFeatures>;
export const RecordedRoutingAction = z.object({ path: z.enum(["router", "model", "clarify"]), tool: Tool.nullable() }).strict();
export const RoutingOutcome = z.object({
  /** What the person's next action confirmed (null: not confirmed). */
  truth: z.object({ tool: Tool.nullable(), account: Hash.nullable() }).strict(),
  /** The recorded model answer, present only when the turn actually went to the model. */
  model: z.object({ correct: z.boolean(), grounded: z.boolean(), guessedAccount: z.boolean() }).strict().nullable(),
  nextAction: z.enum(["accepted", "rephrased", "corrected", "abandoned", "none"]),
}).strict();
export type RoutingOutcome = z.infer<typeof RoutingOutcome>;
export type RoutingTurn = RecordedDecision<RoutingFeatures, z.infer<typeof RecordedRoutingAction>, RoutingOutcome>;
export const RoutingTurnSchema = z.object({ id: Hash, seq: z.number().int().nonnegative(), features: RoutingFeatures,
  action: RecordedRoutingAction, outcome: RoutingOutcome }).strict();

export type RoutingAction = { kind: "router"; tool: string; account: string | null } | { kind: "model" } | { kind: "clarify"; why: "low_score" | "account" };

const Prior = z.number().min(0.5).max(2);
export const RoutingParamsSchema = z.object({
  resolveThreshold: z.number().min(0.5).max(0.99),
  clarifyThreshold: z.number().min(0.05).max(0.9),
  fuzzyAccountThreshold: z.number().min(0.7).max(0.99),
  toolPriors: z.object(Object.fromEntries(INTENT_FAMILIES.map((f) => [f, Prior])) as Record<IntentFamily, typeof Prior>).strict(),
}).strict().refine((p) => p.clarifyThreshold <= p.resolveThreshold, { message: "clarifyThreshold must not exceed resolveThreshold" });
export type RoutingParams = z.infer<typeof RoutingParamsSchema>;

/** The router as deployed: every prior 1, resolve at 0.8, ask below 0.3, accounts at 0.9 similarity. */
export const DEFAULT_ROUTING_PARAMS: RoutingParams = {
  resolveThreshold: 0.8, clarifyThreshold: 0.3, fuzzyAccountThreshold: 0.9,
  toolPriors: Object.fromEntries(INTENT_FAMILIES.map((f) => [f, 1])) as Record<IntentFamily, number>,
};

export const ROUTING_SPACE: ParamSpace = [
  { path: ["resolveThreshold"], min: 0.5, max: 0.99, step: 0.05, precision: 3 },
  { path: ["clarifyThreshold"], min: 0.05, max: 0.9, step: 0.05, precision: 3 },
  { path: ["fuzzyAccountThreshold"], min: 0.7, max: 0.99, step: 0.03, precision: 3 },
  ...INTENT_FAMILIES.map((f): Dim => ({ path: ["toolPriors", f], min: 0.5, max: 2, step: 0.25, precision: 2 })),
];

/** The candidate's action on a recorded turn. */
export function routingAction(p: RoutingParams, t: RoutingTurn): RoutingAction {
  const ranked = [...t.features.router.candidates].sort((a, b) =>
    b.score * p.toolPriors[b.family] - a.score * p.toolPriors[a.family] || b.score - a.score || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
  const top = ranked[0];
  const raw = top?.score ?? 0;
  if (raw < p.clarifyThreshold) return { kind: "clarify", why: "low_score" };
  if (raw < p.resolveThreshold || !top) return { kind: "model" };
  let account: string | null = null;
  if (t.features.account) {
    const accts = [...t.features.account.candidates].sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1));
    const [best, second] = accts;
    if (!best || best.similarity < p.fuzzyAccountThreshold || (second && second.similarity >= p.fuzzyAccountThreshold)) return { kind: "clarify", why: "account" };
    account = best.id;
  }
  return { kind: "router", tool: top.tool, account };
}

/** Recorded outcome of an action on a turn; null when history has none (e.g. a model answer to a turn the router took). */
export function routingOutcome(t: RoutingTurn, a: RoutingAction): StepOutcome | null {
  if (a.kind === "clarify") return { credit: 0 };
  if (a.kind === "model") {
    const m = t.outcome.model;
    if (!m) return null;
    const violations = { ...(m.grounded ? {} : { ungrounded_answer: 1 }), ...(m.guessedAccount ? { guessed_account: 1 } : {}) };
    return { credit: m.correct && m.grounded && !m.guessedAccount ? 1 : 0, ...(Object.keys(violations).length ? { violations } : {}) };
  }
  const truth = t.outcome.truth;
  const guessed = a.account !== null && a.account !== truth.account;
  const violations = guessed ? { guessed_account: 1 } : undefined;
  if (truth.tool === null) return violations ? { credit: 0, violations } : null;
  const correct = a.tool === truth.tool && !guessed;
  return { credit: correct ? 1 : 0, ...(violations ? { violations } : {}) };
}

export function routingConstraints(cand: Evaluation): ConstraintCheck[] {
  const ungrounded = cand.violations.ungrounded_answer ?? 0, guessed = cand.violations.guessed_account ?? 0;
  return [
    { name: "ungrounded_answers", value: ungrounded, limit: 0, ok: ungrounded === 0, detail: "answers whose figures were not found in tool outputs" },
    { name: "guessed_accounts", value: guessed, limit: 0, ok: guessed === 0, detail: "accounts committed to without the person's confirmation" },
  ];
}

function summarizeRouting(pool: ReplayPool<RoutingTurn>, actions: RoutingAction[], outcomes: StepOutcome[]) {
  let router = 0, model = 0, clarify = 0, correct = 0;
  actions.forEach((a, i) => {
    if (a.kind === "router") router++; else if (a.kind === "model") model++; else clarify++;
    if (outcomes[i]!.credit > 0) correct++;
  });
  const n = pool.size || 1;
  return { turns: pool.size, routerResolved: router, modelFallback: model, clarified: clarify, correctResolutionShare: correct / n };
}

export function makeRoutingFamily(): PolicyFamily<RoutingParams, RoutingTurn, RoutingAction> {
  return {
    id: "routing",
    metric: { id: "routing.correct_resolution.v1", description: "share of recorded copilot turns resolved correctly (tool, and account when needed, confirmed by the person's next action)" },
    schema: RoutingParamsSchema as unknown as z.ZodType<RoutingParams>,
    space: ROUTING_SPACE,
    repair: (p) => (p.clarifyThreshold > p.resolveThreshold ? { ...p, clarifyThreshold: p.resolveThreshold } : p),
    act: (p, t) => routingAction(p, t),
    counterfactual: routingOutcome,
    summarize: summarizeRouting,
    constraints: (cand) => routingConstraints(cand),
  };
}
