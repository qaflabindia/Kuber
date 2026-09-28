/**
 * Identity and authorization (findings F01, F02).
 *   - the core accepts only requests signed by the BFF: unsigned, altered, stale, replayed,
 *     wrong-secret, wrong-issuer/audience and cross-tenant assertions fail with no side effect
 *   - passkeys: first owner of a new workspace, sign-in, invitations; ceremonies cannot be replayed
 *   - roles: table-driven permissions; auditors read only; book scope; maker-checker for period
 *     operations and amounts above the policy limit; MCP grants bounded to their book
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { uuid } from "@kuber/contracts";
import postgres from "postgres";
import { Keyring } from "@kuber/crypto";
import { EventStore } from "@kuber/eventstore";
import { KeyAdmin, buildServer, kuberTools, Copilot, type Cell } from "@kuber/core";
import { AUDIENCE, AUTH_HEADER, ISSUER, ReplayCache, STEP_UP_MAX_AGE_MS, authKey, bodyHash, signRequest, stepUpFresh, verifyRequest } from "@kuber/auth";
import { ACTIONS, Identity, ROLES, can, identityStream, permissionTable } from "@kuber/identity";
import type { Plan } from "@kuber/ops";
import { CORE_AUTH_SECRET, ORIGIN, RP_ID, SoftAuthenticator, b64u, enrol, newSession, signedInject, startCell, type SignedRequest } from "./helpers.ts";

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

  it("carries an optional step-up time inside the MAC, for a signed-in principal only", () => {
    const now = Date.now();
    const c = verify(signRequest(key, { ...base, stepUpAt: now - 1000 }));
    expect(c.su).toBe(now - 1000);
    expect(stepUpFresh(c, now)).toBe(true);
    expect(verify(signRequest(key, base)).su).toBeUndefined();
    expect(verify(signRequest(key, { ...base, principal: null, stepUpAt: now })).su).toBeUndefined();
    expect(stepUpFresh({ principal: "owner:x", su: now - STEP_UP_MAX_AGE_MS - 1 }, now)).toBe(false);   // stale
    expect(stepUpFresh({ principal: "owner:x", su: now + 120_000 }, now)).toBe(false);                   // future-dated
    expect(stepUpFresh({ principal: "owner:x" }, now)).toBe(false);
    expect(stepUpFresh({ principal: null, su: now }, now)).toBe(false);
    // The step-up claim and the session claim travel together.
    const both = verify(signRequest(key, { ...base, session: "s".repeat(24), stepUpAt: now }));
    expect(both).toMatchObject({ sid: "s".repeat(24), su: now });
  });
});

// ---------------------------------------------------------------- permissions (pure)
describe("role permissions", () => {
  // Role model v2: the full role x action matrix is in tests/roles.test.ts. Legacy role names stand for their roles.
  it.each([["owner", "superuser"], ["approver", "superuser"], ["preparer", "staff"], ["member", "staff"], ["controller", "controller"], ["auditor", "auditor"]] as const)(
    "legacy %s may exactly what %s may", (legacy, role) => {
      for (const a of ACTIONS) expect(can(legacy, a)).toBe(can(role, a));
    });
  it("denies unknown roles everything; agents only capture and prepare", () => {
    for (const a of ACTIONS) { expect(can("root", a)).toBe(false); expect(can("agent", a)).toBe(a === "capture" || a === "plan.prepare"); }
    expect(Object.keys(permissionTable())).toEqual([...ROLES]);
  });
});

// ---------------------------------------------------------------- core, end to end
const T = "firm", B = "main", B2 = "restricted";
const P = { owner: "owner:ravi", controller: "controller:asha", controller2: "controller:kiran", preparer: "preparer:dev", approver: "treasurer:meena",
  auditor: "auditor:outsider", member: "member:anu", scoped: "controller:branch", agent: "agent:main-only" };
const clock = { value: "2026-11-25" };
let cell: Cell, app: FastifyInstance, stop: () => Promise<void>, ownerUrl: string;
let send: ReturnType<typeof signedInject>;
const as = (principal: string | null, method: SignedRequest["method"], url: string, payload?: unknown, tenant: string | null = T, stepUpAt?: number) =>
  send({ method, url, tenant, principal, payload, stepUpAt });
const journal = { txnDate: "2026-10-01", narration: "Office rent", lines: [{ accountId: "BANK", credit: "100" }, { accountId: "OPENING", debit: "100" }] };
const recordInput = (amount: string | number = 100) => ({ date: "2026-10-01", narration: "Supplies", amount, direction: "out", account: "BIZEXP", via: "BANK" });
const seq = async (book = B) => (await cell.gl.state(T, book)).seq;
const rebalance = (bank: number) => ({ targets: [{ account: "BANK", pct: bank }, { account: "INVEST", pct: 100 - bank }] });

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
    await expect(cell.ops.commit(T, p.planId, P.approver, p.hash)).rejects.toThrow(/treasurer may not plan.approve.period/);
    // Over HTTP a period operation is a signed command (tests/signed-commands.test.ts): a step-up claim alone is refused.
    const r = await as(P.controller2, "POST", `/v1/tenants/${T}/plans/${p.planId}/commit`, { hash: p.hash }, T, Date.now());
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("step_up_required");
    expect((await cell.ops.commit(T, p.planId, P.controller2, p.hash)).status).toBe("committed");
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

  describe("passkey step-up for sensitive approvals", () => {
    const commit = (who: string, p: { planId: string; hash: string }, stepUpAt?: number) =>
      as(who, "POST", `/v1/tenants/${T}/plans/${p.planId}/commit`, { hash: p.hash }, T, stepUpAt);

    // Signed commands (design 14.4/16.4): the positive path, with real passkey signatures over the
    // command digest, is in tests/signed-commands.test.ts. A step-up claim alone is only the
    // development sign-in fallback, and development sign-in is off here.
    it("a period operation is refused without a signature; a step-up claim alone (stale, future or fresh) does not commit it", async () => {
      const p = await cell.ops.plan(T, B, P.controller, "rebalance", rebalance(60));
      const before = await seq();
      const none = await commit(P.controller2, p);
      expect(none.statusCode).toBe(403);
      expect(p).toMatchObject({ gate: "human", status: "proposed", blocked: false });
      expect(none.json()).toMatchObject({ error: "step_up_required", reason: "this is a period operation", signing: { action: "plan.commit" } });
      const stale = await commit(P.controller2, p, Date.now() - STEP_UP_MAX_AGE_MS - 60_000);
      expect(stale.statusCode).toBe(403);
      expect(stale.json().error).toBe("step_up_required");
      expect((await commit(P.controller2, p, Date.now() + 10 * 60_000)).json().error).toBe("step_up_required");   // future-dated
      expect((await commit(P.controller2, p, Date.now() - 60_000)).json().error).toBe("step_up_required");        // fresh: still not a signature
      expect((await cell.ops.get(T, p.planId)).status).toBe("proposed");
      expect(await seq()).toBe(before);
      await cell.ops.discard(T, p.planId, P.controller);
    });

    it("an amount above the approval limit needs a signature; below it the path is unchanged", async () => {
      await cell.identity.setSettings(T, P.owner, { soloOwner: false, sodLimitPaise: "5000000" });     // ₹50,000
      try {
        const big = await cell.ops.plan(T, B, P.controller, "record", recordInput("60,000"));
        expect((await commit(P.approver, big)).json().error).toBe("step_up_required");
        expect((await commit(P.approver, big, Date.now() - STEP_UP_MAX_AGE_MS - 1000)).json().error).toBe("step_up_required");
        expect((await commit(P.approver, big, Date.now())).json()).toMatchObject({ error: "step_up_required", reason: expect.stringMatching(/above the approval limit/) });
        await cell.ops.discard(T, big.planId, P.controller, { codes: ["not_needed"] });
        const small = await cell.ops.plan(T, B, P.controller, "record", recordInput(500));
        const r = await commit(P.approver, small);
        expect(r.statusCode).toBe(200);
        expect(r.json().status).toBe("committed");
      } finally { await cell.identity.setSettings(T, P.owner, { soloOwner: false, sodLimitPaise: null }); }
    });

    it("someone who may not approve is refused as such, not asked for a passkey", async () => {
      const p = await cell.ops.plan(T, B, P.controller, "rebalance", rebalance(50));
      const r = await commit(P.approver, p);
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("forbidden");
      expect((await commit(P.controller, p, Date.now())).json().message).toMatch(/other than its preparer/);    // step-up does not bypass maker-checker
      await cell.ops.discard(T, p.planId, P.controller);
    });
  });

  describe("member management", () => {
    it("changes book scope in place, and a role by re-keying the principal", async () => {
      await enrol(cell, T, ["preparer:sam"]);
      const url = (p: string) => `/v1/tenants/${T}/members/${encodeURIComponent(p)}`;
      const scoped = await as(P.owner, "PATCH", url("preparer:sam"), { books: [B] });
      expect(scoped.statusCode).toBe(200);
      expect(scoped.json()).toMatchObject({ principal: "preparer:sam", books: [B] });
      expect((await as("preparer:sam", "GET", `/v1/tenants/${T}/books/${B2}/accounts`)).statusCode).toBe(403);
      const promoted = await as(P.owner, "PATCH", url("preparer:sam"), { role: "controller", books: null });
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json()).toMatchObject({ principal: "controller:sam", role: "controller", books: null, status: "active" });
      expect((await as("preparer:sam", "GET", `/v1/tenants/${T}/books`)).statusCode).toBe(403);
      expect((await as("controller:sam", "GET", `/v1/tenants/${T}/books/${B2}/accounts`)).statusCode).toBe(200);
      const list = (await as(P.auditor, "GET", `/v1/tenants/${T}/members`)).json() as { principal: string; status: string; displayName: string }[];
      expect(list.find((m) => m.principal === "preparer:sam")?.status).toBe("revoked");
      expect(list.find((m) => m.principal === "controller:sam")?.displayName).toBe("sam");               // sealed name re-sealed for the successor
      const changes = (await cell.store.readStream(T, identityStream(T))).filter((e) => e.type === "MemberRoleChanged").slice(-2);
      expect(changes.map((e) => e.data)).toMatchObject([
        { principal: "preparer:sam", role: "staff", books: [B], previousRole: "staff", previousBooks: null },
        { principal: "controller:sam", role: "controller", books: null, previousRole: "staff", previousBooks: [B], previousPrincipal: "preparer:sam" },
      ]);
      expect(changes.map((e) => e.meta.principal)).toEqual([P.owner, P.owner]);
      expect((await as(P.owner, "PATCH", url("controller:sam"), {})).statusCode).toBe(400);
      expect((await as(P.owner, "PATCH", url("member:nobody"), { books: null })).statusCode).toBe(404);
      expect((await as(P.owner, "PATCH", url(P.agent), { books: null })).statusCode).toBe(400);
    });

    it("maker-checker follows a person through a role change", async () => {
      await enrol(cell, T, ["controller:lee"]);
      const p = await cell.ops.plan(T, B, "controller:lee", "rebalance", rebalance(55));
      await cell.identity.changeMember(T, P.owner, "controller:lee", { role: "owner" });
      await expect(cell.ops.commit(T, p.planId, "superuser:lee", p.hash)).rejects.toThrow(/other than its preparer \(controller:lee\)/);
      await cell.identity.changeMember(T, P.owner, "superuser:lee", { role: "controller" });              // and back again
      await expect(cell.ops.commit(T, p.planId, "controller:lee", p.hash)).rejects.toThrow(/other than its preparer/);
      await cell.ops.discard(T, p.planId, "controller:lee");
    });

    it("only owners change members; the last owner stays an owner; auditors may list passkeys", async () => {
      const url = `/v1/tenants/${T}/members/${encodeURIComponent(P.controller2)}`;
      expect((await as(P.controller, "PATCH", url, { role: "preparer" })).statusCode).toBe(403);
      expect((await as(P.auditor, "PATCH", url, { role: "preparer" })).statusCode).toBe(403);
      expect((await as(P.owner, "PATCH", url, { role: "root" })).statusCode).toBe(400);
      expect((await as(P.owner, "PATCH", `/v1/tenants/${T}/members/${encodeURIComponent(P.owner)}`, { role: "controller" })).statusCode).toBe(409);
      expect((await as(P.auditor, "GET", `/v1/tenants/${T}/credentials`)).statusCode).toBe(200);
      expect((await as(P.member, "GET", `/v1/tenants/${T}/credentials`)).statusCode).toBe(403);
      expect((await as(P.controller, "POST", `/v1/tenants/${T}/credentials/nope/revoke`, {})).statusCode).toBe(404);     // only their own passkeys
      expect((await as(P.owner, "POST", `/v1/tenants/${T}/credentials/nope/revoke`, {})).statusCode).toBe(404);
    });
  });

  it("only owners manage members and separation settings", async () => {
    expect((await as(P.controller, "POST", `/v1/tenants/${T}/members/invitations`, { role: "preparer", displayName: "New" })).statusCode).toBe(403);
    expect((await as(P.controller, "PUT", `/v1/tenants/${T}/settings/separation`, { soloOwner: true, sodLimitPaise: null })).statusCode).toBe(403);
    expect((await as(P.owner, "PUT", `/v1/tenants/${T}/settings/separation`, { soloOwner: false, sodLimitPaise: null })).statusCode).toBe(200);
    expect((await as(P.owner, "POST", `/v1/tenants/${T}/members/${encodeURIComponent(P.owner)}/revoke`, {})).statusCode).toBe(409);   // last owner
  });
});

// ---------------------------------------------------------------- passkeys with a software authenticator (helpers.ts)
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
    expect(r.json()).toMatchObject({ tenant: W, principal: "superuser:priya-rao", role: "superuser", books: null });
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
    expect(ok.json().principal).toBe("superuser:priya-rao");
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
    const inv = await as("superuser:priya-rao", "POST", `/v1/tenants/${W}/members/invitations`, { role: "auditor", displayName: "CA Firm", books: ["main"] }, W);
    expect(inv.statusCode).toBe(201);
    const { token, principal } = inv.json();
    expect(principal).toBe("auditor:ca-firm");
    const opts = (await ceremony(W, "registration/options", { displayName: "CA Firm", enrolment: token })).json();
    const r = await ceremony(W, "registration/verify", { displayName: "CA Firm", enrolment: token, response: new SoftAuthenticator().create(opts) });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ principal: "auditor:ca-firm", role: "auditor", books: ["main"] });
    expect((await ceremony(W, "registration/options", { displayName: "CA Firm", enrolment: token })).statusCode).toBe(403);
    const me = (await as("auditor:ca-firm", "GET", `/v1/tenants/${W}/me`, undefined, W)).json();
    expect(me.role).toBe("auditor");
    expect(me.permissions).toEqual(["self", "read", "members.read", "agent.turns.read"]);
  });

  it("step-up: re-confirms the signed-in person with their own passkey only", async () => {
    const su = (principal: string, path: string, payload: unknown = {}) => as(principal, "POST", `/v1/tenants/${W}/identity/stepup/${path}`, payload, W);
    const opts = (await su("superuser:priya-rao", "options")).json();
    expect(opts.userVerification).toBe("required");
    expect(opts.allowCredentials.map((c: { id: string }) => c.id)).toEqual([b64u(owner.credId)]);
    const ok = await su("superuser:priya-rao", "verify", { response: owner.get(opts) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().principal).toBe("superuser:priya-rao");
    expect(Math.abs(ok.json().at - Date.now())).toBeLessThan(60_000);
    // Another member's step-up challenge cannot be answered with the owner's passkey, nor a sign-in challenge.
    const theirs = (await su("auditor:ca-firm", "options")).json();
    expect((await su("auditor:ca-firm", "verify", { response: owner.get(theirs) })).statusCode).toBe(401);
    const signin = (await ceremony(W, "authentication/options")).json();
    expect((await su("superuser:priya-rao", "verify", { response: owner.get(signin) })).statusCode).toBe(401);
    // Unauthenticated ceremonies (no principal) cannot step up; nor can the dev path when disabled.
    expect((await ceremony(W, "stepup/options")).statusCode).toBe(401);
    expect((await su("superuser:priya-rao", "verify", { dev: true })).statusCode).toBe(403);
  });

  it("a role change keeps the person's passkey; a revoked passkey no longer signs in", async () => {
    const auditor = new SoftAuthenticator();
    const inv = await cell.identity.invite(W, "superuser:priya-rao", { role: "auditor", displayName: "Second CA" });
    const ro = (await ceremony(W, "registration/options", { displayName: "Second CA", enrolment: inv.token })).json();
    expect((await ceremony(W, "registration/verify", { displayName: "Second CA", enrolment: inv.token, response: auditor.create(ro) })).statusCode).toBe(201);
    const changed = await as("superuser:priya-rao", "PATCH", `/v1/tenants/${W}/members/${encodeURIComponent("auditor:second-ca")}`, { role: "controller" }, W);
    expect(changed.json().principal).toBe("controller:second-ca");
    const creds = (await as("superuser:priya-rao", "GET", `/v1/tenants/${W}/credentials`, undefined, W)).json() as { credentialId: string; principal: string }[];
    expect(creds.find((c) => c.credentialId === b64u(auditor.credId))?.principal).toBe("controller:second-ca");
    const o1 = (await ceremony(W, "authentication/options")).json();
    expect((await ceremony(W, "authentication/verify", { response: auditor.get(o1) })).json().principal).toBe("controller:second-ca");
    expect((await as("superuser:priya-rao", "POST", `/v1/tenants/${W}/credentials/${b64u(auditor.credId)}/revoke`, {}, W)).statusCode).toBe(204);
    expect((await cell.store.readStream(W, identityStream(W))).filter((e) => e.type === "CredentialRevoked").at(-1))
      .toMatchObject({ meta: { principal: "superuser:priya-rao" }, data: { principal: "controller:second-ca", credentialId: b64u(auditor.credId) } });
    const o2 = (await ceremony(W, "authentication/options")).json();
    expect((await ceremony(W, "authentication/verify", { response: auditor.get(o2) })).statusCode).toBe(401);
    expect((await as("controller:second-ca", "POST", `/v1/tenants/${W}/identity/stepup/options`, {}, W)).json().error).toBe("no_passkey");
    // The only owner keeps their last passkey.
    const last = await as("superuser:priya-rao", "POST", `/v1/tenants/${W}/credentials/${b64u(owner.credId)}/revoke`, {}, W);
    expect(last.statusCode).toBe(409);
    expect(last.json().error).toBe("last_owner_passkey");
  });

  it("development sign-in is off unless explicitly enabled, and never takes over a workspace with people", async () => {
    expect((await ceremony("devco", "dev-signin", { name: "Dev User" })).statusCode).toBe(403);
    const dev = new Identity(cell.store, cell.policies, { rpId: RP_ID, origins: [ORIGIN], devSignIn: true });
    expect(await dev.devSignIn("devco", "Dev User")).toMatchObject({ principal: "superuser:dev-user", source: "dev" });
    await expect(dev.devSignIn(W, "Mallory")).rejects.toThrow(/sign in with a passkey/);
  });

  it("a signed-in request must carry a session id; sign-out revokes that session only", async () => {
    const url = `/v1/tenants/${T}/books`;
    const none = await send({ method: "GET", url, tenant: T, principal: P.owner, session: null });
    expect(none.statusCode).toBe(401);
    expect(none.json().error).toBe("no_session");
    const s1 = newSession(), s2 = newSession();
    expect((await send({ method: "GET", url, tenant: T, principal: P.owner, session: s1 })).statusCode).toBe(200);
    expect((await send({ method: "POST", url: `/v1/tenants/${T}/sessions/revoke`, tenant: T, principal: P.owner, session: s1, payload: {} })).statusCode).toBe(204);
    const after = await send({ method: "GET", url, tenant: T, principal: P.owner, session: s1 });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe("session_revoked");
    expect((await send({ method: "GET", url, tenant: T, principal: P.owner, session: s2 })).statusCode).toBe(200);
    // Signing out needs no membership (a removed member can still end their session) but does need a session.
    expect((await send({ method: "POST", url: `/v1/tenants/${T}/sessions/revoke`, tenant: T, principal: null, payload: {} })).statusCode).toBe(401);
    const audit = (await cell.store.readStream(T, identityStream(T))).filter((e) => e.type === "SessionRevoked");
    expect(audit.at(-1)).toMatchObject({ meta: { principal: P.owner }, data: { principal: P.owner } });
    expect(JSON.stringify(audit.at(-1)!.data)).not.toContain(s1);                    // only the hash is recorded
  });

  it("a session is bound to the passkey it signed in with; revoking the passkey ends it and blocks sign-in", async () => {
    const S = "sessco", key = new SoftAuthenticator(), spare = new SoftAuthenticator();
    const reg = (await ceremony(S, "registration/options", { displayName: "Sam Owner" })).json();
    expect((await ceremony(S, "registration/verify", { displayName: "Sam Owner", response: key.create(reg) })).statusCode).toBe(201);
    // A second passkey arrives by invitation to a second person, so the workspace keeps a way in.
    const inv = (await send({ method: "POST", url: `/v1/tenants/${S}/members/invitations`, tenant: S, principal: "superuser:sam-owner", payload: { role: "owner", displayName: "Second Owner" } })).json();
    const o2 = (await ceremony(S, "registration/options", { displayName: "Second Owner", enrolment: inv.token })).json();
    expect((await ceremony(S, "registration/verify", { displayName: "Second Owner", enrolment: inv.token, response: spare.create(o2) })).statusCode).toBe(201);
    // Sign in with a session id the web tier chose; the core binds it to this passkey.
    const sid = newSession();
    const opts = (await ceremony(S, "authentication/options")).json();
    const signedIn = await send({ method: "POST", url: `/v1/tenants/${S}/identity/authentication/verify`, tenant: S, principal: null, session: sid, payload: { response: key.get(opts) } });
    expect(signedIn.json().principal).toBe("superuser:sam-owner");
    const me = () => send({ method: "GET", url: `/v1/tenants/${S}/me`, tenant: S, principal: "superuser:sam-owner", session: sid });
    expect((await me()).statusCode).toBe(200);
    // The same session id cannot be used for another principal.
    expect((await send({ method: "GET", url: `/v1/tenants/${S}/me`, tenant: S, principal: "superuser:second-owner", session: sid })).statusCode).toBe(401);
    const creds = (await me().then(() => send({ method: "GET", url: `/v1/tenants/${S}/me/credentials`, tenant: S, principal: "superuser:sam-owner" }))).json();
    expect(creds).toHaveLength(1);
    // Another owner (members.manage) may revoke it; see the next test for someone who may not.
    expect((await send({ method: "POST", url: `/v1/tenants/${S}/credentials/${creds[0].credentialId}/revoke`, tenant: S, principal: "superuser:second-owner", payload: {} })).statusCode).toBe(204);
    const ended = await me();
    expect(ended.statusCode).toBe(401);
    expect(ended.json().error).toBe("session_revoked");
    const o3 = (await ceremony(S, "authentication/options")).json();
    expect((await ceremony(S, "authentication/verify", { response: key.get(o3) })).statusCode).toBe(401);
    expect((await send({ method: "GET", url: `/v1/tenants/${S}/me/credentials`, tenant: S, principal: "superuser:sam-owner" })).json()[0].revokedAt).not.toBeNull();
    // The whole story is in the identity stream, sealed like every event.
    expect((await cell.store.readStream(S, identityStream(S))).map((e) => e.type)).toEqual([
      "MemberAdded", "CredentialRegistered", "InvitationIssued", "InvitationRedeemed", "MemberAdded", "CredentialRegistered", "CredentialRevoked",
    ]);
  });

  it("a member may revoke only their own passkeys unless they manage members", async () => {
    const [c] = await cell.identity.credentials(W, "superuser:priya-rao");
    expect((await as("auditor:ca-firm", "POST", `/v1/tenants/${W}/credentials/${c!.credentialId}/revoke`, {}, W)).statusCode).toBe(404);
    expect((await cell.identity.credentials(W, "superuser:priya-rao"))[0]!.revokedAt).toBeNull();
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
      expect((await cell.identity.member(T, P.owner))?.role).toBe("superuser");           // other workspaces untouched
    } finally { await owner.end(); }
  });
});
