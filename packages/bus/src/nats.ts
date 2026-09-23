/**
 * NATS JetStream bus. One stream per cell captures `kuber.<cell>.>`; each module has a
 * durable pull consumer with explicit acks. Publishing sets Nats-Msg-Id to the event ID so
 * a relay retry inside the duplicate window is dropped by the server.
 * max_ack_pending = 1 keeps delivery ordered per consumer; scale by partitioning subjects
 * (for example by tenant) across more consumers, not by raising in-flight messages.
 */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { Envelope } from "@kuber/contracts";
import type { Bus, Subscription } from "./index.ts";

const DUPLICATE_WINDOW_NS = 10 * 60 * 1_000_000_000; // 10 minutes

export interface NatsOptions { streamName?: string; caFile?: string; retentionDays?: number; token?: string }

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
                      private jsm: JetStreamManager, private stream: string) {}

  static async connect(servers: string, cellId: string, opts: NatsOptions = {}) {
    const streamName = opts.streamName ?? `KUBER_${cellId.replace(/\W/g, "_").toUpperCase()}`;
    const nc = await connect({ servers, name: `kuber-core-${cellId}`, ...tlsFor(servers, opts.caFile), ...(opts.token ? { token: opts.token } : {}) });
    const jsm = await jetstreamManager(nc);
    // The broker is transport, not the system of record (PostgreSQL is): keep messages only as long
    // as consumers could need them, so the broker's disk never accumulates a second copy of history.
    const cfg = { name: streamName, subjects: [`kuber.${cellId}.>`], duplicate_window: DUPLICATE_WINDOW_NS,
      max_age: (opts.retentionDays ?? 7) * 86_400 * 1_000_000_000 };
    try { await jsm.streams.info(streamName); await jsm.streams.update(streamName, cfg); }
    catch { await jsm.streams.add(cfg); }
    return new NatsBus(nc, jetstream(nc), jsm, streamName);
  }

  async publish(subject: string, env: Envelope) {
    await this.js.publish(subject, JSON.stringify(env), { msgID: env.eventId });
  }

  async subscribe(sub: Subscription) {
    const durable = sub.name.replace(/\W/g, "_");
    let exists = true;
    try { await this.jsm.consumers.info(this.stream, durable); } catch { exists = false; }
    if (exists) {
      // keep the durable position; only the filter may change between releases
      await this.jsm.consumers.update(this.stream, durable, { filter_subjects: sub.filter });
    } else {
      await this.jsm.consumers.add(this.stream, {
        durable_name: durable, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All,
        filter_subjects: sub.filter, max_ack_pending: 1, max_deliver: 10, ack_wait: 30 * 1_000_000_000,
      });
    }
    const consumer = await this.js.consumers.get(this.stream, durable);
    const messages = await consumer.consume();
    this.stopFns.push(() => messages.stop());
    void (async () => {
      for await (const m of messages) {
        try { await sub.handler(m.json<Envelope>()); m.ack(); }
        catch (e) { console.error(`[${sub.name}] handler failed, will retry`, e); m.nak(1000); }
      }
    })();
  }

  async close() {
    for (const s of this.stopFns) s();
    await this.nc.drain();
  }
}
