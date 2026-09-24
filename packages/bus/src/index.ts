/**
 * Message bus. Production: NATS JetStream (one stream per cell, durable consumers per module and
 * partition). Tests and single-process runs: the in-memory bus with the same contract.
 *
 * Contract: at-least-once delivery, handlers must be idempotent (use `once()` from the event
 * store), a handler that throws is retried. Ordering (F09): each subscriber's deliveries are split
 * into `partitions` lanes by a stable hash of the tenant; within a lane delivery is sequential and
 * in publish order, so every tenant (and so every stream, which belongs to one tenant) is
 * processed in order, while a slow tenant holds up only the tenants that share its lane.
 */
import type { Envelope } from "@kuber/contracts";

export type Handler = (env: Envelope) => Promise<void>;

export interface Subscription { name: string; filter: string[]; handler: Handler }

export interface Bus {
  publish(subject: string, env: Envelope): Promise<void>;
  subscribe(sub: Subscription): Promise<void>;
  close(): Promise<void>;
}

/** Stable 32-bit FNV-1a hash. Changing it re-routes tenants: it is part of the wire contract. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** The lane (0..n-1) of a tenant. */
export const partitionOf = (tenantId: string, n: number) => (n <= 1 ? 0 : fnv1a32(tenantId) % n);

/** Partition count from KUBER_BUS_PARTITIONS (default 8; 1 = the unpartitioned legacy layout). */
export function busPartitions(env: Record<string, string | undefined> = process.env): number {
  const raw = env.KUBER_BUS_PARTITIONS;
  if (raw === undefined || raw === "") return 8;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1024) throw new Error(`KUBER_BUS_PARTITIONS must be an integer 1..1024, not ${raw}`);
  return n;
}

/** NATS-style subject match: `*` one token, `>` the rest. */
export function matches(pattern: string, subject: string): boolean {
  const p = pattern.split("."), s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return true;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

/**
 * In-memory bus. Each subscriber has one queue per partition; a queue is delivered sequentially
 * and in publish order, like a JetStream consumer with max_ack_pending = 1 per partition.
 * Failed deliveries are retried up to `maxRetries`.
 */
type Lane = { queue: Envelope[]; running: boolean };
export class MemoryBus implements Bus {
  private subs: (Subscription & { lanes: Lane[] })[] = [];
  private seen = new Set<string>();
  public deadLetters: { sub: string; env: Envelope; error: unknown }[] = [];
  constructor(private maxRetries = 3, readonly partitions = busPartitions()) {}

  async publish(subject: string, env: Envelope) {
    if (this.seen.has(env.eventId)) return;           // publish de-duplication by event ID
    this.seen.add(env.eventId);
    const p = partitionOf(env.meta.tenantId, this.partitions);
    for (const s of this.subs) if (s.filter.some((f) => matches(f, subject))) { const lane = s.lanes[p]!; lane.queue.push(env); void this.pump(s, lane); }
  }

  async subscribe(sub: Subscription) {
    this.subs.push({ ...sub, lanes: Array.from({ length: this.partitions }, () => ({ queue: [], running: false })) });
  }

  private async pump(s: MemoryBus["subs"][number], lane: Lane) {
    if (lane.running) return;
    lane.running = true;
    try {
      while (lane.queue.length) {
        const env = lane.queue[0]!;
        let attempt = 0;
        for (;;) {
          try { await s.handler(env); break; }
          catch (e) {
            if (++attempt > this.maxRetries) { this.deadLetters.push({ sub: s.name, env, error: e }); break; }
          }
        }
        lane.queue.shift();
      }
    } finally { lane.running = false; }
  }

  /** Resolve when every subscriber has drained every partition. */
  async idle(timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (this.subs.every((s) => s.lanes.every((l) => !l.running && l.queue.length === 0))) return;
      if (Date.now() > end) throw new Error("bus did not become idle");
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  async close() { this.subs = []; }
}

export { NatsBus, purgeKuberStreams, type NatsOptions } from "./nats.ts";
