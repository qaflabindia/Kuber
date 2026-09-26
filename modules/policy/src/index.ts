/**
 * Policy engine over the .md policy library (design section 13.6). Deterministic; never an LLM.
 *
 * Resolution: active policies for the event code (status active, effective_from <= decision
 * date, review_by not passed); none -> POL-000; several -> all apply and the strictest wins.
 * Runtime limits can only lower autonomy: amount above limit -> at most L2; confidence below
 * threshold or unknown counterparty -> at most L1; an active override -> at most its level.
 *
 * An owner-approved autonomy tuning (Dream-RSI, design 7.2) may replace the confidence threshold,
 * amount ceiling (never above the policy limit), counterparty and amount triggers for TUNABLE_EVENTS,
 * and may relax an L3 policy to L4 after a run of accepted outcomes; all the limits above still apply.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;
export type Level = (typeof LEVELS)[number];
export const ACTIONS: Record<Level, "inform" | "draft" | "await_approval" | "post_then_ratify" | "post"> =
  { L0: "inform", L1: "draft", L2: "await_approval", L3: "post_then_ratify", L4: "post" };
export const DEFAULT_POLICY = "POL-000";
export const DEFAULT_MIN_CONFIDENCE = 0.97;
const rank = (l: Level) => LEVELS.indexOf(l);
const minLevel = (a: Level, b: Level): Level => (rank(a) <= rank(b) ? a : b);

export interface Policy {
  policyId: string; title: string; event: string; klass: string; autonomy: Level; approver: string;
  amountLimitInr: number | null; status: string; version: number; effectiveFrom: string | null; reviewBy: string | null;
  minConfidence: number; body: string; frontMatter: Record<string, unknown>;
}

export interface Decision {
  policyIds: string[]; level: Level; action: (typeof ACTIONS)[Level]; approver: string; reasons: string[];
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "" || v === "null") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
};

export function parsePolicy(text: string): Policy {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("policy file has no YAML front matter");
  const fm = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
  for (const k of ["policy_id", "event", "autonomy"]) if (!fm[k]) throw new Error(`front matter is missing ${k}`);
  const autonomy = String(fm.autonomy) as Level;
  if (!LEVELS.includes(autonomy)) throw new Error(`${fm.policy_id}: autonomy must be one of ${LEVELS.join(", ")}`);
  const limit = fm.amount_limit_inr;
  return {
    policyId: String(fm.policy_id), title: String(fm.title ?? ""), event: String(fm.event), klass: String(fm.class ?? "control"),
    autonomy, approver: String(fm.approver ?? ""), amountLimitInr: typeof limit === "number" ? limit : null,
    status: String(fm.status ?? "draft"), version: Number(fm.version ?? 1),
    effectiveFrom: iso(fm.effective_from), reviewBy: iso(fm.review_by),
    minConfidence: Number(fm.min_confidence ?? DEFAULT_MIN_CONFIDENCE), body: m[2]!, frontMatter: fm,
  };
}

export const isActive = (p: Policy, on: string) =>
  p.status === "active" && (!p.effectiveFrom || on >= p.effectiveFrom) && (!p.reviewBy || on <= p.reviewBy);

export interface DecideInput {
  eventCode: string; on: string; amountPaise?: bigint; confidence?: number;
  counterpartyKnown?: boolean; overrideMax?: Level | null;
  /**
   * Owner-approved autonomy tuning for this book and action type (Dream-RSI proposals, design 7.2).
   * Applies only to TUNABLE_EVENTS; ignored for every other event code. Absent: the policy file alone.
   */
  tuning?: AutonomyTuning | null;
  /** Recent outcomes of this book and action type (see relaxStatsFrom); read only when `tuning` enables L4. */
  relax?: RelaxStats;
  /** z-score of the amount against the counterparty's earlier amounts (null: fewer than MIN_Z_SAMPLES). */
  amountZ?: number | null;
}

// ------------------------------------------------------------------ autonomy tuning (Dream-RSI)
/**
 * Event codes whose autonomy an approved tuning may change. Everything else (period operations,
 * payments, master data, policy changes) keeps exactly its policy file, whatever a tuning says.
 */
export const TUNABLE_EVENTS: readonly string[] = ["EVT-TXN-INGESTED"];
/**
 * Lowest auto-posting confidence a tuning may set. Above the LLM classifier's cap (0.9), so an LLM
 * classification still never posts on its own (tests/dream-rsi.test.ts asserts the ordering).
 */
export const TUNING_MIN_CONFIDENCE = 0.91;
/** Outcomes the accuracy floor is measured over (most recent first). */
export const ACCURACY_WINDOW = 100;
/** Outcomes read to compute relax statistics: the largest relax counter a tuning may ask for. */
export const RELAX_LOOKBACK = 200;
/** Earlier amounts of a counterparty needed before its amount z-score is defined. */
export const MIN_Z_SAMPLES = 3;

/**
 * Autonomy thresholds for one book and action type. Every field can only move autonomy within the
 * policy's own ceiling: the level never exceeds L4 on an L3 policy, never exceeds L2 above the
 * policy's amount limit, and the other limits (unknown counterparty, override, kill switch) still apply.
 */
export interface AutonomyTuning {
  /** Minimum classifier confidence to post then ratify (L3); replaces the policy's min_confidence, floored at TUNING_MIN_CONFIDENCE. */
  l3MinConfidence: number;
  /** Minimum confidence to post without ratification (L4); null: never L4. */
  l4MinConfidence: number | null;
  /** Consecutive accepted outcomes needed before L4 applies. */
  relaxAfterAcceptances: number;
  /** Share of accepted outcomes (last ACCURACY_WINDOW) needed before L4 applies. */
  accuracyFloor: number;
  /** Amount above which a person approves (L2); capped at the policy's amount limit. Paise. */
  amountCeilingPaise: number;
  /** Postings a counterparty needs (unless confirmed by a person) before it counts as known. */
  newCounterpartyKnownAfter: number;
  /** Amounts more than this many standard deviations from the counterparty's history go to a person; null: off. */
  amountZLimit: number | null;
}

export interface RelaxStats { consecutiveAccepted: number; resolved: number; accepted: number }

/** Relax statistics from outcomes, most recent first (true: the person accepted the agent's classification). */
export function relaxStatsFrom(recentFirst: readonly boolean[]): RelaxStats {
  let consecutiveAccepted = 0;
  while (consecutiveAccepted < recentFirst.length && recentFirst[consecutiveAccepted]) consecutiveAccepted++;
  const window = recentFirst.slice(0, ACCURACY_WINDOW);
  return { consecutiveAccepted, resolved: window.length, accepted: window.filter(Boolean).length };
}

/** z-score of `amount` against earlier amounts (null with fewer than MIN_Z_SAMPLES; Infinity when they never vary and it differs). */
export function amountZScore(amount: number, earlier: readonly number[]): number | null {
  if (earlier.length < MIN_Z_SAMPLES) return null;
  const mean = earlier.reduce((s, x) => s + x, 0) / earlier.length;
  const sd = Math.sqrt(earlier.reduce((s, x) => s + (x - mean) ** 2, 0) / earlier.length);
  if (sd === 0) return amount === mean ? 0 : Infinity;
  return Math.abs(amount - mean) / sd;
}

export class PolicyEngine {
  constructor(public readonly policies: Policy[]) {
    if (!policies.some((p) => p.policyId === DEFAULT_POLICY)) throw new Error("the library must contain POL-000, the global default");
  }

  static fromDir(dir: string): PolicyEngine {
    const files = readdirSync(dir).filter((f) => /^POL-.*\.md$/.test(f)).sort();
    return new PolicyEngine(files.map((f) => parsePolicy(readFileSync(join(dir, f), "utf8"))));
  }

  resolve(eventCode: string, on: string): Policy[] {
    const found = this.policies.filter((p) => p.event === eventCode && isActive(p, on));
    return found.length ? found : this.policies.filter((p) => p.policyId === DEFAULT_POLICY);
  }

  /**
   * The policy-file settings a tuning replaces, as a tuning: deciding with it gives exactly the
   * decision without one (the incumbent a Dream-RSI run compares candidates against).
   */
  untunedEquivalent(eventCode: string, on: string): AutonomyTuning {
    const pols = this.resolve(eventCode, on);
    const limits = pols.map((p) => p.amountLimitInr).filter((x): x is number => x !== null);
    return {
      l3MinConfidence: Math.max(TUNING_MIN_CONFIDENCE, ...pols.map((p) => p.minConfidence)), l4MinConfidence: null,
      relaxAfterAcceptances: 30, accuracyFloor: 0.98,     // POL-502 "notes for the agent"; inert while L4 is off
      amountCeilingPaise: limits.length ? Math.min(...limits) * 100 : Number.MAX_SAFE_INTEGER,
      newCounterpartyKnownAfter: 3, amountZLimit: null,
    };
  }

  decide(i: DecideInput): Decision {
    const pols = this.resolve(i.eventCode, i.on);
    const reasons: string[] = [];
    const strictest = pols.reduce<Level>((l, p) => minLevel(l, p.autonomy), "L4");
    let level = strictest;
    const tuning = i.tuning && TUNABLE_EVENTS.includes(i.eventCode) ? i.tuning : null;
    if (pols.length > 1) reasons.push(`${pols.length} policies apply; strictest autonomy ${level} used`);
    if (pols[0]!.policyId === DEFAULT_POLICY && i.eventCode !== "EVT-ANY") reasons.push(`no active policy for ${i.eventCode}; global default applies`);

    // Relaxation to L4 (POL-502 notes) only from an L3 policy, only under an approved tuning, and
    // only after a run of accepted outcomes at the accuracy floor. The limits below still apply.
    if (tuning && level === "L3" && tuning.l4MinConfidence !== null && (i.confidence ?? 0) >= tuning.l4MinConfidence && i.relax
        && i.relax.consecutiveAccepted >= tuning.relaxAfterAcceptances && i.relax.resolved > 0
        && i.relax.accepted / i.relax.resolved >= tuning.accuracyFloor) {
      level = "L4"; reasons.push(`relaxed to L4 after ${i.relax.consecutiveAccepted} consecutive accepted entries (approved tuning)`);
    }

    const limits = pols.map((p) => p.amountLimitInr).filter((x): x is number => x !== null);
    if (limits.length && (i.amountPaise ?? 0n) > BigInt(Math.min(...limits)) * 100n && rank(level) > rank("L2")) {
      level = "L2"; reasons.push(`amount above limit of ₹${Math.min(...limits).toLocaleString("en-IN")}: needs approval`);
    }
    if (tuning && (i.amountPaise ?? 0n) > BigInt(Math.max(0, Math.trunc(tuning.amountCeilingPaise))) && rank(level) > rank("L2")) {
      level = "L2"; reasons.push(`amount above the tuned ceiling of ${tuning.amountCeilingPaise} paise: needs approval`);
    }
    const minConf = tuning ? Math.max(TUNING_MIN_CONFIDENCE, tuning.l3MinConfidence) : Math.max(...pols.map((p) => p.minConfidence));
    if ((i.confidence ?? 1) < minConf && rank(level) > rank("L1")) {
      level = "L1"; reasons.push(`confidence ${(i.confidence ?? 0).toFixed(2)} below ${minConf.toFixed(2)}: draft only`);
    }
    if (i.counterpartyKnown === false && rank(level) > rank("L1")) { level = "L1"; reasons.push("counterparty not yet known: draft only"); }
    if (tuning && tuning.amountZLimit !== null && i.amountZ !== null && i.amountZ !== undefined && i.amountZ > tuning.amountZLimit && rank(level) > rank("L1")) {
      level = "L1"; reasons.push(`amount unusual for this counterparty (z ${Number.isFinite(i.amountZ) ? i.amountZ.toFixed(1) : "∞"} > ${tuning.amountZLimit}): draft only`);
    }
    if (i.overrideMax && rank(i.overrideMax) < rank(level)) { level = i.overrideMax; reasons.push(`autonomy limited to ${i.overrideMax} after a recent correction`); }

    const approver = pols.find((p) => p.autonomy === strictest)?.approver ?? pols[0]!.approver;
    return { policyIds: pols.map((p) => p.policyId), level, action: ACTIONS[level], approver, reasons };
  }
}
