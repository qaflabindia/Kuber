/**
 * Server-side hardening of identity (F01/F02 follow-ups):
 *   1. authorization at module boundaries: agent decisions and channel submissions refuse an
 *      unauthorized principal even when called in-process, bypassing HTTP; ops plan/commit too
 *   2. identity changes are appended as sealed events to the tenant's identity stream, atomically
 *   3. display names are sealed at rest; a one-time data migration seals existing plaintext rows
 *   4. a shared (Valkey) replay store: a nonce accepted by one core instance is a replay on another
 *   5. (sessions: see identity.test.ts, which has the software authenticator)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";
import postgres from "postgres";
import { uuid } from "@kuber/contracts";
import { Keyring } from "@kuber/crypto";
import { EventStore, DENY_ALL_GUARD } from "@kuber/eventstore";
import { Agent } from "@kuber/agent";
import { Channels } from "@kuber/channels";
import { AccessDenied, IDENTITY_SEAL_MIGRATION, identityStream } from "@kuber/identity";
import { AUTH_HEADER, ReplayCache, authKey, signRequest, verifyRequestAsync, ReplayStoreUnavailable } from "@kuber/auth";
import { ValkeyClient, ValkeyReplayStore, encodeCommand, parseReply, parseValkeyUrl, replayStoreFromEnv, type RespClient } from "@kuber/auth/valkey";
import { KeyAdmin, buildServer, sealIdentityColumns, type Cell } from "@kuber/core";
import { CORE_AUTH_SECRET, enrol, newSession, startCell } from "./helpers.ts";

const T = "hard", B = "main", B2 = "other", OWNER = "owner:hema";
const clock = { value: "2026-11-25" };
const csv = (...rows: string[]) => "Date,Narration,Withdrawal Amt,Deposit Amt\n" + rows.join("\n") + "\n";
let cell: Cell, stop: () => Promise<void>, ownerUrl: string;

beforeAll(async () => {
  let db: { ownerUrl: string };
  ({ cell, stop, db } = await startCell(clock));
  ownerUrl = db.ownerUrl;
  await enrol(cell, T, [OWNER, "preparer:pia", "auditor:ali", "approver:amar"]);
  await enrol(cell, T, ["controller:scoped"], [B2]);
  await enrol(cell, T, ["agent:bot"], [B]);
  for (const b of [B, B2]) await cell.gl.openBook(T, b, T, "individual", OWNER);
  await cell.settle();
});
afterAll(async () => { await stop(); });

let drafted = 0;
const openDraft = async (narration: string) => {
  drafted++;
  await cell.channels.submitStatement(T, B, csv(`${String(10 + drafted).padStart(2, "0")}/10/2026,${narration},${100 + drafted * 7},`), OWNER);
  await cell.settle();
  const d = (await cell.agent.queue(T)).find((x) => (x.proposal as { narration: string }).narration.includes(narration));
  expect(d).toBeDefined();
  return d!.draft_id as string;
};

// ---------------------------------------------------------------- 1. module boundaries
describe("authorization at module boundaries (in-process callers)", () => {
  it("channels refuse submissions from non-members, read-only roles and out-of-scope members", async () => {
    const before = (await cell.store.readEvents({ tenantId: T, types: ["SignalReceived"] })).length;
    await expect(cell.channels.submitStatement(T, B, csv("01/10/2026,Sneaky,5,"), "owner:stranger")).rejects.toThrow(AccessDenied);
    await expect(cell.channels.submitChat(T, B, "Paid 450 cash", "auditor:ali", "2026-10-01")).rejects.toThrow(/auditor may not capture/);
    await expect(cell.channels.submitChat(T, B, "Paid 450 cash", "controller:scoped", "2026-10-01")).rejects.toThrow(/no access to book main/);
    await expect(cell.channels.submitRaw(T, B, "sms", "provisional", "x", [], "agent:unknown")).rejects.toThrow(/no grant/);
    await expect(cell.channels.submitRaw(T, B2, "sms", "provisional", "x", [], "agent:bot")).rejects.toThrow(/not granted book other/);
    expect((await cell.store.readEvents({ tenantId: T, types: ["SignalReceived"] })).length).toBe(before);
  });

  it("people with capture, agents in their book and system adapters may still submit", async () => {
    expect(await cell.channels.submitChat(T, B, "Paid 120 to the plumber in cash", "preparer:pia", "2026-10-02")).toMatchObject({ accepted: 1 });
    const txn = { txnDate: "2026-10-03", amount: "4500", direction: "out" as const, narration: "SMS debit", instrument: "BANK" };
    expect(await cell.channels.submitRaw(T, B, "sms", "provisional", "sms-1", [txn], "agent:bot")).toMatchObject({ accepted: 1 });
    expect(await cell.channels.submitRaw(T, B, "sms", "provisional", "sms-2", [{ ...txn, narration: "SMS debit 2" }], "system:sms-adapter")).toMatchObject({ accepted: 1 });
    await cell.settle();
  });

  it("agent decisions refuse principals without the role or book, whoever calls", async () => {
    const id = await openDraft("Unknown vendor A");
    await expect(cell.agent.approveDraft(T, id, "owner:stranger", "LIVING")).rejects.toThrow(/not a member/);
    await expect(cell.agent.approveDraft(T, id, "preparer:pia", "LIVING")).rejects.toThrow(/preparer may not draft.decide/);
    await expect(cell.agent.approveDraft(T, id, "controller:scoped", "LIVING")).rejects.toThrow(/no access to book main/);
    await expect(cell.agent.approveDraft(T, id, "agent:bot", "LIVING")).rejects.toThrow(/agent may not draft.decide directly/);
    await expect(cell.agent.approveDraft(T, id, "system:anything", "LIVING")).rejects.toThrow(/may not draft.decide/);
    // Naming a plan id does not help: the plan's approval must exist, by this principal, for this book.
    await expect(cell.agent.approveDraft(T, id, "agent:bot", "LIVING", uuid())).rejects.toThrow(/agent may not draft.decide/);
    await expect(cell.agent.rejectDraft(T, id, "auditor:ali", "no")).rejects.toThrow(/auditor may not draft.decide/);
    await expect(cell.agent.ratify(T, uuid(), "approver:outsider")).rejects.toThrow(/not a member/);
    await expect(cell.agent.correct(T, uuid(), "LIVING", "controller:scoped")).rejects.toThrow(/limited to books/);
    await expect(cell.agent.addRule(T, "vendor", "LIVING", "preparer:pia")).rejects.toThrow(/preparer may not rules.manage/);
    expect((await cell.agent.queue(T)).find((d) => d.draft_id === id)?.status).toBe("queued");
    // The approver may decide it.
    expect(await cell.agent.approveDraft(T, id, "approver:amar", "LIVING")).toMatchObject({ status: "approved" });
    await cell.settle();
  });

  it("a committed ops plan authorizes its own draft approvals (the ops guard decided)", async () => {
    const id = await openDraft("Mystery supplier Q");
    const plan = await cell.ops.plan(T, B, "preparer:pia", "post", { draftIds: [id], overrides: { [id]: "LIVING" }, minConfidence: 0 });
    expect(plan).toMatchObject({ kind: "write", status: "proposed", blocked: false });
    const r = await cell.ops.commit(T, plan.planId, OWNER, plan.hash);
    expect(r.status).toBe("committed");
    await cell.settle();
    expect((await cell.agent.queue(T)).find((d) => d.draft_id === id)).toBeUndefined();
  });

  it("ops plan and commit refuse non-members and system principals in-process", async () => {
    const input = { date: "2026-10-01", narration: "Supplies", amount: "100", direction: "out", account: "LIVING", via: "BANK" };
    await expect(cell.ops.plan(T, B, "owner:stranger", "record", input)).rejects.toThrow(/not a member/);
    await expect(cell.ops.plan(T, B, "system:batch", "record", input)).rejects.toThrow(/may not use operations/);
    const p = await cell.ops.plan(T, B, "preparer:pia", "record", input);
    await expect(cell.ops.commit(T, p.planId, "owner:stranger", p.hash)).rejects.toThrow(/not a member/);
    await expect(cell.ops.commit(T, p.planId, "system:batch", p.hash)).rejects.toThrow(/may not use operations/);
    expect((await cell.ops.get(T, p.planId)).status).toBe("proposed");
  });

  it("modules built without a guard refuse everything", async () => {
    const agent = new Agent(cell.sql, cell.store, cell.policies);
    const channels = new Channels(cell.store);
    await expect(channels.submitChat(T, B, "Paid 1 cash", OWNER, "2026-10-01")).rejects.toThrow(/no authorization service/);
    await expect(agent.addRule(T, "x", "LIVING", OWNER)).rejects.toThrow(/no authorization service/);
    await expect(DENY_ALL_GUARD.permit(T, OWNER, "read")).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ---------------------------------------------------------------- 2. audit events
describe("identity changes are sealed events in the tenant's identity stream", () => {
  const A = "audited";
  const types = async () => (await cell.store.readStream(A, identityStream(A))).map((e) => `${e.type}:${e.meta.principal}`);

  it("records members, scope changes, invitations, settings and removals with their actor", async () => {
    await cell.identity.addMember(A, "operator:cli", { principal: "owner:olga" });
    await cell.identity.addMember(A, "owner:olga", { principal: "controller:carl", books: ["main"] });
    await cell.identity.addMember(A, "owner:olga", { principal: "controller:carl", books: ["main"] });   // unchanged: no event
    await cell.identity.addMember(A, "owner:olga", { principal: "controller:carl", books: null });
    const inv = await cell.identity.invite(A, "owner:olga", { role: "auditor", displayName: "Audit Firm" });
    await cell.identity.setSettings(A, "owner:olga", { soloOwner: false, sodLimitPaise: "100000" });
    await cell.identity.revoke(A, "owner:olga", "controller:carl");
    expect(await types()).toEqual([
      "MemberAdded:system:operator.cli", "MemberAdded:owner:olga", "MemberRoleChanged:owner:olga", "InvitationIssued:owner:olga",
      "SettingsChanged:owner:olga", "MemberRemoved:owner:olga",
    ]);
    const events = await cell.store.readStream(A, identityStream(A));
    expect(events[2]!.data).toMatchObject({ principal: "controller:carl", books: null, previousBooks: ["main"] });
    expect(events[3]!.data).toMatchObject({ principal: inv.principal, role: "auditor" });
    expect(JSON.stringify(events[3]!.data)).not.toContain(inv.token);                         // the code itself is never recorded
    expect(events[4]!.data).toMatchObject({ soloOwner: false, sodLimitPaise: "100000", previous: null });
    // Sealed at rest, like every event.
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      const rows = await owner`SELECT data, module FROM es.events WHERE tenant_id = ${A} AND stream_id = ${identityStream(A)}`;
      expect(rows.every((r) => typeof (r.data as { $c?: unknown }).$c === "string" && r.module === "identity")).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("Audit Firm");
    } finally { await owner.end(); }
  });

  it("a refused change leaves no event (same transaction)", async () => {
    const n = (await types()).length;
    await expect(cell.identity.revoke(A, "owner:olga", "owner:olga")).rejects.toThrow(/at least one owner/);
    await expect(cell.identity.invite(A, "owner:olga", { role: "owner", displayName: "Olga", principal: "owner:olga" })).rejects.toThrow(/already a member/);
    expect((await types()).length).toBe(n);
  });

  it("agent grants and identity events alone do not make a workspace unclaimable", async () => {
    const W = "grantonly";
    await cell.identity.syncAgentGrants([{ tenant: W, book: "main", principal: "agent:desk" }]);
    expect((await cell.store.readStream(W, identityStream(W))).map((e) => e.type)).toEqual(["MemberAdded"]);
    await expect(cell.identity.registrationOptions(W, { displayName: "First Owner" })).resolves.toMatchObject({ rp: { id: "localhost" } });
  });
});

// ---------------------------------------------------------------- 3. sealed display names
describe("display names are sealed at rest", () => {
  it("members and invitations store ciphertext; the API returns the name", async () => {
    const S = "sealed";
    await cell.identity.addMember(S, "operator:test", { principal: "owner:sita", displayName: "Sita Raman" });
    await cell.identity.invite(S, "owner:sita", { role: "preparer", displayName: "Prakash Iyer" });
    expect((await cell.identity.members(S))[0]).toMatchObject({ principal: "owner:sita", displayName: "Sita Raman" });
    expect((await cell.identity.member(S, "owner:sita"))?.displayName).toBe("Sita Raman");
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      const [m] = await owner`SELECT display_name FROM identity.members WHERE tenant_id = ${S}`;
      const [e] = await owner`SELECT display_name FROM identity.enrolments WHERE tenant_id = ${S}`;
      expect(m!.display_name).toMatch(/^kb1\./);
      expect(e!.display_name).toMatch(/^kb1\./);
    } finally { await owner.end(); }
  });

  it("the data migration seals plaintext names written before encryption, once", async () => {
    const L = "legacyids";
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
        VALUES (${L}, 'owner:lata', 'owner', NULL, 'Lata Old', 'operator', 'operator:old')`;
      await owner`INSERT INTO identity.enrolments (tenant_id, token_hash, principal, role, books, display_name, created_by, expires_at)
        VALUES (${L}, 'legacyhash', 'auditor:ca', 'auditor', NULL, 'CA Old', 'owner:lata', now() + interval '1 day')`;
      expect((await cell.identity.member(L, "owner:lata"))?.displayName).toBe("Lata Old");            // plaintext still readable
      const keyring = new Keyring(owner, cell.keyring.kms, 0);
      expect(await sealIdentityColumns(owner, keyring)).toBe(0);                                      // already applied at start
      await owner`DELETE FROM public.schema_migrations WHERE id = ${IDENTITY_SEAL_MIGRATION}`;
      expect(await sealIdentityColumns(owner, keyring)).toBeGreaterThanOrEqual(2);
      expect(await sealIdentityColumns(owner, keyring)).toBe(0);
      const [m] = await owner`SELECT display_name FROM identity.members WHERE tenant_id = ${L}`;
      const [e] = await owner`SELECT display_name FROM identity.enrolments WHERE tenant_id = ${L}`;
      expect(m!.display_name).toMatch(/^kb1\./);
      expect(e!.display_name).toMatch(/^kb1\./);
      cell.keyring.invalidate(L);
      expect((await cell.identity.member(L, "owner:lata"))?.displayName).toBe("Lata Old");
      const report = await new KeyAdmin(owner, keyring, new EventStore(owner, "admin", { keyring }), 0).verify(false);
      expect(Object.keys(report.plaintext).filter((k) => k.startsWith("identity."))).toEqual([]);
    } finally { await owner.end(); }
  });
});

// ---------------------------------------------------------------- 4. shared replay store
/** An in-memory stand-in for Valkey's SET NX PX, shared by "instances". */
class FakeValkey implements RespClient {
  readonly keys = new Map<string, number>();
  down = false;
  constructor(private now: () => number = Date.now) {}
  async command(args: string[]) {
    if (this.down) throw new Error("connection refused");
    const [cmd, key, , nx, px, ttl] = args;
    if (cmd !== "SET" || nx !== "NX" || px !== "PX") throw new Error(`unexpected ${args.join(" ")}`);
    const exp = this.keys.get(key!);
    if (exp !== undefined && exp > this.now()) return null;
    this.keys.set(key!, this.now() + Number(ttl));
    return "OK";
  }
}

describe("shared replay store (Valkey)", () => {
  const key = authKey(CORE_AUTH_SECRET);
  const req = { method: "GET", path: "/v1/tenants/t/books", body: "" };
  const sign = () => signRequest(key, { ...req, tenant: "t", principal: "owner:x", session: newSession() });

  it("claims each nonce once across instances, with a TTL until the assertion expires", async () => {
    const fake = new FakeValkey();
    const a = new ValkeyReplayStore(fake), b = new ValkeyReplayStore(fake);
    const h = sign();
    await expect(verifyRequestAsync(key, a, { header: h, ...req })).resolves.toMatchObject({ principal: "owner:x" });
    await expect(verifyRequestAsync(key, b, { header: h, ...req })).rejects.toThrow(/already used/);   // the other instance
    const [k, exp] = [...fake.keys][0]!;
    expect(k).toMatch(/^kuber:auth:nonce:/);
    expect(exp! - Date.now()).toBeGreaterThan(60_000);                                                  // expiry + skew
    expect(exp! - Date.now()).toBeLessThanOrEqual(90_000);
    // The in-process cache alone would accept the same assertion on a second instance.
    const h2 = sign();
    await verifyRequestAsync(key, new ReplayCache(), { header: h2, ...req });
    await expect(verifyRequestAsync(key, new ReplayCache(), { header: h2, ...req })).resolves.toBeDefined();
  });

  it("fails closed (503) when the store cannot answer", async () => {
    const fake = new FakeValkey(); fake.down = true;
    await expect(verifyRequestAsync(key, new ValkeyReplayStore(fake), { header: sign(), ...req })).rejects.toBeInstanceOf(ReplayStoreUnavailable);
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET, replay: new ValkeyReplayStore(fake) } });
    try {
      const url = `/v1/tenants/${T}/books`;
      const r = await app.inject({ method: "GET", url, headers: { [AUTH_HEADER]: signRequest(key, { method: "GET", path: url, tenant: T, principal: OWNER, session: newSession() }) } });
      expect(r.statusCode).toBe(503);
    } finally { await app.close(); }
  });

  it("two core instances sharing the store refuse a request replayed to the other", async () => {
    const fake = new FakeValkey();
    const one = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET, replay: new ValkeyReplayStore(fake) } });
    const two = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET, replay: new ValkeyReplayStore(fake) } });
    try {
      const url = `/v1/tenants/${T}/books`;
      const headers = { [AUTH_HEADER]: signRequest(key, { method: "GET", path: url, tenant: T, principal: OWNER, session: newSession() }) };
      expect((await one.inject({ method: "GET", url, headers })).statusCode).toBe(200);
      const replayed = await two.inject({ method: "GET", url, headers });
      expect(replayed.statusCode).toBe(401);
      expect(replayed.json().error).toBe("replayed");
    } finally { await one.close(); await two.close(); }
  });

  it("selects Valkey from VALKEY_URL / REDIS_URL, else the in-process cache", () => {
    expect(replayStoreFromEnv({}).kind).toBe("memory");
    expect(replayStoreFromEnv({ VALKEY_URL: "rediss://valkey:6379", VALKEY_PASSWORD: "pw" }).kind).toBe("valkey");
    expect(replayStoreFromEnv({ REDIS_URL: "redis://localhost:6379/2" }).kind).toBe("valkey");
    expect(parseValkeyUrl("rediss://:s%40cret@valkey:6380/3")).toEqual({ host: "valkey", port: 6380, tls: true, password: "s@cret", db: 3 });
    expect(parseValkeyUrl("redis://localhost")).toEqual({ host: "localhost", port: 6379, tls: false });
    expect(() => parseValkeyUrl("http://x")).toThrow(/scheme/);
  });

  it("the RESP codec round-trips commands and replies, including split packets", () => {
    expect(encodeCommand(["SET", "k", "1"]).toString()).toBe("*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\n1\r\n");
    expect(parseReply(Buffer.from("+OK\r\n"))).toEqual(["OK", 5]);
    expect(parseReply(Buffer.from("$-1\r\n"))).toEqual([null, 5]);
    expect(parseReply(Buffer.from("_\r\n"))).toEqual([null, 3]);
    expect(parseReply(Buffer.from(":42\r\n"))).toEqual([42, 5]);
    expect(parseReply(Buffer.from("$5\r\nhel"))).toBeNull();
    expect(parseReply(Buffer.from("*2\r\n$1\r\na\r\n:1\r\n"))).toEqual([["a", 1], 15]);
    expect((parseReply(Buffer.from("-WRONGPASS nope\r\n"))![0] as Error).message).toBe("WRONGPASS nope");
  });

  it("the client speaks RESP to a server: AUTH, pipelined SET NX PX, errors, reconnect", async () => {
    // A tiny RESP server with the semantics the store relies on.
    const seen = new Map<string, number>();
    let conns = 0;
    const sockets: import("node:net").Socket[] = [];
    const server: Server = createServer((s) => {
      conns++; sockets.push(s);
      let buf = Buffer.alloc(0), authed = false;
      s.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const r = parseReply(buf);
          if (!r) break;
          buf = buf.subarray(r[1]);
          const [cmd, ...a] = r[0] as string[];
          if (cmd === "AUTH") { authed = a[a.length - 1] === "pw"; s.write(authed ? "+OK\r\n" : "-WRONGPASS invalid password\r\n"); continue; }
          if (!authed) { s.write("-NOAUTH Authentication required.\r\n"); continue; }
          if (cmd === "SET") { if (seen.has(a[0]!)) s.write("$-1\r\n"); else { seen.set(a[0]!, Number(a[4])); s.write("+OK\r\n"); } continue; }
          s.write("-ERR unknown\r\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const store = new ValkeyReplayStore(new ValkeyClient({ host: "127.0.0.1", port, tls: false, password: "pw" }));
      const results = await Promise.all(["n1", "n2", "n1", "n3"].map((n) => store.claim(n, Date.now() + 5000)));
      expect(results).toEqual([true, true, false, true]);
      expect(seen.get("kuber:auth:nonce:n1")).toBeGreaterThan(4000);
      // The server drops the connection: the next claim reconnects (and authenticates again).
      for (const s of sockets) s.destroy();
      await new Promise((r) => setTimeout(r, 20));
      expect(await store.claim("n4", Date.now() + 5000)).toBe(true);
      expect(conns).toBe(2);
      await store.close();
      const wrong = new ValkeyClient({ host: "127.0.0.1", port, tls: false, password: "bad" });
      await expect(wrong.command(["SET", "a", "1", "NX", "PX", "10"])).rejects.toThrow(/WRONGPASS/);
      await wrong.close();
    } finally { await new Promise((r) => server.close(r)); }
  });

  const redis = spawnSync("sh", ["-c", "command -v valkey-server || command -v redis-server"], { encoding: "utf8" }).stdout.trim();
  it.skipIf(!redis)("against a real Valkey/Redis server when one is installed", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const srv: ChildProcess = spawn(redis, ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--requirepass", "pw"], { stdio: "ignore" });
    try {
      const client = new ValkeyClient({ host: "127.0.0.1", port, tls: false, password: "pw" });
      for (let i = 0; i < 50; i++) { try { await client.command(["PING"]); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
      const a = new ValkeyReplayStore(client), b = new ValkeyReplayStore(new ValkeyClient({ host: "127.0.0.1", port, tls: false, password: "pw" }));
      const nonce = newSession();
      expect(await a.claim(nonce, Date.now() + 200)).toBe(true);
      expect(await b.claim(nonce, Date.now() + 200)).toBe(false);
      expect(Number(await client.command(["PTTL", `kuber:auth:nonce:${nonce}`]))).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 300));
      expect(await b.claim(nonce, Date.now() + 200)).toBe(true);                                        // expired with its assertion
      await a.close(); await b.close();
    } finally { srv.kill(); }
  });
});
