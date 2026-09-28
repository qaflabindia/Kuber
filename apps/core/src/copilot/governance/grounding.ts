/**
 * Grounding check (TAGOF GEN-01 confabulation control; enforcement point EP-5, output boundary).
 *
 * Every monetary figure and percentage in a reply must come from the turn's tool outputs:
 *
 *   money      ₹ / Rs / INR amounts in Indian (1,30,206.50) or western (130,206.50) grouping or none,
 *              with or without lakh / lac / L / crore / cr / k / thousand ("₹1.2 lakh", "90k",
 *              "INR 2.5 cr", "Rs. 45,000/-"), numbers followed by rupees / INR / Rs, and paise amounts
 *   percent    "12.5%", "40 percent", "40 per cent"
 *
 * Figures are normalised exactly (no floating point) to paise. A figure is grounded when its value
 * appears in some tool output (read either as rupees or, for bare integers, as raw paise, since tools
 * return both), or is exactly the sum or difference of at most two tool figures. Only money-marked
 * tool numbers and bare numbers of three or more digits are terms of a sum or difference, so counts
 * ("3 drafts", "12 months") cannot combine into a figure; ISO dates in tool outputs are ignored.
 * Percentages are grounded only against percentages the tools state. Dates and counts in the reply
 * are not figures unless money-marked. Signs are ignored (a balance shown as -₹500 in a tool and as
 * ₹500 in a reply is the same figure).
 */
import type { GroundingResult } from "./contracts.ts";

/** Exact decimal scale: values are held in millionths of a rupee (10,000 per paisa). */
const SCALE = 1_000_000n;
const PAISA = SCALE / 100n;

const NUM = String.raw`\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const UNIT = String.raw`lakhs?|lacs?|lac|crores?|cr|k|thousand|mn|million|l`;
const MULT: [RegExp, bigint][] = [[/^(lakhs?|lacs?|lac|l)$/i, 100_000n], [/^(crores?|cr)$/i, 10_000_000n], [/^(k|thousand)$/i, 1_000n], [/^(mn|million)$/i, 1_000_000n]];

/** "1,30,206.50" × unit → millionths of a rupee (exact); null when finer than the scale. */
export function scaled(num: string, unit = "", perRupee = SCALE): bigint | null {
  const n = num.replace(/,/g, "");
  const [w, f = ""] = n.split(".");
  if (!/^\d+$/.test(w!) || !/^\d*$/.test(f)) return null;
  const mul = MULT.find(([re]) => re.test(unit))?.[1] ?? 1n;
  const num10 = BigInt(w! + f) * mul * perRupee, den = 10n ** BigInt(f.length);
  return num10 % den === 0n ? num10 / den : null;
}

export interface Figure { text: string; kind: "money" | "percent"; value: bigint; paise?: string }

const RE = {
  prefixed: new RegExp(String.raw`(?:₹|\bRs\.?|\bINR)\s*-?\s*(${NUM})(?:\s*(${UNIT})\b)?(?:\s*\/-)?`, "gi"),
  currencyWord: new RegExp(String.raw`(?<![\w.,])(${NUM})\s*(?:(${UNIT})\s+)?(?:rupees?|inr|rs\b\.?)`, "gi"),
  paise: new RegExp(String.raw`(?<![\w.,])(${NUM})\s*paise\b`, "gi"),
  unit: new RegExp(String.raw`(?<![\w.,₹])(${NUM})\s*(lakhs?|lacs?|lac|crores?|cr|k|thousand)\b`, "gi"),
  percent: new RegExp(String.raw`(?<![\w.,])(${NUM})\s*(?:%|percent\b|per\s+cent\b)`, "gi"),
};

/** Monetary figures and percentages in a reply, each once (the first, most specific reading of a span wins). */
export function extractFigures(text: string): Figure[] {
  const taken: [number, number][] = [];
  const out: (Figure & { at: number })[] = [];
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && x < b);
  const scan = (re: RegExp, kind: Figure["kind"], value: (m: RegExpExecArray) => bigint | null) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const a = m.index, b = a + m[0].length;
      if (!free(a, b)) continue;
      const v = value(m);
      if (v === null) continue;
      taken.push([a, b]);
      out.push({ at: a, text: m[0].trim(), kind, value: v, ...(kind === "money" && v % PAISA === 0n ? { paise: (v / PAISA).toString() } : {}) });
    }
  };
  scan(RE.prefixed, "money", (m) => scaled(m[1]!, m[2] ?? ""));
  scan(RE.currencyWord, "money", (m) => scaled(m[1]!, m[2] ?? ""));
  scan(RE.paise, "money", (m) => scaled(m[1]!, "", PAISA));
  scan(RE.unit, "money", (m) => scaled(m[1]!, m[2]!));
  scan(RE.percent, "percent", (m) => scaled(m[1]!));
  return out.sort((x, y) => x.at - y.at).map(({ at: _at, ...f }) => f);
}

const TOKEN = new RegExp(String.raw`(₹|\bRs\.?\s*|\bINR\s*)?(-?)(${NUM})(?:\s*(${UNIT})\b)?(\s*(?:%|percent\b|per\s+cent\b|rupees?\b|paise\b))?`, "gi");
const DATE_PART = /\d{4}-\d{2}-\d{2}/g;
const COMPLETENESS_LINE = /^Completeness:.*$/gm;

export interface ToolValues {
  /** Every value a tool output shows: each number as rupees (with its unit) and, if an integer, also as raw paise. */
  money: Set<bigint>;
  /** Values that may be added or subtracted: money-marked numbers, and bare numbers of three or more digits outside dates. */
  moneyTerms: Set<bigint>;
  /** Percentages the tools state (numbers followed by % or "percent"). */
  percent: Set<bigint>;
}

export function toolValues(outputs: string[]): ToolValues {
  const money = new Set<bigint>(), moneyTerms = new Set<bigint>(), percent = new Set<bigint>();
  for (const raw of outputs) {
    // Dates are not figures; nor are the counts in a tool's "Completeness:" line (rows shown, rows in all).
    const o = raw.replace(COMPLETENESS_LINE, "").replace(DATE_PART, (d) => " ".repeat(d.length));
    TOKEN.lastIndex = 0;
    for (let m = TOKEN.exec(o); m; m = TOKEN.exec(o)) {
      const [, cur, , num, unit = "", suffix = ""] = m;
      const suf = suffix.trim().toLowerCase();
      if (/^(%|percent|per\s+cent)$/.test(suf)) { const p = scaled(num!); if (p !== null) percent.add(p); continue; }
      const marked = !!cur || !!unit || /^rupee/.test(suf) || suf === "paise";
      const values: bigint[] = [];
      if (suf === "paise") { const p = scaled(num!, "", PAISA); if (p !== null) values.push(p); }
      else {
        const r = scaled(num!, unit); if (r !== null) values.push(r);
        if (!cur && !unit && !num!.includes(".")) { const p = scaled(num!, "", PAISA); if (p !== null) values.push(p); }
      }
      const strong = marked || num!.replace(/[,.]/g, "").length >= 3;
      for (const v of values) { money.add(v); if (strong) moneyTerms.add(v); }
    }
  }
  return { money, moneyTerms, percent };
}

/** v is in `direct`, or v = a + b, a − b or b − a for some a, b in `terms`. */
function groundedIn(v: bigint, direct: Set<bigint>, terms: Set<bigint>): boolean {
  if (direct.has(v)) return true;
  for (const a of terms) {
    if (terms.has(v - a) || terms.has(a - v) || terms.has(a + v)) return true;
  }
  return false;
}

export function checkGrounding(reply: string, toolOutputs: string[]): GroundingResult {
  const figs = extractFigures(reply);
  if (!figs.length) return { ok: true, ungrounded: [] };
  const vals = toolValues(toolOutputs);
  const ungrounded = figs.filter((f) => !(f.kind === "money" ? groundedIn(f.value, vals.money, vals.moneyTerms) : groundedIn(f.value, vals.percent, vals.percent))).map((f) => f.text);
  return { ok: ungrounded.length === 0, ungrounded };
}

// ---------------------------------------------------------------- completeness (context integrity: fragments)
/** A tool result as the completeness check sees it. */
export interface Fragment { text: string; completeness?: { complete: boolean }; scopeTotals?: string[] }
export interface CompletenessResult { ok: boolean; partialTotals: string[] }

/** The reply says the figures are partial (then a total over the rows shown is stated honestly). */
export const PARTIAL_MARK = /\b(showing \d+|shown|partial(ly)?|incomplete|first \d+|top \d+|largest \d+|of the \d+|more exist|at least|not (all|every|the whole|complete)|so far|only (the|those)|excluding|excluded|left out|on this page|this page)\b/i;
/** The sentence presents a figure as a total of the whole. */
export const TOTAL_MARK = /\b(totals?|in all|altogether|overall|combined|sum(med)?|all together|grand|across all|all (of )?(the |your |my )?(accounts|journals|entries|transactions|payments|parties|entities|lines|items|vendors|customers))\b/i;

/**
 * GEN-01 for partial results: a figure presented as a total (its sentence says total, overall, in
 * all, …) may not come from a result that is incomplete (a page, a top-N cut, entities outside the
 * scope) unless the reply marks it partial. A figure is fine when a complete result, or an incomplete
 * result's scope totals (figures that cover the whole scope, such as a ledger's closing balance),
 * ground it; it is a partial total when only the incomplete results' rows ground it. Figures no
 * tool grounds at all are the grounding check's business, not counted here.
 */
export function checkCompleteness(reply: string, fragments: Fragment[]): CompletenessResult {
  const partial = fragments.filter((f) => f.completeness && !f.completeness.complete);
  if (!partial.length || PARTIAL_MARK.test(reply)) return { ok: true, partialTotals: [] };
  const complete = toolValues(fragments.filter((f) => !f.completeness || f.completeness.complete).map((f) => f.text));
  for (const f of partial) for (const p of f.scopeTotals ?? []) { if (/^-?\d+$/.test(p)) { const v = BigInt(p.replace("-", "")) * PAISA; complete.money.add(v); complete.moneyTerms.add(v); } }
  const rows = toolValues(partial.map((f) => f.text));
  const out: string[] = [];
  for (const sentence of reply.split(/(?<=[.!?;\n])\s+/)) {
    if (!TOTAL_MARK.test(sentence)) continue;
    for (const fig of extractFigures(sentence)) {
      if (fig.kind !== "money") continue;
      if (groundedIn(fig.value, complete.money, complete.moneyTerms)) continue;
      const all = new Set([...rows.moneyTerms, ...complete.moneyTerms]);
      if (groundedIn(fig.value, rows.money, all)) out.push(fig.text);
    }
  }
  return { ok: out.length === 0, partialTotals: [...new Set(out)] };
}
