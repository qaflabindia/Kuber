/** Event store against real PostgreSQL: concurrency, append-only, tenant isolation, ownership, outbox, inbox. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { EVENTSTORE_MIGRATIONS, ConcurrencyError, EventStore, OutboxRelay, appGrants, migrate, once, type NewEvent } from "@kuber/eventstore";
import { MemoryBus } from "@kuber/bus";
import type { Envelope } from "@kuber/contracts";
import { APP_ROLE, freshDatabase } from "./helpers.ts";

let sql: Sql, store: EventStore, drop: () => Promise<void>;

beforeAll(async () => {
  const db = await freshDatabase();
  drop = db.drop;
  const owner = postgres(db.ownerUrl, { max: 1, onnotice: () => undefined });
  await migrate(owner, EVENTSTORE_MIGRATIONS);
  await owner.unsafe(appGrants(APP_ROLE, ["es"]));
  await owner.end();
  sql = postgres(db.url, { max: 10, onnotice: () => undefined });
  store = new EventStore(sql, "test");
});
afterAll(async () => { await sql.end(); await drop(); });

const signal = (id: string): NewEvent => ({ type: "SignalReceived", data: { signalId: id, bookId: "b", channel: "chat", trust: "user", contentHash: id, lines: 1 } });

describe("event store", () => {
  it("appends and reads a stream in order with versions", async () => {
    await store.append("channels", "t1", { streamId: "t1/s/a", expected: "no_stream", events: [signal("1"), signal("2")] }, { principal: "owner:x" });
    const evs = await store.readStream("t1", "t1/s/a");
    expect(evs.map((e) => e.streamVersion)).toEqual([1, 2]);
    expect(evs[0]!.meta.tenantId).toBe("t1");
  });

  it("rejects a stale expected version", async () => {
    await expect(store.append("channels", "t1", { streamId: "t1/s/a", expected: 1, events: [signal("3")] }, { principal: "owner:x" }))
      .rejects.toBeInstanceOf(ConcurrencyError);
    await expect(store.append("channels", "t1", { streamId: "t1/s/a", expected: "no_stream", events: [signal("3")] }, { principal: "owner:x" }))
      .rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("lets exactly one of many concurrent writers win the same version", async () => {
    await store.append("channels", "t1", { streamId: "t1/s/race", expected: "no_stream", events: [signal("0")] }, { principal: "owner:x" });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
      store.append("channels", "t1", { streamId: "t1/s/race", expected: 1, events: [signal(`r${i}`)] }, { principal: "owner:x" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof ConcurrencyError)).toBe(true);
    expect(await store.streamVersion("t1", "t1/s/race")).toBe(2);
  });

  it("refuses updates and deletes of events (no privilege, and a trigger behind it)", async () => {
    await expect(sql.begin(async (tx) => { await tx`SELECT set_config('kuber.role','system',true)`; await tx`UPDATE es.events SET type = 'x'`; }))
      .rejects.toThrow(/append-only|permission denied/);
    await expect(sql.begin(async (tx) => { await tx`SELECT set_config('kuber.role','system',true)`; await tx`DELETE FROM es.events`; }))
      .rejects.toThrow(/append-only|permission denied/);
  });

  it("isolates tenants with row-level security", async () => {
    await store.append("channels", "t2", { streamId: "t2/s/secret", expected: "no_stream", events: [signal("s")] }, { principal: "owner:y" });
    expect(await store.readStream("t1", "t2/s/secret")).toHaveLength(0);          // t1 cannot see t2's stream
    expect(await store.readStream("t2", "t2/s/secret")).toHaveLength(1);
    const raw = await sql`SELECT count(*)::int AS n FROM es.events`;               // no tenant, no system role: sees nothing
    expect(raw[0]!.n).toBe(0);
  });

  it("refuses a stream outside the tenant and events owned by another module", async () => {
    await expect(store.append("channels", "t1", { streamId: "t2/s/x", expected: "any", events: [signal("x")] }, { principal: "owner:x" }))
      .rejects.toThrow(/not in tenant/);
    await expect(store.append("agent", "t1", { streamId: "t1/s/x", expected: "any", events: [signal("x")] }, { principal: "owner:x" }))
      .rejects.toThrow(/may not append SignalReceived/);
  });

  it("validates event payloads against the contract", async () => {
    const bad = { type: "SignalReceived", data: { signalId: "x" } } as unknown as NewEvent;
    await expect(store.append("channels", "t1", { streamId: "t1/s/bad", expected: "any", events: [bad] }, { principal: "owner:x" })).rejects.toThrow();
  });

  it("publishes every committed event exactly once through the outbox, in order", async () => {
    const bus = new MemoryBus();
    const got: Envelope[] = [];
    await bus.subscribe({ name: "all", filter: ["kuber.test.>"], handler: async (e) => { got.push(e); } });
    const relay = new OutboxRelay(sql, (s, e) => bus.publish(s, e));
    const n = await relay.drainAll();
    await bus.idle();
    const total = await store.systemTx(async (tx) => (await tx`SELECT count(*)::int AS n FROM es.events`)[0]!.n as number);
    expect(n).toBe(total);
    expect(got.map((e) => BigInt(e.globalPosition))).toEqual([...got.map((e) => BigInt(e.globalPosition))].sort((a, b) => (a < b ? -1 : 1)));
    expect(await relay.drainAll()).toBe(0);
  });

  it("processes an event at most once per consumer", async () => {
    const [env] = await store.readStream("t1", "t1/s/a");
    let calls = 0;
    await once(store, "c1", env!, async () => { calls++; });
    await once(store, "c1", env!, async () => { calls++; });
    await once(store, "c2", env!, async () => { calls++; });
    expect(calls).toBe(2);
  });

  it("rolls back the inbox record when the handler fails, so the event is retried", async () => {
    const [env] = await store.readStream("t1", "t1/s/a");
    await expect(once(store, "c3", env!, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    let ran = false;
    await once(store, "c3", env!, async () => { ran = true; });
    expect(ran).toBe(true);
  });
});
