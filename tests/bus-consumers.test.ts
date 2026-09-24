/**
 * Stale NATS consumers (`ops bus-consumers [--prune]`): after partitioning, the un-suffixed
 * `<module>` durable and lanes beyond KUBER_BUS_PARTITIONS can linger and pin messages. They are
 * listed, and pruned only when their pending messages are already processed per es.inbox (or with
 * --force). Selection is tested without NATS; the last block runs against a real nats-server.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { uuid, type Envelope } from "@kuber/contracts";
import { NatsBus, NatsConsumerAdmin, classifyConsumers, expectedConsumers, planPrune, streamNameFor, type ConsumerState } from "@kuber/bus";
import { OpsAdmin, type BusConsumerAdmin, type Cell } from "@kuber/core";
import { startCell } from "./helpers.ts";

const MODULES = ["gl", "agent", "evidence", "reporting"];
const c = (name: string, pending = 0, ackPending = 0): ConsumerState => ({ name, pending, ackPending, filter: [`kuber.x.${name}.>`], ackFloor: 0 });

describe("consumer selection (no NATS)", () => {
  it("names the expected durables for the partition count", () => {
    expect(expectedConsumers(["gl"], 1)).toEqual(["gl"]);
    expect(expectedConsumers(["gl", "agent"], 2)).toEqual(["gl_p0", "gl_p1", "agent_p0", "agent_p1"]);
  });

  it("classifies expected, legacy, retired-lane and foreign consumers", () => {
    const k = Object.fromEntries(classifyConsumers([c("gl_p0"), c("gl_p3"), c("gl_p4"), c("gl"), c("agent_p12"), c("debug"), c("glx_p1"), c("gl_pX")], MODULES, 4)
      .map((x) => [x.name, [x.kind, x.module, x.lane]]));
    expect(k).toEqual({
      gl_p0: ["expected", "gl", 0], gl_p3: ["expected", "gl", 3], gl_p4: ["retired_lane", "gl", 4], gl: ["legacy", "gl", null],
      agent_p12: ["retired_lane", "agent", 12], debug: ["foreign", null, null], glx_p1: ["foreign", null, null], gl_pX: ["foreign", null, null],
    });
    // unpartitioned layout: the plain name is expected and every lane consumer is stale
    const one = Object.fromEntries(classifyConsumers([c("gl"), c("gl_p0")], MODULES, 1).map((x) => [x.name, x.kind]));
    expect(one).toEqual({ gl: "expected", gl_p0: "retired_lane" });
  });

  it("prunes a stale consumer only when nothing it holds is unprocessed, or with force", () => {
    const cs = classifyConsumers([c("gl_p0", 5), c("debug", 3), c("gl"), c("agent", 2), c("reporting", 0, 1), c("evidence_p9", 4)], MODULES, 4);
    const unprocessed = { agent: 0, reporting: 1 };                     // evidence_p9 could not be inspected
    const plan = (force: boolean) => Object.fromEntries(planPrune(cs, unprocessed, force).map((d) => [d.name, d.delete]));
    expect(plan(false)).toEqual({ gl_p0: false, debug: false, gl: true, agent: true, reporting: false, evidence_p9: false });
    expect(plan(true)).toEqual({ gl_p0: false, debug: false, gl: true, agent: true, reporting: true, evidence_p9: true });
    expect(planPrune(cs, unprocessed).find((d) => d.name === "reporting")!.reason).toMatch(/1 of 1 pending message\(s\) not processed/);
  });
});

describe("OpsAdmin.busConsumers against es.inbox (fake broker)", () => {
  let cell: Cell, stop: () => Promise<void>, owner: postgres.Sql, ops: OpsAdmin;
  beforeAll(async () => {
    const f = await startCell({ value: "2026-10-25" });
    ({ cell, stop } = f);
    owner = postgres(f.db.ownerUrl, { max: 2, onnotice: () => undefined });
    ops = new OpsAdmin(owner, cell);
  });
  afterAll(async () => { await owner.end(); await stop(); });

  it("checks pending event ids against the module's inbox and dead letters, and deletes only what the plan allows", async () => {
    const done = uuid(), dead = uuid(), open = uuid();
    await owner`INSERT INTO es.inbox (consumer, event_id) VALUES ('gl', ${done})`;
    await owner`INSERT INTO es.dead_letters (consumer, tenant_id, event_id, global_position, stream_id, type, attempts, error)
                VALUES ('agent', 't', ${dead}, 1, 't/s', 'JournalPosted', 3, 'x')`;
    const pending: Record<string, string[] | null> = { gl: [done], agent: [dead, open], reporting_p8: null };
    const deleted: string[] = [];
    const fake: BusConsumerAdmin = {
      list: async () => [c("gl_p0"), c("gl", 1), c("agent", 2), c("reporting_p8", 7), c("evidence_p5")],
      pendingEventIds: async (x) => pending[x.name] ?? [],
      delete: async (n) => { deleted.push(n); },
    };
    const list = await ops.busConsumers(fake, { partitions: 2 });
    const by = Object.fromEntries(list.consumers.map((x) => [x.name, x]));
    expect(by.gl).toMatchObject({ kind: "legacy", unprocessed: 0, prune: true });
    expect(by.agent).toMatchObject({ kind: "legacy", unprocessed: 1, prune: false });
    expect(by.reporting_p8).toMatchObject({ kind: "retired_lane", unprocessed: null, prune: false });
    expect(by.evidence_p5).toMatchObject({ kind: "retired_lane", prune: true });
    expect(by.gl_p0).toMatchObject({ kind: "expected", prune: false });
    expect(list.missing).toEqual(expect.arrayContaining(["gl_p1", "agent_p0", "reporting_p1"]));
    expect(deleted).toEqual([]);                                        // listing never deletes
    await ops.busConsumers(fake, { partitions: 2, prune: true });
    expect(deleted.sort()).toEqual(["evidence_p5", "gl"]);
    deleted.length = 0;
    await ops.busConsumers(fake, { partitions: 2, prune: true, force: true });
    expect(deleted.sort()).toEqual(["agent", "evidence_p5", "gl", "reporting_p8"]);
  });
});

// ------------------------------------------------------------------ real JetStream
const NATS_BIN = process.env.NATS_SERVER_BIN ?? "/opt/bin/nats-server";
const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const env = (tenant: string): Envelope => ({ eventId: uuid(), streamId: `${tenant}/s`, streamVersion: 1, type: "PostingRequested", data: {}, meta: { tenantId: tenant } }) as unknown as Envelope;
type Internal = { ensureConsumer(d: string, f: string[]): Promise<void> };

describe.skipIf(!existsSync(NATS_BIN))("ops bus-consumers over NATS JetStream", () => {
  let nats: ChildProcess, dir: string, url: string, cell: Cell, stop: () => Promise<void>, owner: postgres.Sql, ops: OpsAdmin;
  const buses: NatsBus[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kuber-nats-"));
    const port = await freePort();
    nats = spawn(NATS_BIN, ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 500));
    url = `nats://127.0.0.1:${port}`;
    const f = await startCell({ value: "2026-10-25" });                 // the database (memory bus); the broker is inspected directly
    ({ cell, stop } = f);
    owner = postgres(f.db.ownerUrl, { max: 2, onnotice: () => undefined });
    ops = new OpsAdmin(owner, cell);
  }, 30_000);
  afterAll(async () => {
    for (const b of buses) await b.close().catch(() => undefined);
    await owner?.end(); await stop?.(); nats?.kill(); if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists stale consumers with their backlog and prunes them once their messages are processed", async () => {
    const cellId = `bc${Date.now().toString(36)}`;
    const subj = `kuber.${cellId}.agent.PostingRequested`;
    // before partitioning: durable `gl` with a backlog of two 5-token messages nobody consumed
    const old = await NatsBus.connect(url, cellId, { partitions: 1 }); buses.push(old);
    await (old as unknown as Internal).ensureConsumer("gl", [`${subj}.*`]);
    const backlog = [env("acme"), env("acme")];
    for (const e of backlog) await old.publish(`${subj}.acme`, e);
    await old.close();
    // now 2 lanes; a lane 5 consumer left over from an earlier, wider layout; and someone's debug consumer
    const bus = await NatsBus.connect(url, cellId, { partitions: 2 }); buses.push(bus);
    for (const d of ["gl_p0", "gl_p1", "gl_p5"]) await (bus as unknown as Internal).ensureConsumer(d, [`${subj}.*.${d.slice(-1)}`]);
    await (bus as unknown as Internal).ensureConsumer("debug", [`kuber.${cellId}.>`]);

    const admin = await NatsConsumerAdmin.connect(url, streamNameFor(cellId));
    try {
      const names = async () => (await admin.list()).map((x) => x.name).sort();
      const r = await ops.busConsumers(admin, { partitions: 2 });
      const by = Object.fromEntries(r.consumers.map((x) => [x.name, x]));
      expect(by.gl).toMatchObject({ kind: "legacy", pending: 2, unprocessed: 2, prune: false });
      expect(by.gl_p5).toMatchObject({ kind: "retired_lane", pending: 0, prune: true });
      expect(by.gl_p0).toMatchObject({ kind: "expected" });
      expect(by.debug).toMatchObject({ kind: "foreign", prune: false });

      await ops.busConsumers(admin, { partitions: 2, prune: true });
      expect(await names()).toEqual(["debug", "gl", "gl_p0", "gl_p1"]);        // the legacy backlog is not processed yet
      // reading the backlog did not move the durable
      expect((await admin.list()).find((x) => x.name === "gl")).toMatchObject({ pending: 2, ackPending: 0 });

      for (const e of backlog) await owner`INSERT INTO es.inbox (consumer, event_id) VALUES ('gl', ${e.eventId})`;
      const again = await ops.busConsumers(admin, { partitions: 2, prune: true });
      expect(again.consumers.find((x) => x.name === "gl")).toMatchObject({ unprocessed: 0, deleted: true });
      expect(await names()).toEqual(["debug", "gl_p0", "gl_p1"]);
    } finally { await admin.close(); }
  }, 30_000);
});
