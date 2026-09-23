/**
 * PostgreSQL event store.
 *
 * - Optimistic concurrency per stream: append states the version it expects; a mismatch
 *   (or a concurrent writer winning the UNIQUE(stream_id, stream_version) race) raises
 *   ConcurrencyError and nothing is written.
 * - Transactional outbox: every appended event gets an outbox row in the same transaction,
 *   so an event is published if and only if it was committed.
 * - Module ownership: a module may append only the event types it owns.
 * - Tenant isolation: every tenant operation runs with kuber.tenant set; RLS does the rest.
 */
import type { Sql, TransactionSql } from "postgres";
import {
  OWNER, SCHEMA_VERSION, subjectFor, uuid, validateEvent,
  type Envelope, type EventData, type EventType, type Meta,
} from "@kuber/contracts";

export type Expected = number | "no_stream" | "any";
export type ModuleName = "gl" | "channels" | "agent";

export interface NewEvent<T extends EventType = EventType> { type: T; data: EventData<T> }
export interface AppendRequest { streamId: string; expected: Expected; events: NewEvent[] }
export type MetaInput = Omit<Meta, "tenantId" | "cellId" | "occurredAt" | "correlationId"> &
  Partial<Pick<Meta, "correlationId" | "occurredAt">>;

export class ConcurrencyError extends Error {
  constructor(public streamId: string, public expected: Expected, public actual: number) {
    super(`stream ${streamId}: expected version ${expected}, found ${actual}`);
  }
}

export class EventStore {
  constructor(private sql: Sql, private cellId = "local") {}

  /** Run `fn` in a transaction scoped to one tenant. */
  async tenantTx<T>(tenantId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT set_config('kuber.tenant', ${tenantId}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  /** Run `fn` in a transaction that may see every tenant (relay, projections, cell operations). */
  async systemTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT set_config('kuber.role', 'system', true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  /** Append to one or more streams atomically. */
  async append(module: ModuleName, tenantId: string, requests: AppendRequest | AppendRequest[],
               meta: MetaInput, tx?: TransactionSql): Promise<Envelope[]> {
    const reqs = Array.isArray(requests) ? requests : [requests];
    const fullMeta: Meta = {
      correlationId: meta.correlationId ?? uuid(),
      occurredAt: meta.occurredAt ?? new Date().toISOString(),
      ...meta, tenantId, cellId: this.cellId,
    };
    for (const r of reqs) {
      if (!r.streamId.startsWith(`${tenantId}/`)) throw new Error(`stream ${r.streamId} is not in tenant ${tenantId}`);
      for (const e of r.events) {
        if (OWNER[e.type] !== module) throw new Error(`module ${module} may not append ${e.type} (owned by ${OWNER[e.type]})`);
        e.data = validateEvent(e.type, e.data) as never;
      }
    }
    const run = async (t: TransactionSql) => {
      const out: Envelope[] = [];
      for (const r of reqs) {
        const [{ v }] = await t<{ v: number }[]>`
          SELECT COALESCE(MAX(stream_version), 0)::int AS v FROM es.events WHERE stream_id = ${r.streamId}` as unknown as [{ v: number }];
        if (r.expected === "no_stream" && v !== 0) throw new ConcurrencyError(r.streamId, r.expected, v);
        if (typeof r.expected === "number" && v !== r.expected) throw new ConcurrencyError(r.streamId, r.expected, v);
        let version = v;
        for (const e of r.events) {
          version += 1;
          const eventId = uuid();
          let row;
          try {
            [row] = await t<{ global_position: string; recorded_at: Date }[]>`
              INSERT INTO es.events (event_id, tenant_id, stream_id, stream_version, type, schema_version, module, data, meta)
              VALUES (${eventId}, ${tenantId}, ${r.streamId}, ${version}, ${e.type}, ${SCHEMA_VERSION}, ${module},
                      ${t.json(e.data as never)}, ${t.json(fullMeta as never)})
              RETURNING global_position::text, recorded_at`;
          } catch (err: unknown) {
            if ((err as { code?: string }).code === "23505") throw new ConcurrencyError(r.streamId, r.expected, version - 1);
            throw err;
          }
          const env: Envelope = {
            eventId, globalPosition: row!.global_position, streamId: r.streamId, streamVersion: version,
            type: e.type, schemaVersion: SCHEMA_VERSION, data: e.data, meta: fullMeta,
            recordedAt: row!.recorded_at.toISOString(),
          };
          await t`INSERT INTO es.outbox (global_position, tenant_id, subject, envelope)
                  VALUES (${row!.global_position}, ${tenantId}, ${subjectFor(this.cellId, e.type, tenantId)}, ${t.json(env as never)})`;
          out.push(env);
        }
      }
      return out;
    };
    if (tx) return run(tx);
    return this.tenantTx(tenantId, run);
  }

  async readStream(tenantId: string, streamId: string, fromVersion = 0, tx?: TransactionSql): Promise<Envelope[]> {
    const q = async (t: TransactionSql | Sql) => t<Row[]>`
      SELECT event_id, global_position::text, stream_id, stream_version, type, schema_version, data, meta, recorded_at
      FROM es.events WHERE stream_id = ${streamId} AND stream_version > ${fromVersion} ORDER BY stream_version`;
    const rows = tx ? await q(tx) : await this.tenantTx(tenantId, (t) => q(t));
    return rows.map(toEnvelope);
  }

  async streamVersion(tenantId: string, streamId: string): Promise<number> {
    return this.tenantTx(tenantId, async (t) => {
      const [r] = await t<{ v: number }[]>`SELECT COALESCE(MAX(stream_version),0)::int AS v FROM es.events WHERE stream_id = ${streamId}`;
      return r!.v;
    });
  }

  /** Existing stream ids among the candidates (for idempotent ingestion). */
  async existingStreams(tenantId: string, streamIds: string[]): Promise<Set<string>> {
    if (!streamIds.length) return new Set();
    return this.tenantTx(tenantId, async (t) => {
      const rows = await t<{ stream_id: string }[]>`SELECT DISTINCT stream_id FROM es.events WHERE stream_id IN ${t(streamIds)}`;
      return new Set(rows.map((r) => r.stream_id));
    });
  }

  /** Read every event after a global position (system scope: rebuilds and catch-up). */
  async readAll(fromPosition = "0", limit = 1000): Promise<Envelope[]> {
    return this.systemTx(async (t) => (await t<Row[]>`
      SELECT event_id, global_position::text, stream_id, stream_version, type, schema_version, data, meta, recorded_at
      FROM es.events WHERE global_position > ${fromPosition} ORDER BY global_position LIMIT ${limit}`).map(toEnvelope));
  }
}

interface Row {
  event_id: string; global_position: string; stream_id: string; stream_version: number; type: string;
  schema_version: number; data: unknown; meta: Meta; recorded_at: Date;
}

const toEnvelope = (r: Row): Envelope => ({
  eventId: r.event_id, globalPosition: r.global_position, streamId: r.stream_id, streamVersion: r.stream_version,
  type: r.type as EventType, schemaVersion: r.schema_version, data: upcast(r.type, r.schema_version, r.data) as never,
  meta: r.meta, recordedAt: r.recorded_at.toISOString(),
});

/** Upcasters convert old event shapes to the current one on read. None needed at schema version 1. */
const UPCASTERS: Record<string, Record<number, (d: unknown) => unknown>> = {};
function upcast(type: string, version: number, data: unknown): unknown {
  let d = data;
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const f = UPCASTERS[type]?.[v];
    if (f) d = f(d);
  }
  return d;
}

/** Process an event at most once per consumer. `fn` runs in the same transaction as the inbox record. */
export async function once<T>(store: EventStore, consumer: string, env: Envelope,
                              fn: (tx: TransactionSql) => Promise<T>): Promise<T | undefined> {
  return store.systemTx(async (tx) => {
    const ins = await tx`INSERT INTO es.inbox (consumer, event_id) VALUES (${consumer}, ${env.eventId})
                         ON CONFLICT DO NOTHING RETURNING event_id`;
    if (ins.length === 0) return undefined;
    await tx`SELECT set_config('kuber.tenant', ${env.meta.tenantId}, true)`;
    return fn(tx);
  });
}
