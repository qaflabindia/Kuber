/**
 * Operational lifecycle (F12, F15): dead letters, unprocessed-event gaps, projection rebuild and
 * consistency checks, outbox retention. Runs with the database OWNER connection (rebuild deletes
 * projection rows; the application roles cannot delete) next to a Cell for the module handlers.
 *
 * Rebuild is deterministic: the same events, in global order, through each projection's
 * side-effect-free `apply`; a projection's fingerprint (its rows, minus sealed and volatile
 * columns) is the same after a rebuild as after live processing, and after a second rebuild.
 */
import type { Sql } from "postgres";
import type { EventData } from "@kuber/contracts";
import { fingerprintProjection, rebuildProjection, unprocessedEvents, type DeadLetter, type Projection, type RebuildResult } from "@kuber/eventstore";
import type { Cell } from "./cell.ts";
import { pruneOutbox } from "./keys-admin.ts";

/**
 * Event types each consumer takes (keep in step with the subscriptions in cell.ts). Keyed by module
 * consumer, not by bus lane: partition lanes (<module>_p<n>) are transport only; inbox rows, dead
 * letters, gap checks and rebuilds all use the module name, so they are unaffected by the lane count.
 */
export const CONSUMER_INPUTS: Record<string, string[]> = {
  gl: ["PostingRequested", "CorrectionRequested", "ProvisionalConfirmed"],
  agent: ["TransactionExtracted", "BookOpened", "AccountAdded", "JournalPosted", "JournalReversed", "PostingRejected"],
  evidence: ["JournalPosted", "PeriodLocked"],
  reporting: ["BookOpened", "AccountAdded", "JournalPosted", "JournalConfirmed"],
};

export interface ConsistencyReport { projection: string; tenant: string; ok: boolean; problems: string[]; fingerprint: string }

export class OpsAdmin {
  private busRetentionMs: number;
  constructor(private owner: Sql, private cell: Cell, opts: { busRetentionMs?: number } = {}) {
    this.busRetentionMs = opts.busRetentionMs ?? 7 * 86_400_000;
  }

  get projections(): Record<string, Projection> {
    return { reporting: this.cell.reporting.projection, agent: this.cell.agent.projection, evidence: this.cell.evidence.projection };
  }

  private projection(name: string): Projection {
    const p = this.projections[name];
    if (!p) throw new Error(`unknown projection ${name}; one of ${Object.keys(this.projections).join(", ")}`);
    return p;
  }

  /** Tenants with events, excluding shredded ones. */
  async tenants(): Promise<string[]> {
    return (await this.owner<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id FROM es.events WHERE tenant_id NOT IN (SELECT tenant_id FROM keys.shredded) ORDER BY 1`).map((r) => r.tenant_id);
  }

  // ------------------------------------------------------------------ dead letters
  deadLetters(f: { status?: DeadLetter["status"] | "all"; consumer?: string; tenantId?: string } = {}) { return this.cell.deadLetters.list(f); }

  retry(id: string, by: string) { return this.cell.deadLetters.retry(id, this.cell.consumers, by); }

  /** Retry every open dead letter (optionally of one consumer/tenant), oldest event first. */
  async retryAll(by: string, f: { consumer?: string; tenantId?: string } = {}) {
    const out = [];
    for (const d of await this.deadLetters({ ...f, status: "open" })) out.push(await this.retry(d.id, by));
    return out;
  }

  discard(id: string, by: string, reason: string) { return this.cell.deadLetters.discard(id, by, reason); }

  /** Events each consumer has not processed, older than minAgeMs (in flight is not a gap). */
  async gaps(minAgeMs = 60_000, consumer?: string) {
    const out: Record<string, Awaited<ReturnType<typeof unprocessedEvents>>> = {};
    for (const [c, types] of Object.entries(CONSUMER_INPUTS)) {
      if (consumer && c !== consumer) continue;
      const rows = await unprocessedEvents(this.cell.store, c, types, minAgeMs);
      if (rows.length) out[c] = rows;
    }
    return out;
  }

  // ------------------------------------------------------------------ rebuild and checks
  /** Rebuild a projection for one tenant or all, then check it against the event store. */
  async rebuild(name: string, tenant?: string, onProgress?: (tenant: string, n: number) => void): Promise<(RebuildResult & { check: ConsistencyReport })[]> {
    const p = this.projection(name);
    const out = [];
    for (const t of tenant ? [tenant] : await this.tenants()) {
      const r = await rebuildProjection(this.owner, this.cell.store, p, t, (n) => onProgress?.(t, n));
      out.push({ ...r, check: await this.checkTenant(name, t) });
    }
    return out;
  }

  async check(name: string, tenant?: string): Promise<ConsistencyReport[]> {
    this.projection(name);
    const out = [];
    for (const t of tenant ? [tenant] : await this.tenants()) out.push(await this.checkTenant(name, t));
    return out;
  }

  /**
   * Compare a projection with what the event store says it must contain: exact balances per
   * account (reporting daily totals, evidence running balances), journal counts and contiguity,
   * and no unprocessed input events for the consumer.
   */
  private async checkTenant(name: string, tenant: string): Promise<ConsistencyReport> {
    const p = this.projection(name);
    const problems: string[] = [];
    const posted = await this.cell.store.readEvents({ tenantId: tenant, types: ["JournalPosted"], limit: 1_000_000 });
    const expected = new Map<string, bigint>();          // book|account -> balance
    const journals = new Map<string, Set<number>>();     // book -> seqs
    for (const e of posted) {
      const d = e.data as EventData<"JournalPosted">;
      for (const l of d.lines) expected.set(`${d.bookId}|${l.accountId}`, (expected.get(`${d.bookId}|${l.accountId}`) ?? 0n) + BigInt(l.amount));
      (journals.get(d.bookId) ?? journals.set(d.bookId, new Set()).get(d.bookId)!).add(d.seq);
    }
    const compare = (actual: Map<string, bigint>, what: string) => {
      for (const k of new Set([...expected.keys(), ...actual.keys()])) {
        const want = expected.get(k) ?? 0n, got = actual.get(k) ?? 0n;
        if (want !== got) problems.push(`${what} ${k}: ${got} in projection, ${want} from events`);
      }
    };
    const rows = <T>(q: (t: import("postgres").TransactionSql) => Promise<T>) => this.owner.begin(async (t) => {
      await t`SELECT set_config('kuber.tenant', ${tenant}, true)`; return q(t);
    }) as Promise<T>;
    if (name === "reporting") {
      const daily = await rows((t) => t<{ k: string; n: string }[]>`
        SELECT book_id || '|' || account_id AS k, SUM(net)::text AS n FROM reporting.daily WHERE tenant_id = ${tenant} GROUP BY 1`);
      compare(new Map(daily.map((r) => [r.k, BigInt(r.n)])), "balance");
      // Journals the GL confirmed (JournalConfirmed) must not still be shown as provisional.
      const confirmed = (await this.cell.store.readEvents({ tenantId: tenant, types: ["JournalConfirmed"], limit: 1_000_000 }))
        .map((e) => (e.data as EventData<"JournalConfirmed">).journalId);
      if (confirmed.length) {
        const [pv] = await rows((t) => t<{ n: number }[]>`
          SELECT count(DISTINCT journal_id)::int AS n FROM reporting.lines WHERE tenant_id = ${tenant} AND provisional AND journal_id IN ${t(confirmed)}`);
        if (pv!.n) problems.push(`${pv!.n} journal(s) confirmed by the GL still provisional in the projection`);
      }
      for (const [book, seqs] of journals) {
        const b = await this.cell.reporting.freshness(tenant, book);
        if (!b.fresh) problems.push(`book ${book}: projected ${b.projectedSeq} of ${b.ledgerSeq} journal(s)${b.contiguous ? "" : " with gaps"}`);
        if (seqs.size !== b.ledgerSeq) problems.push(`book ${book}: ${seqs.size} JournalPosted events but ledger position ${b.ledgerSeq}`);
      }
    } else if (name === "evidence") {
      const bal = await rows((t) => t<{ k: string; n: string }[]>`
        SELECT book_id || '|' || account_id AS k, balance::text AS n FROM evidence.balances WHERE tenant_id = ${tenant}`);
      // accounts whose balance returned to zero have a row with 0; drop zeros on both sides
      for (const [k, v] of [...expected]) if (v === 0n) expected.delete(k);
      compare(new Map(bal.map((r) => [r.k, BigInt(r.n)] as [string, bigint]).filter(([, v]) => v !== 0n)), "evidence balance");
      const [c] = await rows((t) => t<{ records: number; subjects: number }[]>`
        SELECT (SELECT count(*)::int FROM evidence.records WHERE tenant_id = ${tenant}) AS records,
               (SELECT count(*)::int FROM es.events WHERE tenant_id = ${tenant} AND type IN ('JournalPosted', 'PeriodLocked')) AS subjects`);
      if (c!.records < c!.subjects) problems.push(`${c!.subjects - c!.records} committed action(s) without an evidence record`);
    } else if (name === "agent") {
      const [c] = await rows((t) => t<{ n: number }[]>`SELECT count(*)::int AS n FROM agent.journal_index WHERE tenant_id = ${tenant}`);
      const ids = new Set(posted.map((e) => (e.data as EventData<"JournalPosted">).journalId));
      if (c!.n !== ids.size) problems.push(`journal index has ${c!.n} journal(s), events have ${ids.size}`);
    }
    const gaps = (await unprocessedEvents(this.cell.store, p.consumer, CONSUMER_INPUTS[p.consumer]!, 0)).filter((g) => g.tenant_id === tenant);
    for (const g of gaps) problems.push(`${g.n} ${g.type} event(s) not processed by ${p.consumer} (oldest at position ${g.oldest})`);
    return { projection: name, tenant, ok: problems.length === 0, problems, fingerprint: await fingerprintProjection(this.owner, p, tenant) };
  }

  // ------------------------------------------------------------------ storage verification
  /**
   * Link chains and digests of every stream (or one tenant's): from each stream's verified
   * checkpoint, or from the first event with `full`. Checkpoints of clean streams move forward
   * (written on the cell's system connection).
   */
  verify(opts: { full?: boolean; tenantId?: string } = {}) {
    return this.cell.store.verifyStorage({ deep: true, tenantId: opts.tenantId, incremental: !opts.full, record: true });
  }

  // ------------------------------------------------------------------ status
  pruneOutbox() { return pruneOutbox(this.owner, this.busRetentionMs); }

  async status() {
    const [o] = await this.owner<{ pending: number; oldest_s: number | null; published: number }[]>`
      SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
             extract(epoch FROM now() - min(e.recorded_at) FILTER (WHERE o.published_at IS NULL))::int AS oldest_s,
             count(*) FILTER (WHERE published_at IS NOT NULL)::int AS published
      FROM es.outbox o JOIN es.events e USING (global_position)`;
    const dead = await this.owner<{ consumer: string; n: number }[]>`
      SELECT consumer, count(*)::int AS n FROM es.dead_letters WHERE status = 'open' GROUP BY 1 ORDER BY 1`;
    const books = await this.owner<{ tenant_id: string; book: string }[]>`
      SELECT DISTINCT tenant_id, split_part(stream_id, '/book/', 2) AS book FROM es.events
      WHERE type = 'BookOpened' AND tenant_id NOT IN (SELECT tenant_id FROM keys.shredded) ORDER BY 1, 2`;
    const reports = [];
    for (const b of books) {
      const f = await this.cell.reporting.freshness(b.tenant_id, b.book);
      reports.push({ tenant: b.tenant_id, book: b.book, projectedSeq: f.projectedSeq, ledgerSeq: f.ledgerSeq, lag: f.lag, contiguous: f.contiguous });
    }
    return {
      outbox: { pending: o!.pending, oldestPendingSeconds: o!.oldest_s, publishedRetained: o!.published },
      deadLetters: Object.fromEntries(dead.map((d) => [d.consumer, d.n])),
      gaps: await this.gaps(),
      reports,
    };
  }
}
