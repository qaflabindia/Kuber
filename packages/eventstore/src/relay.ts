/**
 * Outbox relay: publishes committed events to the broker in commit order.
 *
 * One relay per cell holds the leader lock (a PostgreSQL advisory lock), so ordering is
 * preserved. Rows are marked published only after the broker acknowledges; a crash in
 * between re-publishes, and the broker de-duplicates by event ID.
 *
 * It reads every tenant's outbox, so `sql` must connect as a role in kuber_system_scope.
 *
 * Routing: the outbox subject records the cell of the process that wrote the event
 * (`kuber.<cell>.<module>.<type>.<tenant>`). Operator tools write with their own cell id
 * (identity-cli: "cli", ops-cli: CELL_ID or "local"), and the broker's stream only captures
 * `kuber.<relay cell>.>`, so such a row had no responder and blocked the relay (and every
 * consumer behind it) indefinitely. With `cellId` set, the relay publishes every row under its
 * own cell: the event belongs to the database the relay drains, not to the process that wrote it.
 *
 * Health: a failing batch is retried (ordering forbids skipping a row), and the failure is kept
 * in health() so status endpoints and operators see a stuck relay instead of a silent log line.
 */
import type { Sql } from "postgres";
import type { Envelope } from "@kuber/contracts";

export type Publish = (subject: string, env: Envelope) => Promise<void>;

export interface RelayHealth {
  /** False while the last batch failed. */
  ok: boolean;
  consecutiveFailures: number;
  /** When the current run of failures began (ISO), or null. */
  failingSince: string | null;
  lastError: string | null;
  lastPublishedAt: string | null;
}

/** The subject under `cellId`: `kuber.<any>.<module>.<type>.<tenant>[.<lane>]` → `kuber.<cellId>....`. */
export function rehome(subject: string, cellId: string): string {
  const parts = subject.split(".");
  if (parts[0] !== "kuber" || parts.length < 5) throw new Error(`outbox subject not in the kuber.<cell>.<module>.<type>.<tenant> form: ${subject}`);
  parts[1] = cellId;
  return parts.join(".");
}

const LEADER_LOCK = 7337002;

export class OutboxRelay {
  private stopped = false;
  private state: RelayHealth = { ok: true, consecutiveFailures: 0, failingSince: null, lastError: null, lastPublishedAt: null };
  private cellId: string | undefined;
  constructor(private sql: Sql, private publish: Publish, private batch = 200, opts: { cellId?: string } = {}) {
    if (opts.cellId !== undefined && !/^[A-Za-z0-9_-]+$/.test(opts.cellId)) throw new Error(`cell id must be one subject token: ${opts.cellId}`);
    this.cellId = opts.cellId;
  }

  health(): RelayHealth { return { ...this.state }; }

  /** Publish one batch. Returns the number of events published. */
  async drainOnce(): Promise<number> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string; subject: string; envelope: Envelope }[]>`
        SELECT id::text AS id, subject, envelope FROM es.outbox
        WHERE published_at IS NULL ORDER BY es.outbox.id LIMIT ${this.batch} FOR UPDATE SKIP LOCKED`;
      // (ORDER BY the column, not the text alias: "10" sorts before "2", which published out of commit order.)
      for (const r of rows) await this.publish(this.cellId ? rehome(r.subject, this.cellId) : r.subject, r.envelope);
      if (rows.length) await tx`UPDATE es.outbox SET published_at = now() WHERE id IN ${tx(rows.map((r) => r.id))}`;
      return rows.length;
    }).then((n) => {
      if (n) this.state.lastPublishedAt = new Date().toISOString();
      this.state = { ...this.state, ok: true, consecutiveFailures: 0, failingSince: null };
      return n as number;
    }, (e: unknown) => {
      this.state = { ...this.state, ok: false, consecutiveFailures: this.state.consecutiveFailures + 1,
        failingSince: this.state.failingSince ?? new Date().toISOString(), lastError: e instanceof Error ? e.message : String(e) };
      throw e;
    });
  }

  /** Drain until the outbox is empty. */
  async drainAll(): Promise<number> {
    let total = 0;
    for (;;) { const n = await this.drainOnce(); total += n; if (n === 0) return total; }
  }

  /** Run as the cell's leader until stop(); followers wait for the lock. */
  async run(intervalMs = 100): Promise<void> {
    const reserved = await this.sql.reserve();
    try {
      for (;;) {
        if (this.stopped) return;
        const [r] = await reserved`SELECT pg_try_advisory_lock(${LEADER_LOCK}) AS ok`;
        if (r?.ok) break;
        await sleep(1000);
      }
      while (!this.stopped) {
        const n = await this.drainOnce().catch((e) => {
          // One line per failure run, then every 100th retry: a stuck relay is visible in health(), not by flooding logs.
          const k = this.state.consecutiveFailures;
          if (k === 1 || k % 100 === 0) console.error(`relay error (attempt ${k}, failing since ${this.state.failingSince})`, e);
          return -1;
        });
        // Back off while failing (up to 5 s); poll at intervalMs when idle.
        if (n === -1) await sleep(Math.min(5000, intervalMs * 2 ** Math.min(this.state.consecutiveFailures, 6)));
        else if (n === 0) await sleep(intervalMs);
      }
      await reserved`SELECT pg_advisory_unlock(${LEADER_LOCK})`;
    } finally {
      reserved.release();
    }
  }

  stop() { this.stopped = true; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
