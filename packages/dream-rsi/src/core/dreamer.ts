/**
 * Offline dreaming: hill-climb a bounded parameter set over counterfactual replays of the
 * recorded pool (port of open-dream-rsi core/dreamer.py DreamEngine.run_offline_optimization).
 *
 * What is kept from the reference:
 *   - the incumbent seeds the climb, and a candidate replaces the current best only on a strictly
 *     better score (`simulated_score > best_score`);
 *   - candidates are proposed from the current best and clamped to hard bounds;
 *   - every candidate is scored over the same N seeded episodes (common random numbers), so the
 *     comparison between candidates is paired and the whole run is reproducible for a given pool
 *     and seed (the reference's DREAM_SEED / `f"{DREAM_SEED}:{ep}"`).
 *
 * What changes:
 *   - an episode is a seeded bootstrap resample of the recorded decisions, not a stochastic rollout
 *     of a softmax policy: Kuber's policies are deterministic threshold rules, so the uncertainty
 *     worth measuring is sampling uncertainty over the recorded history;
 *   - promotion has two gates (design 7.2): the winner must strictly beat the incumbent, and the
 *     lower bound of a bootstrap confidence interval on the paired improvement must be above zero.
 *     The reference's policygen promotion also demands evidence ("replace the incumbent only when it
 *     demonstrably beats it"); the interval makes "demonstrably" a number;
 *   - hard constraints (family.constraints) must hold for a candidate to be accepted at all;
 *   - candidates are validated against the family's zod schema whoever proposed them; invalid ones
 *     are counted and never evaluated.
 */
import { DiscoveryTree } from "./pool.ts";
import type { ReplayPool, RecordedDecision } from "./pool.ts";
import { MutationProposer, type CandidateProposer } from "./proposer.ts";
import { ReplaySimulator, type ConstraintCheck, type Evaluation, type PolicyFamily } from "./simulator.ts";
import { diffParams } from "./space.ts";
import { SeededRng, hashOf, quantile } from "./util.ts";

export const DEFAULT_EPISODES = 200;
export const DEFAULT_CONFIDENCE = 0.95;

export interface DreamOptions<P> {
  seed: number;
  iterations: number;
  /** Seeded bootstrap episodes per candidate (default 200). */
  episodes?: number;
  /** Two-sided confidence level of the improvement interval (default 0.95). */
  confidence?: number;
  proposer?: CandidateProposer<P>;
}

export interface Scored<P> {
  params: P;
  paramsHash: string;
  /** Mean over episodes of the episode objective. */
  score: number;
  /** Objective on the full pool (no resampling). */
  poolScore: number;
  violations: Record<string, number>;
  metrics: Record<string, number>;
  constraints: ConstraintCheck[];
  feasible: boolean;
}

export interface DreamResult<P> {
  family: string;
  metric: string;
  seed: number;
  iterations: number;
  episodes: number;
  confidence: number;
  pool: { kind: string; size: number; sliceHash: string };
  incumbent: Scored<P>;
  winner: Scored<P>;
  /** Paired improvement of the winner over the incumbent across episodes (null when the winner is the incumbent). */
  improvement: { mean: number; ciLower: number; ciUpper: number } | null;
  diff: { param: string; from: unknown; to: unknown }[];
  candidates: { proposed: number; evaluated: number; rejectedOutOfBounds: number; duplicates: number; infeasible: number; accepted: number };
  decision: "promote" | "keep_incumbent";
  reasons: string[];
  trajectory: { nodeId: string; paramsHash: string; score: number; thought: string }[];
}

export class DreamEngine<P, D extends RecordedDecision, A, C = unknown> {
  readonly simulator: ReplaySimulator<P, D, A, C>;
  readonly tree = new DiscoveryTree();

  constructor(readonly family: PolicyFamily<P, D, A, C>, readonly pool: ReplayPool<D>) {
    this.simulator = new ReplaySimulator(family, pool);
  }

  async run(incumbentParams: P, o: DreamOptions<P>): Promise<DreamResult<P>> {
    const episodes = o.episodes ?? DEFAULT_EPISODES, confidence = o.confidence ?? DEFAULT_CONFIDENCE;
    if (!Number.isInteger(o.seed)) throw new Error("dream seed must be an integer");
    if (!Number.isInteger(o.iterations) || o.iterations < 0) throw new Error("iterations must be a non-negative integer");
    if (!Number.isInteger(episodes) || episodes < 2) throw new Error("episodes must be an integer >= 2");
    const inc = this.family.schema.safeParse(incumbentParams);
    if (!inc.success) throw new Error(`incumbent parameters are outside the ${this.family.id} bounds: ${inc.error.message}`);
    const proposer = o.proposer ?? new MutationProposer<P>();
    const rng = new SeededRng(`${o.seed}:${this.family.id}:proposals`);
    const resamples = bootstrapIndices(this.pool.size, episodes, o.seed, this.family.id);

    const cache = new Map<string, { ev: Evaluation<A>; ep: Float64Array }>();
    const evalOf = (p: P) => {
      const h = hashOf(p);
      let hit = cache.get(h);
      if (!hit) { const ev = this.simulator.evaluate(p); hit = { ev, ep: episodeMeans(ev.credits, resamples) }; cache.set(h, hit); }
      return { h, ...hit };
    };

    const i0 = evalOf(inc.data);
    const scored = (p: P, h: string, ev: Evaluation<A>, ep: Float64Array): Scored<P> => {
      const constraints = this.family.constraints(ev, i0.ev);
      return { params: p, paramsHash: h, score: mean(ep), poolScore: ev.score, violations: ev.violations, metrics: ev.metrics,
        constraints, feasible: constraints.every((c) => c.ok) };
    };
    const incumbent = scored(inc.data, i0.h, i0.ev, i0.ep);
    const rootId = "n0";
    this.tree.addNode(rootId, i0.h, { feasible: incumbent.feasible }, incumbent.score, null, "incumbent");

    let best = incumbent, bestNode = rootId, bestEp = i0.ep;
    const counts = { proposed: 0, evaluated: 0, rejectedOutOfBounds: 0, duplicates: 0, infeasible: 0, accepted: 0 };
    for (let it = 1; it <= o.iterations; it++) {
      counts.proposed++;
      const raw = await proposer.propose({ incumbent: inc.data, best: best.params, bestScore: best.score, iteration: it, rng, space: this.family.space });
      const repaired = raw !== undefined && this.family.repair ? this.family.repair(raw as P) : raw;
      const parsed = this.family.schema.safeParse(repaired);
      if (!parsed.success) { counts.rejectedOutOfBounds++; continue; }
      const p = parsed.data;
      const known = cache.has(hashOf(p));
      const { h, ev, ep } = evalOf(p);
      if (known) { counts.duplicates++; continue; }
      counts.evaluated++;
      const s = scored(p, h, ev, ep);
      const nodeId = `n${it}`;
      this.tree.addNode(nodeId, h, { feasible: s.feasible, violations: s.violations }, s.score, bestNode, `${proposer.name}#${it}`);
      if (!s.feasible) { counts.infeasible++; continue; }
      if (s.score > best.score) { best = s; bestNode = nodeId; bestEp = ep; counts.accepted++; }
    }

    const reasons: string[] = [];
    let improvement: DreamResult<P>["improvement"] = null;
    let decision: DreamResult<P>["decision"] = "keep_incumbent";
    if (best === incumbent) {
      reasons.push(`no feasible candidate strictly beat the incumbent (score ${incumbent.score.toFixed(6)}) in ${o.iterations} iterations`);
    } else {
      const diffs = Float64Array.from(bestEp, (x, e) => x - i0.ep[e]!).sort();
      const alpha = (1 - confidence) / 2;
      improvement = { mean: best.score - incumbent.score, ciLower: quantile(diffs, alpha), ciUpper: quantile(diffs, 1 - alpha) };
      const strict = best.score > incumbent.score;
      if (!strict) reasons.push("winner does not strictly beat the incumbent");
      if (!best.feasible) reasons.push(`winner fails constraints: ${best.constraints.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
      if (!(improvement.ciLower > 0)) reasons.push(`lower bound of the ${Math.round(confidence * 100)}% bootstrap interval on the improvement is ${improvement.ciLower.toFixed(6)}, not above 0`);
      if (strict && best.feasible && improvement.ciLower > 0) {
        decision = "promote";
        reasons.push(`winner beats the incumbent by ${improvement.mean.toFixed(6)} (${Math.round(confidence * 100)}% CI ${improvement.ciLower.toFixed(6)} to ${improvement.ciUpper.toFixed(6)}) and meets every constraint`);
      }
    }
    return {
      family: this.family.id, metric: this.family.metric.id, seed: o.seed, iterations: o.iterations, episodes, confidence,
      pool: { kind: this.pool.kind, size: this.pool.size, sliceHash: this.pool.hash() },
      incumbent, winner: best, improvement, diff: diffParams(this.family.space, incumbent.params, best.params), candidates: counts,
      decision, reasons,
      trajectory: pathTo(this.tree, bestNode).map((n) => ({ nodeId: n.nodeId, paramsHash: n.action, score: n.score, thought: n.thought })),
    };
  }
}

/** Seeded bootstrap resamples: `episodes` arrays of `n` indices drawn with replacement. */
export function bootstrapIndices(n: number, episodes: number, seed: number, label = ""): Uint32Array[] {
  const out: Uint32Array[] = [];
  for (let e = 0; e < episodes; e++) {
    const rng = new SeededRng(`${seed}:${label}:episode:${e}`);
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = rng.int(n);
    out.push(idx);
  }
  return out;
}

/** Mean credit of each resample. */
export function episodeMeans(credits: Float64Array, resamples: Uint32Array[]): Float64Array {
  const n = credits.length;
  return Float64Array.from(resamples, (idx) => {
    if (!n) return 0;
    let s = 0;
    for (let i = 0; i < idx.length; i++) s += credits[idx[i]!]!;
    return s / n;
  });
}

const mean = (xs: Float64Array) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Root-to-node chain: each node's parent is the best candidate when it was proposed, so this is the chain of accepted improvements. */
function pathTo(tree: DiscoveryTree, nodeId: string) {
  const out = [];
  for (let cur = tree.nodes.get(nodeId); cur; cur = cur.parentId ? tree.nodes.get(cur.parentId) : undefined) out.push(cur);
  return out.reverse();
}
