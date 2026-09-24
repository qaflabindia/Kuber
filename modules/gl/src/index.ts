/**
 * General Ledger module: the only writer of journals (design section 16.6).
 * Commands arrive from the API (people) or as PostingRequested / CorrectionRequested events
 * from other modules. Each Book is one event stream: `<tenant>/book/<bookId>`.
 */
import { journalIdForRequest, reversalIdForRequest, uuid, type Envelope, type EventData } from "@kuber/contracts";
import type { TransactionSql } from "postgres";
import { ConcurrencyError, once, type EventStore, type MetaInput } from "@kuber/eventstore";
import { DomainError, decide, emptyBook, evolve, verifyChain, type BookCommand, type BookState } from "./book.ts";
import { SEEDS } from "./seeds.ts";

export { DomainError, verifyChain, validateJournal, type BookCommand, type BookState } from "./book.ts";
export { SEEDS } from "./seeds.ts";

/** A book inside `GeneralLedger.transact`: its state as of `version`, and a way to change it. */
export interface BookTx {
  tx: TransactionSql;
  state: BookState;
  version: number;
  execute(cmd: BookCommand, meta: MetaInput): Promise<Envelope[]>;
}

export const bookStream = (tenantId: string, bookId: string) => `${tenantId}/book/${bookId}`;

export class GeneralLedger {
  /**
   * Book state cache: under the per-book lock only events after the cached version are read and
   * folded, so a write costs O(new events), not O(book history). Safe across processes because
   * the delta read always catches up from the stored version. Persistent snapshots come later.
   */
  private cache = new Map<string, { version: number; state: BookState }>();
  constructor(private store: EventStore, private maxRetries = 5, private cacheSize = 5000) {}

  private async load(tenantId: string, stream: string, tx?: import("postgres").TransactionSql) {
    const hit = this.cache.get(stream);
    const delta = await this.store.readStream(tenantId, stream, hit?.version ?? 0, tx);
    const state = delta.reduce(evolve, hit?.state ?? emptyBook());
    const version = (hit?.version ?? 0) + delta.length;
    return { state, version };
  }

  private remember(stream: string, version: number, state: BookState) {
    this.cache.delete(stream);
    this.cache.set(stream, { version, state });
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
  }

  async state(tenantId: string, bookId: string): Promise<BookState> {
    return (await this.load(tenantId, bookStream(tenantId, bookId))).state;
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
        let final: { version: number; state: BookState } | null = null;
        const out = await this.store.tenantTx(tenantId, async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${stream}, 0))`;
          const loaded = await this.load(tenantId, stream, tx);
          const b: BookTx = {
            tx, state: loaded.state, version: loaded.version,
            execute: async (cmd, meta) => {
              const events = decide(b.state, cmd, meta.principal);
              if (!events.length) return [];
              const written = await this.store.append("gl", tenantId, { streamId: stream, expected: b.version, events }, meta, tx);
              b.state = written.reduce(evolve, b.state); b.version += written.length;
              return written;
            },
          };
          const r = await fn(b);
          final = { version: b.version, state: b.state };
          return r;
        });
        // only committed state reaches the cache, and never an older version than it already holds
        const f = final as { version: number; state: BookState } | null;
        if (f && (this.cache.get(stream)?.version ?? -1) < f.version) this.remember(stream, f.version, f.state);
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
          streamId: `${tenant}/gl-rejections/${bookId}`, expected: "any",
          events: [{ type: "PostingRejected", data: { bookId, requestId, reason: `${e.code}: ${e.message}`, source: env.streamId } }],
        }, meta);
      }
    });
  };
}

export const newJournalId = () => uuid();
