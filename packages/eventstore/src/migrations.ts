import { KEYS_MIGRATION_SQL } from "@kuber/crypto";
/** Event store schema. Each module contributes its own migrations in its own schema. */
export interface Migration { id: string; sql: string }

/** NOLOGIN role whose members see every tenant's rows (relay, catch-up reads, key maintenance). */
export const SYSTEM_SCOPE_ROLE = "kuber_system_scope";

const TENANT_CHECK = "tenant_id = current_setting('kuber.tenant', true)";

/**
 * Rewrites every policy that still grants system scope by session setting into the role-scoped
 * form, in whichever schemas exist. Idempotent; module migrations applied before es-003 are covered.
 */
export const ROLE_SCOPED_POLICIES_SQL = `
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE qual LIKE '%kuber.role%' LOOP
    EXECUTE format($f$ALTER POLICY %I ON %I.%I USING (${TENANT_CHECK}) WITH CHECK (${TENANT_CHECK})$f$,
                   p.policyname, p.schemaname, p.tablename);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = p.schemaname AND tablename = p.tablename AND policyname = 'system_scope') THEN
      EXECUTE format('CREATE POLICY system_scope ON %I.%I TO ${SYSTEM_SCOPE_ROLE} USING (true) WITH CHECK (true)', p.schemaname, p.tablename);
    END IF;
  END LOOP;
END $$;`;

export const EVENTSTORE_MIGRATIONS: Migration[] = [
  {
    id: "es-001-events",
    sql: `
CREATE SCHEMA IF NOT EXISTS es;

CREATE TABLE es.events (
  global_position BIGSERIAL PRIMARY KEY,
  event_id        UUID NOT NULL UNIQUE,
  tenant_id       TEXT NOT NULL,
  stream_id       TEXT NOT NULL,
  stream_version  INTEGER NOT NULL CHECK (stream_version > 0),
  type            TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  module          TEXT NOT NULL,
  data            JSONB NOT NULL,
  meta            JSONB NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (stream_id, stream_version)
);
CREATE INDEX events_tenant_stream ON es.events (tenant_id, stream_id, stream_version);
CREATE INDEX events_type ON es.events (type, global_position);

CREATE TABLE es.outbox (
  id              BIGSERIAL PRIMARY KEY,
  global_position BIGINT NOT NULL REFERENCES es.events(global_position),
  tenant_id       TEXT NOT NULL,
  subject         TEXT NOT NULL,
  envelope        JSONB NOT NULL,
  published_at    TIMESTAMPTZ
);
CREATE INDEX outbox_pending ON es.outbox (id) WHERE published_at IS NULL;

CREATE TABLE es.inbox (
  consumer     TEXT NOT NULL,
  event_id     UUID NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE es.snapshots (
  stream_id      TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  state          JSONB NOT NULL,
  taken_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Events are facts: no updates, no deletes.
CREATE FUNCTION es.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'es.events is append-only'; END $$;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON es.events
  FOR EACH ROW EXECUTE FUNCTION es.reject_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON es.events
  FOR EACH STATEMENT EXECUTE FUNCTION es.reject_change();

-- Tenant isolation inside a cell: a session sees only its tenant unless it runs as the system.
ALTER TABLE es.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE es.events FORCE ROW LEVEL SECURITY;
CREATE POLICY events_tenant ON es.events
  USING (current_setting('kuber.role', true) = 'system' OR tenant_id = current_setting('kuber.tenant', true))
  WITH CHECK (current_setting('kuber.role', true) = 'system' OR tenant_id = current_setting('kuber.tenant', true));
ALTER TABLE es.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE es.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant ON es.outbox
  USING (current_setting('kuber.role', true) = 'system' OR tenant_id = current_setting('kuber.tenant', true))
  WITH CHECK (current_setting('kuber.role', true) = 'system' OR tenant_id = current_setting('kuber.tenant', true));
`,
  },
  {
    id: "es-002-sealed-events",
    // Payloads are stored sealed ({"$c": token}); digest/link form a per-stream hash chain over
    // salted plaintext digests that stays verifiable without keys (after re-encryption or shredding).
    sql: `
ALTER TABLE es.events ADD COLUMN digest TEXT;
ALTER TABLE es.events ADD COLUMN link TEXT;

-- Events stay facts: never deleted, never changed in meaning. The only permitted update is a
-- maintenance reseal (legacy encryption, key rotation) run by the owner role with
-- kuber.maintenance = 'reseal': it may replace the ciphertext, set a missing digest and rebuild
-- links, and nothing else. The application role has no UPDATE privilege at all.
CREATE FUNCTION es.guard_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('kuber.maintenance', true) = 'reseal'
     AND NEW.global_position = OLD.global_position AND NEW.event_id = OLD.event_id
     AND NEW.tenant_id = OLD.tenant_id AND NEW.stream_id = OLD.stream_id AND NEW.stream_version = OLD.stream_version
     AND NEW.type = OLD.type AND NEW.schema_version = OLD.schema_version AND NEW.module = OLD.module
     AND NEW.meta = OLD.meta AND NEW.recorded_at IS NOT DISTINCT FROM OLD.recorded_at
     AND (OLD.digest IS NULL OR NEW.digest = OLD.digest) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'es.events is append-only';
END $$;
DROP TRIGGER events_append_only ON es.events;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON es.events
  FOR EACH ROW EXECUTE FUNCTION es.guard_change();
` + KEYS_MIGRATION_SQL + tenantRlsFor("keys"),
  },
  {
    id: "es-003-system-scope-role",
    // System scope used to be a session setting (kuber.role = 'system') that any connection could
    // set, so the application role could read every tenant. It is now membership of a database
    // role: tenant policies check only kuber.tenant, and a second policy, granted to
    // kuber_system_scope, opens every row. The tenant request role is never a member. The owner
    // running migrations becomes one so key maintenance keeps working without superuser.
    sql: `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_SCOPE_ROLE}') THEN CREATE ROLE ${SYSTEM_SCOPE_ROLE} NOLOGIN; END IF;
END $$;
GRANT ${SYSTEM_SCOPE_ROLE} TO CURRENT_USER;
` + ROLE_SCOPED_POLICIES_SQL,
  },
  {
    id: "es-004-command-results",
    // Idempotent commands (F04): a client-chosen command id, scoped to the tenant and the action,
    // with a keyed hash of the request and the outcome. Written in the same transaction as the
    // financial effect, so "recorded" and "applied" cannot disagree.
    sql: `
CREATE TABLE es.commands (
  tenant_id    TEXT NOT NULL,
  scope        TEXT NOT NULL,
  command_id   TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result       JSONB NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, command_id)
);
ALTER TABLE es.commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE es.commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON es.commands USING (${TENANT_CHECK}) WITH CHECK (${TENANT_CHECK});
CREATE POLICY system_scope ON es.commands TO ${SYSTEM_SCOPE_ROLE} USING (true) WITH CHECK (true);
`,
  },
];

/**
 * SQL that enables tenant row-level security on every table in a module schema (defence in depth).
 * Module migrations applied before es-003 created the old setting-based policies; es-003 and
 * ROLE_SCOPED_POLICIES_SQL rewrite those.
 */
export function tenantRlsFor(schema: string): string {
  return `
DO $$
DECLARE t record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_SCOPE_ROLE}') THEN CREATE ROLE ${SYSTEM_SCOPE_ROLE} NOLOGIN; END IF;
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = '${schema}' LOOP
    EXECUTE format('ALTER TABLE ${schema}.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE ${schema}.%I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON ${schema}.%I USING (${TENANT_CHECK}) WITH CHECK (${TENANT_CHECK})$p$, t.tablename);
    EXECUTE format($p$CREATE POLICY system_scope ON ${schema}.%I TO ${SYSTEM_SCOPE_ROLE} USING (true) WITH CHECK (true)$p$, t.tablename);
  END LOOP;
END $$;`;
}

/**
 * Grants for the application role. The application must connect as a role that is neither a
 * superuser nor BYPASSRLS, or row-level security does not apply. Migrations run as the owner.
 */
export const appGrants = (role: string, schemas: string[]) => schemas.map((s) => `
GRANT USAGE ON SCHEMA ${s} TO ${role};
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${s} TO ${role};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${role};`).join("\n") + `
REVOKE UPDATE ON es.events FROM ${role};
-- Key records: the application may create a tenant's first keys and read them; rotation,
-- re-wrapping and shredding are operator actions that run with the owner role.
REVOKE UPDATE ON keys.tenant_keys FROM ${role};
REVOKE INSERT, UPDATE ON keys.shredded FROM ${role};
GRANT SELECT, INSERT ON public.schema_migrations TO ${role};`;

/**
 * The system role: the same privileges as the application role (no event updates, no key
 * rotation), plus membership of kuber_system_scope so it sees every tenant. Used only by the
 * outbox relay and system reads, never to serve a tenant request.
 */
export const systemGrants = (role: string, schemas: string[]) => appGrants(role, schemas) + `
GRANT ${SYSTEM_SCOPE_ROLE} TO ${role};`;
