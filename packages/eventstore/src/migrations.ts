/** Event store schema. Each module contributes its own migrations in its own schema. */
export interface Migration { id: string; sql: string }

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
];

/** SQL that enables tenant row-level security on every table in a module schema (defence in depth). */
export const tenantRlsFor = (schema: string) => `
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = '${schema}' LOOP
    EXECUTE format('ALTER TABLE ${schema}.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE ${schema}.%I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON ${schema}.%I
      USING (current_setting('kuber.role', true) = 'system' OR tenant_id = current_setting('kuber.tenant', true))
      WITH CHECK (current_setting('kuber.role', true) = 'system' OR tenant_id = current_setting('kuber.tenant', true))$p$, t.tablename);
  END LOOP;
END $$;`;

/**
 * Grants for the application role. The application must connect as a role that is neither a
 * superuser nor BYPASSRLS, or row-level security does not apply. Migrations run as the owner.
 */
export const appGrants = (role: string, schemas: string[]) => schemas.map((s) => `
GRANT USAGE ON SCHEMA ${s} TO ${role};
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${s} TO ${role};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${role};`).join("\n") + `
REVOKE UPDATE ON es.events FROM ${role};
GRANT SELECT, INSERT ON public.schema_migrations TO ${role};`;
