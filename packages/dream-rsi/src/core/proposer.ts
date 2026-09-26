/**
 * Where candidate parameter sets come from.
 *
 * MutationProposer (the default) is open-dream-rsi's DreamEngine move: perturb the current best by
 * a bounded uniform step and clamp. Two changes, both deterministic under the seed: a random
 * subset of dimensions moves each time (a move of every dimension at once almost never improves a
 * ten-parameter policy), and with a small probability a dimension is redrawn uniformly within its
 * bounds, so a plateau (where no local step changes any decision) does not end the climb.
 *
 * JsonCandidateProposer lets a model propose candidates. Deviation from open-dream-rsi
 * (core/policygen.py, where the model writes Python that runs in a sandbox): the model returns a
 * JSON object of parameters only. It is parsed with JSON.parse and validated against the family's
 * zod bounds; nothing it writes is ever executed (design 7.2, TAGOF TOL-02/06).
 */
import type { ZodType } from "zod";
import { clampDim, dimKey, getAt, setAt, type ParamSpace } from "./space.ts";
import { canonicalJson, type SeededRng } from "./util.ts";

export interface ProposalContext<P> {
  incumbent: P;
  /** Current best feasible candidate (the incumbent until something strictly better was found). */
  best: P;
  bestScore: number;
  iteration: number;
  rng: SeededRng;
  space: ParamSpace;
}

export interface CandidateProposer<P> {
  readonly name: string;
  /** A raw candidate. The engine validates it against the family schema; invalid ones are counted and skipped. */
  propose(ctx: ProposalContext<P>): unknown | Promise<unknown>;
}

export interface MutationOptions {
  /** Probability that each dimension moves (at least one always does). */
  dimProbability?: number;
  /** Probability that a moving dimension is redrawn uniformly within its bounds instead of stepped. */
  globalProbability?: number;
  /** Probability that a nullable dimension toggles between null and a value. */
  nullToggleProbability?: number;
}

export class MutationProposer<P> implements CandidateProposer<P> {
  readonly name = "mutation";
  constructor(private o: MutationOptions = {}) {}

  propose(ctx: ProposalContext<P>): P {
    const { rng, space } = ctx;
    const pDim = this.o.dimProbability ?? 0.5, pGlobal = this.o.globalProbability ?? 0.1, pToggle = this.o.nullToggleProbability ?? 0.25;
    let moving = space.map(() => rng.next() < pDim);
    if (!moving.some(Boolean)) { const k = rng.int(space.length); moving = space.map((_, i) => i === k); }
    let out = ctx.best;
    space.forEach((d, i) => {
      if (!moving[i]) return;
      const cur = getAt(out, d.path);
      if (d.nullable && (cur === null || rng.next() < pToggle)) {
        out = setAt(out, d.path, cur === null ? clampDim(d, rng.uniform(d.min, d.max)) : null);
        return;
      }
      const base = typeof cur === "number" ? cur : (d.min + d.max) / 2;
      const v = rng.next() < pGlobal ? rng.uniform(d.min, d.max) : base + rng.uniform(-d.step, d.step);
      out = setAt(out, d.path, clampDim(d, v));
    });
    return out;
  }
}

/** A text-completion model, e.g. behind the model gateway. Only its text is used; it never gets tools. */
export type CompleteFn = (prompt: string) => Promise<string>;

export class JsonCandidateProposer<P> implements CandidateProposer<P> {
  readonly name = "json-model";
  /** Replies that were not a valid parameter object (counted; the fallback proposed instead). */
  rejected = 0;
  constructor(private complete: CompleteFn, private schema: ZodType<P>, private fallback: CandidateProposer<P> = new MutationProposer<P>(),
              private describe: string = "") {}

  async propose(ctx: ProposalContext<P>): Promise<unknown> {
    const bounds = ctx.space.map((d) => `${dimKey(d)}: ${d.nullable ? "null or " : ""}${d.integer ? "integer" : "number"} in [${d.min}, ${d.max}]`).join("\n");
    const prompt = [
      "Propose one parameter set for an offline policy search. Reply with ONE JSON object and nothing else.",
      this.describe,
      `Bounds (hard; anything outside is discarded):\n${bounds}`,
      `Current best (score ${ctx.bestScore.toFixed(6)}): ${canonicalJson(ctx.best)}`,
      `Incumbent: ${canonicalJson(ctx.incumbent)}`,
    ].filter(Boolean).join("\n\n");
    let reply: string;
    try { reply = await this.complete(prompt); } catch { this.rejected++; return this.fallback.propose(ctx); }
    const parsed = parseFirstJsonObject(reply);
    const ok = parsed === undefined ? null : this.schema.safeParse(parsed);
    if (!ok?.success) { this.rejected++; return this.fallback.propose(ctx); }
    return ok.data;
  }
}

/** The first balanced {...} in a reply, parsed as JSON (data only: never evaluated). */
export function parseFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}
