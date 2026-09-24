/**
 * NATS JetStream bus. One stream per cell captures `kuber.<cell>.>`. Publishing sets
 * Nats-Msg-Id to the event ID so a relay retry inside the duplicate window is dropped by the server.
 *
 * Partitioning (F09). With P > 1 partitions (KUBER_BUS_PARTITIONS, default 8) the publisher
 * appends the tenant's lane as a last subject token:
 *
 *     kuber.<cell>.<module>.<Type>.<tenant>.<lane>      lane = fnv1a32(tenant) mod P
 *
 * and each module gets one durable pull consumer per lane (`<module>_p<lane>`) whose filters are
 * the module's filters plus `.<lane>`. max_ack_pending = 1 per consumer keeps every tenant (and
 * so every stream) in order; P lanes make independent progress, and replicas bound to the same
 * durables share them. The stream itself is unchanged (`kuber.<cell>.>` captures both layouts).
 *
 * P = 1 is the original layout (5-token subjects, one durable `<module>`), unchanged.
 *
 * Routing is versioned: the stream's metadata records P. Starting with a different P is refused
 * while any Kuber consumer still has pending or unacknowledged messages (a tenant would change
 * lanes with work in flight and could be processed out of order); once they are drained the new
 * P is recorded, consumers for lanes >= P are removed and the new lanes are created.
 *
 * Migration from the unpartitioned layout: when a legacy durable `<module>` exists, `subscribe`
 * first drains it through the handler (its backlog is older than any partitioned message), then
 * deletes it and starts the lane consumers. Stop every old-version process (in particular the
 * relay leader, which would keep publishing 5-token subjects) before starting the new version.
 */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager, type JsMsg } from "@nats-io/jetstream";
import type { Envelope } from "@kuber/contracts";
import { busPartitions, partitionOf, type Bus, type DeadLetterHook, type Subscription } from "./index.ts";

const DUPLICATE_WINDOW_NS = 10 * 60 * 1_000_000_000; // 10 minutes

export interface NatsOptions {
  streamName?: string; caFile?: string; retentionDays?: number; token?: string; partitions?: number;
  /** Deliveries per message before it is dead-lettered (JetStream max_deliver, per lane consumer). Default 10. */
  maxDeliver?: number;
  /** Records a message that failed its last delivery; the message is then terminated. */
  onDeadLetter?: DeadLetterHook;
}

const PARTITIONS_KEY = "kuber_partitions";

/** The partition-lane filter for a module filter: its subjects plus the lane token. */
export function laneFilter(filter: string, lane: number): string {
  if (filter.endsWith(">")) throw new Error(`filter ${filter} cannot be partitioned; name the tenant token with *`);
  return `${filter}.${lane}`;
}

/** tls:// servers require TLS; with a CA file the server certificate is verified against it. */
const tlsFor = (servers: string, caFile?: string) =>
  servers.startsWith("tls://") || caFile ? { tls: { ...(caFile ? { caFile } : {}) } } : {};

/** Drop every retained message of Kuber streams (operator command; events live in PostgreSQL). */
export async function purgeKuberStreams(servers: string, caFile?: string, token?: string) {
  const nc = await connect({ servers, name: "kuber-admin", ...tlsFor(servers, caFile), ...(token ? { token } : {}) });
  try {
    const jsm = await jetstreamManager(nc);
    const out: Record<string, number> = {};
    for await (const s of jsm.streams.list()) if (s.config.name.startsWith("KUBER_")) out[s.config.name] = (await jsm.streams.purge(s.config.name)).purged;
    return out;
  } finally { await nc.close(); }
}

export class NatsBus implements Bus {
  private stopFns: (() => void)[] = [];
  private constructor(private nc: NatsConnection, private js: JetStreamClient,
                      private jsm: JetStreamManager, private stream: string, readonly partitions: number, private opts: NatsOptions = {}) {}

  static async connect(servers: string, cellId: string, opts: NatsOptions = {}) {
    const streamName = opts.streamName ?? `KUBER_${cellId.replace(/\W/g, "_").toUpperCase()}`;
    const partitions = opts.partitions ?? busPartitions();
    const nc = await connect({ servers, name: `kuber-core-${cellId}`, ...tlsFor(servers, opts.caFile), ...(opts.token ? { token: opts.token } : {}) });
    const jsm = await jetstreamManager(nc);
    // The broker is transport, not the system of record (PostgreSQL is): keep messages only as long
    // as consumers could need them, so the broker's disk never accumulates a second copy of history.
    const cfg = { name: streamName, subjects: [`kuber.${cellId}.>`], duplicate_window: DUPLICATE_WINDOW_NS,
      max_age: (opts.retentionDays ?? 7) * 86_400 * 1_000_000_000 };
    let existing: Record<string, string> | undefined;
    try { existing = (await jsm.streams.info(streamName)).config.metadata ?? {}; } catch { existing = undefined; }
    try {
      if (existing === undefined) await jsm.streams.add({ ...cfg, metadata: { [PARTITIONS_KEY]: String(partitions) } });
      else {
        const recorded = existing[PARTITIONS_KEY];
        // 1 -> P is the legacy migration, ordered by drainLegacy in subscribe; any other change needs drained consumers
        if (recorded !== undefined && recorded !== "1" && recorded !== String(partitions)) await assertDrained(jsm, streamName, recorded, partitions);
        await jsm.streams.update(streamName, { ...cfg, metadata: { ...existing, [PARTITIONS_KEY]: String(partitions) } });
      }
    } catch (e) { await nc.close(); throw e; }
    return new NatsBus(nc, jetstream(nc), jsm, streamName, partitions, opts);
  }

  async publish(subject: string, env: Envelope) {
    const s = this.partitions > 1 ? `${subject}.${partitionOf(env.meta.tenantId, this.partitions)}` : subject;
    await this.js.publish(s, JSON.stringify(env), { msgID: env.eventId });
  }

  async subscribe(sub: Subscription) {
    const base = sub.name.replace(/\W/g, "_");
    if (this.partitions <= 1) { await this.bind(sub, base, sub.filter); return; }
    await this.drainLegacy(sub, base);
    // lanes beyond the current partition count (after a drained reduction) are retired
    for await (const c of this.jsm.consumers.list(this.stream)) {
      const m = new RegExp(`^${base}_p(\\d+)$`).exec(c.name);
      if (m && Number(m[1]) >= this.partitions) await this.jsm.consumers.delete(this.stream, c.name).catch(() => undefined);
    }
    for (let lane = 0; lane < this.partitions; lane++) await this.bind(sub, `${base}_p${lane}`, sub.filter.map((f) => laneFilter(f, lane)));
  }

  private async ensureConsumer(durable: string, filter: string[]) {
    let exists = true;
    try { await this.jsm.consumers.info(this.stream, durable); } catch { exists = false; }
    if (exists) {
      // keep the durable position; only the filter may change between releases
      await this.jsm.consumers.update(this.stream, durable, { filter_subjects: filter });
    } else {
      await this.jsm.consumers.add(this.stream, {
        durable_name: durable, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All,
        filter_subjects: filter, max_ack_pending: 1, max_deliver: this.opts.maxDeliver ?? 10, ack_wait: 30 * 1_000_000_000,
      });
    }
  }

  private async bind(sub: Subscription, durable: string, filter: string[]) {
    await this.ensureConsumer(durable, filter);
    const consumer = await this.js.consumers.get(this.stream, durable);
    const messages = await consumer.consume();
    this.stopFns.push(() => messages.stop());
    void (async () => {
      for await (const m of messages) {
        let env: Envelope | undefined;
        try { env = m.json<Envelope>(); await sub.handler(env); m.ack(); }
        catch (e) { await this.failed(m, sub, durable, env, e); }
      }
    })();
  }

  /**
   * A failed delivery: on the last one (max_deliver of this lane's consumer) record it as a dead
   * letter under the module's consumer name and terminate it; otherwise retry after a second.
   */
  private async failed(m: JsMsg, sub: Subscription, durable: string, env: Envelope | undefined, e: unknown) {
    if (env && this.opts.onDeadLetter && m.info.deliveryCount >= (this.opts.maxDeliver ?? 10)) {
      try { await this.opts.onDeadLetter({ consumer: sub.name, env, error: e, attempts: m.info.deliveryCount }); m.term(); return; }
      catch (x) { console.error(`[${durable}] could not record dead letter`, x); }
    }
    console.error(`[${durable}] handler failed, will retry`, e); m.nak(1000);
  }

  /** Process what an unpartitioned durable still holds, in order, then remove it. */
  private async drainLegacy(sub: Subscription, durable: string) {
    try { await this.jsm.consumers.info(this.stream, durable); } catch { return; }
    const c = await this.js.consumers.get(this.stream, durable);
    for (;;) {
      const i = await c.info();
      if (i.num_pending === 0 && i.num_ack_pending === 0) break;
      const m = await c.next({ expires: 1000 });
      if (!m) continue;
      let env: Envelope | undefined;
      try { env = m.json<Envelope>(); await sub.handler(env); m.ack(); }
      catch (e) { await this.failed(m, sub, `${durable} (legacy)`, env, e); }
    }
    await this.jsm.consumers.delete(this.stream, durable).catch(() => undefined);   // another replica may have removed it
    console.warn(JSON.stringify({ bus: "legacy_consumer_drained", stream: this.stream, durable }));
  }

  async close() {
    for (const s of this.stopFns) s();
    await this.nc.drain();
  }
}

/** Refuse to re-route tenants while any Kuber consumer has work in flight. */
async function assertDrained(jsm: JetStreamManager, stream: string, from: string, to: number) {
  const busy: string[] = [];
  for await (const c of jsm.consumers.list(stream)) if (c.num_pending > 0 || c.num_ack_pending > 0) busy.push(`${c.name} (${c.num_pending} pending, ${c.num_ack_pending} unacked)`);
  if (busy.length) {
    throw new Error(`stream ${stream} is partitioned ${from} ways; changing to ${to} re-routes tenants. ` +
      `Stop the relay, let consumers drain, then restart. Still busy: ${busy.join(", ")}`);
  }
}
