/**
 * Outbox relay: publishes committed events to the broker in commit order.
 *
 * One relay per cell holds the leader lock (a PostgreSQL advisory lock), so ordering is
 * preserved. Rows are marked published only after the broker acknowledges; a crash in
 * between re-publishes, and the broker de-duplicates by event ID.
 *
 * It reads every tenant's outbox, so `sql` must connect as a role in kuber_system_scope.
 */
import type { Sql } from "postgres";
import type { Envelope } from "@kuber/contracts";

export type Publish = (subject: string, env: Envelope) => Promise<void>;

const LEADER_LOCK = 7337002;

export class OutboxRelay {
  private stopped = false;
  constructor(private sql: Sql, private publish: Publish, private batch = 200) {}

  /** Publish one batch. Returns the number of events published. */
  async drainOnce(): Promise<number> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string; subject: string; envelope: Envelope }[]>`
        SELECT id::text AS id, subject, envelope FROM es.outbox
        WHERE published_at IS NULL ORDER BY es.outbox.id LIMIT ${this.batch} FOR UPDATE SKIP LOCKED`;
      // (ORDER BY the column, not the text alias: "10" sorts before "2", which published out of commit order.)
      for (const r of rows) await this.publish(r.subject, r.envelope);
      if (rows.length) await tx`UPDATE es.outbox SET published_at = now() WHERE id IN ${tx(rows.map((r) => r.id))}`;
      return rows.length;
    }) as Promise<number>;
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
        const n = await this.drainOnce().catch((e) => { console.error("relay error", e); return 0; });
        if (n === 0) await sleep(intervalMs);
      }
      await reserved`SELECT pg_advisory_unlock(${LEADER_LOCK})`;
    } finally {
      reserved.release();
    }
  }

  stop() { this.stopped = true; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
