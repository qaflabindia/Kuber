/**
 * Message bus. Production: NATS JetStream (one stream per cell, durable consumer per module).
 * Tests and single-process runs: the in-memory bus with the same contract.
 *
 * Contract: at-least-once delivery, ordered per subject, handlers must be idempotent
 * (use `once()` from the event store). A handler that throws is retried.
 */
import type { Envelope } from "@kuber/contracts";

export type Handler = (env: Envelope) => Promise<void>;

export interface Subscription { name: string; filter: string[]; handler: Handler }

export interface Bus {
  publish(subject: string, env: Envelope): Promise<void>;
  subscribe(sub: Subscription): Promise<void>;
  close(): Promise<void>;
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
 * In-memory bus. Delivery is sequential per subscriber and in publish order, like a
 * JetStream consumer with max_ack_pending = 1. Failed deliveries are retried up to `maxRetries`.
 */
export class MemoryBus implements Bus {
  private subs: (Subscription & { queue: Envelope[]; subjects: string[]; running: boolean })[] = [];
  private seen = new Set<string>();
  public deadLetters: { sub: string; env: Envelope; error: unknown }[] = [];
  constructor(private maxRetries = 3) {}

  async publish(subject: string, env: Envelope) {
    if (this.seen.has(env.eventId)) return;           // publish de-duplication by event ID
    this.seen.add(env.eventId);
    for (const s of this.subs) if (s.filter.some((f) => matches(f, subject))) { s.queue.push(env); void this.pump(s); }
  }

  async subscribe(sub: Subscription) { this.subs.push({ ...sub, queue: [], subjects: [], running: false }); }

  private async pump(s: MemoryBus["subs"][number]) {
    if (s.running) return;
    s.running = true;
    try {
      while (s.queue.length) {
        const env = s.queue[0]!;
        let attempt = 0;
        for (;;) {
          try { await s.handler(env); break; }
          catch (e) {
            if (++attempt > this.maxRetries) { this.deadLetters.push({ sub: s.name, env, error: e }); break; }
          }
        }
        s.queue.shift();
      }
    } finally { s.running = false; }
  }

  /** Resolve when every subscriber has drained its queue. */
  async idle(): Promise<void> {
    for (let i = 0; i < 10000; i++) {
      if (this.subs.every((s) => !s.running && s.queue.length === 0)) return;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error("bus did not become idle");
  }

  async close() { this.subs = []; }
}

export { NatsBus } from "./nats.ts";
