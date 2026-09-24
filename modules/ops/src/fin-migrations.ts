/**
 * Finance-control tables of the ops module.
 *
 *   plan_approvals  FIN-MDM-04: approvals recorded ahead of execution (who approved which hash);
 *                   'active' until executed ('used') or until the approver's authority changed
 *                   ('invalidated': the plan needs re-approval)
 *   incidents       FIN-OPS-02: the financial incident register. Title, description, containment
 *                   and notes are sealed (detail); books, periods, amounts, owner and status are
 *                   plain for filtering. Amounts are integer paise.
 */
import type { Migration } from "@kuber/eventstore";

const rls = (tables: string[]) => `
DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kuber_system_scope') THEN CREATE ROLE kuber_system_scope NOLOGIN; END IF;
  FOREACH t IN ARRAY ARRAY[${tables.map((t) => `'${t}'`).join(", ")}] LOOP
    EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE ops.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON ops.%I USING (tenant_id = current_setting('kuber.tenant', true)) WITH CHECK (tenant_id = current_setting('kuber.tenant', true))$p$, t);
    EXECUTE format($p$CREATE POLICY system_scope ON ops.%I TO kuber_system_scope USING (true) WITH CHECK (true)$p$, t);
  END LOOP;
END $$;`;

export const OPS_FIN_MIGRATIONS: Migration[] = [{
  id: "ops-fin-001-approvals-incidents",
  sql: `
CREATE TABLE ops.plan_approvals (
  tenant_id TEXT NOT NULL, plan_id TEXT NOT NULL, approver TEXT NOT NULL, book_id TEXT NOT NULL, hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','invalidated')),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(), invalidated_at TIMESTAMPTZ, invalidated_reason TEXT,
  PRIMARY KEY (tenant_id, plan_id, approver));
CREATE INDEX plan_approvals_active ON ops.plan_approvals (tenant_id, approver) WHERE status = 'active';
CREATE TABLE ops.incidents (
  tenant_id TEXT NOT NULL, incident_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','contained','closed')),
  owner TEXT NOT NULL, books TEXT[] NOT NULL, periods TEXT[] NOT NULL,
  possible_loss_paise BIGINT NOT NULL CHECK (possible_loss_paise >= 0), duplication BOOLEAN NOT NULL,
  corrections TEXT[] NOT NULL DEFAULT '{}', detail TEXT NOT NULL,
  reconciliation_ref TEXT, opened_by TEXT NOT NULL, opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_by TEXT, closed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, incident_id), CHECK (status <> 'closed' OR (reconciliation_ref IS NOT NULL AND closed_by IS NOT NULL AND closed_by <> owner)));
CREATE INDEX incidents_open ON ops.incidents (tenant_id, opened_at DESC) WHERE status <> 'closed';
` + rls(["plan_approvals", "incidents"]),
}];

export const incidentDetailCtx = (incidentId: string) => `ops.incidents.detail|${incidentId}`;
