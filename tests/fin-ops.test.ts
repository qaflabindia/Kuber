/**
 * Finance requirement gaps (FIN-MDM-04, FIN-MDM-05, FIN-OPS-01, FIN-OPS-02, FIN-OPS-03), each test
 * named by its requirement ID, on real PostgreSQL with the in-memory bus.
 *
 *   FIN-MDM-04  authority matrix: action x book x amount band x delegation period; conflict rules;
 *               single-owner exception; invalidation of approvals on authority change; re-check at execution
 *   FIN-MDM-05  access and master-change review with dispositions; revoked users cannot execute saved plans
 *   FIN-OPS-03  autonomy kill switch (new, queued and agent-committed actions) and autonomous error counts
 *   FIN-OPS-02  financial incident register with independent closure
 *   FIN-OPS-01  restore drill comparison: pg_dump restored into another database, compared cell by cell
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { uuid, type EventData } from "@kuber/contracts";
import { Cell, OpsAdmin, buildServer, compareCells } from "@kuber/core";
import type { Plan } from "@kuber/ops";
import { APP_ROLE, CORE_AUTH_SECRET, POLICY_DIR, ROOT, SYSTEM_ROLE, enrol, signedInject, startCell, type SignedRequest } from "./helpers.ts";

const DAY = 86_400_000;
const clock = { value: "2026-11-25" };
/** The identity service's clock (delegation validity); null = real time. */
let nowMs: number | null = null;
let cell: Cell, app: FastifyInstance, stop: () => Promise<void>, db: { url: string; ownerUrl: string; systemUrl: string };
let owner: postgres.Sql, send: ReturnType<typeof signedInject>;
const as = (tenant: string, principal: string, method: SignedRequest["method"], url: string, payload?: unknown) =>
  send({ method, url: `/v1/tenants/${tenant}${url}`, tenant, principal, payload });

let n = 0;
const rec = (amount: string, extra: Record<string, unknown> = {}) =>
  ({ date: "2026-10-01", narration: `Supplies ${++n}`, amount, direction: "out", account: "BIZEXP", via: "BANK", ...extra });
const opening = (t: string, b: string, by: string) => cell.gl.execute(t, b, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: "Opening",
  voucherType: "opening", lines: [{ accountId: "BANK", amount: "10000000000", dimensions: {} }, { accountId: "OPENING", amount: "-10000000000", dimensions: {} }] }, { principal: by });
const identityEvents = async (t: string) => cell.store.readStream(t, `${t}/identity`, 0);

beforeAll(async () => {
  ({ cell, stop, db } = await startCell(clock, { identity: { now: () => nowMs ?? Date.now(), devSignIn: true } }));
  owner = postgres(db.ownerUrl, { max: 2, onnotice: () => undefined });
  app = buildServer(cell, { clock: () => clock.value, auth: { secret: CORE_AUTH_SECRET } });
  send = signedInject(app);
});
afterAll(async () => { await owner?.end(); await stop(); });

// ====================================================================== FIN-MDM-04
describe("FIN-MDM-04 authority matrix", () => {
  const T = "doa", B = "main", B2 = "side";
  const P = { owner: "owner:ravi", asha: "controller:asha", kiran: "controller:kiran", meena: "approver:meena", neel: "approver:neel",
    dev: "preparer:dev", pia: "preparer:pia", tom: "preparer:tom", auditor: "auditor:ina", bea: "approver:bea" };
  const prep = (who: string, amount: string, extra: Record<string, unknown> = {}, book = B) => cell.ops.plan(T, book, who, "record", rec(amount, extra));
  const approve = (p: Plan, who: string) => cell.ops.approve(T, p.planId, who, p.hash);
  const commit = (p: Plan, who: string) => cell.ops.commit(T, p.planId, who, p.hash);
  const inAWeek = () => new Date(Date.now() + 7 * DAY).toISOString();
  const delegate = (by: string, d: Record<string, unknown>) => cell.identity.authority.delegate(T, by, { action: "plan.approve", books: [B], validTo: inAWeek(), ...d } as never);

  beforeAll(async () => {
    await enrol(cell, T, [P.owner, P.asha, P.kiran, P.meena, P.neel, P.dev, P.pia, P.tom, P.auditor]);
    await enrol(cell, T, [P.bea], [B2]);
    for (const b of [B, B2]) { await cell.gl.openBook(T, b, T, "company", P.owner); await opening(T, b, P.owner); }
    await cell.settle();
  });

  it("FIN-MDM-04: a maker cannot approve their own controlled action", async () => {
    // Above POL-502's ₹25,000 the preparer's own approval is not enough (maker-checker).
    const p = await prep(P.asha, "30,000");
    await expect(approve(p, P.asha)).rejects.toThrow(/other than its preparer \(controller:asha\)/);
    await expect(commit(p, P.asha)).rejects.toThrow(/other than its preparer/);
    const r = await as(T, P.asha, "POST", `/plans/${p.planId}/approve`, { hash: p.hash });
    expect(r.statusCode).toBe(403);
    // A checker approves; the maker may then execute exactly that approval.
    expect((await as(T, P.kiran, "POST", `/plans/${p.planId}/approve`, { hash: p.hash })).json()).toMatchObject({ status: "approved", approvedBy: P.kiran });
    const done = await commit(p, P.asha);
    expect(done).toMatchObject({ status: "committed", approvedBy: P.kiran });
    const approved = (await cell.store.readStream(T, `${T}/plan/${p.planId}`, 0)).find((e) => e.type === "PlanApproved")!;
    expect(approved.meta.principal).toBe(P.asha);
    expect((approved.data as EventData<"PlanApproved">).approvedBy).toBe(P.kiran);
    expect((await cell.ops.approvals(T, p.planId)).map((a) => [a.approver, a.status])).toEqual([[P.kiran, "used"]]);
    // An agent can never record or carry out an approval.
    await enrol(cell, T, ["agent:helper"], [B]);
    const q = await prep(P.asha, "40,000");
    await expect(approve(q, "agent:helper")).rejects.toThrow(/approvals are recorded and carried out by people/);
  });

  it("FIN-MDM-04: an auditor cannot post", async () => {
    const journal = { txnDate: "2026-10-01", narration: "Audit entry", lines: [{ accountId: "BANK", credit: "100" }, { accountId: "OPENING", debit: "100" }] };
    expect((await as(T, P.auditor, "POST", `/books/${B}/journals`, journal)).statusCode).toBe(403);
    await expect(prep(P.auditor, "100")).rejects.toThrow(/auditor may not plan.prepare/);
    const p = await prep(P.dev, "100");
    await expect(approve(p, P.auditor)).rejects.toThrow(/auditor may not plan.approve/);
    await expect(commit(p, P.auditor)).rejects.toThrow(/auditor may not plan.approve/);
    // …not even by delegation: auditors cannot receive approval authority.
    await expect(delegate(P.asha, { grantee: P.auditor, maxPaise: "100000" })).rejects.toThrow(/auditors cannot receive approval authority/);
    expect((await as(T, P.auditor, "POST", `/delegations`, { grantee: P.dev, action: "plan.approve", maxPaise: "100", validTo: inAWeek() })).statusCode).toBe(403);
  });

  it("FIN-MDM-04: amount bands from POL-002 apply per action, book and role once the matrix is on", async () => {
    expect((await as(T, P.asha, "PUT", "/authority", { enabled: true })).statusCode).toBe(403);           // settings.manage: owners
    const m = (await as(T, P.owner, "PUT", "/authority", { enabled: true })).json();
    expect(m).toMatchObject({ enabled: true, defaults: { "plan.approve": { owner: null, controller: "20000000", approver: "2500000" } } });
    expect((await identityEvents(T)).some((e) => e.type === "AuthorityMatrixChanged" && e.meta.principal === P.owner)).toBe(true);

    await approve(await prep(P.dev, "20,000"), P.meena);                                                     // approver: up to ₹25,000
    const over = await prep(P.dev, "30,000");
    await expect(approve(over, P.meena)).rejects.toThrow(/₹30,000 is above approver:meena's authority of ₹25,000 for plan.approve in book main/);
    await approve(over, P.asha);                                                                               // controller: up to ₹2,00,000
    const big = await prep(P.dev, "3,00,000");
    await expect(approve(big, P.asha)).rejects.toThrow(/authority of ₹2,00,000/);
    await approve(big, P.owner);                                                                               // owner: no limit
    // A tenant sets its own band, here for one book: approvers may approve up to ₹40,000 in main.
    expect((await as(T, P.owner, "PUT", "/authority/bands", { action: "plan.approve", book: B, role: "approver", maxPaise: "4000000" })).statusCode).toBe(200);
    await approve(over, P.meena);
    // The book's band does not reach the other book.
    const side = await prep(P.dev, "30,000", {}, B2);
    await expect(approve(side, P.asha)).resolves.toMatchObject({ status: "approved" });
    await expect(cell.ops.approve(T, side.planId, P.bea, side.hash)).rejects.toThrow(/above approver:bea's authority of ₹25,000 for plan.approve in book side/);
  });

  it("FIN-MDM-04: a delegation grants authority for its period, amount and books, never beyond the grantor's own", async () => {
    const d = (await as(T, P.asha, "POST", "/delegations", { grantee: P.dev, action: "plan.approve", books: [B], maxPaise: "10000000", validTo: inAWeek() })).json();
    expect(d).toMatchObject({ grantor: P.asha, grantee: P.dev, maxPaise: "10000000", status: "active", current: true });
    const fifty = await prep(P.pia, "50,000");
    await approve(fifty, P.dev);                                                                             // a preparer, by delegation
    await expect(approve(await prep(P.pia, "1,50,000"), P.dev)).rejects.toThrow(/preparer may not plan.approve/);   // above the delegated ₹1,00,000
    await expect(delegate(P.asha, { grantee: P.pia, maxPaise: "50000000" })).rejects.toThrow(/exceeds the grantor's own authority of ₹2,00,000/);
    await expect(delegate(P.meena, { grantee: P.pia, action: "plan.approve.period", maxPaise: "100" })).rejects.toThrow(/approver may not plan.approve.period, so cannot delegate it/);
    await expect(delegate(P.dev, { grantee: P.pia, maxPaise: "100" })).rejects.toThrow(/preparer may not plan.approve, so cannot delegate/);
    // At use, too: when the grantor's own band drops below the amount, the delegation no longer covers it.
    await cell.identity.authority.setBand(T, P.owner, { action: "plan.approve", book: null, role: "controller", maxPaise: "3000000" });   // ₹30,000
    expect((await cell.ops.approvals(T, fifty.planId)).find((a) => a.approver === P.dev)).toMatchObject({ status: "invalidated", reason: expect.stringMatching(/controller band/) });
    await expect(approve(fifty, P.dev)).rejects.toThrow(/preparer may not plan.approve/);
    await cell.identity.authority.setBand(T, P.owner, { action: "plan.approve", book: null, role: "controller", maxPaise: "20000000" });
    await approve(fifty, P.dev);
    const list = (await as(T, P.owner, "GET", "/delegations")).json() as { delegationId: string }[];
    expect(list.some((x) => x.delegationId === d.delegationId)).toBe(true);
    expect((await identityEvents(T)).some((e) => e.type === "DelegationGranted" && (e.data as { delegationId: string }).delegationId === d.delegationId)).toBe(true);
  });

  it("FIN-MDM-04: an expired delegate fails", async () => {
    const p = await prep(P.pia, "45,000");
    nowMs = Date.now() + 8 * DAY;                                                                            // past every delegation's valid-to
    try {
      await expect(approve(p, P.dev)).rejects.toThrow(/preparer may not plan.approve/);
      expect((await cell.identity.authority.delegations(T, { principal: P.dev })).every((x) => !x.current)).toBe(true);
    } finally { nowMs = null; }
    await expect(approve(p, P.dev)).resolves.toMatchObject({ status: "approved" });
    // A delegation that has not started yet does not help either.
    await delegate(P.asha, { grantee: P.tom, maxPaise: "10000000", validFrom: new Date(Date.now() + DAY).toISOString() });
    await expect(approve(await prep(P.pia, "10,000"), P.tom)).rejects.toThrow(/preparer may not plan.approve/);
  });

  it("FIN-MDM-04: wrong-book access fails", async () => {
    const p = await prep(P.dev, "1,000");
    await expect(approve(p, P.bea)).rejects.toThrow(/approver:bea has no access to book main/);
    await expect(commit(p, P.bea)).rejects.toThrow(/has no access to book main/);
    // A delegation for another book does not cover this one…
    await delegate(P.asha, { grantee: P.pia, books: [B2], maxPaise: "5000000" });
    await expect(approve(await prep(P.dev, "2,000"), P.pia)).rejects.toThrow(/preparer may not plan.approve/);
    await expect(approve(await prep(P.dev, "2,000", {}, B2), P.pia)).resolves.toMatchObject({ status: "approved" });
    // …and a book-scoped member cannot delegate outside their books.
    await expect(delegate(P.bea, { grantee: P.pia, books: [B], maxPaise: "100" })).rejects.toThrow(/can delegate only within books side/);
    await expect(delegate(P.bea, { grantee: P.pia, books: null, maxPaise: "100" })).rejects.toThrow(/can delegate only within books side/);
  });

  it("FIN-MDM-04: authority is checked again at execution, not only at approval", async () => {
    const d = await delegate(P.asha, { grantee: P.dev, maxPaise: "10000000", validTo: new Date(Date.now() + 2 * DAY).toISOString() });
    const p = await prep(P.pia, "40,000");
    await approve(p, P.dev);                                                                                 // valid now, by delegation
    nowMs = Date.now() + 8 * DAY;                                                                            // every delegation of dev lapses; nothing invalidates the approval
    try {
      expect((await cell.ops.approvals(T, p.planId)).find((a) => a.approver === P.dev)?.status).toBe("active");
      await expect(commit(p, P.pia)).rejects.toThrow(/preparer may not plan.approve/);                        // dev's authority, re-checked at execution
      expect((await as(T, P.pia, "POST", `/plans/${p.planId}/commit`, { hash: p.hash })).statusCode).toBe(403);
    } finally { nowMs = null; }
    expect(await commit(p, P.pia)).toMatchObject({ status: "committed", approvedBy: P.dev });
    await cell.identity.authority.revokeDelegation(T, P.asha, d.delegationId, "test over");
    // The executor must be a person who may act in the book (an auditor cannot carry out an approval).
    const q = await prep(P.pia, "1,000");
    await approve(q, P.meena);
    await expect(commit(q, P.auditor)).rejects.toThrow(/auditor may not plan.prepare/);
  });

  it("FIN-MDM-04: authority or delegation changes invalidate approved-but-uncommitted plans; they need re-approval", async () => {
    const d = await delegate(P.asha, { grantee: P.dev, maxPaise: "10000000" });
    const p1 = await prep(P.pia, "40,000"), p2 = await prep(P.pia, "20,000");
    await approve(p1, P.dev);
    await approve(p2, P.meena);
    expect((await as(T, P.pia, "POST", `/delegations/${d.delegationId}/revoke`, { reason: "not mine" })).statusCode).toBe(403);   // not the grantor
    expect((await as(T, P.asha, "POST", `/delegations/${d.delegationId}/revoke`, { reason: "back from leave" })).statusCode).toBe(204);
    const a1 = (await as(T, P.pia, "GET", `/plans/${p1.planId}/approvals`)).json();
    expect(a1).toEqual([expect.objectContaining({ approver: P.dev, status: "invalidated", reason: expect.stringMatching(/revoked by controller:asha: back from leave/) })]);
    expect((await cell.ops.approvals(T, p2.planId))[0]!.status).toBe("active");
    const invalidated = (await cell.store.readStream(T, `${T}/plan/${p1.planId}`, 0)).find((e) => e.type === "PlanApprovalInvalidated");
    expect(invalidated?.data).toMatchObject({ approver: P.dev });
    await expect(commit(p1, P.pia)).rejects.toThrow(/preparer may not plan.approve/);                        // needs re-approval
    await approve(p1, P.kiran);
    expect(await commit(p1, P.pia)).toMatchObject({ status: "committed", approvedBy: P.kiran });
    // A role or scope change invalidates that member's approvals.
    await cell.identity.addMember(T, P.owner, { principal: P.meena, books: [B2] });
    expect((await cell.ops.approvals(T, p2.planId))[0]).toMatchObject({ status: "invalidated", reason: expect.stringMatching(/approver:meena changed role or book scope/) });
    await cell.identity.addMember(T, P.owner, { principal: P.meena, books: null });
    // Removing a member makes the plans they saved stale.
    const p3 = await prep(P.tom, "5,000");
    await cell.identity.revoke(T, P.owner, P.tom);
    expect((await cell.ops.get(T, p3.planId)).status).toBe("stale");
    expect((await cell.store.readStream(T, `${T}/plan/${p3.planId}`, 0)).some((e) => e.type === "PlanMarkedStale")).toBe(true);
    await expect(approve(p3, P.kiran)).rejects.toThrow(/plan is stale/);
  });

  it("FIN-MDM-04: a related-party flag blocks that member from approving plans that pay that party", async () => {
    expect((await as(T, P.meena, "POST", "/conflicts", { principal: P.neel, partyId: "p.acme", note: "brother-in-law runs Acme" })).statusCode).toBe(403);
    expect((await as(T, P.asha, "POST", "/conflicts", { principal: P.neel, partyId: "p.acme", note: "brother-in-law runs Acme" })).statusCode).toBe(204);
    expect((await as(T, P.auditor, "GET", "/conflicts")).json()).toEqual([expect.objectContaining({ principal: P.neel, partyId: "p.acme", note: "brother-in-law runs Acme" })]);
    const acme = await prep(P.dev, "10,000", { party: "p.acme" });
    expect(acme.journals[0]!.lines).toHaveLength(2);
    await expect(approve(acme, P.neel)).rejects.toThrow(/conflict of interest: approver:neel is flagged as related to party p.acme/);
    await expect(commit(acme, P.neel)).rejects.toThrow(/conflict of interest/);
    await expect(approve(await prep(P.dev, "10,000", { party: "p.other" }), P.neel)).resolves.toMatchObject({ status: "approved" });
    await approve(acme, P.meena);                                                                            // someone without the conflict
    await expect(commit(acme, P.dev)).resolves.toMatchObject({ status: "committed", approvedBy: P.meena });
    // The flag also invalidates approvals the member recorded before it was raised.
    const other = await prep(P.dev, "11,000", { party: "p.acme2" });
    await approve(other, P.neel);
    await cell.identity.authority.flagRelatedParty(T, P.asha, { principal: P.neel, partyId: "p.acme2", note: "same family" });
    expect((await cell.ops.approvals(T, other.planId))[0]!.status).toBe("invalidated");
    expect((await as(T, P.asha, "POST", "/conflicts/clear", { principal: P.neel, partyId: "p.acme2", note: "resolved" })).statusCode).toBe(204);
    await expect(approve(other, P.neel)).resolves.toMatchObject({ status: "approved" });
    const types = (await identityEvents(T)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["RelatedPartyFlagged", "RelatedPartyCleared"]));
  });

  it("FIN-MDM-04: the explicit single-owner exception still applies", async () => {
    const S = "solo-doa";
    await enrol(cell, S, ["owner:lone"]);
    await cell.gl.openBook(S, B, S, "company", "owner:lone");
    await opening(S, B, "owner:lone");
    await cell.settle();
    await cell.identity.authority.setMatrix(S, "owner:lone", true);
    const p = await cell.ops.plan(S, B, "owner:lone", "record", rec("30,000"));
    await expect(cell.ops.commit(S, p.planId, "owner:lone", p.hash)).rejects.toThrow(/other than its preparer/);
    await cell.identity.setSettings(S, "owner:lone", { soloOwner: true, sodLimitPaise: null });
    expect((await cell.ops.commit(S, p.planId, "owner:lone", p.hash)).status).toBe("committed");
  });
});

// ====================================================================== FIN-MDM-05
describe("FIN-MDM-05 access and master change review", () => {
  const T = "acc", B = "main";
  const P = { owner: "owner:ravi", asha: "controller:asha", kiran: "controller:kiran", auditor: "auditor:ina", dev: "preparer:dev",
    pia: "preparer:pia", old: "preparer:old", meena: "approver:meena" };
  beforeAll(async () => {
    await enrol(cell, T, Object.values(P));
    await cell.gl.openBook(T, B, T, "company", P.owner);
    await opening(T, B, P.owner);
    await cell.settle();
    await cell.identity.devSignIn(T, "ravi", randomBytes(16).toString("hex"));                     // the owner signs in
    await owner.begin(async (t) => {
      await t`SELECT set_config('kuber.tenant', ${T}, true)`;
      await t`UPDATE identity.members SET created_at = now() - interval '200 days' WHERE tenant_id = ${T} AND principal = ${P.old}`;
    });
    await cell.identity.revoke(T, P.owner, P.meena);                                                      // removed
    await cell.identity.addMember(T, P.owner, { principal: P.dev, books: [B] });                            // re-scoped
  });

  it("FIN-MDM-05: the review lists removed, dormant and role-changed members and unreviewed identity changes", async () => {
    expect((await as(T, P.dev, "GET", "/access-review")).statusCode).toBe(403);
    const res = await as(T, P.auditor, "GET", "/access-review");
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.removed).toEqual([expect.objectContaining({ kind: "removed", subject: P.meena, actor: P.owner, disposition: null })]);
    expect(r.roleChanges).toEqual([expect.objectContaining({ kind: "role_change", subject: P.dev, detail: expect.objectContaining({ books: [B], previousBooks: null }) })]);
    expect(r.dormant.map((d: { subject: string }) => d.subject)).toEqual([P.old]);                          // 200 days, never signed in
    expect(r.dormant[0].itemId).toBe(`dormant:${P.old}:never`);
    expect(r.changes.filter((c: { type: string }) => c.type === "MemberAdded").length).toBeGreaterThanOrEqual(Object.keys(P).length);
    expect(r.unreviewed).toBe(r.items);
    // A shorter dormancy window and a later start narrow the report.
    const narrow = await cell.identity.accessReview.report(T, { since: new Date(Date.now() + DAY).toISOString().slice(0, 10), dormantDays: 365 });
    expect(narrow).toMatchObject({ removed: [], roleChanges: [], changes: [], dormant: [] });
    // `ops access-review` (all tenants, or one) gives the same report.
    const cli = await new OpsAdmin(owner, cell).accessReview({ tenant: T });
    expect(cli[0]).toMatchObject({ tenant: T, unreviewed: r.unreviewed, items: r.items });
  });

  it("FIN-MDM-05: each item gets a disposition, recorded as an event with reviewer, decision and note", async () => {
    const r0 = (await as(T, P.auditor, "GET", "/access-review")).json();
    const removed = r0.removed[0].itemId as string;
    // Reviewers are independent: the owner made this change; the auditor has no access.review.
    expect((await as(T, P.owner, "POST", "/access-review/dispositions", { itemId: removed, decision: "appropriate", note: "left the firm" })).statusCode).toBe(403);
    expect((await as(T, P.auditor, "POST", "/access-review/dispositions", { itemId: removed, decision: "appropriate", note: "left the firm" })).statusCode).toBe(403);
    const ok = await as(T, P.asha, "POST", "/access-review/dispositions", { itemId: removed, decision: "appropriate", note: "left the firm; exit checklist done" });
    expect(ok.statusCode).toBe(201);
    const ev = (await identityEvents(T)).filter((e) => e.type === "AccessReviewDisposed").at(-1)!;
    expect(ev.meta.principal).toBe(P.asha);
    expect(ev.data).toEqual({ itemId: removed, kind: "removed", subject: P.meena, decision: "appropriate", note: "left the firm; exit checklist done" });
    await cell.identity.accessReview.dispose(T, P.owner, r0.dormant[0].itemId, { decision: "revoke", note: "never used the account" });
    await expect(cell.identity.accessReview.dispose(T, P.asha, "no-such-item", { decision: "appropriate", note: "x" })).rejects.toThrow(/no access-review item/);
    const r1 = (await as(T, P.auditor, "GET", "/access-review")).json();
    expect(r1.removed[0].disposition).toMatchObject({ decision: "appropriate", reviewer: P.asha, note: "left the firm; exit checklist done" });
    expect(r1.dormant[0].disposition).toMatchObject({ decision: "revoke", reviewer: P.owner });
    expect(r1.unreviewed).toBe(r0.unreviewed - 2);
    expect(r1.changes.some((c: { type: string }) => c.type === "AccessReviewDisposed")).toBe(false);          // reviews are not review items
  });

  it("FIN-MDM-05: a revoked user cannot execute a saved plan", async () => {
    // The preparer saved a plan and a checker approved it; then the preparer is removed.
    const p = await cell.ops.plan(T, B, P.pia, "record", rec("30,000"));
    await cell.ops.approve(T, p.planId, P.asha, p.hash);
    await cell.identity.revoke(T, P.owner, P.pia);
    await expect(cell.ops.commit(T, p.planId, P.pia, p.hash)).rejects.toThrow(/not a member of workspace acc/);
    expect((await as(T, P.pia, "POST", `/plans/${p.planId}/commit`, { hash: p.hash })).statusCode).toBe(403);
    expect((await cell.ops.get(T, p.planId)).status).toBe("stale");
    await expect(cell.ops.commit(T, p.planId, P.asha, p.hash)).rejects.toThrow(/plan is stale/);
    // The approver is removed: their approval no longer stands, and the preparer cannot execute it.
    const q = await cell.ops.plan(T, B, P.old, "record", rec("30,000"));
    await cell.ops.approve(T, q.planId, P.kiran, q.hash);
    await cell.identity.revoke(T, P.owner, P.kiran);
    expect((await cell.ops.approvals(T, q.planId))[0]).toMatchObject({ status: "invalidated", reason: expect.stringMatching(/controller:kiran was removed/) });
    await expect(cell.ops.commit(T, q.planId, P.old, q.hash)).rejects.toThrow(/preparer may not plan.approve/);
  });
});

// ====================================================================== FIN-OPS-03
describe("FIN-OPS-03 autonomy kill switch", () => {
  const T = "auto", B = "main", OWNER = "owner:laksh", CTRL = "controller:asha", APPROVER = "approver:meena", AGENT = "agent:assistant";
  const csv = (f: string) => readFileSync(join(ROOT, "samples", f), "utf8");
  const line = (date: string, ref: string, amount: string) => `Date,Narration,Withdrawal Amt,Deposit Amt\n${date},UPI/DR/${ref}/GITHUB/github@hdfcbank,${amount},\n`;
  const narr = (d: { proposal: unknown }) => (d.proposal as { narration: string }).narration;

  beforeAll(async () => {
    clock.value = "2026-10-25";
    await enrol(cell, T, [OWNER, CTRL, APPROVER]);
    await enrol(cell, T, [AGENT], [B]);
    await cell.gl.openBook(T, B, "laksh", "freelancer", OWNER);
    for (const [acc, amt] of [["BANK", 12500000n], ["LOANS", -240000000n]] as const) {
      await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: `Opening ${acc}`, voucherType: "opening",
        lines: [{ accountId: acc, amount: amt.toString(), dimensions: {} }, { accountId: "OPENING", amount: (-amt).toString(), dimensions: {} }] }, { principal: OWNER });
    }
    await cell.channels.submitStatement(T, B, csv("hdfc_2026_10.csv"), OWNER);
    await cell.settle();
    // Month one: a person approves the agent's drafts, so it knows these counterparties in month two.
    for (const d of await cell.agent.queue(T)) {
      const p = d.proposal as { accountId: string; narration: string };
      if (p.accountId === "SUSPENSE" && !p.narration.includes("LOAN")) continue;
      await cell.agent.approveDraft(T, d.draft_id as string, OWNER, p.narration.includes("LOAN") ? "LOANS" : undefined);
    }
    await cell.settle();
    clock.value = "2026-11-25";
  });
  afterAll(() => { clock.value = "2026-11-25"; });

  it("FIN-OPS-03: the kill switch immediately sends all autonomous posting to human review, recorded with actor and reason", async () => {
    expect((await as(T, APPROVER, "POST", "/autonomy/halt", { reason: "suspicious postings" })).statusCode).toBe(403);   // owner/controller only
    const r = await as(T, OWNER, "POST", "/autonomy/halt", { reason: "classifier drift under investigation" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([expect.objectContaining({ book: null, halted: true, reason: "classifier drift under investigation", setBy: OWNER })]);
    const ev = (await identityEvents(T)).find((e) => e.type === "AutonomyHalted")!;
    expect(ev.meta.principal).toBe(OWNER);
    expect(ev.data).toEqual({ bookId: null, reason: "classifier drift under investigation" });

    await cell.channels.submitStatement(T, B, csv("hdfc_2026_11.csv"), OWNER);
    await cell.settle();
    expect(await cell.agent.openRatifications(T)).toEqual([]);                                             // nothing posted on its own
    const github = (await cell.agent.queue(T)).find((d) => narr(d).includes("GITHUB"))!;
    expect(github.status).toBe("queued");
    expect(github.decision).toMatchObject({ level: "L1", action: "draft", reasons: expect.arrayContaining([expect.stringMatching(/kill switch/)]) });
    expect((await as(T, OWNER, "GET", "/autonomy")).json().switches[0]).toMatchObject({ halted: true });
    expect((await new OpsAdmin(owner, cell).autonomy(T))[0]!.halted).toEqual([expect.objectContaining({ book: null, by: OWNER })]);
  });

  it("FIN-OPS-03: queued autonomous actions that have not executed are blocked and routed to review", async () => {
    expect((await as(T, CTRL, "POST", "/autonomy/resume", { reason: "classifier fixed" })).statusCode).toBe(200);
    expect((await identityEvents(T)).some((e) => e.type === "AutonomyResumed" && e.meta.principal === CTRL)).toBe(true);
    await cell.channels.submitStatement(T, B, line("22/11/2026", "2", "1680"), OWNER);
    // The agent decides (L3: post, then ratify) but the GL has not executed the posting yet…
    await cell.relay.drainOnce();
    await (cell.bus as unknown as { idle(): Promise<void> }).idle();
    const queued = (await cell.agent.openRatifications(T)).find((x) => (x.narration as string).includes("/2/GITHUB"));
    expect(queued).toBeDefined();
    // …when the switch goes on (for this book).
    await cell.identity.autonomy.set(T, OWNER, { book: B, halted: true, reason: "stop everything queued" });
    await cell.settle();
    expect((await cell.gl.state(T, B)).journals.has(queued!.journal_id as string)).toBe(false);          // never posted
    expect((await cell.agent.openRatifications(T)).some((x) => x.journal_id === queued!.journal_id)).toBe(false);
    const rejected = (await cell.store.readEvents({ tenantId: T, types: ["PostingRejected"] })).map((e) => (e.data as EventData<"PostingRejected">).reason);
    expect(rejected.some((x) => x.startsWith("autonomy_halted:"))).toBe(true);
    const draft = (await cell.agent.queue(T)).find((d) => narr(d).includes("/2/GITHUB"))!;
    expect(draft).toMatchObject({ status: "queued", decision: expect.objectContaining({ level: "L1", reasons: expect.arrayContaining([expect.stringMatching(/kill switch/)]) }) });
    // A person approves it: it posts as the journal it would have been (people are never halted).
    const ok = await cell.agent.approveDraft(T, draft.draft_id as string, OWNER);
    await cell.settle();
    expect(ok.journalId).toBe(queued!.journal_id);
    expect((await cell.gl.state(T, B)).journals.has(ok.journalId)).toBe(true);
  });

  it("FIN-OPS-03: an agent cannot commit a plan while autonomy is halted; it waits for a person", async () => {
    const p = await cell.ops.plan(T, B, AGENT, "record", { date: "2026-11-10", narration: "Tea", amount: "120", direction: "out", account: "LIVING", via: "CASH" });
    expect(p.needsPerson).toBe(false);                                                                        // L3 by policy
    expect(await cell.ops.commit(T, p.planId, AGENT, p.hash)).toMatchObject({ status: "awaiting_person", message: expect.stringMatching(/kill switch/) });
    await cell.identity.autonomy.set(T, OWNER, { book: B, halted: false, reason: "resolved" });
    expect((await cell.ops.commit(T, p.planId, AGENT, p.hash)).status).toBe("committed");
  });

  it("FIN-OPS-03: reversals and corrections of agent-posted journals are counted per period in ops status", async () => {
    await cell.channels.submitStatement(T, B, `Date,Narration,Withdrawal Amt,Deposit Amt\n23/11/2026,UPI/DR/3/GITHUB/github@hdfcbank,1680,\n24/11/2026,UPI/DR/4/GITHUB/github@hdfcbank,1700,\n`, OWNER);
    await cell.settle();
    const auto = (await cell.agent.openRatifications(T)).filter((x) => /\/(3|4)\/GITHUB/.test(x.narration as string));
    expect(auto).toHaveLength(2);                                                                              // posted at L3
    await cell.agent.correct(T, auto[0]!.journal_id as string, "LIVING", OWNER);
    await cell.gl.execute(T, B, { kind: "ReverseJournal", journalId: auto[1]!.journal_id as string, reversalJournalId: uuid(), reason: "duplicate charge" }, { principal: OWNER });
    await cell.settle();
    const status = await new OpsAdmin(owner, cell).status();
    const mine = status.autonomy.find((a) => a.tenant === T)!;
    expect(mine.errors).toMatchObject({ reversed: 1, corrected: 1 });
    expect(mine.errors.periods).toEqual([expect.objectContaining({ period: "2026-11", posted: 2, reversed: 1, corrected: 1, errorRate: 1 })]);
    expect((await as(T, OWNER, "GET", "/autonomy")).json().errors).toEqual(mine.errors.periods);
  });
});

// ====================================================================== FIN-OPS-02
describe("FIN-OPS-02 financial incident register", () => {
  const T = "inc";
  const P = { owner: "owner:ravi", asha: "controller:asha", kiran: "controller:kiran", meena: "approver:meena", auditor: "auditor:ina" };
  const body = { title: "Duplicate vendor payment", description: "Acme invoice 17 paid twice by NEFT", books: ["main"], periods: ["2026-10"],
    possibleLossPaise: "11800000", duplication: true };
  beforeAll(async () => { await enrol(cell, T, Object.values(P)); });

  it("FIN-OPS-02: an incident records tenant, books, periods, possible loss or duplication, owner, containment and corrections", async () => {
    expect((await as(T, P.meena, "POST", "/incidents", body)).statusCode).toBe(403);                         // incident.manage: owner/controller
    expect((await as(T, P.asha, "POST", "/incidents", { ...body, possibleLossPaise: "118000.00" })).statusCode).toBe(400);   // integer paise
    const opened = await as(T, P.asha, "POST", "/incidents", body);
    expect(opened.statusCode).toBe(201);
    const inc = opened.json();
    expect(inc).toMatchObject({ ...body, status: "open", owner: P.asha, openedBy: P.asha, containment: null, corrections: [] });
    const upd = await as(T, P.asha, "POST", `/incidents/${inc.incidentId}/update`, { containment: "Vendor bank detail frozen; recall requested",
      corrections: ["j-refund-1"], note: "bank confirms recall" });
    expect(upd.json()).toMatchObject({ status: "contained", containment: "Vendor bank detail frozen; recall requested", corrections: ["j-refund-1"] });
    expect((await as(T, P.auditor, "GET", "/incidents?status=unclosed")).json().map((i: { incidentId: string }) => i.incidentId)).toEqual([inc.incidentId]);
    const events = await cell.store.readStream(T, `${T}/incident/${inc.incidentId}`, 0);
    expect(events.map((e) => [e.type, e.meta.principal])).toEqual([["IncidentOpened", P.asha], ["IncidentUpdated", P.asha]]);
    await expect(cell.incidents.open(T, P.asha, { ...body, owner: "agent:kuber" })).rejects.toThrow(/owned by a person/);
    await expect(cell.incidents.open(T, P.asha, { ...body, owner: P.asha, periods: ["October"] })).rejects.toThrow(/periods/);
  });

  it("FIN-OPS-02: closure requires a reconciliation reference and approval by someone other than the owner", async () => {
    const inc = await cell.incidents.open(T, P.asha, { ...body, title: "Missing receipt batch", duplication: false, owner: P.kiran });
    const url = `/incidents/${inc.incidentId}/close`;
    expect((await as(T, P.asha, "POST", url, { reconciliationRef: "" })).statusCode).toBe(400);
    await expect(cell.incidents.close(T, P.asha, inc.incidentId, { reconciliationRef: "  " })).rejects.toThrow(/reconciliation reference/);
    const self = await as(T, P.kiran, "POST", url, { reconciliationRef: "BRS-2026-10-main" });
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toMatch(/owner \(controller:kiran\) cannot approve closing their own incident/);
    const closed = await as(T, P.asha, "POST", url, { reconciliationRef: "BRS-2026-10-main", note: "reconciled to statement" });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: "closed", reconciliationRef: "BRS-2026-10-main", closedBy: P.asha, owner: P.kiran });
    const ev = (await cell.store.readStream(T, `${T}/incident/${inc.incidentId}`, 0)).at(-1)!;
    expect(ev).toMatchObject({ type: "IncidentClosed", data: { reconciliationRef: "BRS-2026-10-main", owner: P.kiran, approvedBy: P.asha } });
    await expect(cell.incidents.update(T, P.asha, inc.incidentId, { note: "late" })).rejects.toThrow(/is closed/);
    expect((await as(T, P.owner, "GET", `/incidents/${inc.incidentId}`)).json().status).toBe("closed");
  });
});

// ====================================================================== FIN-OPS-01
const hasPgTools = (() => { try { execFileSync("pg_dump", ["--version"]); execFileSync("pg_restore", ["--version"]); return true; } catch { return false; } })();

describe("FIN-OPS-01 restore drill", () => {
  it("restore-drill.sh is valid shell and never publishes (memory bus, no relay)", () => {
    const script = readFileSync(join(ROOT, "scripts", "restore-drill.sh"), "utf8");
    execFileSync("bash", ["-n", join(ROOT, "scripts", "restore-drill.sh")]);
    expect(script).toMatch(/NATS_URL=/);
    expect(script).toMatch(/verify --full/);
    expect(script).toMatch(/for p in reporting agent evidence; do step "check_\$p" tools ops check "\$p"/);
    expect(script).toMatch(/for p in reporting agent evidence; do step "rebuild_\$p" tools ops rebuild "\$p"/);
    expect(script).toMatch(/drill-compare/);
    expect(script).toMatch(/\.kuber\}?\/drills|\$DIR\/drills/);
  });

  it.skipIf(!hasPgTools)("FIN-OPS-01: compareCells finds a pg_dump restored into another database identical, then reports differences", async () => {
    const T = "auto";
    await cell.reporting.certify(T, "main", "trial-balance", { from: null, to: null, asOf: null }, "owner:laksh", { freshness: "wait", timeoutMs: 10_000 });
    await cell.settle();
    const dir = mkdtempSync(join(tmpdir(), "kuber-drill-"));
    const name = `kuber_drill_${randomBytes(4).toString("hex")}`;
    const adminUrl = new URL(db.ownerUrl); adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
    const restoredOwner = new URL(db.ownerUrl); restoredOwner.pathname = `/${name}`;
    let restoredCell: Cell | undefined, rsql: postgres.Sql | undefined;
    try {
      execFileSync("pg_dump", ["--format=custom", `--file=${join(dir, "src.dump")}`, `--dbname=${db.ownerUrl}`]);
      await admin.unsafe(`CREATE DATABASE ${name}`);
      execFileSync("pg_restore", ["--no-owner", "--exit-on-error", `--dbname=${restoredOwner}`, join(dir, "src.dump")]);

      // The drill: an isolated cell on the restored database (memory bus, relay never started),
      // projections rebuilt and checked, storage verified in full, then compared with the source.
      const app = new URL(restoredOwner); app.username = APP_ROLE; app.password = process.env.TEST_APP_DB_PASSWORD ?? APP_ROLE;
      const sys = new URL(restoredOwner); sys.username = SYSTEM_ROLE; sys.password = process.env.TEST_SYSTEM_DB_PASSWORD ?? SYSTEM_ROLE;
      restoredCell = await Cell.start({ databaseUrl: app.toString(), migrationUrl: restoredOwner.toString(), appRole: APP_ROLE, systemDatabaseUrl: sys.toString(),
        policyDir: POLICY_DIR, kms: cell.keyring.kms, clock: () => clock.value, bus: "memory" });
      rsql = postgres(restoredOwner.toString(), { max: 2, onnotice: () => undefined });
      const drill = new OpsAdmin(rsql, restoredCell);
      for (const p of ["reporting", "agent", "evidence"]) {
        expect((await drill.rebuild(p)).every((x) => x.check.ok)).toBe(true);
        expect((await drill.check(p)).every((x) => x.ok)).toBe(true);
      }
      expect((await drill.verify({ full: true })).problems).toEqual([]);
      const [pending] = await rsql<{ n: number }[]>`SELECT count(*)::int AS n FROM es.outbox WHERE published_at IS NULL`;
      const [srcPending] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM es.outbox WHERE published_at IS NULL`;
      expect(pending!.n).toBe(srcPending!.n);                                                                     // nothing was published by the drill

      const same = await compareCells(db.ownerUrl, restoredOwner.toString());
      expect(same.ok).toBe(true);
      const tenants = same.tenants.map((t) => t.tenant);
      expect(tenants).toEqual(expect.arrayContaining(["doa", "acc", "auto", "inc"]));
      const auto = same.tenants.find((t) => t.tenant === T)!;
      expect(auto.checks.balances!.source).toBeGreaterThan(0);
      expect(auto.checks.certifiedSnapshots!.source).toBe(1);
      expect(auto.checks.openDrafts!.source).toBeGreaterThan(0);
      expect(same.tenants.find((t) => t.tenant === "doa")!.checks.openPlans!.source).toBeGreaterThan(0);
      expect(same.tenants.find((t) => t.tenant === "inc")!.checks.openIncidents!.source).toBe(1);
      expect(same.source).not.toMatch(/@|kuber:/);                                                              // no credentials in evidence

      // A restore that lost an open plan and changed a balance is reported, cell by cell.
      const [plan] = await owner.begin(async (t) => { await t`SELECT set_config('kuber.tenant', 'doa', true)`;
        return t<{ plan_id: string }[]>`SELECT plan_id FROM ops.plans WHERE tenant_id = 'doa' AND status = 'proposed' ORDER BY plan_id LIMIT 1`; }) as { plan_id: string }[];
      await rsql.begin(async (t) => {
        await t`SELECT set_config('kuber.tenant', 'doa', true)`;
        await t`UPDATE ops.plans SET status = 'discarded' WHERE tenant_id = 'doa' AND plan_id = ${plan!.plan_id}`;
        await t`SELECT set_config('kuber.tenant', 'auto', true)`;
        await t`UPDATE reporting.daily SET net = net + 1 WHERE tenant_id = 'auto' AND ctid = (SELECT ctid FROM reporting.daily WHERE tenant_id = 'auto' AND account_id = 'BANK' LIMIT 1)`;
      });
      const diff = await OpsAdmin.compareCells(db.ownerUrl, restoredOwner.toString());
      expect(diff.ok).toBe(false);
      expect(diff.tenants.find((t) => t.tenant === "doa")!.checks.openPlans).toMatchObject({ ok: false, missing: [plan!.plan_id] });
      expect(diff.tenants.find((t) => t.tenant === "auto")!.checks.balances!.changed).toEqual([expect.stringMatching(/^main\|BANK: /)]);
    } finally {
      await rsql?.end();
      await restoredCell?.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
