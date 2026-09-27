/**
 * Certification (FIN-RPT-01/02).
 *
 * Statements: an output is "certified" only when a certified close covers its period end. The close
 * workflow (FIN-CLS, built separately) provides that through CertificationSource. Until it lands,
 * SnapshotCertificationSource treats a sealed reporting.snapshots row of kind "close" or "report"
 * for the book whose body names the period end (periodEnd, or params.periodEnd / asOf / to) as the
 * certification. The statements additionally check that nothing dated in the period was posted
 * after the snapshot's ledger position (statements.ts), so a back-dated journal withdraws it.
 *
 * Metric versions (design 8.4): a version is certified when its golden test passes; the pass is
 * recorded once in reporting.metric_certifications with the definition hash, so a changed formula
 * under the same version is refused rather than silently re-certified.
 */
import type { Sql } from "postgres";
import type { Certification } from "./statements.ts";
import { MemoryLedgerData, type LedgerFixture } from "./data.ts";
import { mappingFor, type StatementMapping } from "./mapping.ts";
import { definitionHash, evaluateMetric, loadFixture, type MetricDef } from "./metrics.ts";

export interface CertificationSource {
  /** The certification covering (tenant, book, period end), or null when the period is not certified. */
  certifiedFor(tenantId: string, bookId: string, periodEnd: string): Promise<Certification | null>;
}

/** Kinds of reporting.snapshots rows that certify a period (a close pack, a certified report). */
export const CERTIFYING_KINDS = ["close", "report"] as const;

interface SnapshotRow { snapshot_id: string; kind: string; seq: number; content_hash: string; body: string; taken_by: string; taken_at: Date }
export class SnapshotCertificationSource implements CertificationSource {
  constructor(
    private rows: (tenantId: string, bookId: string) => Promise<SnapshotRow[]>,
    private open: (tenantId: string, snapshotId: string, body: string) => Promise<string>,
  ) {}
  async certifiedFor(tenantId: string, bookId: string, periodEnd: string): Promise<Certification | null> {
    for (const r of await this.rows(tenantId, bookId)) {
      let body: Record<string, any>;
      try { body = JSON.parse(await this.open(tenantId, r.snapshot_id, r.body)); } catch { continue; }
      const pe = body.periodEnd ?? body.params?.periodEnd ?? body.params?.asOf ?? body.params?.to ?? null;
      if (pe !== periodEnd) continue;
      return { source: `reporting.snapshots/${r.kind}`, snapshotId: r.snapshot_id, kind: r.kind, seq: r.seq, periodEnd, contentHash: r.content_hash,
        takenBy: r.taken_by, takenAt: new Date(r.taken_at).toISOString() };
    }
    return null;
  }
}

export const METRIC_CERT_MIGRATION = {
  id: "reporting-006-metric-certifications",
  // Not tenant data: which metric definition versions passed their golden test (design 8.4).
  sql: `
CREATE TABLE reporting.metric_certifications (
  metric_id TEXT NOT NULL, version INT NOT NULL, definition_hash TEXT NOT NULL, test_ref TEXT NOT NULL,
  expected TEXT NOT NULL, actual TEXT NOT NULL, certified_by TEXT NOT NULL, certified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_id, version));`,
};

export interface MetricCertRow { metricId: string; version: number; definitionHash: string; testRef: string; expected: string; actual: string; certifiedBy: string; certifiedAt: string }
export interface MetricTestResult { id: string; version: number; expected: string; actual: string | null; passed: boolean; certified: boolean; problem?: string }

/** Run one metric's golden test (pure: the in-memory golden book). */
export async function runMetricTest(m: MetricDef, mappings: StatementMapping[]): Promise<{ actual: string | null; passed: boolean; reasons: string[] }> {
  const fx = loadFixture(m.test.fixture) as LedgerFixture & { framework?: string };
  const data = new MemoryLedgerData(fx);
  const r = await evaluateMetric(data, m, { mapping: mappingFor(mappings, fx.framework ?? "AS (ICAI)"), from: m.test.from, to: m.test.to, firstDate: await data.firstDate() });
  return { actual: r.value, passed: r.value === m.test.expected, reasons: r.reasons };
}

export async function metricCertifications(sql: Sql): Promise<Map<string, MetricCertRow>> {
  const rows = await sql<{ metric_id: string; version: number; definition_hash: string; test_ref: string; expected: string; actual: string; certified_by: string; certified_at: Date }[]>`
    SELECT metric_id, version, definition_hash, test_ref, expected, actual, certified_by, certified_at FROM reporting.metric_certifications`;
  return new Map(rows.map((r) => [`${r.metric_id}@${r.version}`, { metricId: r.metric_id, version: r.version, definitionHash: r.definition_hash, testRef: r.test_ref,
    expected: r.expected, actual: r.actual, certifiedBy: r.certified_by, certifiedAt: new Date(r.certified_at).toISOString() }]));
}

/** Run every metric's golden test; record each passing version once. A failing test or a changed definition certifies nothing. */
export async function certifyMetricVersions(sql: Sql, metrics: MetricDef[], mappings: StatementMapping[], by: string): Promise<MetricTestResult[]> {
  const out: MetricTestResult[] = [];
  for (const m of metrics) {
    const t = await runMetricTest(m, mappings);
    const hash = definitionHash(m);
    const [prior] = await sql<{ definition_hash: string }[]>`SELECT definition_hash FROM reporting.metric_certifications WHERE metric_id = ${m.id} AND version = ${m.version}`;
    if (prior && prior.definition_hash !== hash) {
      out.push({ id: m.id, version: m.version, expected: m.test.expected, actual: t.actual, passed: t.passed, certified: false,
        problem: `${m.id} v${m.version} was certified with a different definition; a changed formula needs a new version` });
      continue;
    }
    if (!t.passed) { out.push({ id: m.id, version: m.version, expected: m.test.expected, actual: t.actual, passed: false, certified: !!prior, problem: t.reasons.join("; ") || `expected ${m.test.expected}, got ${t.actual}` }); continue; }
    if (!prior) await sql`INSERT INTO reporting.metric_certifications (metric_id, version, definition_hash, test_ref, expected, actual, certified_by)
      VALUES (${m.id}, ${m.version}, ${hash}, ${`${m.test.fixture} ${m.test.from}..${m.test.to}`}, ${m.test.expected}, ${t.actual!}, ${by}) ON CONFLICT DO NOTHING`;
    out.push({ id: m.id, version: m.version, expected: m.test.expected, actual: t.actual, passed: true, certified: true });
  }
  return out;
}
