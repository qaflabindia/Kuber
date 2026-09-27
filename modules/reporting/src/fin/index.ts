/**
 * Financial reporting service (FIN-RPT-01/02): mapped statements, the KPI catalogue, drill-down,
 * export and certification, computed from the reporting projection in one snapshot per request.
 */
import type { Sql, TransactionSql } from "postgres";
import { SqlLedgerData } from "./data.ts";
import { loadMappings, mappingFor, validateMapping, type StatementMapping } from "./mapping.ts";
import { definitionHash, drillMetric, evaluateMetric, loadMetrics, type MetricDef, type MetricResult } from "./metrics.ts";
import { computeStatements, type BookInfo, type Column, type OutputStatus, type Period, type StatementBundle } from "./statements.ts";
import { certifyMetricVersions, metricCertifications, type CertificationSource, type MetricCertRow } from "./certification.ts";
import { exportKpis, exportStatements, type ExportFile, type KpiExportRow } from "./export.ts";
import { priorYear, strictDate } from "./rational.ts";

export * from "./rational.ts";
export * from "./mapping.ts";
export * from "./data.ts";
export * from "./statements.ts";
export * from "./metrics.ts";
export * from "./certification.ts";
export * from "./export.ts";

export interface StatementParams { from: string; to: string; compareFrom?: string | null; compareTo?: string | null; comparative?: boolean }
export type BookInfoSource = (tenantId: string, bookId: string) => Promise<BookInfo | null>;
export type SnapshotRunner = <T>(tenantId: string, bookId: string, opts: { freshness?: "any" | "require" | "wait"; timeoutMs?: number },
  fn: (tx: TransactionSql, basis: { fresh: boolean; contiguous: boolean; lag: number; projectedSeq: number } & Record<string, unknown>) => Promise<T>) => Promise<T>;

export class FinReportError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
  get statusCode() { return this.status; }
}

export interface KpiRow extends KpiExportRow { current: MetricResult; comparative: MetricResult | null; basis?: string }
export interface KpiReport {
  tenantId: string; bookId: string; mapping: StatementBundle["mapping"]; periods: Period[];
  /** Certification status of each period (from the mapped statements). */
  periodStatus: Column[];
  metrics: KpiRow[]; basis?: unknown;
}

/** Validate a period request: strict calendar dates, from ≤ to, the comparative defaulting to the same span a year earlier. */
export function periodsOf(p: StatementParams): Period[] {
  const from = strictDate(p.from, "from"), to = strictDate(p.to, "to");
  if (from > to) throw new FinReportError("bad_period", `from (${from}) is after to (${to})`);
  const out: Period[] = [{ from, to }];
  if (p.comparative === false) return out;
  if (p.compareFrom || p.compareTo) {
    if (!p.compareFrom || !p.compareTo) throw new FinReportError("bad_period", "give both compareFrom and compareTo, or neither");
    const cf = strictDate(p.compareFrom, "compareFrom"), ct = strictDate(p.compareTo, "compareTo");
    if (cf > ct) throw new FinReportError("bad_period", `compareFrom (${cf}) is after compareTo (${ct})`);
    out.push({ from: cf, to: ct });
  } else out.push(priorYear(from, to));
  return out;
}

export class FinReports {
  readonly mappings: StatementMapping[];
  readonly metrics: MetricDef[];
  /** Book configuration (framework label, basis, fiscal year): set by the cell from the GL's authoritative book state. */
  bookInfo: BookInfoSource | null = null;

  constructor(private sql: Sql, private snapshot: SnapshotRunner, public certification: CertificationSource,
              opts: { mappings?: StatementMapping[]; metrics?: MetricDef[] } = {}) {
    this.mappings = opts.mappings ?? loadMappings();
    this.metrics = opts.metrics ?? loadMetrics(undefined, this.mappings);
  }

  private async book(tenantId: string, bookId: string): Promise<BookInfo> {
    const b = this.bookInfo ? await this.bookInfo(tenantId, bookId) : null;
    if (!b) throw new FinReportError("no_book", `book ${bookId} does not exist`, 404);
    return b;
  }

  mappingFor(framework: string) { return mappingFor(this.mappings, framework); }

  /** Add a mapping (e.g. an approved one after CA review); validated like the files. An approved mapping is preferred for its frameworks. */
  addMapping(m: StatementMapping) {
    const problems = validateMapping(m);
    if (problems.length) throw new FinReportError("bad_mapping", `mapping ${(m as { id?: string }).id}: ${problems.join("; ")}`);
    if (this.mappings.some((x) => x.id === m.id && x.version === m.version)) throw new FinReportError("bad_mapping", `mapping ${m.id} v${m.version} already exists`);
    this.mappings.unshift(m);
  }

  /** Every mapped statement for a period and its comparative, in one snapshot. */
  async statements(tenantId: string, bookId: string, p: StatementParams, opts: { freshness?: "any" | "require" | "wait"; timeoutMs?: number } = {}): Promise<StatementBundle> {
    const periods = periodsOf(p);
    const book = await this.book(tenantId, bookId);
    const certifications = await Promise.all(periods.map((x) => this.certification.certifiedFor(tenantId, bookId, x.to)));
    return this.snapshot(tenantId, bookId, opts, async (tx, basis) => {
      const data = new SqlLedgerData(tx, tenantId, bookId);
      const b = await computeStatements(data, { tenantId, bookId, book, mapping: this.mappingFor(book.framework), periods, certifications, freshness: basis });
      return { ...b, basis };
    });
  }

  /** Metric definitions with the certification of each version. */
  async catalogue() {
    const certs = await metricCertifications(this.sql);
    return this.metrics.map((m) => {
      const c = certs.get(`${m.id}@${m.version}`);
      return { ...m, definitionHash: definitionHash(m), status: c && c.definitionHash === definitionHash(m) ? "certified" as const : "draft" as const, certification: c ?? null };
    });
  }

  private def(id: string): MetricDef {
    const ms = this.metrics.filter((m) => m.id === id).sort((a, b) => b.version - a.version);
    if (!ms.length) throw new FinReportError("unknown_metric", `no metric ${id}; known: ${[...new Set(this.metrics.map((m) => m.id))].join(", ")}`, 404);
    return ms[0]!;
  }

  /** KPIs (latest version of each, or `ids`) for a period and its comparative, from one snapshot. */
  async kpis(tenantId: string, bookId: string, p: StatementParams & { ids?: string[] }, opts: { freshness?: "any" | "require" | "wait"; timeoutMs?: number } = {}): Promise<KpiReport> {
    const periods = periodsOf(p);
    const defs = (p.ids?.length ? [...new Set(p.ids)] : [...new Set(this.metrics.map((m) => m.id))]).map((id) => this.def(id));
    const book = await this.book(tenantId, bookId);
    const certs = await metricCertifications(this.sql);
    const certifications = await Promise.all(periods.map((x) => this.certification.certifiedFor(tenantId, bookId, x.to)));
    const mapping = this.mappingFor(book.framework);
    return this.snapshot(tenantId, bookId, opts, async (tx, basis) => {
      const data = new SqlLedgerData(tx, tenantId, bookId);
      const bundle = await computeStatements(data, { tenantId, bookId, book, mapping, periods, certifications, freshness: basis });
      const periodStatus = bundle.statements.balanceSheet.columns;
      const firstDate = await data.firstDate();
      const metrics: KpiRow[] = [];
      for (const m of defs) {
        const c = certs.get(`${m.id}@${m.version}`);
        const certified = !!c && c.definitionHash === definitionHash(m);
        const results = [];
        for (const per of periods) results.push(await evaluateMetric(data, m, { mapping, from: per.from, to: per.to, lag: basis.lag, firstDate }));
        const columns = results.map((r, i) => {
          const col = periodStatus[i]!;
          let status: OutputStatus = "preliminary";
          const reasons = [...r.reasons];
          if (!r.available) status = "unavailable";
          else {
            if (!certified) reasons.push(`${m.id} v${m.version} is a draft: its golden test has not been recorded as passing (design 8.4)`);
            if (col.status !== "certified") reasons.push(...col.reasons);
            status = certified && col.status === "certified" ? "certified" : "preliminary";
          }
          return { key: col.key, from: col.from, to: col.to, status, value: r.value, exact: r.exact, reasons, notes: r.notes };
        });
        metrics.push({ id: m.id, name: m.name, version: m.version, unit: m.unit, owner: m.owner, definitionStatus: certified ? "certified" : "draft",
          columns, current: results[0]!, comparative: results[1] ?? null, ...(m.basis ? { basis: m.basis } : {}) });
      }
      return { tenantId, bookId, mapping: bundle.mapping, periods, periodStatus, metrics, basis };
    });
  }

  /** The journals, balances or open items behind a metric; each input's items sum to it. */
  async kpiDrill(tenantId: string, bookId: string, id: string, p: { from: string; to: string }, opts: { freshness?: "any" | "require" | "wait"; timeoutMs?: number } = {}) {
    const [period] = periodsOf({ ...p, comparative: false });
    const m = this.def(id);
    const book = await this.book(tenantId, bookId);
    return this.snapshot(tenantId, bookId, opts, async (tx, basis) => {
      const data = new SqlLedgerData(tx, tenantId, bookId);
      const d = await drillMetric(data, m, { mapping: this.mappingFor(book.framework), from: period!.from, to: period!.to, lag: basis.lag, firstDate: await data.firstDate() });
      return { ...d, basis };
    });
  }

  exportStatements(b: StatementBundle, format: "csv" | "json"): ExportFile { return exportStatements(b, format); }
  exportKpis(r: KpiReport, format: "csv" | "json"): ExportFile {
    return exportKpis({ ...r, metrics: r.metrics.map((m) => ({ id: m.id, name: m.name, version: m.version, unit: m.unit, owner: m.owner, definitionStatus: m.definitionStatus, columns: m.columns })) } as never, format);
  }

  /** Run every metric's golden test and record passing versions (design 8.4). */
  certifyMetricVersions(by: string) { return certifyMetricVersions(this.sql, this.metrics, this.mappings, by); }
  metricCertifications(): Promise<Map<string, MetricCertRow>> { return metricCertifications(this.sql); }
}
