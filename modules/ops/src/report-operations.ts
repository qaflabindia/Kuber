/**
 * Reporting operations for FIN-RPT-01/02 (read only; they never write). Registered by the cell, so
 * each is planned under the ops guard like every read, appears in ops.list() and so in every agent
 * surface's tool catalogue and the governance register.
 *
 *   financial_statements  FIN-RPT-01  mapped balance sheet, profit and loss and notes, with comparatives
 *   cash_flow             FIN-RPT-01  cash flow statement (indirect; direct where cash lines allow)
 *   equity_statement      FIN-RPT-01  statement of changes in equity
 *   kpis                  FIN-RPT-02  the metric catalogue evaluated for a period and its comparative
 *   kpi_drill             FIN-RPT-02  the journals, balances and open items behind one metric
 *
 * Figures come from reporting.fin (one evaluator for report, API and export); each output carries
 * its preliminary / certified / unavailable label and the reasons.
 */
import { z } from "zod";
import { IsoDate } from "@kuber/contracts";
import type { FinStatement, KpiReport, StatementBundle } from "@kuber/reporting";
import { financialYear, fiscalStart } from "./math.ts";
import type { Check, Draft, OpContext, OpDef, Section } from "./types.ts";

const rs = (p: bigint) => { const n = p < 0n ? -p : p; return `${p < 0n ? "-" : ""}₹${(n / 100n).toLocaleString("en-IN")}${n % 100n ? "." + String(n % 100n).padStart(2, "0") : ""}`; };
const PeriodIn = {
  from: IsoDate.optional().describe("first day, YYYY-MM-DD (default: start of the book's fiscal year)"),
  to: IsoDate.optional().describe("last day, YYYY-MM-DD (default: today)"),
  compareFrom: IsoDate.optional().describe("comparative period start (default: the same span a year earlier)"),
  compareTo: IsoDate.optional().describe("comparative period end"),
  comparative: z.boolean().default(true).describe("include the comparative period column"),
};
const StmtInput = z.object(PeriodIn);
type StmtInput = z.infer<typeof StmtInput>;

/** The period asked for, defaulting to the book's fiscal year to date (FIN-MDM-01 start month). */
function period(ctx: OpContext, i: { from?: string; to?: string }) {
  const fy = financialYear(i.to ?? ctx.today, fiscalStart(ctx.state));
  const to = i.to ?? (ctx.today < fy.to ? ctx.today : fy.to);
  return { from: i.from ?? financialYear(to, fiscalStart(ctx.state)).from, to };
}
const params = (ctx: OpContext, i: StmtInput) => ({ ...period(ctx, i), compareFrom: i.compareFrom ?? null, compareTo: i.compareTo ?? null, comparative: i.comparative });

const statusLine = (s: FinStatement) => s.columns.map((c) => `${c.key === "current" ? "Current" : "Comparative"} ${c.from} to ${c.to}: ${c.status.toUpperCase()}${c.reasons.length ? ` (${c.reasons.join("; ")})` : ""}`).join(" · ");

/** A statement as one table: line, then one money column per period (null shows "unavailable"). */
export function statementSection(s: FinStatement): Section {
  const cols = s.columns.map((c) => `${c.key === "current" ? "" : "Comparative "}${c.from} to ${c.to} [${c.status}]`);
  return {
    title: `${s.title} (${s.status})`, kind: "table", columns: ["Section", "Line", ...cols], money: s.columns.map((_, i) => i + 2),
    rows: s.rows.map((r) => [r.section ?? "", r.kind === "total" || r.kind === "subtotal" ? `= ${r.label}` : r.kind === "exception" ? `! ${r.label}` : r.label,
      ...r.amounts.map((a, i) => (s.columns[i]!.status === "unavailable" ? "unavailable" : r.kind === "note" && r.text && a === null ? r.text : a))]),
  };
}
function statementChecks(s: FinStatement): Check[] {
  return [
    { label: `${s.title}: ${s.status}`, ok: s.status !== "unavailable", blocking: false, detail: s.reasons.join("; ") || undefined },
    ...s.checks.map((c) => ({ label: `${c.label} (${c.column})`, ok: c.ok, blocking: false, ...(c.detail ? { detail: c.detail } : {}) })),
  ];
}
const q = (p: { from: string; to: string }) => `?from=${p.from}&to=${p.to}`;
const bundleData = (b: StatementBundle) => JSON.parse(JSON.stringify(b));

async function statementDraft(ctx: OpContext, i: StmtInput, pick: (b: StatementBundle) => FinStatement[], title: string): Promise<Draft> {
  const p = params(ctx, i);
  const b = await ctx.svc.reporting.fin.statements(ctx.tenant, ctx.book, p);
  const ss = pick(b);
  const main = ss[0]!;
  return {
    title: `${title} ${p.from} to ${p.to}: ${main.status}`,
    summary: `${main.status === "unavailable" ? "Unavailable" : main.status === "certified" ? "Certified" : "Preliminary"}. ${statusLine(main)}`
      + (b.mapping ? ` Mapping ${b.mapping.label}.` : ""),
    actions: [], checks: ss.flatMap(statementChecks), sections: ss.map(statementSection),
    notes: [...new Set(ss.flatMap((s) => s.exceptions.map((e) => `Exception (blocks certification): ${e}`)))],
    data: { ...bundleData(b), statements: Object.fromEntries(Object.entries(b.statements).filter(([, s]) => ss.includes(s))) },
    links: [["Open statements", `/statements${q(p)}`], ["Export CSV", `/statements/export${q(p)}&format=csv`]],
  };
}

export const financialStatements: OpDef<StmtInput> = {
  name: "financial_statements", title: "Financial statements", kind: "read", gate: "policy",
  description: "Mapped balance sheet, statement of profit and loss and notes for a period with its comparative, grouped by the statement mapping of the book's framework (Schedule III style). Each is labelled preliminary, certified (a certified close covers the period) or unavailable, with the reasons; unmapped accounts show as exception lines and block certification. Figures in paise. Never writes.",
  input: StmtInput,
  plan: (ctx, i) => statementDraft(ctx, i, (b) => [b.statements.balanceSheet, b.statements.profitAndLoss, b.statements.notes], "Financial statements"),
};
export const cashFlow: OpDef<StmtInput> = {
  name: "cash_flow", title: "Cash flow statement", kind: "read", gate: "policy",
  description: "Cash flow statement for a period with its comparative: indirect method from mapped accounts and non-cash adjustments, and the direct method where cash-account lines allow. Opening cash + net movement + FX effect = closing cash is checked; non-cash investing and financing transactions are excluded and listed. Labelled preliminary, certified or unavailable. Never writes.",
  input: StmtInput,
  plan: (ctx, i) => statementDraft(ctx, i, (b) => [b.statements.cashFlow], "Cash flow statement"),
};
export const equityStatement: OpDef<StmtInput> = {
  name: "equity_statement", title: "Statement of changes in equity", kind: "read", gate: "policy",
  description: "Statement of changes in equity for a period with its comparative: opening balance, profit, contributions, distributions and closing balance per equity line, tied to the balance sheet. Labelled preliminary, certified or unavailable. Never writes.",
  input: StmtInput,
  plan: (ctx, i) => statementDraft(ctx, i, (b) => [b.statements.equity], "Statement of changes in equity"),
};

const KpiInput = z.object({ ...PeriodIn, metrics: z.array(z.string().min(1)).optional().describe("metric ids, e.g. current_ratio, dso (default: the whole catalogue)") });
type KpiInput = z.infer<typeof KpiInput>;
const unitText = (u: string, v: string | null) => (v === null ? "unavailable" : u === "percent" ? `${v}%` : u === "days" ? `${v} days` : u === "months" ? `${v} months` : u === "paise" ? rs(BigInt(v)) : v);

export function kpiSection(r: KpiReport): Section {
  return { title: "KPIs", kind: "table", columns: ["Metric", "Version", `${r.periods[0]!.from} to ${r.periods[0]!.to}`, "Status", ...(r.periods[1] ? [`Comparative ${r.periods[1].from} to ${r.periods[1].to}`, "Status"] : []), "Owner", "Why"],
    rows: r.metrics.map((m) => [m.name, `v${m.version} (${m.definitionStatus})`, unitText(m.unit, m.columns[0]!.value), m.columns[0]!.status,
      ...(m.columns[1] ? [unitText(m.unit, m.columns[1].value), m.columns[1].status] : []), m.owner, [...m.columns[0]!.reasons, ...m.columns[0]!.notes].join("; ")]) };
}

export const kpis: OpDef<KpiInput> = {
  name: "kpis", title: "KPIs", kind: "read", gate: "policy",
  description: "Key metrics from the versioned catalogue (gross margin, operating margin, current and quick ratio, cash runway, DSO on credit sales, DPO on credit purchases, working capital, debt to equity) for a period and its comparative. One evaluator for report and export; a metric whose inputs are missing is unavailable with the reason, never 0; proxies are disclosed. Never writes.",
  input: KpiInput,
  async plan(ctx, i) {
    const p = params(ctx, i);
    const r = await ctx.svc.reporting.fin.kpis(ctx.tenant, ctx.book, { ...p, ids: i.metrics });
    const line = r.metrics.map((m) => `${m.name} ${unitText(m.unit, m.columns[0]!.value)}${m.columns[0]!.status === "unavailable" ? ` (${m.columns[0]!.reasons[0]})` : ""}`).join(" · ");
    return {
      title: `KPIs ${p.from} to ${p.to}`, summary: line, actions: [],
      checks: [{ label: `Period ${p.from} to ${p.to}: ${r.periodStatus[0]!.status}`, ok: r.periodStatus[0]!.status !== "unavailable", blocking: false, detail: r.periodStatus[0]!.reasons.join("; ") || undefined }],
      sections: [kpiSection(r)], data: JSON.parse(JSON.stringify(r)),
      notes: r.metrics.filter((m) => m.basis).map((m) => `${m.name}: ${m.basis}`),
      links: [["Open KPI panel", `/statements${q(p)}#kpis`]],
    };
  },
};

const DrillInput = z.object({ metric: z.string().min(1).describe("metric id, e.g. dso"), from: PeriodIn.from, to: PeriodIn.to });
export const kpiDrill: OpDef<z.infer<typeof DrillInput>> = {
  name: "kpi_drill", title: "KPI drill-down", kind: "read", gate: "policy",
  description: "The journals, account balances and open items behind one metric for a period; each input's items sum exactly to the input the metric used. Never writes.",
  input: DrillInput,
  async plan(ctx, i) {
    const p = period(ctx, i);
    const d = await ctx.svc.reporting.fin.kpiDrill(ctx.tenant, ctx.book, i.metric, p);
    const m = d.metric;
    const ties = Object.entries(d.totals).every(([, t]) => t.input === null || t.input === t.items);
    return {
      title: `${m.name} ${p.from} to ${p.to}: ${m.available ? unitText(m.unit, m.value) : "unavailable"}`,
      summary: m.available ? `${m.name} = ${unitText(m.unit, m.value)} (exact ${m.exact}). ${m.inputs.map((x) => `${x.label} ${x.value === null ? "unavailable" : rs(BigInt(x.value))}`).join(", ")}.` : `Unavailable: ${m.reasons.join("; ")}`,
      actions: [],
      checks: [{ label: "Drill-down items sum to each input", ok: ties, blocking: false }],
      sections: [
        { title: "Inputs", kind: "table", columns: ["Input", "Value", "Items total", "Basis"], money: [1, 2], rows: m.inputs.map((x) => [x.label, x.value ?? "unavailable", d.totals[x.name]!.items, x.basis ?? x.reason ?? ""]) },
        { title: "Items", kind: "table", columns: ["Input", "Reference", "Date", "Description", "Amount"], money: [4], rows: d.items.map((x) => [x.input, x.ref, x.txnDate ?? "", x.label, x.amount]) },
      ],
      data: JSON.parse(JSON.stringify(d)), notes: m.notes,
    };
  },
};

export const REPORT_OPERATIONS = [financialStatements, cashFlow, equityStatement, kpis, kpiDrill] as OpDef<any>[];
