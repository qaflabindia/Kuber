/**
 * Counterfactual evaluation of a policy over a recorded pool (port of open-dream-rsi
 * core/simulator.py ReplaySimulator.step_offline and the rollout harness of core/policygen.py).
 *
 * For each recorded decision the candidate policy chooses an action from the decision's context
 * features; the simulator returns the outcome of that action from recorded outcomes only:
 *
 *   - the action the deployed policy took: its recorded outcome;
 *   - another action whose outcome the history still determines (e.g. auto-posting an entry a
 *     person later approved unchanged): that outcome, as the family's counterfactual rule says;
 *   - an action with no recorded outcome: conservatively nothing, no credit and no error.
 *
 * Deviation from open-dream-rsi: step_offline credits an unseen action with 0.9 x the recorded
 * score ("dreaming heuristic"). An invented outcome is exactly the optimism a metric-gaming
 * optimiser exploits (design 7.3: a metric the optimiser can game is a control failure), so an
 * unrecorded outcome earns zero here.
 */
import type { ZodType } from "zod";
import type { ReplayPool, RecordedDecision } from "./pool.ts";
import type { ParamSpace } from "./space.ts";

/** The outcome of one decision under a policy: objective credit and counts of hard-constraint events. */
export interface StepOutcome { credit: number; violations?: Readonly<Record<string, number>> }
export const NO_OUTCOME: StepOutcome = Object.freeze({ credit: 0 });

export interface ConstraintCheck {
  name: string;
  /** The candidate's value and the largest value allowed. */
  value: number;
  limit: number;
  ok: boolean;
  detail: string;
}

/** A candidate's full-pool evaluation. */
export interface Evaluation<A = unknown> {
  /** Objective credit of each decision (pool order). */
  credits: Float64Array;
  /** Mean credit over the whole pool. */
  score: number;
  violations: Record<string, number>;
  metrics: Record<string, number>;
  actions: A[];
}

/**
 * A policy family: the bounded parameters, how a parameter set acts on a recorded decision, what
 * the recorded history says that action led to, and the hard constraints. Families must not share
 * a metric (design 7.3, ASDGF relation A3): `metric.id` names the objective and its evaluation set.
 */
export interface PolicyFamily<P, D extends RecordedDecision, A, C = unknown> {
  readonly id: string;
  readonly metric: { id: string; description: string };
  readonly schema: ZodType<P>;
  readonly space: ParamSpace;
  /** Make a mutated candidate consistent across dimensions (e.g. l4 >= l3) before validation. */
  repair?(params: P): P;
  /** Parameter-independent context computed once per pool (e.g. relax counters as of each decision). */
  prepare?(pool: ReplayPool<D>): C;
  /** The action the policy with `params` takes on decision `index` (pure: no I/O, no randomness). */
  act(params: P, decision: D, index: number, ctx: C): A;
  /** The recorded (or recorded-determined) outcome of `action`; null when history has none. */
  counterfactual(decision: D, action: A): StepOutcome | null;
  /** Family metrics for the report (shares, counts). */
  summarize?(pool: ReplayPool<D>, actions: A[], outcomes: StepOutcome[]): Record<string, number>;
  /** Hard constraints of a candidate against the incumbent; all must hold for promotion. */
  constraints(candidate: Evaluation<A>, incumbent: Evaluation<A>): ConstraintCheck[];
}

export class ReplaySimulator<P, D extends RecordedDecision, A, C = unknown> {
  private ctx: C;

  constructor(readonly family: PolicyFamily<P, D, A, C>, readonly pool: ReplayPool<D>) {
    this.ctx = (family.prepare ? family.prepare(pool) : undefined) as C;
  }

  /** One offline step: the outcome of `action` on decision `index`, conservatively nothing when unrecorded. */
  stepOffline(index: number, action: A): StepOutcome {
    const d = this.pool.items[index];
    if (!d) return NO_OUTCOME;
    return this.family.counterfactual(d, action) ?? NO_OUTCOME;
  }

  /** Roll the policy over the whole recorded pool. */
  evaluate(params: P): Evaluation<A> {
    const n = this.pool.size;
    const credits = new Float64Array(n);
    const violations: Record<string, number> = {};
    const actions: A[] = new Array(n);
    const outcomes: StepOutcome[] = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const a = this.family.act(params, this.pool.items[i]!, i, this.ctx);
      const o = this.stepOffline(i, a);
      actions[i] = a; outcomes[i] = o;
      credits[i] = o.credit; sum += o.credit;
      if (o.violations) for (const [k, v] of Object.entries(o.violations)) violations[k] = (violations[k] ?? 0) + v;
    }
    const metrics = this.family.summarize ? this.family.summarize(this.pool, actions, outcomes) : {};
    return { credits, score: n ? sum / n : 0, violations, metrics, actions };
  }
}
