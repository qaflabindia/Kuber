/**
 * Stale JetStream consumers (operator command `ops bus-consumers`).
 *
 * The expected durables of a cell are `<module>_p<lane>` for lane < P (KUBER_BUS_PARTITIONS), or
 * `<module>` when P = 1. Others left on the stream keep their messages pinned against retention
 * limits and show up as backlog: the un-suffixed durable from before partitioning (normally drained
 * and removed by `subscribe`, but not when a module is no longer started on that release) and lanes
 * >= P after the partition count was reduced.
 *
 * Selection is pure (`classifyConsumers`, `planPrune`) so it can be tested without NATS; a stale
 * consumer with pending messages is deleted only when every pending message is already accounted
 * for in PostgreSQL (the caller decides that from es.inbox), or with force.
 */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { DeliverPolicy, jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { Envelope } from "@kuber/contracts";

export interface ConsumerState {
  name: string;
  /** Messages not yet delivered. */
  pending: number;
  /** Delivered, not yet acknowledged. */
  ackPending: number;
  filter: string[];
  /** Stream sequence of the acknowledgement floor. */
  ackFloor: number;
}

export type ConsumerKind = "expected" | "legacy" | "retired_lane" | "foreign";
export interface ClassifiedConsumer extends ConsumerState { module: string | null; lane: number | null; kind: ConsumerKind }

/** The durable names a cell with these module consumers and P lanes uses. */
export function expectedConsumers(modules: string[], partitions: number): string[] {
  return modules.flatMap((m) => {
    const base = m.replace(/\W/g, "_");
    return partitions <= 1 ? [base] : Array.from({ length: partitions }, (_, lane) => `${base}_p${lane}`);
  });
}

export function classifyConsumers(consumers: ConsumerState[], modules: string[], partitions: number): ClassifiedConsumer[] {
  const expected = new Set(expectedConsumers(modules, partitions));
  const bases = new Set(modules.map((m) => m.replace(/\W/g, "_")));
  return consumers.map((c) => {
    const lane = /^(.+)_p(\d+)$/.exec(c.name);
    const module = bases.has(c.name) ? c.name : lane && bases.has(lane[1]!) ? lane[1]! : null;
    const n = lane && module === lane[1] ? Number(lane[2]) : null;
    const kind: ConsumerKind = expected.has(c.name) ? "expected" : module === null ? "foreign" : n === null ? "legacy" : "retired_lane";
    return { ...c, module, lane: n, kind };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export interface PruneDecision { name: string; kind: ConsumerKind; delete: boolean; reason: string }

/**
 * What `--prune` does with each consumer. `unprocessed[name]`: how many of its pending messages
 * are not accounted for in PostgreSQL (undefined: not inspected). Expected and foreign consumers
 * are never deleted.
 */
export function planPrune(consumers: ClassifiedConsumer[], unprocessed: Record<string, number | undefined>, force = false): PruneDecision[] {
  return consumers.map((c) => {
    const d = (del: boolean, reason: string): PruneDecision => ({ name: c.name, kind: c.kind, delete: del, reason });
    if (c.kind === "expected") return d(false, "expected");
    if (c.kind === "foreign") return d(false, "not a consumer of a Kuber module; left alone");
    const why = c.kind === "legacy" ? "unpartitioned durable from before partitioning" : `lane ${c.lane} is beyond the current partition count`;
    const waiting = c.pending + c.ackPending;
    if (waiting === 0) return d(true, `${why}; nothing pending`);
    const left = unprocessed[c.name];
    if (left === 0) return d(true, `${why}; its ${waiting} pending message(s) are already processed`);
    if (force) return d(true, `${why}; forced with ${left === undefined ? "unchecked" : left} unprocessed message(s) (the events stay in PostgreSQL: see ops gaps / ops retry)`);
    return d(false, left === undefined ? `${why}; ${waiting} pending message(s) not checked` : `${why}; ${left} of ${waiting} pending message(s) not processed yet (drain it or use --force)`);
  });
}

/** Stream name of a cell (as NatsBus.connect names it). */
export const streamNameFor = (cellId: string) => `KUBER_${cellId.replace(/\W/g, "_").toUpperCase()}`;

/** Consumer inspection and removal on a cell's stream. */
export class NatsConsumerAdmin {
  private constructor(private nc: NatsConnection, private js: JetStreamClient, private jsm: JetStreamManager, readonly stream: string) {}

  static async connect(servers: string, stream: string, opts: { caFile?: string; token?: string } = {}) {
    const tls = servers.startsWith("tls://") || opts.caFile ? { tls: { ...(opts.caFile ? { caFile: opts.caFile } : {}) } } : {};
    const nc = await connect({ servers, name: "kuber-admin", ...tls, ...(opts.token ? { token: opts.token } : {}) });
    return new NatsConsumerAdmin(nc, jetstream(nc), await jetstreamManager(nc), stream);
  }

  async list(): Promise<ConsumerState[]> {
    const out: ConsumerState[] = [];
    for await (const c of this.jsm.consumers.list(this.stream)) {
      if (!c.config.durable_name) continue;                            // ephemeral (e.g. an inspection in progress)
      const f = c.config.filter_subjects ?? (c.config.filter_subject ? [c.config.filter_subject] : []);
      out.push({ name: c.name, pending: c.num_pending, ackPending: c.num_ack_pending, filter: f, ackFloor: c.ack_floor.stream_seq });
    }
    return out;
  }

  /**
   * Event ids of the messages a consumer has not acknowledged (above its ack floor, on its filter),
   * read with an ordered consumer so the durable itself is untouched. Null when they could not all
   * be read (then nothing can be concluded about them).
   */
  async pendingEventIds(c: ConsumerState, max = 100_000): Promise<string[] | null> {
    const want = c.pending + c.ackPending;
    if (want === 0) return [];
    if (want > max || !c.filter.length) return null;
    const oc = await this.js.consumers.get(this.stream, { filter_subjects: c.filter, deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: c.ackFloor + 1 });
    const ids: string[] = [];
    try {
      await this.readInto(oc, want, ids);
    } catch { return null; } finally { await oc.delete().catch(() => undefined); }
    return ids.length >= want ? ids : null;                           // could not read them all: conclude nothing
  }

  private async readInto(oc: Awaited<ReturnType<JetStreamClient["consumers"]["get"]>>, want: number, ids: string[]) {
    while (ids.length < want) {
      const batch = await oc.fetch({ max_messages: Math.min(want - ids.length, 1000), expires: 2000 });
      let got = 0;
      for await (const m of batch) {
        got++;
        ids.push(m.json<Envelope>().eventId);
        if (ids.length >= want) break;
      }
      if (got === 0) break;
    }
  }

  async delete(name: string) { return this.jsm.consumers.delete(this.stream, name); }

  async close() { await this.nc.close(); }
}
