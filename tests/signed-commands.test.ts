/**
 * Signed commands (design 14.4 and 16.4): high-risk commands are signed on the device.
 *   - the WebAuthn challenge is the digest of the command (tenant, book, subject, subject hash,
 *     action, principal, single-use nonce with a short expiry, the hash of the summary shown)
 *   - the signing options carry a summary rendered from the command itself (amount, payee, accounts, book)
 *   - the assertion is verified with user verification, by the member's own active passkey, and
 *     stored in the resulting event in the same transaction; an offline verifier re-checks it
 *     against the stored public key and the event (ops verify-signatures, evidence records)
 *   - an assertion for plan A cannot approve plan B, cannot be reused, and expires
 *   - without an assertion only development sign-in may fall back to the `su` claim
 *   - owners and controllers with one passkey are warned; `requireTwoAuthenticators` refuses them;
 *     recovery of an existing member is an audited identity event
 * Real assertions: an ES256 software authenticator (tests/helpers.ts) signs the digest.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { uuid, type CommandSignature, type Envelope } from "@kuber/contracts";
import { OpsAdmin, buildServer, type Cell } from "@kuber/core";
import { DEV_STEP_UP_NOTE, Identity, identityStream } from "@kuber/identity";
import type { Plan } from "@kuber/ops";
import { CORE_AUTH_SECRET, ORIGIN, ROOT, RP_ID, SoftAuthenticator, b64u, enrol, signedInject, startCell, type SignedRequest } from "./helpers.ts";

const T = "signco", B = "main", F = "free";
const P = { owner: "superuser:ravi", asha: "controller:asha", kiran: "controller:kiran", meena: "treasurer:meena", preparer: "preparer:dev" };
const clock = { value: "2026-11-25" };
let nowMs: number | undefined;
let cell: Cell, app: FastifyInstance, stop: () => Promise<void>, ownerUrl: string;
let send: ReturnType<typeof signedInject>;
const keys: Record<string, SoftAuthenticator> = {};
type Signed = Extract<CommandSignature, { kind: "webauthn" }>;
interface SigningOptions {
  required: boolean; reason: string | null; digest: string; expiresAt: string;
  options: { challenge: string; userVerification: string; allowCredentials: { id: string }[] };
  inputs: Signed["inputs"]; summary: Signed["summary"];
}

const as = (principal: string | null, method: SignedRequest["method"], url: string, payload?: unknown, stepUpAt?: number) =>
  send({ method, url: `/v1/tenants/${T}${url}`, tenant: T, principal, payload, stepUpAt });
const ceremony = (path: string, payload: unknown) => as(null, "POST", `/identity/${path}`, payload);
async function signingOptions(principal: string, body: unknown): Promise<SigningOptions> {
  const r = await as(principal, "POST", "/signing/options", body);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
/** Ask for the command's signing options and sign them with `by`'s authenticator (default: the principal's own). */
async function sign(principal: string, body: unknown, by = keys[principal]!) {
  const o = await signingOptions(principal, body);
  expect(o.required).toBe(true);
  return { o, assertion: by.get(o.options) };
}
/** Register a passkey for an invited person (the ceremony the sign-in page runs). */
async function register(principal: string, displayName: string) {
  const inv = await cell.identity.invite(T, P.owner, { role: principal.split(":")[0] as "controller", displayName, principal });
  const auth = new SoftAuthenticator();
  const o = (await ceremony("registration/options", { displayName, enrolment: inv.token })).json();
  expect((await ceremony("registration/verify", { displayName, enrolment: inv.token, response: auth.create(o) })).statusCode).toBe(201);
  keys[principal] = auth;
}
const planEvents = (planId: string) => cell.store.readStream(T, `${T}/plan/${planId}`);
const rebalance = (bank: number) => ({ targets: [{ account: "BANK", pct: bank }, { account: "INVEST", pct: 100 - bank }] });
const commit = (principal: string, p: Pick<Plan, "planId" | "hash">, extra: Record<string, unknown> = {}, stepUpAt?: number) =>
  as(principal, "POST", `/plans/${p.planId}/commit`, { hash: p.hash, ...extra }, stepUpAt);

beforeAll(async () => {
  let db: { ownerUrl: string };
  ({ cell, stop, db } = await startCell(clock, { identity: { now: () => nowMs ?? Date.now() } }));
  ownerUrl = db.ownerUrl;
  app = buildServer(cell, { clock: () => clock.value, auth: { secret: CORE_AUTH_SECRET } });
  send = signedInject(app);
  // The first owner claims the empty workspace with a passkey; the others are invited and register theirs.
  keys[P.owner] = new SoftAuthenticator();
  const o = (await ceremony("registration/options", { displayName: "Ravi" })).json();
  expect((await ceremony("registration/verify", { displayName: "Ravi", response: keys[P.owner]!.create(o) })).json().principal).toBe(P.owner);
  await register(P.asha, "Asha");
  await register(P.kiran, "Kiran");
  await register(P.meena, "Meena");
  await enrol(cell, T, [P.preparer]);                               // prepares plans; never signs
  await cell.gl.openBook(T, B, T, "company", P.owner);
  await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: "Opening", voucherType: "opening",
    lines: [{ accountId: "BANK", amount: "100000000", dimensions: {} }, { accountId: "OPENING", amount: "-100000000", dimensions: {} }] }, { principal: P.owner });
  await cell.settle();
});
afterAll(async () => { await app.close(); await stop(); });

let signedPlan: { planId: string; approved: Envelope };

describe("command-bound passkey signatures", () => {
  it("a step-up-class plan commits only with a passkey signature over it; the assertion is stored with PlanApproved and verifies offline", async () => {
    const p = await cell.ops.plan(T, B, P.preparer, "rebalance", rebalance(60));
    expect(p).toMatchObject({ gate: "human", status: "proposed" });
    const refused = await commit(P.kiran, p);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", reason: "this is a period operation", signing: { action: "plan.commit" } });

    const { o, assertion } = await sign(P.kiran, { action: "plan.commit", planId: p.planId, hash: p.hash });
    // The challenge IS the digest of the command; only Kiran's own passkey may answer; user verification required.
    expect(o.inputs).toMatchObject({ v: 1, tenant: T, book: B, action: "plan.commit", subject: p.planId, subjectHash: p.hash, principal: P.kiran });
    expect(o.options.challenge).toBe(Buffer.from(o.digest, "hex").toString("base64url"));
    expect(o.options.userVerification).toBe("required");
    expect(o.options.allowCredentials.map((c) => c.id)).toEqual([b64u(keys[P.kiran]!.credId)]);
    expect(Date.parse(o.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    // The summary is rendered from the plan: amount, accounts with debits and credits, book.
    expect(o.summary).toMatchObject({ action: "plan.commit", book: B, amountPaise: "40000000", title: p.title });
    expect(o.summary.accounts).toEqual([
      { accountId: "BANK", name: expect.any(String), debitPaise: "0", creditPaise: "40000000" },
      { accountId: "INVEST", name: expect.any(String), debitPaise: "40000000", creditPaise: "0" }]);
    expect(o.summary.lines.join("\n")).toMatch(/Amount ₹4,00,000/);

    const before = (await cell.gl.state(T, B)).seq;
    const ok = await commit(P.kiran, p, { assertion });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe("committed");
    expect((await cell.gl.state(T, B)).seq).toBe(before + 1);

    const approved = (await planEvents(p.planId)).find((e) => e.type === "PlanApproved")!;
    expect(approved.meta.principal).toBe(P.kiran);
    expect(approved.data).toMatchObject({ planId: p.planId, hash: p.hash, signature: {
      kind: "webauthn", digest: o.digest, inputs: o.inputs, summary: o.summary, credentialId: b64u(keys[P.kiran]!.credId),
      authenticatorData: assertion.response.authenticatorData, clientDataJSON: assertion.response.clientDataJSON, signature: assertion.response.signature,
      rpId: RP_ID, origin: ORIGIN } });
    signedPlan = { planId: p.planId, approved };

    const report = await cell.identity.verifySignatures(T);
    expect(report).toMatchObject({ checked: 1, valid: 1, failures: [], devStepUps: [], unsignedPeriodOps: [] });

    // The evidence record of the committed action carries the signature, re-verified.
    await cell.settle();
    const ev = await cell.evidence.find(T, p.planId);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.record.approval.signature).toMatchObject({ kind: "webauthn", digest: o.digest, credentialId: b64u(keys[P.kiran]!.credId), verified: true });
    expect(ev[0]!.verified).toEqual({ recordHash: true, citations: true, signature: true });
  });

  it("a tampered stored assertion fails the offline verifier", async () => {
    const { approved } = signedPlan;
    const sig = (approved.data as { signature: Signed }).signature;
    const check = (s: Signed, env: Envelope = approved) => cell.identity.verifyStoredSignature(T, env, s);
    expect(await check(sig)).toEqual([]);
    const flip = (v: string) => { const b = Buffer.from(v, "base64url"); b[b.length - 1]! ^= 0x01; return b.toString("base64url"); };
    expect((await check({ ...sig, signature: flip(sig.signature) })).join("; ")).toMatch(/does not verify/);
    expect((await check({ ...sig, summary: { ...sig.summary, amountPaise: "1" } })).join("; ")).toMatch(/summary does not match/);
    expect((await check({ ...sig, inputs: { ...sig.inputs, subject: uuid() } })).join("; ")).toMatch(/digest does not match.*subject/);
    const auth = Buffer.from(sig.authenticatorData, "base64url"); auth[32] = auth[32]! & ~0x04;                       // user verification flag cleared
    expect((await check({ ...sig, authenticatorData: auth.toString("base64url") })).join("; ")).toMatch(/verification/);
    expect((await check({ ...sig, clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64u(Buffer.alloc(32)), origin: ORIGIN })).toString("base64url") })).join("; "))
      .toMatch(/not the command digest/);
    // The same signature stored on another command's event does not verify for it.
    expect((await check(sig, { ...approved, data: { ...approved.data, hash: "f".repeat(64) } } as Envelope)).join("; ")).toMatch(/subjectHash/);
    expect((await check(sig, { ...approved, meta: { ...approved.meta, principal: P.asha } } as Envelope)).join("; ")).toMatch(/principal/);
    // A signature by another person's key does not verify against the credential it names.
    const other = keys[P.asha]!.get({ challenge: b64u(Buffer.from(sig.digest, "hex")) });
    expect((await check({ ...sig, signature: other.response.signature, authenticatorData: other.response.authenticatorData })).join("; ")).toMatch(/does not verify/);
  });

  it("an assertion for plan A cannot commit plan B, and only the member's own passkey signs", async () => {
    const a = await cell.ops.plan(T, B, P.preparer, "rebalance", rebalance(55));
    const b = await cell.ops.plan(T, B, P.preparer, "rebalance", rebalance(50));
    const { assertion } = await sign(P.kiran, { action: "plan.commit", planId: a.planId, hash: a.hash });
    const cross = await commit(P.kiran, b, { assertion });
    expect(cross.statusCode).toBe(403);
    expect(cross.json()).toMatchObject({ error: "signature_mismatch", message: expect.stringMatching(/another command/) });
    expect((await cell.ops.get(T, b.planId)).status).toBe("proposed");
    // Kiran's request answered by Asha's passkey, and Asha's signature submitted by Kiran: refused.
    const { assertion: byAsha } = await sign(P.kiran, { action: "plan.commit", planId: b.planId, hash: b.hash }, keys[P.asha]);
    expect((await commit(P.kiran, b, { assertion: byAsha })).json().message).toMatch(/not one of your active passkeys/);
    const { assertion: ashas } = await sign(P.asha, { action: "plan.commit", planId: b.planId, hash: b.hash });
    expect((await commit(P.kiran, b, { assertion: ashas })).json().message).toMatch(/requested for someone else/);
    expect((await cell.ops.get(T, b.planId)).status).toBe("proposed");
    // Nothing was consumed by the refusals: plan A commits with its own signature.
    expect((await commit(P.kiran, a, { assertion })).json().status).toBe("committed");
    await cell.ops.discard(T, b.planId, P.preparer).catch(() => undefined);
  });

  it("a signature cannot be reused, and a signing request expires", async () => {
    await cell.identity.setSettings(T, P.owner, { soloOwner: false, sodLimitPaise: "5000000" });              // ₹50,000
    try {
      const c = await cell.ops.plan(T, B, P.preparer, "record", { date: "2026-10-01", narration: "Supplier", amount: "60,000", direction: "out", account: "BIZEXP", via: "BANK" });
      const approve = (assertion?: unknown) => as(P.meena, "POST", `/plans/${c.planId}/approve`, { hash: c.hash, ...(assertion ? { assertion } : {}) });
      expect((await approve()).json()).toMatchObject({ error: "step_up_required", signing: { action: "plan.approve" } });
      const { o, assertion } = await sign(P.meena, { action: "plan.approve", planId: c.planId, hash: c.hash });
      expect(o.reason).toMatch(/above the approval limit/);
      expect((await approve(assertion)).json()).toMatchObject({ status: "approved", approvedBy: P.meena });
      const replay = await approve(assertion);
      expect(replay.statusCode).toBe(403);
      expect(replay.json().error).toBe("signature_replayed");
      const rec = (await planEvents(c.planId)).filter((e) => e.type === "PlanApprovalRecorded");
      expect(rec).toHaveLength(1);
      expect(rec[0]!.data).toMatchObject({ signature: { kind: "webauthn", inputs: { action: "plan.approve", subject: c.planId, principal: P.meena } } });
      // The preparer carries out Meena's signed approval: no signature of their own is asked for.
      expect((await commit(P.preparer, c)).json()).toMatchObject({ status: "committed", approvedBy: P.meena });
      await cell.settle();
      const ev = (await cell.evidence.find(T, c.planId))[0]!;
      expect(ev.record.approval.signature).toMatchObject({ inputs: { action: "plan.approve", principal: P.meena }, verified: true });
      expect(ev.verified.signature).toBe(true);

      // Expiry: a request answered after its five minutes is refused (and a later one still works).
      const d = await cell.ops.plan(T, B, P.preparer, "rebalance", rebalance(45));
      const { assertion: late } = await sign(P.kiran, { action: "plan.commit", planId: d.planId, hash: d.hash });
      nowMs = Date.now() + 6 * 60_000;
      try { expect((await commit(P.kiran, d, { assertion: late })).json().error).toBe("signature_expired"); } finally { nowMs = undefined; }
      const { assertion: fresh } = await sign(P.kiran, { action: "plan.commit", planId: d.planId, hash: d.hash });
      expect((await commit(P.kiran, d, { assertion: fresh })).json().status).toBe("committed");
    } finally { await cell.identity.setSettings(T, P.owner, { soloOwner: false, sodLimitPaise: null }); }
  });

  it("without an assertion a step-up-class command is refused; only development sign-in falls back to the su claim, labelled as such", async () => {
    const p = await cell.ops.plan(T, B, P.preparer, "rebalance", rebalance(40));
    for (const su of [undefined, Date.now(), Date.now() - 1000]) expect((await commit(P.kiran, p, {}, su)).json().error).toBe("step_up_required");
    expect((await cell.ops.get(T, p.planId)).status).toBe("proposed");
    // Production (this cell): no fallback, even for a member with no passkey.
    expect(await cell.identity.devAttestation(T, P.preparer, Date.now())).toBeNull();
    // Development sign-in: only a member without a passkey, only with a fresh claim; recorded as not a signature.
    const dev = new Identity(cell.store, cell.policies, { rpId: RP_ID, origins: [ORIGIN], devSignIn: true });
    expect(await dev.devAttestation(T, P.preparer, Date.now())).toMatchObject({ kind: "dev-step-up", note: DEV_STEP_UP_NOTE, principal: P.preparer });
    expect(DEV_STEP_UP_NOTE).toMatch(/DEVELOPMENT SIGN-IN ONLY.*not a signature/);
    expect(await dev.devAttestation(T, P.preparer, Date.now() - 10 * 60_000)).toBeNull();
    expect(await dev.devAttestation(T, P.preparer, undefined)).toBeNull();
    expect(await dev.devAttestation(T, P.kiran, Date.now())).toBeNull();                     // has a passkey: must sign
    await cell.ops.discard(T, p.planId, P.preparer);
  });

  it("a direct period lock is a signed command; the signature is stored on PeriodLocked and cannot be replayed", async () => {
    const lock = (assertion?: unknown) => as(P.asha, "POST", `/books/${B}/locks`, { periodEnd: "2026-09-30", level: "soft", ...(assertion ? { assertion } : {}) });
    expect((await lock()).json()).toMatchObject({ error: "step_up_required", signing: { action: "period.lock" } });
    expect((await as(P.meena, "POST", `/signing/options`, { action: "period.lock", book: B, periodEnd: "2026-09-30", level: "soft" })).statusCode).toBe(403);   // approvers may not lock
    const { o, assertion } = await sign(P.asha, { action: "period.lock", book: B, periodEnd: "2026-09-30", level: "soft" });
    expect(o.summary).toMatchObject({ action: "period.lock", book: B, periods: [{ periodEnd: "2026-09-30", level: "soft" }] });
    expect((await lock(assertion)).statusCode).toBe(201);
    expect((await lock(assertion)).json().error).toBe("signature_replayed");
    const locked = (await cell.store.readStream(T, `${T}/book/${B}`)).filter((e) => e.type === "PeriodLocked");
    expect(locked).toHaveLength(1);
    expect(locked[0]!.data).toMatchObject({ periodEnd: "2026-09-30", level: "soft", signature: { kind: "webauthn", inputs: { action: "period.lock", principal: P.asha } } });
    await cell.settle();
    const ev = await cell.evidence.find(T, locked[0]!.eventId);
    expect(ev[0]!.record.approval.signature).toMatchObject({ verified: true });
  });
});

describe("two authenticators and recovery", () => {
  it("owners and controllers with one passkey are warned in /me and in the books-in-order check", async () => {
    const me = (await as(P.owner, "GET", "/me")).json();
    expect(me).toMatchObject({ passkeys: 1, requireTwoAuthenticators: false, warnings: [{ code: "single_passkey" }] });
    expect((await as(P.meena, "GET", "/me")).json()).toMatchObject({ passkeys: 1, warnings: [] });          // an approver is not required to
    expect((await as(P.preparer, "GET", "/me")).json()).toMatchObject({ passkeys: 0, warnings: [] });
    const balance = await cell.ops.plan(T, B, P.owner, "balance", {});
    const c = balance.checks.find((x) => x.label === "Owners and controllers have a second passkey")!;
    expect(c).toMatchObject({ ok: false, blocking: false });
    expect(c.detail).toMatch(/controller:asha, controller:kiran, superuser:ravi/);
    expect(balance.blocked).toBe(false);
  });

  it("requireTwoAuthenticators refuses a single-passkey owner or controller until they register a second passkey", async () => {
    const p = await cell.ops.plan(T, B, P.preparer, "rebalance", rebalance(35));
    const { assertion: early } = await sign(P.kiran, { action: "plan.commit", planId: p.planId, hash: p.hash });
    const set = await as(P.owner, "PUT", "/settings/separation", { soloOwner: false, sodLimitPaise: null, requireTwoAuthenticators: true });
    expect(set.json()).toMatchObject({ requireTwoAuthenticators: true });
    expect((await cell.store.readStream(T, identityStream(T))).filter((e) => e.type === "SettingsChanged").at(-1)!.data)
      .toMatchObject({ requireTwoAuthenticators: true, previous: { requireTwoAuthenticators: false } });
    try {
      const opts = await as(P.kiran, "POST", "/signing/options", { action: "plan.commit", planId: p.planId, hash: p.hash });
      expect(opts.statusCode).toBe(403);
      expect(opts.json().error).toBe("second_passkey_required");
      expect((await commit(P.kiran, p, { assertion: early })).json().error).toBe("second_passkey_required");   // also when verifying
      expect((await as(P.kiran, "GET", "/me")).json().warnings[0].message).toMatch(/requires/);

      // Kiran registers a second passkey: confirming with the first one (step-up) comes first.
      const second = new SoftAuthenticator();
      const add = async (stepUpAt?: number) => {
        const o = (await as(P.kiran, "POST", "/identity/passkeys/options", {})).json();
        expect(o.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([b64u(keys[P.kiran]!.credId)]);
        return as(P.kiran, "POST", "/identity/passkeys/verify", { response: second.create(o) }, stepUpAt);
      };
      expect((await add()).json().error).toBe("step_up_required");
      const su = (await as(P.kiran, "POST", "/identity/stepup/options", {})).json();
      expect((await as(P.kiran, "POST", "/identity/stepup/verify", { response: keys[P.kiran]!.get(su) })).statusCode).toBe(200);
      const added = await add(Date.now());
      expect(added.statusCode).toBe(201);
      expect(added.json().credentialId).toBe(b64u(second.credId));
      expect((await as(P.kiran, "GET", "/me")).json()).toMatchObject({ passkeys: 2, warnings: [] });
      expect((await cell.identity.singlePasskeyPeople(T))).toEqual([P.asha, P.owner]);

      // Now either of Kiran's passkeys signs.
      const { o, assertion } = await sign(P.kiran, { action: "plan.commit", planId: p.planId, hash: p.hash }, second);
      expect(o.options.allowCredentials).toHaveLength(2);
      expect((await commit(P.kiran, p, { assertion })).json().status).toBe("committed");
      // Asha still has one: refused.
      const q = await cell.ops.plan(T, B, P.preparer, "rebalance", rebalance(30));
      expect((await as(P.asha, "POST", "/signing/options", { action: "plan.commit", planId: q.planId, hash: q.hash })).json().error).toBe("second_passkey_required");
      await cell.ops.discard(T, q.planId, P.preparer);
    } finally {
      await as(P.owner, "PUT", "/settings/separation", { soloOwner: false, sodLimitPaise: null, requireTwoAuthenticators: false });
    }
  });

  it("recovery of an existing member is an operator action recorded in the identity stream; the lost passkey stops working", async () => {
    await expect(cell.identity.invite(T, P.owner, { role: "controller", displayName: "Asha", principal: P.asha })).rejects.toThrow(/identity-cli recover/);
    const old = keys[P.asha]!;
    const r = await cell.identity.recover(T, "operator:cli", P.asha, { reason: "lost her phone" });
    expect(r).toMatchObject({ principal: P.asha, revokeExisting: true });
    const fresh = new SoftAuthenticator();
    const o = (await ceremony("registration/options", { displayName: "Asha", enrolment: r.token })).json();
    const done = await ceremony("registration/verify", { displayName: "Asha", enrolment: r.token, response: fresh.create(o) });
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({ principal: P.asha, role: "controller", books: null });
    keys[P.asha] = fresh;
    const audit = await cell.store.readStream(T, identityStream(T));
    const issued = audit.find((e) => e.type === "RecoveryIssued")!;
    expect(issued).toMatchObject({ meta: { principal: "system:operator.cli" }, data: { principal: P.asha, reason: "lost her phone", revokeExisting: true } });
    expect(audit.find((e) => e.type === "RecoveryCompleted")!.data).toMatchObject({ invitation: (issued.data as { invitation: string }).invitation,
      principal: P.asha, credentialId: b64u(fresh.credId), revokedCredentials: [b64u(old.credId)] });
    expect(audit.some((e) => e.type === "MemberAdded" && (e.data as { principal: string }).principal === P.asha && audit.indexOf(e) > audit.indexOf(issued))).toBe(false);
    // The lost passkey no longer signs in; the code worked once.
    const a = (await ceremony("authentication/options", {})).json();
    expect((await ceremony("authentication/verify", { response: old.get(a) })).statusCode).toBe(401);
    expect((await ceremony("registration/options", { displayName: "Asha", enrolment: r.token })).statusCode).toBe(403);
    // The recovered member signs with the new passkey.
    const p = await cell.ops.plan(T, B, P.preparer, "rebalance", rebalance(30));
    const { assertion } = await sign(P.asha, { action: "plan.commit", planId: p.planId, hash: p.hash });
    expect((await commit(P.asha, p, { assertion })).json().status).toBe("committed");
    // A revoked key still verifies what it signed before: the offline verifier uses the stored public key.
    const report = await cell.identity.verifySignatures(T);
    expect(report.failures).toEqual([]);
    expect(report.valid).toBe(report.checked);
  });
});

describe("drafts and ratifications above the approval limit", () => {
  const csv = (f: string) => readFileSync(join(ROOT, "samples", f), "utf8");
  const drafts = async () => (await cell.agent.queue(T, { bookId: F })).map((d) => ({ id: d.draft_id as string, ...(d.proposal as { narration: string; accountId: string }) }));

  it("approving a draft or ratifying an automatic posting above the limit is signed, and the evidence carries the signature", async () => {
    clock.value = "2026-10-25";
    await cell.gl.openBook(T, F, "laksh", "freelancer", P.owner);
    await cell.gl.execute(T, F, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: "Opening", voucherType: "opening",
      lines: [{ accountId: "BANK", amount: "12500000", dimensions: {} }, { accountId: "OPENING", amount: "-12500000", dimensions: {} }] }, { principal: P.owner });
    await cell.channels.submitStatement(T, F, csv("hdfc_2026_10.csv"), P.owner);
    await cell.settle();
    await cell.identity.setSettings(T, P.owner, { soloOwner: false, sodLimitPaise: "3000000" });              // ₹30,000
    try {
      const all = await drafts();
      const loan = all.find((d) => d.narration.includes("HOME LOAN"))!, aws = all.find((d) => d.narration.includes("AWS"))!;
      // Below the limit: unchanged.
      expect((await as(P.kiran, "POST", `/drafts/${aws.id}/approve`, {})).statusCode).toBe(202);
      // Above it (₹32,500): refused without a signature; the signature binds the chosen account.
      const approve = (body: Record<string, unknown>) => as(P.kiran, "POST", `/drafts/${loan.id}/approve`, body);
      expect((await approve({ accountId: "LOANS" })).json()).toMatchObject({ error: "step_up_required", signing: { action: "draft.approve" } });
      const { o, assertion } = await sign(P.kiran, { action: "draft.approve", draftId: loan.id, accountId: "LOANS" });
      expect(o.summary).toMatchObject({ action: "draft.approve", book: F, amountPaise: "3250000" });
      expect(o.summary.accounts.map((a) => a.accountId)).toEqual(["BANK", "LOANS"]);
      const correction = { codes: ["wrong_account"], text: "home loan EMI" };                                   // above the limit, a correction carries its reason
      expect((await approve({ accountId: "LIVING", assertion, correction })).json().error).toBe("signature_mismatch");      // another account
      expect((await approve({ accountId: "LOANS", assertion, correction })).statusCode).toBe(202);
      await cell.settle();
      const ev = (await cell.evidence.find(T, loan.id))[0]!;
      expect(ev.record.approval).toMatchObject({ kind: "draft", by: P.kiran, signature: { kind: "webauthn", inputs: { action: "draft.approve", subject: loan.id }, verified: true } });
      expect(ev.verified.signature).toBe(true);

      // Month two: the agent auto-posts GitHub (₹1,680) under policy and asks for ratification.
      for (const d of await drafts()) if (d.accountId !== "SUSPENSE") await cell.agent.approveDraft(T, d.id, P.owner);
      await cell.settle();
      clock.value = "2026-11-25";
      await cell.channels.submitStatement(T, F, csv("hdfc_2026_11.csv"), P.owner);
      await cell.settle();
      const github = (await cell.agent.openRatifications(T)).find((r) => String(r.narration).includes("GITHUB"))!;
      expect(github).toBeTruthy();
      await cell.identity.setSettings(T, P.owner, { soloOwner: false, sodLimitPaise: "100000" });              // ₹1,000
      const ratify = (body: Record<string, unknown>) => as(P.kiran, "POST", `/journals/${github.journal_id}/ratify`, body);
      expect((await ratify({})).json()).toMatchObject({ error: "step_up_required", signing: { action: "journal.ratify" } });
      const r = await sign(P.kiran, { action: "journal.ratify", journalId: github.journal_id });
      expect(r.o.summary).toMatchObject({ action: "journal.ratify", book: F, amountPaise: "168000" });
      expect((await ratify({ assertion: r.assertion })).statusCode).toBe(204);
      expect((await ratify({ assertion: r.assertion })).statusCode).toBeGreaterThanOrEqual(403);               // used (and no longer open)
      const ratified = (await cell.store.readEvents({ tenantId: T, types: ["Ratified"] })).at(-1)!;
      expect(ratified.data).toMatchObject({ journalId: github.journal_id, signature: { kind: "webauthn", inputs: { action: "journal.ratify", principal: P.kiran } } });
    } finally { await cell.identity.setSettings(T, P.owner, { soloOwner: false, sodLimitPaise: null }); }
  });

  it("ops verify-signatures re-checks every stored signature in the tenant offline", async () => {
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      const r = await new OpsAdmin(owner, cell).verifySignatures(T);
      expect(r.ok).toBe(true);
      const t = r.tenants[0]!;
      // five signed plan commits, one plan approval, one lock, one draft approval, one ratification
      expect(t).toMatchObject({ tenant: T, failures: [], devStepUps: [], unsignedPeriodOps: [] });
      expect(t.checked).toBe(9);
      expect(t.valid).toBe(t.checked);
    } finally { await owner.end(); }
  });
});
