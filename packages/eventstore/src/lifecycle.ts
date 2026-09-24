/**
 * Operational lifecycle of the event store (F12, F13):
 *
 * - Dead letters: a delivery that exhausts its retries is recorded in es.dead_letters with the
 *   event reference (tenant, event id, position, stream, type), consumer, attempts and error.
 *   Retry re-reads the event from PostgreSQL (the system of record), so it never depends on the
 *   broker still holding the message or on the data key the message was sealed with.
 * - Bus purges: es.bus_purges records when the broker was emptied, so the key lifecycle knows
 *   which published envelopes no longer exist anywhere but the outbox.
 * - Erasure write fence: no event can be appended for a crypto-shredded tenant.
 * - Projection rebuild: truncate a projection's rows for one tenant and replay the tenant's events
 *   from the event store through the projection's side-effect-free `apply`, in global order, in
 *   one transaction, with inbox rows rewritten so the live consumer stays exactly-once.
 */
import type { Sql, TransactionSql } from "postgres";
import { canonical, sha256, type Envelope } from "@kuber/contracts";
import { SYSTEM_SCOPE_ROLE, type Migration } from "./migrations.ts";
import type { EventStore } from "./store.ts";

const TENANT_CHECK = "tenant_id = current_setting('kuber.tenant', true)";

export const LIFECYCLE_MIGRATIONS: Migration[] = [{
  id: "es-ops-001-lifecycle",
  sql: `
CREATE TABLE es.dead_letters (
  id              BIGSERIAL PRIMARY KEY,
  consumer        TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  event_id        UUID NOT NULL,
  global_position BIGINT NOT NULL,
  stream_id       TEXT NOT NULL,
  type            TEXT NOT NULL,
  attempts        INT NOT NULL,
  error           TEXT NOT NULL,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','retried','discarded')),
  resolved_by     TEXT, resolved_at TIMESTAMPTZ, resolution TEXT);
CREATE UNIQUE INDEX dead_letters_open ON es.dead_letters (consumer, event_id) WHERE status = 'open';
ALTER TABLE es.dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE es.dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON es.dead_letters USING (${TENANT_CHECK}) WITH CHECK (${TENANT_CHECK});
CREATE POLICY system_scope ON es.dead_letters TO ${SYSTEM_SCOPE_ROLE} USING (true) WITH CHECK (true);

-- When the broker was purged: envelopes published before then exist only in the outbox.
CREATE TABLE es.bus_purges (purged_at TIMESTAMPTZ PRIMARY KEY DEFAULT now(), purged_by TEXT NOT NULL);

-- Erasure write fence: once a tenant is shredded nothing new is recorded for it, even by a
-- process that still holds its keys in cache.
CREATE FUNCTION es.reject_shredded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM keys.shredded WHERE tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'tenant % was crypto-shredded; nothing may be recorded for it', NEW.tenant_id USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER events_not_shredded BEFORE INSERT ON es.events FOR EACH ROW EXECUTE FUNCTION es.reject_shredded();
`,
}];

// ------------------------------------------------------------------ dead letters

export interface DeadLetter {
  id: string; consumer: string; tenant_id: string; event_id: string; global_position: string; stream_id: string; type: string;
  attempts: number; error: string; first_failed_at: Date; last_failed_at: Date; status: "open" | "retried" | "discarded";
  resolved_by: string | null; resolved_at: Date | null; resolution: string | null;
}

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 2000);

export class DeadLetterStore {
  constructor(private store: EventStore) {}

  /** Record (or refresh) an exhausted delivery. System scope: the envelope may be undecryptable. */
  async record(consumer: string, env: Pick<Envelope, "eventId" | "globalPosition" | "streamId" | "type" | "meta">, attempts: number, error: unknown) {
    await this.store.systemTx((t) => t`
      INSERT INTO es.dead_letters (consumer, tenant_id, event_id, global_position, stream_id, type, attempts, error)
      VALUES (${consumer}, ${env.meta.tenantId}, ${env.eventId}, ${env.globalPosition}, ${env.streamId}, ${env.type}, ${attempts}, ${errText(error)})
      ON CONFLICT (consumer, event_id) WHERE status = 'open'
      DO UPDATE SET attempts = es.dead_letters.attempts + EXCLUDED.attempts, error = EXCLUDED.error, last_failed_at = now()`);
  }

  async list(f: { status?: DeadLetter["status"] | "all"; consumer?: string; tenantId?: string } = {}): Promise<DeadLetter[]> {
    const status = f.status ?? "open";
    return this.store.systemTx((t) => t<DeadLetter[]>`
      SELECT id::text, consumer, tenant_id, event_id::text, global_position::text, stream_id, type, attempts, error,
             first_failed_at, last_failed_at, status, resolved_by, resolved_at, resolution
      FROM es.dead_letters WHERE true
        ${status === "all" ? t`` : t`AND status = ${status}`}
        ${f.consumer ? t`AND consumer = ${f.consumer}` : t``}
        ${f.tenantId ? t`AND tenant_id = ${f.tenantId}` : t``}
      ORDER BY global_position, id`);
  }

  /**
   * Re-run the consumer's handler on the event, read from the event store. Handlers are
   * idempotent (once()), so a retry after a partial success does nothing twice.
   */
  async retry(id: string, handlers: Record<string, (env: Envelope) => Promise<void>>, by: string): Promise<{ id: string; ok: boolean; error?: string }> {
    const [d] = await this.store.systemTx((t) => t<DeadLetter[]>`SELECT id::text, consumer, global_position::text, status FROM es.dead_letters WHERE id = ${id}`);
    if (!d) throw new Error(`no dead letter ${id}`);
    if (d.status !== "open") throw new Error(`dead letter ${id} is ${d.status}`);
    const handler = handlers[d.consumer];
    if (!handler) throw new Error(`no handler for consumer ${d.consumer}`);
    try {
      const [env] = await this.store.readEvents({ positions: [d.global_position], limit: 1 });
      if (!env) throw new Error(`event at position ${d.global_position} not found`);
      await handler(env);
    } catch (e) {
      await this.store.systemTx((t) => t`UPDATE es.dead_letters SET attempts = attempts + 1, error = ${errText(e)}, last_failed_at = now() WHERE id = ${id}`);
      return { id, ok: false, error: errText(e) };
    }
    await this.resolve(id, "retried", by, "handler succeeded on retry");
    return { id, ok: true };
  }

  async discard(id: string, by: string, reason: string) {
    if (!reason) throw new Error("a reason is required to discard a dead letter");
    const n = await this.resolve(id, "discarded", by, reason);
    if (!n) throw new Error(`no open dead letter ${id}`);
  }

  private async resolve(id: string, status: "retried" | "discarded", by: string, resolution: string) {
    return (await this.store.systemTx((t) => t`
      UPDATE es.dead_letters SET status = ${status}, resolved_by = ${by}, resolved_at = now(), resolution = ${resolution}
      WHERE id = ${id} AND status = 'open'`)).count;
  }
}

// ------------------------------------------------------------------ projection rebuild

/** A projection a module owns, described so it can be rebuilt from the event store. */
export interface Projection {
  name: string;
  /** Inbox consumer name the live handler uses in once(). */
  consumer: string;
  /** Tenant-scoped tables holding only this projection's rows (cleared for the tenant). */
  tables: string[];
  /** Event types replayed, in global order. */
  replay: string[];
  /**
   * Types whose inbox rows are reset and rewritten by the rebuild. Types that the live consumer
   * handles with side effects (appending events) are never listed: those projections are rebuilt
   * from the events the consumer wrote, not by re-running it.
   */
  inboxTypes: string[];
  /** Apply one event with no side effects outside the projection's tables. */
  apply(tx: TransactionSql, env: Envelope): Promise<void>;
  /** Canonical content of the tenant's rows (volatile and sealed columns excluded), for comparison. */
  fingerprint(tx: TransactionSql, tenantId: string): Promise<unknown>;
}

export interface RebuildResult { projection: string; tenant: string; events: number; before: string; after: string }

/**
 * Rebuild one projection for one tenant: clear, replay, compare. One transaction: readers see the
 * old rows until it commits; a concurrent live delivery blocks on the inbox row or is skipped, so
 * each event is applied exactly once. `sql` must be allowed to DELETE (the owner connection).
 */
export async function rebuildProjection(sql: Sql, store: EventStore, p: Projection, tenant: string,
                                        onProgress?: (n: number) => void, batch = 500): Promise<RebuildResult> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('kuber.tenant', ${tenant}, true)`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`rebuild:${p.name}:${tenant}`}, 0))`;
    const before = sha256(canonical(await p.fingerprint(tx, tenant)));
    for (const table of p.tables) await tx.unsafe(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenant]);
    if (p.inboxTypes.length) {
      await tx`DELETE FROM es.inbox i USING es.events e
               WHERE i.consumer = ${p.consumer} AND i.event_id = e.event_id AND e.tenant_id = ${tenant} AND e.type IN ${tx(p.inboxTypes)}`;
    }
    let after = "0", n = 0;
    for (;;) {
      const evs = await store.readEvents({ tenantId: tenant, types: p.replay, after, limit: batch }, tx);
      if (!evs.length) break;
      for (const env of evs) {
        if (p.inboxTypes.includes(env.type)) {
          const ins = await tx`INSERT INTO es.inbox (consumer, event_id) VALUES (${p.consumer}, ${env.eventId}) ON CONFLICT DO NOTHING RETURNING 1`;
          if (!ins.length) continue;
        }
        await p.apply(tx, env);
        n++;
      }
      after = evs[evs.length - 1]!.globalPosition;
      onProgress?.(n);
    }
    return { projection: p.name, tenant, events: n, before, after: sha256(canonical(await p.fingerprint(tx, tenant))) };
  }) as Promise<RebuildResult>;
}

/** Fingerprint of a projection as it stands (same hash rebuildProjection reports). */
export async function fingerprintProjection(sql: Sql, p: Projection, tenant: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('kuber.tenant', ${tenant}, true)`;
    return sha256(canonical(await p.fingerprint(tx, tenant)));
  }) as Promise<string>;
}

/**
 * Events a consumer has not processed (no inbox row), older than `minAgeMs`: the gap check a
 * maximum-sequence checkpoint cannot give. Excludes shredded tenants.
 */
export async function unprocessedEvents(store: EventStore, consumer: string, types: string[], minAgeMs = 0) {
  return store.systemTx((t) => t<{ tenant_id: string; type: string; n: number; oldest: string }[]>`
    SELECT e.tenant_id, e.type, count(*)::int AS n, min(e.global_position)::text AS oldest
    FROM es.events e
    WHERE e.type IN ${t(types)} AND e.recorded_at < now() - make_interval(secs => ${minAgeMs / 1000})
      AND NOT EXISTS (SELECT 1 FROM es.inbox i WHERE i.consumer = ${consumer} AND i.event_id = e.event_id)
      AND NOT EXISTS (SELECT 1 FROM keys.shredded s WHERE s.tenant_id = e.tenant_id)
    GROUP BY 1, 2 ORDER BY 1, 2`);
}
