/**
 * Identity and authorization (findings F01, F02).
 *   - the core accepts only requests signed by the BFF: unsigned, altered, stale, replayed,
 *     wrong-secret, wrong-issuer/audience and cross-tenant assertions fail with no side effect
 *   - passkeys: first owner of a new workspace, sign-in, invitations; ceremonies cannot be replayed
 *   - roles: table-driven permissions; auditors read only; book scope; maker-checker for period
 *     operations and amounts above the policy limit; MCP grants bounded to their book
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { uuid } from "@kuber/contracts";
import postgres from "postgres";
import { Keyring } from "@kuber/crypto";
import { EventStore } from "@kuber/eventstore";
import { KeyAdmin, buildServer, kuberTools, Copilot, type Cell } from "@kuber/core";
import { AUDIENCE, AUTH_HEADER, ISSUER, ReplayCache, authKey, bodyHash, signRequest, verifyRequest } from "@kuber/auth";
import { ACTIONS, Identity, ROLES, can, permissionTable, type Action, type Role } from "@kuber/identity";
import type { Plan } from "@kuber/ops";
import { CORE_AUTH_SECRET, enrol, newSession, signedInject, startCell, type SignedRequest } from "./helpers.ts";

// ---------------------------------------------------------------- request signing (unit)
describe("service assertions (BFF → core)", () => {
  const key = authKey(CORE_AUTH_SECRET);
  const base = { method: "POST", path: "/v1/tenants/t/books/main/journals", body: '{"a":1}', tenant: "t", principal: "owner:x" };
  const verify = (header: string, over: Partial<{ method: string; path: string; body: string; now: number; issuers: string[] }> = {}, replay = new ReplayCache()) =>
    verifyRequest(key, replay, { header, method: over.method ?? base.method, path: over.path ?? base.path, body: over.body ?? base.body, now: over.now, issuers: over.issuers });

  it("accepts an intact assertion once, and binds method, path and exact body bytes", () => {
    const replay = new ReplayCache();
    const h = signRequest(key, base);
    expect(verify(h, {}, replay)).toMatchObject({ tenant: "t", principal: "owner:x", aud: AUDIENCE, iss: ISSUER });
    expect(() => verify(h, {}, replay)).toThrow(/already used/);
    expect(() => verify(signRequest(key, base), { body: '{"a":2}' })).toThrow(/body/);
    expect(() => verify(signRequest(key, base), { body: '{"a": 1}' })).toThrow(/body/);          // same JSON, other bytes
    expect(() => verify(signRequest(key, base), { method: "PUT" })).toThrow(/another request/);
    expect(() => verify(signRequest(key, base), { path: "/v1/tenants/t/books/other/journals" })).toThrow(/another request/);
  });

  it("refuses unsigned, malformed, wrong-key, expired and future-dated assertions", () => {
    expect(() => verify(undefined as unknown as string)).toThrow(/missing/);
    expect(() => verify("Bearer abc")).toThrow(/missing/);
    expect(() => verify(signRequest(authKey("another-secret-of-at-least-32-characters!"), base))).toThrow(/signature/);
    const now = Date.now();
    expect(() => verify(signRequest(key, { ...base, now: now - 120_000 }), { now })).toThrow(/expired/);
    expect(() => verify(signRequest(key, { ...base, now: now + 120_000 }), { now })).toThrow(/future/);
    expect(() => authKey("short")).toThrow(/32/);
  });

  it("checks issuer and audience inside the MAC", () => {
    expect(() => verify(signRequest(key, { ...base, issuer: "someone-else" }))).toThrow(/issuer/);
    // Re-MAC a payload with another audience using the right key: still refused.
    const [, payload] = /^KH1 ([^.]+)\./.exec(signRequest(key, base))!;
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, aud: "kuber-other", nonce: randomBytes(16).toString("base64url") })).toString("base64url");
    const mac = createHmac("sha256", key).update(`kuber-core-auth/v1\n${forged}`).digest("base64url");
    expect(() => verify(`KH1 ${forged}.${mac}`)).toThrow(/not for the core/);
    // Altering any claim without the key breaks the MAC.
    const tampered = Buffer.from(JSON.stringify({ ...claims, principal: "owner:mallory" })).toString("base64url");
    expect(() => verify(`KH1 ${tampered}.${signRequest(key, base).split(".")[1]}`)).toThrow(/signature/);
    expect(bodyHash(undefined)).toBe(bodyHash(""));
  });
});

// ---------------------------------------------------------------- permissions (pure)
describe("role permissions", () => {
  const expected: Record<Role, Action[]> = {
    owner: [...ACTIONS],
    controller: ACTIONS.filter((a) => a !== "members.manage" && a !== "settings.manage"),
    preparer: ["read", "capture", "plan.prepare", "copilot"],
    approver: ["read", "draft.decide", "journal.ratify", "plan.prepare", "plan.approve", "plan.discard", "copilot"],
    auditor: ["read", "members.read"],
    member: ["read", "capture", "plan.prepare", "copilot"],
  };
  it.each(ROLES.flatMap((r) => ACTIONS.map((a) => [r, a] as const)))("%s may %s: as specified", (role, action) => {
    expect(can(role, action)).toBe(expected[role].includes(action));
  });
  it("denies unknown roles and agents everything", () => {
    for (const a of ACTIONS) { expect(can("agent", a)).toBe(false); expect(can("root", a)).toBe(false); }
    expect(Object.keys(permissionTable())).toEqual([...ROLES]);
  });
});

// ---------------------------------------------------------------- core, end to end
const T = "firm", B = "main", B2 = "restricted";
const P = { owner: "owner:ravi", controller: "controller:asha", controller2: "controller:kiran", preparer: "preparer:dev", approver: "approver:meena",
  auditor: "auditor:outsider", member: "member:anu", scoped: "controller:branch", agent: "agent:main-only" };
const clock = { value: "2026-11-25" };
let cell: Cell, app: FastifyInstance, stop: () => Promise<void>, ownerUrl: string;
let send: ReturnType<typeof signedInject>;
const as = (principal: string | null, method: SignedRequest["method"], url: string, payload?: unknown, tenant: string | null = T) =>
  send({ method, url, tenant, principal, payload });
const journal = { txnDate: "2026-10-01", narration: "Office rent", lines: [{ accountId: "BANK", credit: "100" }, { accountId: "OPENING", debit: "100" }] };
const recordInput = (amount: string | number = 100) => ({ date: "2026-10-01", narration: "Supplies", amount, direction: "out", account: "BIZEXP", via: "BANK" });
const seq = async (book = B) => (await cell.gl.state(T, book)).seq;

beforeAll(async () => {
  let db: { ownerUrl: string };
  ({ cell, stop, db } = await startCell(clock));
  ownerUrl = db.ownerUrl;
  await enrol(cell, T, [P.owner, P.controller, P.controller2, P.preparer, P.approver, P.auditor, P.member]);
  await enrol(cell, T, [P.scoped], [B]);
  await enrol(cell, T, [P.agent], [B]);
  for (const b of [B, B2]) {
    await cell.gl.openBook(T, b, T, "company", P.owner);
    await cell.gl.execute(T, b, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: "Opening", voucherType: "opening",
      lines: [{ accountId: "BANK", amount: "100000000", dimensions: {} }, { accountId: "OPENING", amount: "-100000000", dimensions: {} }] }, { principal: P.owner });
  }
  await cell.settle();
  app = buildServer(cell, { clock: () => clock.value, auth: { secret: CORE_AUTH_SECRET } });
  send = signedInject(app);
});
afterAll(async () => { await app.close(); await stop(); });

describe("F01: the core authenticates every request", () => {
  it("A01 fixed: an unsigned caller claiming a principal cannot post", async () => {
    const before = await seq();
    const r = await app.inject({ method: "POST", url: `/v1/tenants/${T}/books/${B}/journals`,
      headers: { "x-kuber-tenant": T, "x-kuber-principal": P.owner }, payload: journal });
    expect(r.statusCode).toBe(401);
    expect(await seq()).toBe(before);
  });

  it("refuses wrong secret, replay, altered body and cross-tenant assertions without side effects", async () => {
    const before = await seq();
    const url = `/v1/tenants/${T}/books/${B}/journals`;
    expect((await signedInject(app, "not-the-core-secret-but-long-enough-0123")({ method: "POST", url, tenant: T, principal: P.owner, payload: journal })).statusCode).toBe(401);
    const body = JSON.stringify(journal);
    const header = signRequest(authKey(CORE_AUTH_SECRET), { method: "POST", path: url, body, tenant: T, principal: P.controller, session: newSession() });
    const once = await app.inject({ method: "POST", url, headers: { [AUTH_HEADER]: header, "content-type": "application/json" }, payload: body });
    expect(once.statusCode).toBe(201);
    const replayed = await app.inject({ method: "POST", url, headers: { [AUTH_HEADER]: header, "content-type": "application/json" }, payload: body });
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json().error).toBe("replayed");
    const altered = await app.inject({ method: "POST", url, headers: { [AUTH_HEADER]: signRequest(authKey(CORE_AUTH_SECRET), { method: "POST", path: url, body, tenant: T, principal: P.controller, session: newSession() }), "content-type": "application/json" },
      payload: JSON.stringify({ ...journal, narration: "Altered in transit" }) });
    expect(altered.statusCode).toBe(401);
    expect((await as(P.owner, "POST", url, journal, "other-tenant")).statusCode).toBe(403);
    expect(await seq()).toBe(before + 1);                                     // only the one genuine request posted
  });

  it("a server without the shared secret refuses everything but health", async () => {
    const bare = buildServer(cell);
    try {
      expect((await signedInject(bare)({ method: "GET", url: `/v1/tenants/${T}/books`, tenant: T, principal: P.owner })).statusCode).toBe(401);
      expect((await bare.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    } finally { await bare.close(); }
  });

  it("a signed request for a non-member or a revoked member is refused", async () => {
    expect((await as("owner:stranger", "GET", `/v1/tenants/${T}/books`)).statusCode).toBe(403);
    await enrol(cell, T, ["member:leaver"]);
    expect((await as("member:leaver", "GET", `/v1/tenants/${T}/books`)).statusCode).toBe(200);
    expect((await as(P.owner, "POST", `/v1/tenants/${T}/members/${encodeURIComponent("member:leaver")}/revoke`, {})).statusCode).toBe(204);
    expect((await as("member:leaver", "GET", `/v1/tenants/${T}/books`)).statusCode).toBe(403);
  });

  it("a principal must match its membership role: the prefix is not a claim", async () => {
    // asha is a controller; "owner:asha" is a different, non-existent principal.
    expect((await as("owner:asha", "POST", `/v1/tenants/${T}/members/invitations`, { role: "owner", displayName: "Me again" })).statusCode).toBe(403);
  });
});

describe("F02: roles, book scope and maker-checker", () => {
  const url = `/v1/tenants/${T}/books/${B}/journals`;
  it.each([
    ["owner", 201], ["controller", 201], ["preparer", 403], ["approver", 403], ["auditor", 403], ["member", 403],
  ] as const)("direct journal as %s → %i", async (role, status) => {
    const before = await seq();
    const r = await as(P[role], "POST", url, journal);
    expect(r.statusCode).toBe(status);
    expect(await seq()).toBe(before + (status === 201 ? 1 : 0));
  });

  it.each(["owner", "controller", "preparer", "approver", "auditor", "member"] as const)("%s can read reports", async (role) => {
    expect((await as(P[role], "GET", `/v1/tenants/${T}/books/${B}/reports/trial-balance`)).statusCode).toBe(200);
  });

  it("auditors are read-only: no plan, capture, lock, rule or member changes", async () => {
    const a = P.auditor;
    expect((await as(a, "POST", `/v1/tenants/${T}/books/${B}/ops/record`, recordInput())).statusCode).toBe(403);
    expect((await as(a, "POST", `/v1/tenants/${T}/books/${B}/ops/dashboard`, {})).statusCode).toBe(200);   // read operation
    expect((await as(a, "POST", `/v1/tenants/${T}/books/${B}/chat`, { text: "Paid 450 cash" })).statusCode).toBe(403);
    expect((await as(a, "POST", `/v1/tenants/${T}/books/${B}/locks`, { periodEnd: "2026-09-30", level: "soft" })).statusCode).toBe(403);
    expect((await as(a, "POST", `/v1/tenants/${T}/rules`, { pattern: "AWS", accountId: "LIVING" })).statusCode).toBe(403);
    expect((await as(a, "POST", `/v1/tenants/${T}/books/${B}/copilot`, { text: "Close FY 2026-27" })).statusCode).toBe(403);
    expect((await as(a, "POST", `/v1/tenants/${T}/members/invitations`, { role: "auditor", displayName: "Friend" })).statusCode).toBe(403);
    expect((await as(a, "GET", `/v1/tenants/${T}/members`)).statusCode).toBe(200);
  });

  it("A10 fixed: an auditor member can neither prepare nor approve a write plan", async () => {
    await expect(cell.ops.plan(T, B, P.auditor, "record", recordInput())).rejects.toThrow(/auditor may not plan.prepare/);
    const p = await cell.ops.plan(T, B, P.preparer, "record", recordInput());
    await expect(cell.ops.commit(T, p.planId, P.auditor, p.hash)).rejects.toThrow(/auditor may not plan.approve/);
    await expect(cell.ops.commit(T, p.planId, P.preparer, p.hash)).rejects.toThrow(/preparer may not plan.approve/);
    expect((await cell.ops.commit(T, p.planId, P.approver, p.hash)).status).toBe("committed");
  });

  it("maker-checker: a period operation needs someone other than its preparer", async () => {
    const p = await cell.ops.plan(T, B, P.controller, "close", { periodEnd: "2026-09-30" });
    expect(p.blocked).toBe(false);
    await expect(cell.ops.commit(T, p.planId, P.controller, p.hash)).rejects.toThrow(/period operation: it needs approval by someone other than its preparer/);
    await expect(cell.ops.commit(T, p.planId, P.approver, p.hash)).rejects.toThrow(/approver may not plan.approve.period/);
    const r = await as(P.controller2, "POST", `/v1/tenants/${T}/plans/${p.planId}/commit`, { hash: p.hash });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("committed");
  });

  it("maker-checker: above the policy's amount limit the preparer cannot approve; below it they can", async () => {
    const small = await cell.ops.plan(T, B, P.controller, "record", recordInput(500));
    expect((await cell.ops.commit(T, small.planId, P.controller, small.hash)).status).toBe("committed");
    // The policy's own limit (POL-502: ₹25,000 for recorded transactions) applies by default.
    const overPolicy = await cell.ops.plan(T, B, P.controller, "record", recordInput("30,000"));
    await expect(cell.ops.commit(T, overPolicy.planId, P.controller, overPolicy.hash)).rejects.toThrow(/above the approval limit of ₹25,000/);
    await cell.ops.discard(T, overPolicy.planId, P.controller);
    // A tenant setting can set its own limit.
    await cell.identity.setSettings(T, P.owner, { soloOwner: false, sodLimitPaise: "5000000" });     // ₹50,000
    const big = await cell.ops.plan(T, B, P.controller, "record", recordInput("60,000"));
    await expect(cell.ops.commit(T, big.planId, P.controller, big.hash)).rejects.toThrow(/above the approval limit of ₹50,000/);
    const res = await as(P.controller, "POST", `/v1/tenants/${T}/plans/${big.planId}/commit`, { hash: big.hash });
    expect(res.statusCode).toBe(403);
    expect((await cell.ops.commit(T, big.planId, P.approver, big.hash)).status).toBe("committed");
    await cell.identity.setSettings(T, P.owner, { soloOwner: false, sodLimitPaise: null });
  });

  it("the copilot prepares for the person who asked, so they cannot approve it themselves where separation applies", async () => {
    const r = await new Copilot(cell, null, null, () => clock.value).ask({ tenant: T, book: B, principal: P.controller }, "Rebalance BANK 70 INVEST 30");
    const p = r.cards[0]! as Plan;
    expect(p).toMatchObject({ op: "rebalance", gate: "human", status: "proposed", createdBy: "agent:copilot", requestedBy: P.controller });
    await expect(cell.ops.commit(T, p.planId, P.controller, p.hash)).rejects.toThrow(/other than its preparer/);
    await expect(cell.ops.commit(T, p.planId, "agent:copilot", p.hash)).rejects.toThrow(/copilot proposes/);
    // Acting for an auditor, the copilot can neither prepare a write plan nor capture an entry.
    const copilot = new Copilot(cell, null, null, () => clock.value), auditor = { tenant: T, book: B, principal: P.auditor };
    const byAuditor = await copilot.ask(auditor, "Reconcile bank to 1,000 as of 31 Oct 2026");
    expect(byAuditor.cards).toHaveLength(0);
    expect(byAuditor.reply).toMatch(/auditor may not plan.prepare/);
    await expect(copilot.ask(auditor, "Paid 450 to the plumber in cash")).rejects.toThrow(/auditor may not capture/);
  });

  it("the single-owner exception is explicit and lapses when a second person joins", async () => {
    const solo = "solo";
    await enrol(cell, solo, ["owner:lone"]);
    await cell.gl.openBook(solo, B, solo, "individual", "owner:lone");
    await cell.settle();
    const p = await cell.ops.plan(solo, B, "owner:lone", "close", { periodEnd: "2026-09-30" });
    await expect(cell.ops.commit(solo, p.planId, "owner:lone", p.hash)).rejects.toThrow(/other than its preparer/);
    await cell.identity.setSettings(solo, "owner:lone", { soloOwner: true, sodLimitPaise: null });
    const q = await cell.ops.plan(solo, B, "owner:lone", "close", { periodEnd: "2026-09-30" });
    await enrol(cell, solo, ["member:partner"]);
    await expect(cell.ops.commit(solo, q.planId, "owner:lone", q.hash)).rejects.toThrow(/other than its preparer/);
    await cell.identity.revoke(solo, "owner:lone", "member:partner");
    expect((await cell.ops.commit(solo, q.planId, "owner:lone", q.hash)).status).toBe("committed");
  });

  it("book scope: a member limited to one book cannot read, plan or commit in another", async () => {
    expect((await as(P.scoped, "GET", `/v1/tenants/${T}/books/${B}/accounts`)).statusCode).toBe(200);
    expect((await as(P.scoped, "GET", `/v1/tenants/${T}/books/${B2}/accounts`)).statusCode).toBe(403);
    expect((await as(P.scoped, "GET", `/v1/tenants/${T}/books`)).json().map((b: { book_id: string }) => b.book_id)).toEqual([B]);
    expect((await as(P.scoped, "POST", `/v1/tenants/${T}/books/${B2}/journals`, journal)).statusCode).toBe(403);
    expect((await as(P.scoped, "GET", `/v1/tenants/${T}/evidence?q=x`)).statusCode).toBe(403);           // tenant-wide
    const other = await cell.ops.plan(T, B2, P.preparer, "record", recordInput());
    expect((await as(P.scoped, "GET", `/v1/tenants/${T}/plans/${other.planId}`)).statusCode).toBe(403);
    expect((await as(P.scoped, "POST", `/v1/tenants/${T}/plans/${other.planId}/commit`, { hash: other.hash })).statusCode).toBe(403);
    await expect(cell.ops.plan(T, B2, P.scoped, "record", recordInput())).rejects.toThrow(/no access to book restricted/);
    expect((await cell.ops.get(T, other.planId)).status).toBe("proposed");
  });

  it("A12 fixed: a book-scoped MCP agent cannot commit another book's plan, even with its id and hash", async () => {
    const plan = await cell.ops.plan(T, B2, P.preparer, "record", recordInput());
    expect(plan.needsPerson).toBe(false);
    const commit = kuberTools(cell, { tenant: T, book: B, principal: P.agent }).find((t) => t.name === "kuber_commit")!;
    await expect(commit.run({ planId: plan.planId, hash: plan.hash })).rejects.toThrow(/not in book main/);
    await expect(cell.ops.commit(T, plan.planId, P.agent, plan.hash)).rejects.toThrow(/not granted book restricted/);
    await expect(cell.ops.commit(T, plan.planId, "agent:unregistered", plan.hash)).rejects.toThrow(/no grant/);
    expect(await seq(B2)).toBe(1);
    // In its own book the grant still works as policy allows.
    const own = await kuberTools(cell, { tenant: T, book: B, principal: P.agent }).find((t) => t.name === "kuber_record")!.run(recordInput());
    const r = await commit.run({ planId: own.plan!.planId, hash: own.plan!.hash });
    expect(r.text).toMatch(/Committed/);
  });

  it("only owners manage members and separation settings", async () => {
    expect((await as(P.controller, "POST", `/v1/tenants/${T}/members/invitations`, { role: "preparer", displayName: "New" })).statusCode).toBe(403);
    expect((await as(P.controller, "PUT", `/v1/tenants/${T}/settings/separation`, { soloOwner: true, sodLimitPaise: null })).statusCode).toBe(403);
    expect((await as(P.owner, "PUT", `/v1/tenants/${T}/settings/separation`, { soloOwner: false, sodLimitPaise: null })).statusCode).toBe(200);
    expect((await as(P.owner, "POST", `/v1/tenants/${T}/members/${encodeURIComponent(P.owner)}/revoke`, {})).statusCode).toBe(409);   // last owner
  });
});

// ---------------------------------------------------------------- passkeys with a software authenticator
const ORIGIN = "http://localhost:3000", RP_ID = "localhost";
const b64u = (b: Uint8Array | Buffer | string) => Buffer.from(b as Uint8Array).toString("base64url");
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n])
    : n < 65536 ? Buffer.from([(major << 5) | 25, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b; })();
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  const o = v as Record<string, unknown>;
  return Buffer.concat([head(5, Object.keys(o).length), ...Object.entries(o).flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
class SoftAuthenticator {
  private key: KeyObject; readonly credId = randomBytes(32); private count = 0; readonly cose: Buffer;
  constructor(private origin = ORIGIN) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  }
  private authData(flags: number, attested?: Buffer) {
    const c = Buffer.alloc(4); c.writeUInt32BE(this.count);
    return Buffer.concat([createHash("sha256").update(RP_ID).digest(), Buffer.from([flags]), c, ...(attested ? [attested] : [])]);
  }
  create(options: { challenge: string }) {
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const authData = this.authData(0x45, Buffer.concat([Buffer.alloc(16), len, this.credId, this.cose]));
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor({ fmt: "none", attStmt: {}, authData })), transports: ["internal"] } };
  }
  get(options: { challenge: string }) {
    this.count++;
    const authData = this.authData(0x05);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signature = createSign("sha256").update(Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()])).sign(this.key);
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) } };
  }
}

describe("passkeys", () => {
  const W = "newco";
  const ceremony = (tenant: string, path: string, payload: unknown = {}) => as(null, "POST", `/v1/tenants/${tenant}/identity/${path}`, payload, tenant);
  const owner = new SoftAuthenticator();

  it("registers the first owner of a new workspace, and only once", async () => {
    const opts = (await ceremony(W, "registration/options", { displayName: "Priya Rao" })).json();
    expect(opts.rp.id).toBe(RP_ID);
    expect(opts.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    const r = await ceremony(W, "registration/verify", { displayName: "Priya Rao", response: owner.create(opts) });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ tenant: W, principal: "owner:priya-rao", role: "owner", books: null });
    const again = await ceremony(W, "registration/options", { displayName: "Someone Else" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("workspace_taken");
    // The same challenge cannot register a second passkey.
    const replay = await ceremony(W, "registration/verify", { displayName: "Priya Rao", response: new SoftAuthenticator().create(opts) });
    expect(replay.statusCode).toBeGreaterThanOrEqual(401);
  });

  it("an existing workspace with data but no members cannot be claimed by registering", async () => {
    const r = await ceremony("legacy", "registration/options", { displayName: "Claimer" });
    expect(r.statusCode).toBe(200);                                              // empty: claimable
    await cell.gl.openBook("legacy", B, "legacy", "individual", "owner:old");
    const taken = await ceremony("legacy", "registration/options", { displayName: "Claimer" });
    expect(taken.statusCode).toBe(409);
  });

  it("signs in with the passkey; refuses a replayed assertion, another origin and an unknown credential", async () => {
    const opts = (await ceremony(W, "authentication/options")).json();
    expect(opts.userVerification).toBe("required");
    const assertion = owner.get(opts);
    const ok = await ceremony(W, "authentication/verify", { response: assertion });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().principal).toBe("owner:priya-rao");
    expect((await ceremony(W, "authentication/verify", { response: assertion })).statusCode).toBe(401);
    const o2 = (await ceremony(W, "authentication/options")).json();
    expect((await ceremony(W, "authentication/verify", { response: new SoftAuthenticator().get(o2) })).statusCode).toBe(401);
    const o3 = (await ceremony(W, "authentication/options")).json();
    const phished = new SoftAuthenticator("https://evil.example");
    expect((await ceremony(W, "authentication/verify", { response: { ...phished.get(o3), id: b64u(owner.credId), rawId: b64u(owner.credId) } })).statusCode).toBe(401);
    // A challenge issued for another workspace does not work here.
    const foreign = (await ceremony("elsewhere", "authentication/options")).json();
    expect((await ceremony(W, "authentication/verify", { response: owner.get(foreign) })).statusCode).toBe(401);
  });

  it("the owner invites an auditor limited to one book; the code works once", async () => {
    const inv = await as("owner:priya-rao", "POST", `/v1/tenants/${W}/members/invitations`, { role: "auditor", displayName: "CA Firm", books: ["main"] }, W);
    expect(inv.statusCode).toBe(201);
    const { token, principal } = inv.json();
    expect(principal).toBe("auditor:ca-firm");
    const opts = (await ceremony(W, "registration/options", { displayName: "CA Firm", enrolment: token })).json();
    const r = await ceremony(W, "registration/verify", { displayName: "CA Firm", enrolment: token, response: new SoftAuthenticator().create(opts) });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ principal: "auditor:ca-firm", role: "auditor", books: ["main"] });
    expect((await ceremony(W, "registration/options", { displayName: "CA Firm", enrolment: token })).statusCode).toBe(403);
    expect((await as("auditor:ca-firm", "GET", `/v1/tenants/${W}/me`, undefined, W)).json().role).toBe("auditor");
  });

  it("development sign-in is off unless explicitly enabled, and never takes over a workspace with people", async () => {
    expect((await ceremony("devco", "dev-signin", { name: "Dev User" })).statusCode).toBe(403);
    const dev = new Identity(cell.store, cell.policies, { rpId: RP_ID, origins: [ORIGIN], devSignIn: true });
    expect(await dev.devSignIn("devco", "Dev User")).toMatchObject({ principal: "owner:dev-user", source: "dev" });
    await expect(dev.devSignIn(W, "Mallory")).rejects.toThrow(/sign in with a passkey/);
  });

  it("crypto-shredding a workspace removes its members, passkeys, invitations and settings", async () => {
    const G = "gone";
    const opts = (await ceremony(G, "registration/options", { displayName: "Leaving Owner" })).json();
    expect((await ceremony(G, "registration/verify", { displayName: "Leaving Owner", response: new SoftAuthenticator().create(opts) })).statusCode).toBe(201);
    await cell.identity.invite(G, "owner:leaving-owner", { role: "auditor", displayName: "Their CA" });
    await cell.identity.setSettings(G, "owner:leaving-owner", { soloOwner: true, sodLimitPaise: null });
    await cell.gl.openBook(G, B, G, "individual", "owner:leaving-owner");
    const owner = postgres(ownerUrl, { max: 2, onnotice: () => undefined });
    try {
      const count = async () => Object.fromEntries(await Promise.all(["members", "credentials", "enrolments", "settings"].map(async (t) =>
        [t, (await owner.unsafe(`SELECT count(*)::int AS n FROM identity.${t} WHERE tenant_id = $1`, [G]))[0]!.n as number])));
      expect(await count()).toEqual({ members: 1, credentials: 1, enrolments: 1, settings: 1 });
      const keyring = new Keyring(owner, cell.keyring.kms, 0);
      await new KeyAdmin(owner, keyring, new EventStore(owner, "admin", { keyring }), 0).shred(G, "operator:test", "erasure request");
      expect(await count()).toEqual({ members: 0, credentials: 0, enrolments: 0, settings: 0 });
      expect((await cell.identity.member(T, P.owner))?.role).toBe("owner");           // other workspaces untouched
    } finally { await owner.end(); }
  });
});
