/**
 * Finance-control tables of the identity module (FIN-MDM-04, FIN-MDM-05, FIN-OPS-03). All
 * tenant-scoped with row-level security, like the rest of the schema. Free text (notes, reasons)
 * is sealed with the tenant's data key; amounts are integer paise.
 *
 *   authority_settings  whether the tenant's authority matrix (amount bands) is enforced
 *   authority_bands     tenant overrides of the POL-002 bands: action x book ('*' = every book) x role
 *   delegations         time-boxed, amount-capped grants of an approval authority from one member to another
 *   related_parties     conflict rules: a member may not approve plans that pay a flagged party
 *   access_reviews      dispositions of access-review items (latest per item; history in the identity stream)
 *   autonomy_switches   kill switch: autonomous posting (scope 'autonomy') or the model-driven copilot
 *                       (scope 'copilot', AGT-09) halted for the tenant ('*') or one book
 */
import type { Migration } from "@kuber/eventstore";

/** Row-level security for tables added after the schema's first migration (tenantRlsFor covers the whole schema once). */
export const rlsForTables = (schema: string, tables: string[]) => `
DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kuber_system_scope') THEN CREATE ROLE kuber_system_scope NOLOGIN; END IF;
  FOREACH t IN ARRAY ARRAY[${tables.map((t) => `'${t}'`).join(", ")}] LOOP
    EXECUTE format('ALTER TABLE ${schema}.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE ${schema}.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON ${schema}.%I USING (tenant_id = current_setting('kuber.tenant', true)) WITH CHECK (tenant_id = current_setting('kuber.tenant', true))$p$, t);
    EXECUTE format($p$CREATE POLICY system_scope ON ${schema}.%I TO kuber_system_scope USING (true) WITH CHECK (true)$p$, t);
  END LOOP;
END $$;`;

export const IDENTITY_FIN_MIGRATIONS: Migration[] = [{
  id: "identity-fin-001-authority-access-autonomy",
  sql: `
CREATE TABLE identity.authority_settings (
  tenant_id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT false,
  updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE identity.authority_bands (
  tenant_id TEXT NOT NULL, action TEXT NOT NULL, book_id TEXT NOT NULL DEFAULT '*', role TEXT NOT NULL,
  max_paise BIGINT CHECK (max_paise IS NULL OR max_paise >= 0),
  updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, action, book_id, role));
CREATE TABLE identity.delegations (
  tenant_id TEXT NOT NULL, delegation_id TEXT NOT NULL, grantor TEXT NOT NULL, grantee TEXT NOT NULL, action TEXT NOT NULL,
  books TEXT[], max_paise BIGINT NOT NULL CHECK (max_paise >= 0),
  valid_from TIMESTAMPTZ NOT NULL, valid_to TIMESTAMPTZ NOT NULL CHECK (valid_to > valid_from),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_by TEXT, revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, delegation_id), CHECK (grantor <> grantee));
CREATE INDEX delegations_grantee ON identity.delegations (tenant_id, grantee, action) WHERE status = 'active';
CREATE TABLE identity.related_parties (
  tenant_id TEXT NOT NULL, principal TEXT NOT NULL, party_id TEXT NOT NULL, note TEXT NOT NULL,
  flagged_by TEXT NOT NULL, flagged_at TIMESTAMPTZ NOT NULL DEFAULT now(), cleared_by TEXT, cleared_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, principal, party_id));
CREATE TABLE identity.access_reviews (
  tenant_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('appropriate','revoke','investigate','accepted')), note TEXT NOT NULL,
  reviewer TEXT NOT NULL, decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id));
CREATE TABLE identity.autonomy_switches (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL DEFAULT '*', halted BOOLEAN NOT NULL, reason TEXT NOT NULL,
  set_by TEXT NOT NULL, set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, book_id));
` + rlsForTables("identity", ["authority_settings", "authority_bands", "delegations", "related_parties", "access_reviews", "autonomy_switches"]),
}, {
  // AGT-09: the kill switch gets a scope. 'autonomy' (FIN-OPS-03, every existing row) halts autonomous
  // posting; 'copilot' halts the model-driven copilot (it falls back to rules and read-only answers).
  // The two are independent: either can be halted without the other.
  id: "identity-fin-002-switch-scope",
  sql: `
ALTER TABLE identity.autonomy_switches ADD COLUMN scope TEXT NOT NULL DEFAULT 'autonomy' CHECK (scope IN ('autonomy','copilot'));
ALTER TABLE identity.autonomy_switches DROP CONSTRAINT autonomy_switches_pkey;
ALTER TABLE identity.autonomy_switches ADD PRIMARY KEY (tenant_id, book_id, scope);
`,
}];

/** Contexts sealed identity finance-control columns are bound to (see SEALED_COLUMNS in the core). */
export const relatedPartyNoteCtx = (principal: string, partyId: string) => `identity.related_parties.note|${principal}|${partyId}`;
export const accessReviewNoteCtx = (itemId: string) => `identity.access_reviews.note|${itemId}`;
/** The autonomy scope keeps its original context, so reasons sealed before scopes existed still open. */
export const autonomyReasonCtx = (book: string, scope: string = "autonomy") =>
  scope === "autonomy" ? `identity.autonomy_switches.reason|${book}` : `identity.autonomy_switches.reason|${book}|${scope}`;
