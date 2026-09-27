/**
 * CSV and JSON export of statements and KPIs (FIN-RPT-01/02), each with a SHA-256 of its exact
 * bytes. An export is rendered from the very report object the API returns (never recomputed by a
 * second path), so the export equals the report; volatile fields (when it was computed) are left out
 * so the same ledger position always exports the same bytes and hash.
 */
import { canonical, sha256 } from "@kuber/contracts";
import type { StatementBundle } from "./statements.ts";

export interface ExportFile { format: "csv" | "json"; mediaType: string; filename: string; content: string; sha256: string }

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

/** RFC 4180 parsing (for tests and for re-import checks). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); out.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}

/** The report without volatile fields: what an export states. */
export function stable<T>(x: T): T {
  return JSON.parse(JSON.stringify(x, (k, v) => (k === "computedAt" || k === "generatedAt" ? undefined : v)));
}

const file = (format: "csv" | "json", name: string, content: string): ExportFile =>
  ({ format, mediaType: format === "csv" ? "text/csv; charset=utf-8" : "application/json", filename: `${name}.${format}`, content, sha256: sha256(content) });

export const STATEMENT_CSV_HEADER = ["statement", "group", "section", "key", "label", "kind", "current_paise", "comparative_paise", "text"];

export function exportStatements(b: StatementBundle, format: "csv" | "json"): ExportFile {
  const name = `statements-${b.bookId}-${b.periods[0]!.from}-${b.periods[0]!.to}`;
  if (format === "json") return file("json", name, canonical(stable(b)));
  const rows: unknown[][] = [STATEMENT_CSV_HEADER];
  rows.push(["meta", "", "", "mapping", b.mapping?.label ?? "none", "meta", "", "", b.mapping?.reviewNote ?? ""]);
  rows.push(["meta", "", "", "framework", b.book.framework, "meta", "", "", ""]);
  for (const s of Object.values(b.statements)) {
    rows.push([s.kind, "", "", "period", "Period", "meta", s.columns[0] ? `${s.columns[0].from}..${s.columns[0].to}` : "", s.columns[1] ? `${s.columns[1].from}..${s.columns[1].to}` : "", ""]);
    rows.push([s.kind, "", "", "status", "Status", "meta", s.columns[0]?.status ?? "", s.columns[1]?.status ?? "", s.columns.map((c) => `${c.key}: ${c.reasons.join("; ")}`).join(" | ")]);
    for (const r of s.rows) rows.push([s.kind, r.group ?? "", r.section ?? "", r.key, r.label, r.kind, r.amounts[0] ?? "", r.amounts[1] ?? "", r.text ?? ""]);
  }
  return file("csv", name, toCsv(rows));
}

export interface KpiExportRow {
  id: string; name: string; version: number; unit: string; owner: string; definitionStatus: string;
  columns: { key: string; from: string; to: string; status: string; value: string | null; exact: string | null; reasons: string[]; notes: string[] }[];
}
export const KPI_CSV_HEADER = ["id", "name", "version", "unit", "owner", "definition_status", "column", "from", "to", "status", "value", "exact", "reasons", "notes"];

export function exportKpis(report: { bookId: string; periods: { from: string; to: string }[]; metrics: KpiExportRow[] }, format: "csv" | "json"): ExportFile {
  const name = `kpis-${report.bookId}-${report.periods[0]!.from}-${report.periods[0]!.to}`;
  if (format === "json") return file("json", name, canonical(stable(report)));
  const rows: unknown[][] = [KPI_CSV_HEADER];
  for (const m of report.metrics) for (const c of m.columns)
    rows.push([m.id, m.name, m.version, m.unit, m.owner, m.definitionStatus, c.key, c.from, c.to, c.status, c.value ?? "", c.exact ?? "", c.reasons.join("; "), c.notes.join("; ")]);
  return file("csv", name, toCsv(rows));
}
