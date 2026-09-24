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
 *   System scope (every tenant) is not a setting: it needs a connection whose role is a member
 *   of kuber_system_scope, which only `systemSql` has.
 * - Encryption at rest: payloads are sealed with the tenant's data key before they touch the
 *   database; the outbox and broker carry the same ciphertext (see sealing.ts).
 */
import type { Sql, TransactionSql } from "postgres";
import {
  OWNER, SCHEMA_VERSION, subjectFor, uuid, validateEvent,
  type Envelope, type EventData, type EventType, type Meta,
} from "@kuber/contracts";
import { CryptoError, type Keyring, type TenantKeys } from "@kuber/crypto";
import { GENESIS_LINK, isSealed, linkOf, openEventData, sealEvent, type LegacyPolicy } from "./sealing.ts";

export type Expected = number | "no_stream" | "any";
export type ModuleName = import("@kuber/contracts").Module;

export interface NewEvent<T extends EventType = EventType> { type: T; data: EventData<T> }
export interface AppendRequest { streamId: string; expected: Expected; events: NewEvent[] }
export type MetaInput = Omit<Meta, "tenantId" | "cellId" | "occurredAt" | "correlationId"> &
  Partial<Pick<Meta, "correlationId" | "occurredAt">>;

export class ConcurrencyError extends Error {
  constructor(public streamId: string, public expected: Expected, public actual: number) {
    super(`stream ${streamId}: expected version ${expected}, found ${actual}`);
  }
}

export interface StoreCrypto { keyring: Keyring; legacy?: LegacyPolicy }

export class EventStore {
  /**
   * `crypto` is required in every deployed cell; `null` (plaintext) exists only for the event
   * store's own unit tests and is refused by Cell.start.
   * `systemSql` connects as a role in kuber_system_scope; it defaults to `sql`, which is right only
   * when `sql` itself is such a role (the owner, in admin tools).
   */
  constructor(private sql: Sql, private cellId = "local", readonly crypto: StoreCrypto | null = null,
              private systemSql: Sql = sql) {}

  /** The tenant's keys (for modules that seal their own columns). */
  async keys(tenantId: string): Promise<TenantKeys> {
    if (!this.crypto) throw new CryptoError("no_key", "this event store has no keyring");
    return this.crypto.keyring.forTenant(tenantId);
  }

  /** Run `fn` in a transaction scoped to one tenant. */
  async tenantTx<T>(tenantId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    try {
      return await (this.sql.begin(async (tx) => {
        await tx`SELECT set_config('kuber.tenant', ${tenantId}, true)`;
        return fn(tx);
      }) as Promise<T>);
    } catch (e) {
      // A write into another tenant's rows is a bug or an attack, never a normal outcome: record it.
      const err = e as { code?: string; message?: string };
      if (err.code === "42501" && /row-level security/.test(err.message ?? "")) {
        const table = /for table "([^"]+)"/.exec(err.message!)?.[1];   // PostgreSQL names the table, not its schema
        console.error(JSON.stringify({ security: "rls_denied", cell: this.cellId, tenant: tenantId, table, message: err.message }));
      }
      throw e;
    }
  }

  /** Run `fn` in a transaction that may see every tenant (catch-up reads, storage checks), on the system connection. */
  async systemTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return this.systemSql.begin(fn) as Promise<T>;
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
    const keys = this.crypto ? await this.crypto.keyring.forTenant(tenantId) : null;
    const run = async (t: TransactionSql) => {
      const out: Envelope[] = [];
      for (const r of reqs) {
        const [{ v, link: lastLink }] = await t<{ v: number; link: string | null }[]>`
          SELECT COALESCE(MAX(stream_version), 0)::int AS v,
                 (SELECT link FROM es.events WHERE stream_id = ${r.streamId} ORDER BY stream_version DESC LIMIT 1) AS link
          FROM es.events WHERE stream_id = ${r.streamId}` as unknown as [{ v: number; link: string | null }];
        let prevLink = lastLink ?? GENESIS_LINK;
        if (r.expected === "no_stream" && v !== 0) throw new ConcurrencyError(r.streamId, r.expected, v);
        if (typeof r.expected === "number" && v !== r.expected) throw new ConcurrencyError(r.streamId, r.expected, v);
        let version = v;
        for (const e of r.events) {
          version += 1;
          const eventId = uuid();
          const sealed = keys ? sealEvent(keys, eventId, e.type, r.streamId, e.data) : null;
          const stored = sealed ? sealed.sealed : e.data;
          const link = sealed ? linkOf(prevLink, sealed.digest, r.streamId, version) : null;
          let row;
          try {
            [row] = await t<{ global_position: string; recorded_at: Date }[]>`
              INSERT INTO es.events (event_id, tenant_id, stream_id, stream_version, type, schema_version, module, data, meta, digest, link)
              VALUES (${eventId}, ${tenantId}, ${r.streamId}, ${version}, ${e.type}, ${SCHEMA_VERSION}, ${module},
                      ${t.json(stored as never)}, ${t.json(fullMeta as never)}, ${sealed?.digest ?? null}, ${link})
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
          // The outbox (and so the broker) carries the sealed payload, never the plaintext.
          await t`INSERT INTO es.outbox (global_position, tenant_id, subject, envelope)
                  VALUES (${row!.global_position}, ${tenantId}, ${subjectFor(this.cellId, e.type, tenantId)}, ${t.json({ ...env, data: stored } as never)})`;
          if (link) prevLink = link;
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
    return this.openRows(rows);
  }

  /** Decrypt stored rows; plaintext rows are refused unless the legacy policy allows them. */
  private async openRows(rows: Row[]): Promise<Envelope[]> {
    const keysBy = new Map<string, TenantKeys>();
    const out: Envelope[] = [];
    for (const r of rows) {
      let data = r.data;
      if (isSealed(data)) {
        if (!this.crypto) throw new CryptoError("no_key", "sealed event read without a keyring");
        const tenant = r.meta.tenantId;
        let k = keysBy.get(tenant);
        if (!k) { k = await this.crypto.keyring.forTenant(tenant); keysBy.set(tenant, k); }
        data = openEventData(k, r.event_id, r.type, r.stream_id, data).data;
      } else if (this.crypto && (this.crypto.legacy ?? "reject") === "reject") {
        throw new CryptoError("plaintext", `event ${r.event_id} is stored unencrypted; run: keys encrypt-legacy`);
      }
      out.push(toEnvelope({ ...r, data }));
    }
    return out;
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
      FROM es.events WHERE global_position > ${fromPosition} ORDER BY global_position LIMIT ${limit}`)).then((rows) => this.openRows(rows));
  }

  /**
   * Events by tenant, type and/or position, oldest first (rebuilds, dead-letter retry). Runs in
   * `tx` when given (which must see the rows), otherwise in system scope.
   */
  async readEvents(q: { tenantId?: string; types?: string[]; after?: string; positions?: string[]; limit?: number },
                   tx?: TransactionSql): Promise<Envelope[]> {
    const run = (t: TransactionSql) => t<Row[]>`
      SELECT event_id, global_position::text, stream_id, stream_version, type, schema_version, data, meta, recorded_at
      FROM es.events WHERE global_position > ${q.after ?? "0"}
        ${q.tenantId ? t`AND tenant_id = ${q.tenantId}` : t``}
        ${q.types ? t`AND type IN ${t(q.types.length ? q.types : [""])}` : t``}
        ${q.positions ? t`AND global_position IN ${t(q.positions.length ? q.positions : ["0"])}` : t``}
      ORDER BY global_position LIMIT ${q.limit ?? 1000}`;
    return this.openRows(tx ? await run(tx) : await this.systemTx(run));
  }

  /**
   * Storage integrity: recompute every stream's link chain from stored digests (no keys needed)
   * and, with `deep`, decrypt each event and recompute its digest. Returns problems found.
   */
  async verifyStorage(opts: { deep?: boolean; tenantId?: string } = {}): Promise<{ streams: number; events: number; problems: string[] }> {
    const rows = await this.systemTx((t) => t<(Row & { digest: string | null; link: string | null })[]>`
      SELECT event_id, global_position::text, stream_id, stream_version, type, schema_version, data, meta, recorded_at, digest, link
      FROM es.events ${opts.tenantId ? t`WHERE tenant_id = ${opts.tenantId}` : t``} ORDER BY stream_id, stream_version`);
    const problems: string[] = [];
    let prev = GENESIS_LINK, stream = "", streams = 0;
    const keysBy = new Map<string, TenantKeys | null>();
    for (const r of rows) {
      if (r.stream_id !== stream) { stream = r.stream_id; prev = GENESIS_LINK; streams++; }
      if (!r.digest || !r.link) { problems.push(`${r.stream_id}#${r.stream_version}: not sealed (legacy plaintext)`); continue; }
      if (linkOf(prev, r.digest, r.stream_id, r.stream_version) !== r.link) problems.push(`${r.stream_id}#${r.stream_version}: link chain broken`);
      prev = r.link;
      if (opts.deep && this.crypto && isSealed(r.data)) {
        const tenant = r.meta.tenantId;
        if (!keysBy.has(tenant)) keysBy.set(tenant, await this.crypto.keyring.forTenant(tenant).catch(() => null));
        const k = keysBy.get(tenant);
        if (!k) continue;                                               // shredded: structure only
        try {
          if (openEventData(k, r.event_id, r.type, r.stream_id, r.data).digest !== r.digest) problems.push(`${r.stream_id}#${r.stream_version}: digest mismatch`);
        } catch (e) { problems.push(`${r.stream_id}#${r.stream_version}: ${(e as Error).message}`); }
      }
    }
    return { streams, events: rows.length, problems };
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

/**
 * Process an event at most once per consumer. `fn` runs in the same transaction as the inbox
 * record, scoped to the event's tenant: a handler can never touch another tenant's rows.
 */
export async function once<T>(store: EventStore, consumer: string, env: Envelope,
                              fn: (tx: TransactionSql) => Promise<T>): Promise<T | undefined> {
  return store.tenantTx(env.meta.tenantId, async (tx) => {
    const ins = await tx`INSERT INTO es.inbox (consumer, event_id) VALUES (${consumer}, ${env.eventId})
                         ON CONFLICT DO NOTHING RETURNING event_id`;
    if (ins.length === 0) return undefined;
    return fn(tx);
  });
}
