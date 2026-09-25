/**
 * Finance operations checks run by operators (ops CLI) and the core.
 *
 *   autonomyErrors   FIN-OPS-03: reversals and corrections of journals the agent posted on its own
 *                    authority (autonomy L3/L4), per accounting period (month of the journal's date)
 *   compareCells     FIN-OPS-01: compare a restored database with its source, cell by cell: event
 *                    counts and positions, balances (reporting and evidence projections), open drafts,
 *                    open match reviews, open plans, certified snapshots and unclosed incidents, per tenant
 *
 * compareCells reads only plaintext index columns (ids, statuses, hashes, amounts in projections),
 * never sealed payloads, so it needs no keys, and it only reads: it never publishes to the bus.
 */
import postgres, { type Sql, type TransactionSql } from "postgres";
import type { EventData } from "@kuber/contracts";
import type { EventStore } from "@kuber/eventstore";

// ------------------------------------------------------------------ FIN-OPS-03 autonomous errors
export interface AutonomyErrorPeriod { period: string; posted: number; reversed: number; corrected: number; errorRate: number }

/** Per period (YYYY-MM of the journal's date): agent-posted journals, and how many were later reversed or corrected. */
export async function autonomyErrors(store: EventStore, tenant: string): Promise<AutonomyErrorPeriod[]> {
  const read = (types: string[]) => store.readEvents({ tenantId: tenant, types, limit: 1_000_000 });
  const agentJournals = new Map<string, string>();                 // journalId -> period
  const by = new Map<string, AutonomyErrorPeriod>();
  const at = (period: string) => by.get(period) ?? by.set(period, { period, posted: 0, reversed: 0, corrected: 0, errorRate: 0 }).get(period)!;
  for (const e of await read(["JournalPosted"])) {
    const d = e.data as EventData<"JournalPosted">;
    if (d.reverses || !(d.autonomy === "L3" || d.autonomy === "L4")) continue;
    const period = d.txnDate.slice(0, 7);
    agentJournals.set(d.journalId, period);
    at(period).posted++;
  }
  for (const e of await read(["JournalReversed"])) {
    const d = e.data as EventData<"JournalReversed">;
    const period = agentJournals.get(d.journalId);
    if (!period) continue;
    // CorrectJournal reverses with "reclassified to <account>"; anything else is a plain reversal.
    if (d.reason.startsWith("reclassified to")) at(period).corrected++; else at(period).reversed++;
  }
  return [...by.values()].map((p) => ({ ...p, errorRate: p.posted ? Math.round(((p.reversed + p.corrected) / p.posted) * 10_000) / 10_000 : 0 }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

// ------------------------------------------------------------------ FIN-OPS-01 restore comparison
export interface CellCheck { ok: boolean; source: number; restored: number; missing: string[]; extra: string[]; changed: string[] }
export interface TenantComparison { tenant: string; ok: boolean; checks: Record<string, CellCheck> }
export interface CellComparison {
  ok: boolean; source: string; restored: string; comparedAt: string; elapsedMs: number;
  tenants: TenantComparison[]; missingTenants: string[]; extraTenants: string[];
}

const MAX_LIST = 20;
/** The database name only: never print credentials. */
export const dbName = (url: string) => { try { return new URL(url).pathname.replace(/^\//, "") || url; } catch { return "(unparseable url)"; } };

/** Rows keyed by id, with a value that must match: what each check compares. */
type Cells = Map<string, string>;
const QUERIES: Record<string, (t: TransactionSql, tenant: string) => Promise<{ k: string; v: string }[]>> = {
  events: (t, tenant) => t`SELECT 'events' AS k, count(*)::text || '@' || COALESCE(max(global_position), 0)::text AS v FROM es.events WHERE tenant_id = ${tenant}`,
  balances: (t, tenant) => t`SELECT book_id || '|' || account_id AS k, SUM(net)::text AS v FROM reporting.daily WHERE tenant_id = ${tenant} GROUP BY 1 HAVING SUM(net) <> 0`,
  evidenceBalances: (t, tenant) => t`SELECT book_id || '|' || account_id AS k, balance::text AS v FROM evidence.balances WHERE tenant_id = ${tenant} AND balance <> 0`,
  openDrafts: (t, tenant) => t`SELECT draft_id AS k, book_id || '|' || status AS v FROM agent.drafts
    WHERE tenant_id = ${tenant} AND status IN ('queued','awaiting_approval','rejected_by_gl','approved')`,
  matchReviews: (t, tenant) => t`SELECT review_id AS k, book_id || '|' || status AS v FROM agent.match_reviews WHERE tenant_id = ${tenant} AND status = 'open'`,
  openPlans: (t, tenant) => t`SELECT plan_id AS k, book_id || '|' || hash AS v FROM ops.plans WHERE tenant_id = ${tenant} AND status = 'proposed'`,
  certifiedSnapshots: (t, tenant) => t`SELECT snapshot_id AS k, book_id || '|' || kind || '|' || seq::text || '|' || content_hash AS v FROM reporting.snapshots WHERE tenant_id = ${tenant}`,
  openIncidents: (t, tenant) => t`SELECT incident_id AS k, status AS v FROM ops.incidents WHERE tenant_id = ${tenant} AND status <> 'closed'`,
};

async function tenantsOf(sql: Sql): Promise<string[]> {
  return (await sql<{ tenant_id: string }[]>`SELECT DISTINCT tenant_id FROM es.events
    WHERE tenant_id NOT IN (SELECT tenant_id FROM keys.shredded) ORDER BY 1`).map((r) => r.tenant_id);
}

async function cellsOf(sql: Sql, tenant: string): Promise<Record<string, Cells>> {
  // Row-level security is forced even for the owner: read as the tenant.
  return sql.begin(async (t) => {
    await t`SELECT set_config('kuber.tenant', ${tenant}, true)`;
    const out: Record<string, Cells> = {};
    for (const [name, q] of Object.entries(QUERIES)) {
      try { out[name] = new Map((await q(t, tenant)).map((r) => [r.k, r.v])); }
      catch (e) { throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return out;
  }) as Promise<Record<string, Cells>>;
}

function diff(a: Cells, b: Cells): CellCheck {
  const missing = [...a.keys()].filter((k) => !b.has(k)).sort();
  const extra = [...b.keys()].filter((k) => !a.has(k)).sort();
  const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)).sort().map((k) => `${k}: ${a.get(k)} -> ${b.get(k)}`);
  return { ok: !missing.length && !extra.length && !changed.length, source: a.size, restored: b.size,
    missing: missing.slice(0, MAX_LIST), extra: extra.slice(0, MAX_LIST), changed: changed.slice(0, MAX_LIST) };
}

/**
 * Compare a restored database with its source (owner connection URLs). Both must be at rest for
 * an exact answer: compare against the backup's source only if nothing was written since, or
 * against a second restore of the same backup. Returns per-tenant, per-check differences.
 */
export async function compareCells(sourceUrl: string, restoredUrl: string): Promise<CellComparison> {
  const started = Date.now();
  const src = postgres(sourceUrl, { max: 1, onnotice: () => undefined }), dst = postgres(restoredUrl, { max: 1, onnotice: () => undefined });
  try {
    const [ts, td] = [await tenantsOf(src), await tenantsOf(dst)];
    const tenants: TenantComparison[] = [];
    for (const tenant of ts.filter((t) => td.includes(t))) {
      const [a, b] = [await cellsOf(src, tenant), await cellsOf(dst, tenant)];
      const checks = Object.fromEntries(Object.keys(QUERIES).map((name) => [name, diff(a[name]!, b[name]!)]));
      tenants.push({ tenant, ok: Object.values(checks).every((c) => c.ok), checks });
    }
    const missingTenants = ts.filter((t) => !td.includes(t)), extraTenants = td.filter((t) => !ts.includes(t));
    return { ok: tenants.every((t) => t.ok) && !missingTenants.length && !extraTenants.length, source: dbName(sourceUrl), restored: dbName(restoredUrl),
      comparedAt: new Date().toISOString(), elapsedMs: Date.now() - started, tenants, missingTenants, extraTenants };
  } finally { await src.end(); await dst.end(); }
}
