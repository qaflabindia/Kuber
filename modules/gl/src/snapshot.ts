/**
 * Durable Book snapshots (F10): the folded state at a stream version, so a cold load reads one
 * row plus the events after it instead of the whole history.
 *
 * - Sealed with the tenant's data key (the state holds narrations), bound to stream, version and
 *   schema, so a row cannot be replayed onto another stream or version.
 * - Versioned: `BOOK_SNAPSHOT_SCHEMA` is a manual format number plus a fingerprint of the fold
 *   code. Any change to `evolve` (or the format) yields a new schema; older rows are ignored and
 *   replaced, never interpreted by code that did not write them.
 * - Anchored: the snapshot records the hash-chain link of the event at its version; a load only
 *   uses it if the stored event still has that link (a restore, reseal or a different history
 *   makes it a miss).
 * - Disposable: any problem (missing key, schema, anchor, parse) means "no snapshot" and a full
 *   replay. Snapshots never decide a ledger result on their own.
 */
import type { TransactionSql } from "postgres";
import { sha256, type Account } from "@kuber/contracts";
import type { EventStore } from "@kuber/eventstore";
import { emptyBook, evolve, type BookState, type JournalRecord } from "./book.ts";
import { JournalMap } from "./journals.ts";

const FORMAT = 1;
export const BOOK_SNAPSHOT_SCHEMA = `book.${FORMAT}.${sha256(`${FORMAT}|${evolve.toString()}|${emptyBook.toString()}`).slice(0, 16)}`;

interface Stored {
  exists: boolean; bookId: string; entityId: string; accounts: Account[]; locks: BookState["locks"];
  seq: number; lastHash: string; journals: [string, JournalRecord][]; link: string | null;
}

const ctxOf = (stream: string, version: number, schema: string) => `es.snapshots|${stream}|${version}|${schema}`;

export function serialize(s: BookState, link: string | null): Stored {
  return { exists: s.exists, bookId: s.bookId, entityId: s.entityId, accounts: [...s.accounts.values()], locks: s.locks,
    seq: s.seq, lastHash: s.lastHash, journals: [...s.journals.entries()], link };
}

export function deserialize(d: Stored): BookState {
  return { exists: d.exists, bookId: d.bookId, entityId: d.entityId, accounts: new Map(d.accounts.map((a) => [a.accountId, a])),
    locks: d.locks, seq: d.seq, lastHash: d.lastHash, journals: JournalMap.from(d.journals) };
}

/** Rough in-memory size of a state, for the byte-bounded cache. */
export function approxBytes(s: BookState): number {
  let n = 2048 + s.accounts.size * 300;
  for (const j of s.journals.values()) n += 400 + j.narration.length * 2 + j.lines.length * 220;
  return n;
}

export class SnapshotStore {
  constructor(private store: EventStore, private schema = BOOK_SNAPSHOT_SCHEMA) {}

  /** Snapshots need the tenant keyring; a plaintext store (event-store unit tests) has none. */
  get enabled() { return this.store.crypto !== null; }

  async load(tenantId: string, stream: string, tx: TransactionSql): Promise<{ version: number; state: BookState } | null> {
    if (!this.enabled) return null;
    const [r] = await tx<{ stream_version: number; schema: string | null; state: { $c?: string }; link: string | null }[]>`
      SELECT s.stream_version, s.schema, s.state, e.link FROM es.snapshots s
      LEFT JOIN es.events e ON e.stream_id = s.stream_id AND e.stream_version = s.stream_version
      WHERE s.stream_id = ${stream}`;
    if (!r || r.schema !== this.schema || typeof r.state?.$c !== "string" || r.link === null) return null;
    try {
      const d = (await this.store.keys(tenantId)).openJson<Stored>(r.state.$c, ctxOf(stream, r.stream_version, this.schema));
      if (d.link !== r.link) return null;
      return { version: r.stream_version, state: deserialize(d) };
    } catch (e) {
      console.warn(JSON.stringify({ snapshot: "unusable", stream, error: (e as Error).message }));
      return null;
    }
  }

  /** Write (or replace with a newer) snapshot. Never throws: a failed snapshot only costs replay time. */
  async save(tenantId: string, stream: string, version: number, state: BookState): Promise<boolean> {
    if (!this.enabled || version <= 0) return false;
    try {
      const keys = await this.store.keys(tenantId);
      return await this.store.tenantTx(tenantId, async (tx) => {
        const [e] = await tx<{ link: string | null }[]>`SELECT link FROM es.events WHERE stream_id = ${stream} AND stream_version = ${version}`;
        if (!e?.link) return false;
        const sealed = { $c: keys.sealJson(serialize(state, e.link), ctxOf(stream, version, this.schema)) };
        const w = await tx`
          INSERT INTO es.snapshots (stream_id, tenant_id, stream_version, state, schema, taken_at)
          VALUES (${stream}, ${tenantId}, ${version}, ${tx.json(sealed as never)}, ${this.schema}, now())
          ON CONFLICT (stream_id) DO UPDATE SET stream_version = EXCLUDED.stream_version, state = EXCLUDED.state,
            schema = EXCLUDED.schema, taken_at = EXCLUDED.taken_at
          WHERE es.snapshots.stream_version < EXCLUDED.stream_version OR es.snapshots.schema IS DISTINCT FROM EXCLUDED.schema
          RETURNING 1`;
        return w.length > 0;
      });
    } catch (e) {
      console.warn(JSON.stringify({ snapshot: "save_failed", stream, version, error: (e as Error).message }));
      return false;
    }
  }
}
