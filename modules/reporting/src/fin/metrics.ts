/**
 * FIN-RPT-02 metric catalogue and its single evaluator (design 8.3, 8.4).
 *
 * Each metric is a versioned JSON definition in modules/reporting/src/metrics/: id, name, formula
 * over named inputs, grain, sign convention, filters, period semantics, source, owner (a role),
 * freshness requirement, version, and a golden test. Inputs are measures over mapped statement
 * lines (closing balance, period flow) or subledger facts (credit sales, credit purchases, cash
 * decrease over trailing months). The formula is a small arithmetic expression evaluated with exact
 * rationals (bigint numerator / denominator), formatted only at the end.
 *
 * One evaluator computes every figure: the API, the copilot, the web panel and the CSV / JSON
 * export all call evaluateMetric, and drillMetric returns the journals, account balances or open
 * items behind each input, which sum exactly to the input. A metric whose input is missing, or
 * whose denominator is zero, is unavailable with the reason: never 0.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, sha256 } from "@kuber/contracts";
import type { LedgerData } from "./data.ts";
import { resolveAccounts, type Mapped, type MappingLine, type StatementMapping } from "./mapping.ts";
import { DivisionByZero, Rational, addDays, addMonths, daysInclusive } from "./rational.ts";

export type Measure = "closing" | "flow" | "credit_sales" | "credit_purchases" | "cash_decrease";
export interface MetricInput {
  measure: Measure; label: string;
  /** closing / flow: statement line keys; "CA.*" selects every line whose key starts with "CA.". */
  lines?: string[];
  /** Absent mapping for these lines is taken as nil (with a note) instead of making the metric unavailable. */
  optional?: boolean;
  /** credit_sales: receivable and revenue lines; credit_purchases: payable lines. */
  receivables?: string[]; revenue?: string[]; payables?: string[];
  /** credit_sales / credit_purchases: flow lines used, and disclosed, when the credit basis cannot be separated. */
  proxy?: string[];
  /** cash_decrease: trailing calendar months ending on the period end. */
  months?: number;
}
export interface MetricDef {
  id: string; name: string; version: number; description: string;
  unit: "ratio" | "percent" | "days" | "months" | "paise"; places: number;
  inputs: Record<string, MetricInput>;
  formula: string;
  unavailableWhen?: { input: string; op: "<=" | "<" | "=="; value: string; reason: string }[];
  grain: string[]; sign: string; filters: Record<string, string>;
  period: { type: "point" | "flow" | "mixed"; semantics: string };
  source: string[]; owner: string;
  freshness: { maxLagJournals: number; note: string };
  basis?: string;
  test: { fixture: string; from: string; to: string; expected: string };
}

// ---------------------------------------------------------------- formula
type Node = { k: "num"; v: bigint } | { k: "id"; name: string } | { k: "neg"; a: Node } | { k: "op"; op: "+" | "-" | "*" | "/"; a: Node; b: Node };
export function parseFormula(src: string): Node {
  const toks = src.match(/\s*(\d+|[A-Za-z_][A-Za-z0-9_]*|[-+*/()])/gy);
  if (!toks || toks.join("").replace(/\s+/g, "") !== src.replace(/\s+/g, "")) throw new Error(`formula has characters it cannot read: ${src}`);
  const t = toks.map((x) => x.trim());
  let i = 0;
  const peek = () => t[i], next = () => t[i++];
  const expr = (): Node => { let a = term(); while (peek() === "+" || peek() === "-") { const op = next() as "+" | "-"; a = { k: "op", op, a, b: term() }; } return a; };
  const term = (): Node => { let a = factor(); while (peek() === "*" || peek() === "/") { const op = next() as "*" | "/"; a = { k: "op", op, a, b: factor() }; } return a; };
  const factor = (): Node => {
    const x = next();
    if (x === undefined) throw new Error(`formula ends early: ${src}`);
    if (x === "-") return { k: "neg", a: factor() };
    if (x === "(") { const e = expr(); if (next() !== ")") throw new Error(`missing ) in ${src}`); return e; }
    if (/^\d+$/.test(x)) return { k: "num", v: BigInt(x) };
    if (/^[A-Za-z_]/.test(x)) return { k: "id", name: x };
    throw new Error(`unexpected ${x} in ${src}`);
  };
  const e = expr();
  if (i !== t.length) throw new Error(`unexpected ${t[i]} in ${src}`);
  return e;
}
const idsOf = (n: Node): string[] => n.k === "id" ? [n.name] : n.k === "num" ? [] : n.k === "neg" ? idsOf(n.a) : [...idsOf(n.a), ...idsOf(n.b)];
const show = (n: Node): string => n.k === "num" ? n.v.toString() : n.k === "id" ? n.name : n.k === "neg" ? `-${show(n.a)}` : `(${show(n.a)} ${n.op} ${show(n.b)})`;
export class ZeroDenominator extends Error { constructor(public expr: string) { super(`denominator ${expr} is zero`); } }
function evalNode(n: Node, env: Map<string, Rational>): Rational {
  switch (n.k) {
    case "num": return new Rational(n.v);
    case "id": { const v = env.get(n.name); if (!v) throw new Error(`unknown input ${n.name}`); return v; }
    case "neg": return evalNode(n.a, env).neg();
    case "op": {
      const a = evalNode(n.a, env), b = evalNode(n.b, env);
      if (n.op === "/") { try { return a.div(b); } catch (e) { if (e instanceof DivisionByZero) throw new ZeroDenominator(show(n.b)); throw e; } }
      return n.op === "+" ? a.add(b) : n.op === "-" ? a.sub(b) : a.mul(b);
    }
  }
}

// ---------------------------------------------------------------- catalogue
export const BUILTINS = new Set(["days"]);
const MEASURES = new Set(["closing", "flow", "credit_sales", "credit_purchases", "cash_decrease"]);
const REQUIRED = ["id", "name", "version", "description", "unit", "places", "inputs", "formula", "grain", "sign", "filters", "period", "source", "owner", "freshness", "test"] as const;

/** Problems with a metric definition (empty when valid). `lineKeys`: keys of the mappings, to check line selectors against. */
export function validateMetric(m: unknown, lineKeys?: Set<string>): string[] {
  const o = m as Partial<MetricDef>, out: string[] = [];
  if (!o || typeof o !== "object") return ["metric is not an object"];
  for (const k of REQUIRED) if ((o as Record<string, unknown>)[k] === undefined) out.push(`${k} required`);
  if (out.length) return out;
  if (!/^[a-z][a-z0-9_]*$/.test(o.id!)) out.push("id: lower_snake_case");
  if (!Number.isInteger(o.version) || o.version! < 1) out.push("version: positive integer");
  if (!["ratio", "percent", "days", "months", "paise"].includes(o.unit!)) out.push("unit: ratio, percent, days, months or paise");
  if (!Number.isInteger(o.places) || o.places! < 0 || o.places! > 6) out.push("places: 0 to 6");
  if (!Array.isArray(o.grain) || !o.grain.length) out.push("grain: non-empty list");
  if (typeof o.sign !== "string" || !o.sign) out.push("sign: the sign convention");
  if (typeof o.filters !== "object") out.push("filters: object");
  if (!o.period || !["point", "flow", "mixed"].includes(o.period.type) || !o.period.semantics) out.push("period: { type: point|flow|mixed, semantics }");
  if (!Array.isArray(o.source) || !o.source.length) out.push("source: non-empty list");
  if (typeof o.owner !== "string" || !o.owner) out.push("owner: a role");
  if (!o.freshness || !Number.isInteger(o.freshness.maxLagJournals) || o.freshness.maxLagJournals < 0) out.push("freshness.maxLagJournals: integer ≥ 0");
  if (!o.test || !o.test.fixture || !o.test.from || !o.test.to || typeof o.test.expected !== "string") out.push("test: { fixture, from, to, expected }");
  const names = Object.keys(o.inputs ?? {});
  if (!names.length) out.push("inputs: at least one");
  const sel = (name: string, what: string, xs: unknown) => {
    if (!Array.isArray(xs) || !xs.length || xs.some((x) => typeof x !== "string")) { out.push(`inputs.${name}.${what}: non-empty list of line keys`); return; }
    if (lineKeys) for (const x of xs as string[]) if (![...lineKeys].some((k) => matches(x, k))) out.push(`inputs.${name}.${what}: ${x} matches no mapping line`);
  };
  for (const [name, i] of Object.entries(o.inputs ?? {})) {
    if (BUILTINS.has(name)) out.push(`inputs.${name}: ${name} is a built-in`);
    if (!MEASURES.has(i.measure)) { out.push(`inputs.${name}.measure: one of ${[...MEASURES].join(", ")}`); continue; }
    if (!i.label) out.push(`inputs.${name}.label required`);
    if (i.measure === "closing" || i.measure === "flow") sel(name, "lines", i.lines);
    if (i.measure === "credit_sales") { sel(name, "receivables", i.receivables); sel(name, "revenue", i.revenue); if (i.proxy) sel(name, "proxy", i.proxy); }
    if (i.measure === "credit_purchases") { sel(name, "payables", i.payables); if (i.proxy) sel(name, "proxy", i.proxy); }
    if (i.measure === "cash_decrease" && (!Number.isInteger(i.months) || i.months! < 1 || i.months! > 24)) out.push(`inputs.${name}.months: 1 to 24`);
  }
  try {
    const ids = idsOf(parseFormula(o.formula!));
    for (const id of ids) if (!names.includes(id) && !BUILTINS.has(id)) out.push(`formula uses ${id}, which is neither an input nor a built-in`);
  } catch (e) { out.push(`formula: ${(e as Error).message}`); }
  for (const u of o.unavailableWhen ?? []) {
    if (!names.includes(u.input)) out.push(`unavailableWhen: unknown input ${u.input}`);
    if (!["<=", "<", "=="].includes(u.op) || !/^-?\d+$/.test(u.value) || !u.reason) out.push("unavailableWhen: { input, op (<=, <, ==), value (integer), reason }");
  }
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const METRICS_DIR = join(HERE, "..", "metrics");

/** Hash of what determines a metric's figure: a change to any of it needs a new version. */
export const definitionHash = (m: MetricDef) => sha256(canonical({ id: m.id, version: m.version, unit: m.unit, places: m.places, inputs: m.inputs, formula: m.formula, unavailableWhen: m.unavailableWhen ?? [] }));

/** Load and validate every metric file (throws listing the problems). */
export function loadMetrics(dir = METRICS_DIR, mappings: StatementMapping[] = []): MetricDef[] {
  const keys = mappings.length ? new Set(mappings.flatMap((m) => m.lines.map((l) => l.key))) : undefined;
  const out = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const problems = validateMetric(m, keys);
    if (problems.length) throw new Error(`metric ${f}: ${problems.join("; ")}`);
    return m as MetricDef;
  });
  const seen = new Set<string>();
  for (const m of out) { const k = `${m.id}@${m.version}`; if (seen.has(k)) throw new Error(`metric ${k} is defined twice`); seen.add(k); }
  return out;
}
/** The golden book a metric's test runs on. */
export function loadFixture(name: string, dir = join(METRICS_DIR, "golden")) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad fixture name ${name}`);
  return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
}

// ---------------------------------------------------------------- evaluation
const matches = (sel: string, key: string) => (sel.endsWith("*") ? key.startsWith(sel.slice(0, -1)) : key === sel);
export interface InputValue { name: string; label: string; measure: Measure; value: string | null; reason?: string; basis?: string; accounts: string[] }
export interface MetricResult {
  id: string; name: string; version: number; unit: MetricDef["unit"]; owner: string;
  /** Exact value "n/d" (or integer paise), and the formatted figure; both null when unavailable. */
  exact: string | null; value: string | null;
  available: boolean; reasons: string[]; notes: string[];
  inputs: InputValue[];
  period: { from: string; to: string; days: number };
  definitionHash: string;
}
export interface DrillItem { input: string; ref: string; journalId?: string; txnDate?: string; accountId?: string; partyId?: string | null; label: string; amount: string }
export interface MetricContext { mapping: StatementMapping | null; from: string; to: string; lag?: number; firstDate?: string | null }

interface Resolved { mapped: Map<string, Mapped>; lineOf: (sel: string[]) => MappingLine[]; accountsOf: (sel: string[]) => string[] }
function resolver(mapping: StatementMapping, accounts: Awaited<ReturnType<LedgerData["accounts"]>>): Resolved {
  const { mapped } = resolveAccounts(mapping, accounts);
  const lineOf = (sel: string[]) => mapping.lines.filter((l) => sel.some((s) => matches(s, l.key)));
  const accountsOf = (sel: string[]) => { const keys = new Set(lineOf(sel).map((l) => l.key)); return [...mapped.values()].filter((m) => keys.has(m.line.key)).map((m) => m.account.accountId); };
  return { mapped, lineOf, accountsOf };
}

interface Computed { value: bigint | null; reason?: string; basis?: string; accounts: string[]; drill: () => Promise<DrillItem[]> }

/** One input's value (and how to drill into it), from the data source. */
async function computeInput(data: LedgerData, r: Resolved, name: string, i: MetricInput, ctx: MetricContext, plAccounts: string[]): Promise<Computed> {
  const g = (m: Map<string, bigint>, a: string) => m.get(a) ?? 0n;
  const need = (sel: string[], what: string): { lines: MappingLine[]; ids: string[]; reason?: string } => {
    const lines = r.lineOf(sel);
    if (!lines.length) return { lines, ids: [], reason: `${what}: no line ${sel.join(", ")} in the statement mapping` };
    const ids = r.accountsOf(sel);
    if (!ids.length && !i.optional) return { lines, ids, reason: `${what}: no account is mapped to ${lines.map((l) => l.label).join(", ")}` };
    return { lines, ids };
  };
  const nat = (a: string) => r.mapped.get(a)!.line.side === "debit" ? 1n : -1n;
  const flowDrill = async (ids: string[], sign: (a: string) => bigint): Promise<DrillItem[]> => {
    const set = new Set(ids), per = new Map<string, DrillItem>();
    for (const j of await data.journals(ctx.from, ctx.to, ids)) {
      if (!set.has(j.accountId)) continue;
      const cur = per.get(j.journalId) ?? { input: name, ref: j.journalId, journalId: j.journalId, txnDate: j.txnDate, label: `Journal ${j.journalId}`, amount: "0" };
      cur.amount = (BigInt(cur.amount) + sign(j.accountId) * j.amount).toString();
      per.set(j.journalId, cur);
    }
    return [...per.values()].filter((x) => x.amount !== "0");
  };
  switch (i.measure) {
    case "closing": {
      const n = need(i.lines!, i.label);
      if (n.reason) return { value: null, reason: n.reason, accounts: [], drill: async () => [] };
      const closing = await data.sums(null, ctx.to);
      const profitLine = n.lines.some((l) => l.profit);
      const unclosed = profitLine ? -plAccounts.reduce((a, x) => a + g(closing, x), 0n) : 0n;
      const value = n.ids.reduce((a, x) => a + nat(x) * g(closing, x), 0n) + unclosed;
      return { value, accounts: n.ids, ...(i.optional && !n.ids.length ? { basis: `no account is mapped to ${n.lines.map((l) => l.label).join(", ")}: taken as nil` } : {}),
        drill: async () => {
          const parties = await data.partyBalances(n.ids, ctx.to);
          const out: DrillItem[] = [];
          for (const a of n.ids) {
            const ps = parties.filter((p) => p.accountId === a && p.amount !== 0n);
            if (ps.some((p) => p.partyId)) for (const p of ps) out.push({ input: name, ref: `${a}/${p.partyId ?? "-"}`, accountId: a, partyId: p.partyId, label: `Open items ${a}${p.partyId ? ` · ${p.partyId}` : " · no party"}`, amount: (nat(a) * p.amount).toString() });
            else if (g(closing, a) !== 0n) out.push({ input: name, ref: a, accountId: a, label: `Balance ${a}`, amount: (nat(a) * g(closing, a)).toString() });
          }
          if (unclosed !== 0n) out.push({ input: name, ref: "unclosed-profit", label: "Profit not yet closed into reserves", amount: unclosed.toString() });
          return out;
        } };
    }
    case "flow": {
      const n = need(i.lines!, i.label);
      if (n.reason) return { value: null, reason: n.reason, accounts: [], drill: async () => [] };
      const mov = await data.sums(ctx.from, ctx.to, { excludeClosing: true });
      return { value: n.ids.reduce((a, x) => a + nat(x) * g(mov, x), 0n), accounts: n.ids,
        ...(i.optional && !n.ids.length ? { basis: `no account is mapped to ${n.lines.map((l) => l.label).join(", ")}: taken as nil` } : {}),
        drill: () => flowDrill(n.ids, nat) };
    }
    case "credit_sales":
    case "credit_purchases": {
      const sales = i.measure === "credit_sales";
      const side = need(sales ? i.receivables! : i.payables!, sales ? "trade receivables" : "trade payables");
      if (side.reason) return { value: null, reason: side.reason, accounts: [], drill: async () => [] };
      const rev = sales ? need(i.revenue!, "revenue") : null;
      if (rev?.reason) return { value: null, reason: rev.reason, accounts: [], drill: async () => [] };
      const cash = new Set([...r.mapped.values()].filter((m) => m.line.cashFlow === "cash").map((m) => m.account.accountId));
      const sideSet = new Set(side.ids), revSet = new Set(rev?.ids ?? []);
      // Aggregate per journal first (one figure per journal), then sum: several lines cannot double a sale.
      const per = new Map<string, { txnDate: string; side: bigint; rev: boolean; cash: boolean }>();
      for (const j of await data.journals(ctx.from, ctx.to, side.ids)) {
        const cur = per.get(j.journalId) ?? { txnDate: j.txnDate, side: 0n, rev: false, cash: false };
        if (sideSet.has(j.accountId)) cur.side += j.amount;
        if (revSet.has(j.accountId) && j.amount !== 0n) cur.rev = true;
        if (cash.has(j.accountId) && j.amount !== 0n) cur.cash = true;
        per.set(j.journalId, cur);
      }
      const qualifying = [...per].filter(([, x]) => !x.cash && (sales ? x.rev : true) && x.side !== 0n);
      const value = qualifying.reduce((a, [, x]) => a + (sales ? x.side : -x.side), 0n);
      const basisText = sales ? "credit sales: invoice value (incl. GST) debited to trade receivables by journals that credit revenue and move no cash"
        : "credit purchases: bill value (incl. GST) credited to trade payables by journals that move no cash";
      const drill = async () => qualifying.map(([id, x]) => ({ input: name, ref: id, journalId: id, txnDate: x.txnDate, label: `Journal ${id}`, amount: (sales ? x.side : -x.side).toString() }));
      if (value !== 0n) return { value, basis: basisText, accounts: side.ids, drill };
      // Not separable: the side has a balance but no credit journals in the period. Use the proxy, and say so.
      const closing = await data.sums(null, ctx.to);
      const open = side.ids.reduce((a, x) => a + g(closing, x), 0n);
      if (open !== 0n && i.proxy) {
        const p = need(i.proxy, "proxy");
        if (p.reason) return { value: null, reason: `${sales ? "credit sales" : "credit purchases"} cannot be separated and the proxy is unavailable (${p.reason})`, accounts: [], drill: async () => [] };
        const mov = await data.sums(ctx.from, ctx.to, { excludeClosing: true });
        const pv = p.ids.reduce((a, x) => a + nat(x) * g(mov, x), 0n);
        return { value: pv, accounts: p.ids, basis: `PROXY: ${sales ? "credit sales" : "credit purchases"} cannot be separated (no journal in the period creates ${sales ? "receivables from revenue" : "payables"} without moving cash, but the ${sales ? "receivables" : "payables"} balance is not nil); ${p.lines.map((l) => l.label).join(" + ")} for the period is used instead`,
          drill: () => flowDrill(p.ids, nat) };
      }
      return { value: null, reason: `no ${sales ? "credit sales" : "credit purchases"} in ${ctx.from} to ${ctx.to}`, accounts: side.ids, drill };
    }
    case "cash_decrease": {
      const cashIds = [...r.mapped.values()].filter((m) => m.line.cashFlow === "cash").map((m) => m.account.accountId);
      if (!cashIds.length) return { value: null, reason: "no account is mapped to a cash and cash equivalents line", accounts: [], drill: async () => [] };
      const start = addMonths(ctx.to, -i.months!);
      if (ctx.firstDate && addDays(start, 1) < ctx.firstDate) return { value: null, reason: `the trailing ${i.months} months (from ${addDays(start, 1)}) start before the book's first posting on ${ctx.firstDate}`, accounts: [], drill: async () => [] };
      const a = await data.sums(null, start), b = await data.sums(null, ctx.to);
      const value = cashIds.reduce((s, x) => s + g(a, x) - g(b, x), 0n);
      return { value, accounts: cashIds, basis: `cash on ${start} less cash on ${ctx.to} (${i.months} months)`,
        drill: async () => cashIds.flatMap((x) => [
          { input: name, ref: `${x}@${start}`, accountId: x, label: `${x} on ${start}`, amount: g(a, x).toString() },
          { input: name, ref: `${x}@${ctx.to}`, accountId: x, label: `${x} on ${ctx.to} (less)`, amount: (-g(b, x)).toString() }]).filter((d) => d.amount !== "0") };
    }
  }
}

export function formatValue(v: Rational, m: Pick<MetricDef, "unit" | "places">): string {
  return m.unit === "percent" ? v.mul(new Rational(100n)).toFixed(m.places) : m.unit === "paise" ? v.toFixed(0) : v.toFixed(m.places);
}

async function evaluateInternal(data: LedgerData, m: MetricDef, ctx: MetricContext) {
  const days = daysInclusive(ctx.from, ctx.to);
  const base = { id: m.id, name: m.name, version: m.version, unit: m.unit, owner: m.owner, period: { from: ctx.from, to: ctx.to, days }, definitionHash: definitionHash(m) };
  const unavailable = (reasons: string[], inputs: InputValue[] = [], computed = new Map<string, Computed>()) =>
    ({ result: { ...base, exact: null, value: null, available: false, reasons, notes: [], inputs } as MetricResult, computed });
  if (!ctx.mapping) return unavailable(["no statement mapping serves the book's framework"]);
  if (ctx.firstDate === null) return unavailable(["the book has no postings"]);
  if (ctx.firstDate && ctx.to < ctx.firstDate) return unavailable([`no ledger data for this period: the book's first posting is on ${ctx.firstDate}`]);
  if (ctx.lag !== undefined && ctx.lag > m.freshness.maxLagJournals) return unavailable([`the reporting projection is ${ctx.lag} journal(s) behind the ledger; ${m.name} needs at most ${m.freshness.maxLagJournals} (${m.freshness.note})`]);
  const accounts = await data.accounts();
  const r = resolver(ctx.mapping, accounts);
  const plAccounts = accounts.filter((a) => a.nature === "income" || a.nature === "expense").map((a) => a.accountId);
  const computed = new Map<string, Computed>();
  for (const [name, i] of Object.entries(m.inputs)) computed.set(name, await computeInput(data, r, name, i, ctx, plAccounts));
  const inputs: InputValue[] = Object.entries(m.inputs).map(([name, i]) => {
    const c = computed.get(name)!;
    return { name, label: i.label, measure: i.measure, value: c.value === null ? null : c.value.toString(), ...(c.reason ? { reason: c.reason } : {}), ...(c.basis ? { basis: c.basis } : {}), accounts: c.accounts };
  });
  const missing = inputs.filter((x) => x.value === null);
  if (missing.length) return unavailable(missing.map((x) => x.reason ?? `${x.label} is unavailable`), inputs, computed);
  const env = new Map<string, Rational>(inputs.map((x) => [x.name, new Rational(BigInt(x.value!))]));
  env.set("days", new Rational(BigInt(days)));
  const reasons: string[] = [];
  for (const u of m.unavailableWhen ?? []) {
    const v = env.get(u.input)!, lim = new Rational(BigInt(u.value)), c = v.cmp(lim);
    if ((u.op === "<=" && c <= 0) || (u.op === "<" && c < 0) || (u.op === "==" && c === 0)) reasons.push(u.reason);
  }
  if (reasons.length) return unavailable(reasons, inputs, computed);
  let v: Rational;
  try { v = evalNode(parseFormula(m.formula), env); }
  catch (e) { if (e instanceof ZeroDenominator) return unavailable([`${e.message}: ${m.name} is not defined for this period`], inputs, computed); throw e; }
  const notes = inputs.filter((x) => x.basis).map((x) => `${x.label}: ${x.basis}`);
  return { result: { ...base, exact: v.toString(), value: formatValue(v, m), available: true, reasons: [], notes, inputs } as MetricResult, computed };
}

/** The single evaluator: every surface calls this. */
export async function evaluateMetric(data: LedgerData, m: MetricDef, ctx: MetricContext): Promise<MetricResult> {
  return (await evaluateInternal(data, m, ctx)).result;
}

/** The metric with, per input, the items behind it (journals, balances, open items); each input's items sum to the input. */
export async function drillMetric(data: LedgerData, m: MetricDef, ctx: MetricContext): Promise<{ metric: MetricResult; items: DrillItem[]; totals: Record<string, { input: string | null; items: string }> }> {
  const { result, computed } = await evaluateInternal(data, m, ctx);
  const items: DrillItem[] = [];
  for (const [, c] of computed) items.push(...await c.drill());
  const totals = Object.fromEntries(result.inputs.map((x) => [x.name, { input: x.value, items: items.filter((d) => d.input === x.name).reduce((a, d) => a + BigInt(d.amount), 0n).toString() }]));
  return { metric: result, items, totals };
}
