/**
 * General Ledger module: the only writer of journals (design section 16.6).
 * Commands arrive from the API (people) or as PostingRequested / CorrectionRequested events
 * from other modules. Each Book is one event stream: `<tenant>/book/<bookId>`.
 */
import { journalIdForRequest, reversalIdForRequest, uuid, type Envelope, type EventData } from "@kuber/contracts";
import { ConcurrencyError, once, type EventStore, type MetaInput } from "@kuber/eventstore";
import type { TransactionSql } from "postgres";
import { DomainError, decide, emptyBook, evolve, verifyChain, type BookCommand, type BookState } from "./book.ts";
import { SEEDS } from "./seeds.ts";
import { SnapshotStore, approxBytes } from "./snapshot.ts";

export { DomainError, verifyChain, validateJournal, type BookCommand, type BookState, type JournalRecord } from "./book.ts";
export { JournalMap } from "./journals.ts";
export { BOOK_SNAPSHOT_SCHEMA, SnapshotStore } from "./snapshot.ts";
export { SEEDS } from "./seeds.ts";

export const bookStream = (tenantId: string, bookId: string) => `${tenantId}/book/${bookId}`;

export interface GlOptions {
  maxRetries?: number;
  /** Most books kept in memory (default 5000). */
  cacheEntries?: number;
  /** Approximate memory budget for cached book states (default KUBER_GL_CACHE_MB or 256 MB). */
  cacheBytes?: number;
  /** Take a durable snapshot once this many events follow the last one (default KUBER_SNAPSHOT_EVERY or 500; 0 disables). */
  snapshotEvery?: number;
}

interface CacheEntry { version: number; state: BookState; bytes: number; snapshotVersion: number }

const envInt = (name: string, dflt: number) => { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : dflt; };

export class GeneralLedger {
  /**
   * Book state cache (F10). A load is: cached state, else the latest durable snapshot, else empty;
   * then only the events after that version are read and folded. Book states are persistent
   * structures, so folding shares memory with the previous version and cached states are never
   * mutated. The cache is an LRU bounded by entries and approximate bytes. Safe across processes:
   * every write catches up from the store under the per-book lock.
   */
  private cache = new Map<string, CacheEntry>();
  private cachedBytes = 0;
  private maxRetries: number;
  private cacheEntries: number;
  private cacheBytes: number;
  private snapshotEvery: number;
  readonly snapshots: SnapshotStore;

  private inFlight = new Map<string, Promise<void>>();

  constructor(private store: EventStore, o: GlOptions = {}) {
    this.maxRetries = o.maxRetries ?? 5;
    this.cacheEntries = o.cacheEntries ?? 5000;
    this.cacheBytes = o.cacheBytes ?? envInt("KUBER_GL_CACHE_MB", 256) * 1024 * 1024;
    this.snapshotEvery = o.snapshotEvery ?? envInt("KUBER_SNAPSHOT_EVERY", 500);
    this.snapshots = new SnapshotStore(store);
  }

  private async load(tenantId: string, stream: string, tx: TransactionSql): Promise<CacheEntry> {
    let base = this.cache.get(stream);
    if (!base && this.snapshotEvery > 0) {
      const snap = await this.snapshots.load(tenantId, stream, tx);
      if (snap) base = { ...snap, bytes: approxBytes(snap.state), snapshotVersion: snap.version };
    }
    const from = base?.version ?? 0;
    const delta = await this.store.readStream(tenantId, stream, from, tx);
    if (!delta.length && base) return base;
    const state = delta.reduce(evolve, base?.state ?? emptyBook());
    return { version: from + delta.length, state, bytes: (base?.bytes ?? 2048) + delta.reduce((n, e) => n + eventBytes(e), 0),
      snapshotVersion: base?.snapshotVersion ?? 0 };
  }

  /** Keep the newest committed state; evict least recently used entries beyond the budget. */
  private remember(stream: string, e: CacheEntry) {
    const old = this.cache.get(stream);
    if (old && old.version > e.version) return;
    if (old) { this.cache.delete(stream); this.cachedBytes -= old.bytes; }
    if (e.bytes > this.cacheBytes) return;                             // too large to cache: load per use
    this.cache.set(stream, e);
    this.cachedBytes += e.bytes;
    while (this.cache.size > this.cacheEntries || this.cachedBytes > this.cacheBytes) {
      const [k, v] = this.cache.entries().next().value!;
      this.cache.delete(k); this.cachedBytes -= v.bytes;
    }
  }

  /**
   * Snapshot when enough events follow the last one. Runs after commit, outside the book lock and
   * off the request path (one at a time per book); `flushSnapshots` waits for them.
   */
  private maybeSnapshot(tenantId: string, stream: string, e: CacheEntry) {
    if (this.snapshotEvery <= 0 || e.version - e.snapshotVersion < this.snapshotEvery || this.inFlight.has(stream)) return;
    const p = this.snapshots.save(tenantId, stream, e.version, e.state).then(() => {
      // a failed save is retried after another `snapshotEvery` events, not on every write
      e.snapshotVersion = e.version;
      const cur = this.cache.get(stream);
      if (cur && cur.version >= e.version && cur.snapshotVersion < e.version) cur.snapshotVersion = e.version;
    }).finally(() => this.inFlight.delete(stream));
    this.inFlight.set(stream, p);
  }

  /** Wait for snapshot writes in progress (tests, graceful shutdown). */
  async flushSnapshots() { await Promise.all(this.inFlight.values()); }

  /** Cache statistics (for tests and metrics). */
  cacheStats() { return { entries: this.cache.size, bytes: this.cachedBytes, maxBytes: this.cacheBytes }; }

  async state(tenantId: string, bookId: string): Promise<BookState> {
    const stream = bookStream(tenantId, bookId);
    const e = await this.store.tenantTx(tenantId, (tx) => this.load(tenantId, stream, tx));
    this.remember(stream, e);                                           // committed data only: safe to keep
    this.maybeSnapshot(tenantId, stream, e);
    return e.state;
  }

  /**
   * Decide and append. A Book has one writer at a time: a transaction-scoped advisory lock on
   * the stream serialises writers (no retry storms on busy books), and the expected-version
   * check remains as a second guard in case anything bypasses the lock.
   */
  async execute(tenantId: string, bookId: string, cmd: BookCommand, meta: MetaInput): Promise<Envelope[]> {
    const stream = bookStream(tenantId, bookId);
    for (let attempt = 0; ; attempt++) {
      try {
        const { written, next } = await this.store.tenantTx(tenantId, async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${stream}, 0))`;
          const cur = await this.load(tenantId, stream, tx);
          const events = decide(cur.state, cmd, meta.principal);
          if (!events.length) return { written: [] as Envelope[], next: cur };
          const written = await this.store.append("gl", tenantId, { streamId: stream, expected: cur.version, events }, meta, tx);
          return { written, next: { ...cur, version: cur.version + written.length, state: written.reduce(evolve, cur.state),
            bytes: cur.bytes + written.reduce((n, e) => n + eventBytes(e), 0) } };
        });
        // only committed state reaches the cache, and never an older version than it already holds
        this.remember(stream, next);
        this.maybeSnapshot(tenantId, stream, next);
        return written;
      } catch (e) {
        if (!(e instanceof ConcurrencyError) || attempt >= this.maxRetries) throw e;
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
      }
    }
  }

  openBook(tenantId: string, bookId: string, entityId: string, entityType: string, principal: string) {
    const accounts = SEEDS[entityType];
    if (!accounts) throw new DomainError("bad_entity_type", `unknown entity type ${entityType}`);
    return this.execute(tenantId, bookId, { kind: "OpenBook", bookId, entityId, entityType, accounts }, { principal });
  }

  async verify(tenantId: string, bookId: string) {
    return verifyChain(await this.store.readStream(tenantId, bookStream(tenantId, bookId)));
  }

  /** Event handler: postings and corrections requested by other modules. */
  handler = async (env: Envelope): Promise<void> => {
    if (env.type !== "PostingRequested" && env.type !== "CorrectionRequested") return;
    await once(this.store, "gl", env, async () => {
      const tenant = env.meta.tenantId;
      const meta: MetaInput = { principal: env.meta.principal, correlationId: env.meta.correlationId, causationId: env.eventId,
        policyIds: env.meta.policyIds, commandId: env.meta.commandId };
      let bookId = "";
      let requestId = "";
      try {
        if (env.type === "PostingRequested") {
          const d = env.data as EventData<"PostingRequested">;
          bookId = d.bookId; requestId = d.requestId;
          await this.execute(tenant, d.bookId, {
            kind: "PostJournal", journalId: journalIdForRequest(tenant, d.requestId), txnDate: d.txnDate,
            narration: d.narration, voucherType: d.voucherType, lines: d.lines, provisional: d.provisional,
            source: { stream: d.sourceStream, eventId: env.eventId }, autonomy: d.autonomy, confidence: d.confidence,
          }, meta);
        } else {
          const d = env.data as EventData<"CorrectionRequested">;
          bookId = d.bookId; requestId = d.requestId;
          await this.execute(tenant, d.bookId, {
            kind: "CorrectJournal", journalId: d.journalId, fromAccount: d.fromAccount, toAccount: d.toAccount,
            reversalJournalId: reversalIdForRequest(tenant, d.requestId), newJournalId: journalIdForRequest(tenant, d.requestId),
          }, meta);
        }
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;          // infrastructure failure: let the bus retry
        await this.store.append("gl", tenant, {
          streamId: `${tenant}/gl-rejections/${bookId}`, expected: "any",
          events: [{ type: "PostingRejected", data: { bookId, requestId, reason: `${e.code}: ${e.message}`, source: env.streamId } }],
        }, meta);
      }
    });
  };
}

export const newJournalId = () => uuid();

/** Approximate memory an event adds to a folded book (see approxBytes). */
function eventBytes(e: Envelope): number {
  if (e.type !== "JournalPosted") return 300;
  const d = e.data as EventData<"JournalPosted">;
  return 400 + d.narration.length * 2 + d.lines.length * 220;
}
