/**
 * Policy engine over the .md policy library (design section 13.6). Deterministic; never an LLM.
 *
 * Resolution: active policies for the event code (status active, effective_from <= decision
 * date, review_by not passed); none -> POL-000; several -> all apply and the strictest wins.
 * Runtime limits can only lower autonomy: amount above limit -> at most L2; confidence below
 * threshold or unknown counterparty -> at most L1; an active override -> at most its level.
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

  decide(i: DecideInput): Decision {
    const pols = this.resolve(i.eventCode, i.on);
    const reasons: string[] = [];
    const strictest = pols.reduce<Level>((l, p) => minLevel(l, p.autonomy), "L4");
    let level = strictest;
    if (pols.length > 1) reasons.push(`${pols.length} policies apply; strictest autonomy ${level} used`);
    if (pols[0]!.policyId === DEFAULT_POLICY && i.eventCode !== "EVT-ANY") reasons.push(`no active policy for ${i.eventCode}; global default applies`);

    const limits = pols.map((p) => p.amountLimitInr).filter((x): x is number => x !== null);
    if (limits.length && (i.amountPaise ?? 0n) > BigInt(Math.min(...limits)) * 100n && rank(level) > rank("L2")) {
      level = "L2"; reasons.push(`amount above limit of ₹${Math.min(...limits).toLocaleString("en-IN")}: needs approval`);
    }
    const minConf = Math.max(...pols.map((p) => p.minConfidence));
    if ((i.confidence ?? 1) < minConf && rank(level) > rank("L1")) {
      level = "L1"; reasons.push(`confidence ${(i.confidence ?? 0).toFixed(2)} below ${minConf.toFixed(2)}: draft only`);
    }
    if (i.counterpartyKnown === false && rank(level) > rank("L1")) { level = "L1"; reasons.push("counterparty not yet known: draft only"); }
    if (i.overrideMax && rank(i.overrideMax) < rank(level)) { level = i.overrideMax; reasons.push(`autonomy limited to ${i.overrideMax} after a recent correction`); }

    const approver = pols.find((p) => p.autonomy === strictest)?.approver ?? pols[0]!.approver;
    return { policyIds: pols.map((p) => p.policyId), level, action: ACTIONS[level], approver, reasons };
  }
}
