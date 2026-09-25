/**
 * General Ledger module: the only writer of journals (design section 16.6).
 * Commands arrive from the API (people) or as PostingRequested / CorrectionRequested events
 * from other modules. Each Book is one event stream: `<tenant>/book/<bookId>`.
 */
import { GENESIS_HASH, journalIdForRequest, reversalIdForRequest, uuid, type Envelope, type EventData } from "@kuber/contracts";
import type { TransactionSql } from "postgres";
import { ConcurrencyError, once, type EventStore, type MetaInput } from "@kuber/eventstore";
import { DomainError, decide, emptyBook, evolve, verifyChain, type BookCommand, type BookState, type DecideContext } from "./book.ts";
import { SEEDS } from "./seeds.ts";
import { SnapshotStore, approxBytes } from "./snapshot.ts";

export { DomainError, verifyChain, validateJournal, checkEntity, type BookCommand, type BookState, type DecideContext, type JournalRecord } from "./book.ts";
export * from "./parties.ts";
export { JournalMap } from "./journals.ts";
export { BOOK_SNAPSHOT_SCHEMA, SnapshotStore } from "./snapshot.ts";
export { SEEDS } from "./seeds.ts";
export { assertBookCurrency, checkManualControl, checkSuspenseClearing, isSuspense, suspenseLines } from "./controls.ts";
export * as schedules from "./schedules.ts";

/** A book inside `GeneralLedger.transact`: its state as of `version`, and a way to change it. */
export interface BookTx {
  tx: TransactionSql;
  state: BookState;
  version: number;
  execute(cmd: BookCommand, meta: MetaInput): Promise<Envelope[]>;
}

export const bookStream = (tenantId: string, bookId: string) => `${tenantId}/book/${bookId}`;
/** Postings the GL refused (PostingRejected), per book: the durable "failed" state of the journal lifecycle. */
export const rejectionStream = (tenantId: string, bookId: string) => `${tenantId}/gl-rejections/${bookId}`;

export interface Rejection { requestId: string; reason: string; source: string | null; principal: string; at: string; eventId: string }

export interface GlOptions {
  maxRetries?: number;
  /** Most books kept in memory (default 5000). */
  cacheEntries?: number;
  /** Approximate memory budget for cached book states (default KUBER_GL_CACHE_MB or 256 MB). */
  cacheBytes?: number;
  /** Take a durable snapshot once this many events follow the last one (default KUBER_SNAPSHOT_EVERY or 500; 0 disables). */
  snapshotEvery?: number;
  /**
   * Legal entity of registered parties (the party master, FIN-MDM-01/03), read in the book's
   * transaction before a journal naming parties is decided. Without it, party entities are not checked.
   */
  partyEntities?: (tenantId: string, partyIds: string[], tx: TransactionSql) => Promise<ReadonlyMap<string, string>>;
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
  private partyEntities?: GlOptions["partyEntities"];
  readonly snapshots: SnapshotStore;

  private inFlight = new Map<string, Promise<void>>();

  constructor(private store: EventStore, o: GlOptions = {}) {
    this.maxRetries = o.maxRetries ?? 5;
    this.cacheEntries = o.cacheEntries ?? 5000;
    this.cacheBytes = o.cacheBytes ?? envInt("KUBER_GL_CACHE_MB", 256) * 1024 * 1024;
    this.snapshotEvery = o.snapshotEvery ?? envInt("KUBER_SNAPSHOT_EVERY", 500);
    this.snapshots = new SnapshotStore(store);
    this.partyEntities = o.partyEntities;
  }

  /** Facts from outside the book that `decide` needs for this command (FIN-MDM-01: party entities). */
  private async contextFor(tenantId: string, cmd: BookCommand, tx: TransactionSql): Promise<DecideContext> {
    if (!this.partyEntities || cmd.kind !== "PostJournal") return {};
    const ids = [...new Set(cmd.lines.map((l) => l.partyId).filter((p): p is string => !!p))];
    return ids.length ? { partyEntities: await this.partyEntities(tenantId, ids, tx) } : {};
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
    return this.transact(tenantId, bookId, (b) => b.execute(cmd, meta));
  }

  /**
   * One consistency boundary for work on a book (F03): `fn` runs in a single tenant transaction
   * holding the book lock, sees the book at `b.version`, and may execute several commands (each
   * decided against the state its predecessors produced). Everything it does, including the
   * caller's own rows written on `b.tx`, commits together or not at all. `fn` may be re-run after
   * a concurrency conflict, so it must not have effects outside the transaction.
   */
  async transact<T>(tenantId: string, bookId: string, fn: (b: BookTx) => Promise<T>): Promise<T> {
    const stream = bookStream(tenantId, bookId);
    for (let attempt = 0; ; attempt++) {
      try {
        let final: CacheEntry | null = null;
        const out = await this.store.tenantTx(tenantId, async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${stream}, 0))`;
          const loaded = await this.load(tenantId, stream, tx);
          let bytes = loaded.bytes;
          const b: BookTx = {
            tx, state: loaded.state, version: loaded.version,
            execute: async (cmd, meta) => {
              const events = decide(b.state, cmd, meta.principal, await this.contextFor(tenantId, cmd, tx));
              if (!events.length) return [];
              const written = await this.store.append("gl", tenantId, { streamId: stream, expected: b.version, events }, meta, tx);
              b.state = written.reduce(evolve, b.state); b.version += written.length;
              bytes += written.reduce((n, e) => n + eventBytes(e), 0);
              return written;
            },
          };
          const r = await fn(b);
          final = { ...loaded, version: b.version, state: b.state, bytes };
          return r;
        });
        // only committed state reaches the cache (remember never goes back to an older version)
        const f = final as CacheEntry | null;
        if (f) { this.remember(stream, f); this.maybeSnapshot(tenantId, stream, f); }
        return out;
      } catch (e) {
        if (!(e instanceof ConcurrencyError) || attempt >= this.maxRetries) throw e;
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
      }
    }
  }

  /**
   * Execute a client command at most once (F04). `commandId` is the client's idempotency key,
   * scoped by `scope` (the action); `request` is what the client asked for. A repeat with the same
   * request returns the first outcome without executing again; a repeat with a different request
   * throws CommandConflict. The record is written in the transaction that applies the command.
   */
  async executeOnce<R>(tenantId: string, bookId: string, idem: { scope: string; commandId: string; request: unknown },
                       cmd: BookCommand, meta: MetaInput, result: (written: Envelope[]) => R): Promise<{ result: R; replayed: boolean }> {
    const scope = `gl/${bookId}/${idem.scope}`;
    return this.transact(tenantId, bookId, async (b) => {
      const prior = await this.store.priorCommand(b.tx, tenantId, scope, idem.commandId, idem.request);
      if (prior) return { result: prior.result as R, replayed: true };
      const r = result(await b.execute(cmd, { ...meta, commandId: meta.commandId ?? idem.commandId }));
      await this.store.recordCommand(b.tx, tenantId, scope, idem.commandId, idem.request, r);
      return { result: r, replayed: false };
    });
  }

  /** Open a book from the entity type's seed chart. `config`: FIN-MDM-01 configuration (defaults otherwise). */
  openBook(tenantId: string, bookId: string, entityId: string, entityType: string, principal: string,
           config: Omit<Extract<BookCommand, { kind: "OpenBook" }>, "kind" | "bookId" | "entityId" | "entityType" | "accounts"> = {}) {
    const accounts = SEEDS[entityType];
    if (!accounts) throw new DomainError("bad_entity_type", `unknown entity type ${entityType}`);
    return this.execute(tenantId, bookId, { kind: "OpenBook", bookId, entityId, entityType, accounts, ...config }, { principal });
  }

  /**
   * Is the book intact? Returns null, or the first broken journal (or storage problem). Verifies
   * incrementally: from the stream's verified checkpoint, the storage link chain, each event's
   * digest and the journal hash chain (continuing from the last journal at the checkpoint); then
   * moves the checkpoint forward. `full` re-checks the whole history (see `keys verify --full`).
   */
  async verify(tenantId: string, bookId: string, opts: { full?: boolean } = {}): Promise<string | null> {
    return (await this.verifyDetail(tenantId, bookId, opts)).broken;
  }

  async verifyDetail(tenantId: string, bookId: string, opts: { full?: boolean } = {}) {
    const stream = bookStream(tenantId, bookId);
    let brokenJournal: string | null = null;
    const r = await this.store.verifyStream(tenantId, stream, {
      full: opts.full,
      check: async (events, from, tx) => {
        let prev = GENESIS_HASH;
        if (from > 0) {
          const last = await this.store.lastEventOfType(tenantId, stream, "JournalPosted", from, tx);
          if (last) prev = (last.data as EventData<"JournalPosted">).hash;
        }
        brokenJournal = verifyChain(events, prev);
        return brokenJournal ? [`journal ${brokenJournal}: hash chain broken`] : [];
      },
    });
    return { broken: brokenJournal ?? r.problems[0] ?? null, problems: r.problems, from: r.from, to: r.to, events: r.events, checkpointed: r.checkpointed };
  }

  /**
   * Record that a posting attempt was refused (FIN-GL-01): a manual journal refused at the API, or
   * an occurrence the scheduler could not post. Nothing reaches the book; the attempt stays visible
   * as "failed" with its reason. `requestId` is the caller's command id when it has one.
   */
  async recordRejection(tenantId: string, bookId: string, r: { requestId: string; reason: string; source?: string }, meta: MetaInput) {
    await this.store.append("gl", tenantId, { streamId: rejectionStream(tenantId, bookId), expected: "any",
      events: [{ type: "PostingRejected", data: { bookId, requestId: r.requestId, reason: r.reason.slice(0, 2000), ...(r.source ? { source: r.source } : {}) } }] }, meta);
  }

  /** Refused postings of a book, oldest first. */
  async rejections(tenantId: string, bookId: string): Promise<Rejection[]> {
    const events = await this.store.readStream(tenantId, rejectionStream(tenantId, bookId));
    return events.filter((e) => e.type === "PostingRejected").map((e) => {
      const d = e.data as EventData<"PostingRejected">;
      return { requestId: d.requestId, reason: d.reason, source: d.source ?? null, principal: e.meta.principal, at: e.recordedAt, eventId: e.eventId };
    });
  }

  /** Event handler: postings and corrections requested by other modules. */
  handler = async (env: Envelope): Promise<void> => {
    if (env.type !== "PostingRequested" && env.type !== "CorrectionRequested" && env.type !== "ProvisionalConfirmed") return;
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
        } else if (env.type === "ProvisionalConfirmed") {
          // the agent matched a statement line to a provisional journal: record it in the book
          const d = env.data as EventData<"ProvisionalConfirmed">;
          if (!d.bookId) return;                                   // pre-propagation event: see Agent.backfillConfirmations
          bookId = d.bookId; requestId = `confirm-${d.txnId}`;
          await this.execute(tenant, d.bookId, { kind: "ConfirmJournal", journalId: d.journalId, source: env.streamId, basis: d.basis }, meta);
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
          streamId: rejectionStream(tenant, bookId), expected: "any",
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
