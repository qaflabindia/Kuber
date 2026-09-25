/**
 * Role model v2 (implementation design 6.3, decided 25 September 2026; agent design 8 and 9):
 *
 *   ROLE-01  twelve roles, deny by default: the role x action matrix
 *   ROLE-02  legacy principals keep their names; memberships migrate to the new roles, idempotently
 *   ROLE-03  admin has no financial authority; treasurer verifies bank changes but never also approves a payment to that party
 *   ROLE-04  agent checker: a policy-cleared agent commit records agent:policy as checker; maker never checker
 *   ROLE-05  a language model (agent:copilot) is never a checker; excluded classes always need a person
 *   ROLE-06  customers and suppliers are bound to one party and see only it (portal)
 *   ROLE-07  supplier bank-detail requests enter the POL-501 hold and can never be released by the supplier
 *   ROLE-08  investors see only published snapshots; guests only unexpired shares; no cross-tenant access
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { uuid, type Line } from "@kuber/contracts";
import { ACTIONS, LEGACY_ALIASES, POLICY_CHECKER, ROLES, can, identityStream, permissionTable, roleOf, type Action, type Role } from "@kuber/identity";
import { buildServer, type Cell } from "@kuber/core";
import { CORE_AUTH_SECRET, enrol, signedInject, startCell } from "./helpers.ts";

// ================================================================= ROLE-01 the matrix (pure)
const EXTERNAL: Action[] = ["portal.customer.read", "portal.customer.query", "portal.supplier.read", "portal.supplier.bank_request", "investor.read", "share.read"];
const INTERNAL = ACTIONS.filter((a) => !EXTERNAL.includes(a) && a !== "policy.commit");
/** The spec's table, written out independently of the implementation. */
const EXPECTED: Record<Role, Action[]> = {
  superuser: INTERNAL,                                                         // everything, agent.system included as ultimate authority
  admin: ["self", "members.read", "members.manage", "settings.manage"],        // no financial action, no ledger reads
  system_owner: ["self", "agent.system", "agent.turns.read"],
  controller: INTERNAL.filter((a) => !["members.manage", "settings.manage", "authority.manage", "agent.system"].includes(a)),
  treasurer: ["self", "read", "capture", "plan.prepare", "plan.approve", "copilot", "party.bank.verify"],
  staff: ["self", "read", "capture", "plan.prepare", "party.manage", "copilot"],
  auditor: ["self", "read", "members.read", "agent.turns.read"],
  agent: ["capture", "plan.prepare"],
  agent_checker: ["policy.commit"],
  customer: ["self", "portal.customer.read", "portal.customer.query"],
  supplier: ["self", "portal.supplier.read", "portal.supplier.bank_request"],
  investor: ["self", "investor.read"],
  guest: ["self", "share.read"],
};

describe("ROLE-01 permission matrix", () => {
  it("ROLE-01 lists the twelve roles of the model (thirteen rows: agent maker and checker) and every action", () => {
    expect([...ROLES]).toEqual(["superuser", "admin", "system_owner", "controller", "treasurer", "staff", "auditor", "customer", "supplier", "investor", "guest", "agent", "agent_checker"]);
    expect(ACTIONS).toEqual(expect.arrayContaining(["agent.system", "agent.turns.read", ...EXTERNAL]));
    expect(Object.keys(permissionTable())).toEqual([...ROLES]);
  });
  it.each(ROLES.flatMap((r) => ACTIONS.map((a) => [r, a] as const)))("ROLE-01 %s may %s: as specified", (role, action) => {
    expect(can(role, action)).toBe(EXPECTED[role].includes(action));
  });
  it("ROLE-01 agent.system: system owner and superuser only; agent.turns.read: system owner, superuser, auditor, controller", () => {
    expect(ROLES.filter((r) => can(r, "agent.system"))).toEqual(["superuser", "system_owner"]);
    expect(ROLES.filter((r) => can(r, "agent.turns.read")).sort()).toEqual(["auditor", "controller", "superuser", "system_owner"]);
  });
  it("ROLE-01 unknown roles get nothing; external roles get no internal action", () => {
    for (const a of ACTIONS) expect(can("root", a)).toBe(false);
    for (const r of ["customer", "supplier", "investor", "guest"]) for (const a of INTERNAL) if (a !== "self") expect(can(r, a)).toBe(false);
  });
});

// ================================================================= cell
const T = "roles", OTHER = "roles-other", B = "main";
const P = {
  su: "superuser:sita", legacyOwner: "owner:ravi", legacyApprover: "approver:meena", legacyPreparer: "preparer:dev", legacyMember: "member:anu",
  admin: "admin:ada", sysowner: "system_owner:sam", ctrl: "controller:asha", ctrl2: "controller:kiran", treas: "treasurer:tara", staff: "staff:pia",
  auditor: "auditor:ina", agent: "agent:helper", cust: "customer:acme", cust2: "customer:beta", supp: "supplier:vend", investor: "investor:ian", guest: "guest:gia",
};
const clock = { value: "2026-10-25" };
let cell: Cell, stop: () => Promise<void>, app: FastifyInstance, ownerUrl: string;
let send: ReturnType<typeof signedInject>;
const as = (principal: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown, tenant = T) =>
  send({ method, url: `/v1/tenants/${tenant}${url}`, tenant, principal, payload });
const L = (accountId: string, amount: bigint, extra: Partial<Line> = {}): Line => ({ accountId, amount: amount.toString(), dimensions: {}, ...extra });
const post = (lines: Line[], txnDate: string) =>
  cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate, narration: "internal note: do not show", lines }, { principal: P.su });
const BANK = { accountNumber: "50100012345678", ifsc: "HDFC0001234", holderName: "Vend Supplies" };
const BANK2 = { accountNumber: "91020033334444", ifsc: "ICIC0004321", holderName: "Vend Supplies" };

beforeAll(async () => {
  let db: { ownerUrl: string };
  ({ cell, stop, db } = await startCell(clock));
  ownerUrl = db.ownerUrl;
  await enrol(cell, T, [P.su, P.legacyOwner, P.legacyApprover, P.legacyPreparer, P.legacyMember, P.admin, P.sysowner, P.ctrl, P.ctrl2, P.treas, P.staff, P.auditor, P.investor, P.guest]);
  await enrol(cell, T, [P.agent], [B]);
  await cell.gl.openBook(T, B, "roles", "freelancer", P.su, { legalEntityId: "ent-r" });
  await post([L("BANK", 10_000_000n), L("OPENING", -10_000_000n)], "2026-09-30");
  for (const [partyId, kind, name] of [["C-ACME", "customer", "Acme"], ["C-BETA", "customer", "Beta"], ["V-VEND", "vendor", "Vend Supplies"]] as const)
    await cell.parties.register(T, P.staff, { partyId, entityId: "ent-r", kind, name });
  await cell.identity.addMember(T, "operator:test", { principal: P.cust, partyId: "C-ACME" });
  await cell.identity.addMember(T, "operator:test", { principal: P.cust2, partyId: "C-BETA" });
  await cell.identity.addMember(T, "operator:test", { principal: P.supp, partyId: "V-VEND" });
  // Acme: invoiced 10,000 and 5,000, paid 12,000. Beta: invoiced 7,000. Vend: billed 8,000, paid 3,000.
  await post([L("DEBTORS", 1_000_000n, { partyId: "C-ACME" }), L("FEES", -1_000_000n)], "2026-10-01");
  await post([L("DEBTORS", 500_000n, { partyId: "C-ACME" }), L("FEES", -500_000n)], "2026-10-03");
  await post([L("DEBTORS", 700_000n, { partyId: "C-BETA" }), L("FEES", -700_000n)], "2026-10-04");
  await post([L("BANK", 1_200_000n), L("DEBTORS", -1_200_000n, { partyId: "C-ACME" })], "2026-10-10");
  await post([L("BIZEXP", 800_000n), L("CREDITORS", -800_000n, { partyId: "V-VEND" })], "2026-10-05");
  await post([L("CREDITORS", 300_000n, { partyId: "V-VEND" }), L("BANK", -300_000n)], "2026-10-12");
  await cell.settle();
  app = buildServer(cell, { clock: () => clock.value, auth: { secret: CORE_AUTH_SECRET } });
  send = signedInject(app);
});
afterAll(async () => { await app?.close(); await stop(); });

// ================================================================= ROLE-02 legacy aliases and migration
describe("ROLE-02 legacy principals and the migration", () => {
  it("ROLE-02 legacy prefixes stand for their new roles; the membership row stores the new role", async () => {
    expect(LEGACY_ALIASES).toEqual({ owner: "superuser", approver: "superuser", preparer: "staff", member: "staff" });
    expect(roleOf("owner:ravi")).toBe("superuser");
    expect(roleOf("preparer:dev")).toBe("staff");
    expect(roleOf(POLICY_CHECKER)).toBe("agent_checker");
    expect((await cell.identity.member(T, P.legacyOwner))?.role).toBe("superuser");
    expect((await cell.identity.member(T, P.legacyApprover))?.role).toBe("superuser");
    expect((await cell.identity.member(T, P.legacyPreparer))?.role).toBe("staff");
    expect((await cell.identity.member(T, P.legacyMember))?.role).toBe("staff");
    // Legacy principals still work end to end: an owner:* principal reads, a preparer:* principal may not approve.
    expect((await as(P.legacyOwner, "GET", "/me")).json()).toMatchObject({ role: "superuser" });
    expect((await as(P.legacyPreparer, "GET", `/books/${B}/reports/trial-balance`)).statusCode).toBe(200);
  });

  it("ROLE-02 new invitations use the new prefixes; a principal may not claim a role its membership does not have", async () => {
    const inv = await cell.identity.invite(T, P.su, { role: "staff", displayName: "New Person" });
    expect(inv.principal).toBe("staff:new-person");
    const legacyName = await cell.identity.invite(T, P.su, { role: "preparer", displayName: "Old Name" });  // a legacy role name stands for its role
    expect(legacyName).toMatchObject({ principal: "staff:old-name", role: "staff" });
    await expect(cell.identity.invite(T, P.su, { role: "staff", displayName: "X", principal: "controller:x" })).rejects.toThrow(/must be staff:<name>/);
    // "superuser:ravi" is not "owner:ravi": the prefix is part of the identifier, not a claim.
    expect((await as("superuser:ravi", "GET", "/me")).statusCode).toBe(403);
  });

  it("ROLE-02 the migration rewrites legacy role values, records MemberRoleChanged with the reason, and is idempotent", async () => {
    const M = "legacy-tenant";
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      for (const [principal, role] of [["owner:lata", "owner"], ["approver:abe", "approver"], ["preparer:pat", "preparer"], ["member:mo", "member"], ["controller:cy", "controller"]] as const)
        await owner`INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
          VALUES (${M}, ${principal}, ${role}, NULL, ${principal}, 'operator', 'operator:old')`;
      await owner`INSERT INTO identity.authority_bands (tenant_id, action, book_id, role, max_paise, updated_by) VALUES (${M}, 'plan.approve', '*', 'owner', NULL, 'owner:lata')`;
    } finally { await owner.end(); }
    expect(await cell.identity.migrateRoleModel()).toEqual({ [M]: 4 });
    const roles = Object.fromEntries((await cell.identity.members(M)).map((m) => [m.principal, m.role]));
    expect(roles).toEqual({ "owner:lata": "superuser", "approver:abe": "superuser", "preparer:pat": "staff", "member:mo": "staff", "controller:cy": "controller" });
    const changed = (await cell.store.readStream(M, identityStream(M))).filter((e) => e.type === "MemberRoleChanged");
    expect(changed.map((e) => e.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ principal: "owner:lata", role: "superuser", previousRole: "owner", reason: "role model v2" }),
      expect.objectContaining({ principal: "preparer:pat", role: "staff", previousRole: "preparer", reason: "role model v2" }),
    ]));
    expect(changed).toHaveLength(4);
    expect(changed.every((e) => e.meta.principal === "system:migration")).toBe(true);
    expect((await cell.identity.authority.matrix(M)).bands).toEqual([expect.objectContaining({ role: "superuser" })]);
    // Idempotent: nothing left to change, no new events.
    expect(await cell.identity.migrateRoleModel()).toEqual({});
    expect(await cell.identity.migrateTenantRoles(M)).toBe(0);
    expect((await cell.store.readStream(M, identityStream(M))).filter((e) => e.type === "MemberRoleChanged")).toHaveLength(4);
  });

  it("ROLE-02 soloSuperuser is the new name of the single-owner exception; soloOwner is still accepted", async () => {
    const S = "solo-v2";
    await enrol(cell, S, ["superuser:lone"]);
    expect(await cell.identity.setSettings(S, "superuser:lone", { soloSuperuser: true, sodLimitPaise: null })).toMatchObject({ soloSuperuser: true, soloOwner: true });
    expect(await cell.identity.setSettings(S, "superuser:lone", { soloOwner: false, sodLimitPaise: null })).toMatchObject({ soloSuperuser: false, soloOwner: false });
    await expect(cell.identity.setSettings(S, "superuser:lone", { soloOwner: true, soloSuperuser: false, sodLimitPaise: null })).rejects.toThrow(/disagree/);
  });
});

// ================================================================= ROLE-03 admin and treasurer
const record = (amount: string, extra: Record<string, unknown> = {}) =>
  ({ date: "2026-10-15", narration: "Office supplies", amount, direction: "out", account: "BIZEXP", via: "BANK", ...extra });

describe("ROLE-03 admin and treasurer separation", () => {
  it("ROLE-03 admin cannot approve, post, read the ledger or change authority; it manages members", async () => {
    const p = await cell.ops.plan(T, B, P.staff, "record", record("100"));
    await expect(cell.ops.commit(T, p.planId, P.admin, p.hash)).rejects.toThrow(/admin may not plan.approve/);
    await expect(cell.ops.approve(T, p.planId, P.admin, p.hash)).rejects.toThrow(/admin may not plan.approve/);
    expect((await as(P.admin, "GET", `/books/${B}/reports/trial-balance`)).statusCode).toBe(403);
    expect((await as(P.admin, "PUT", "/authority", { enabled: true })).statusCode).toBe(403);
    expect((await as(P.admin, "PUT", "/settings/separation", { soloSuperuser: true, sodLimitPaise: null })).statusCode).toBe(403);
    expect((await as(P.admin, "POST", "/members/invitations", { role: "auditor", displayName: "Firm" })).statusCode).toBe(201);
    expect((await as(P.admin, "GET", "/me")).json()).toMatchObject({ role: "admin", permissions: ["self", "members.read", "members.manage", "settings.manage"] });
    await cell.ops.discard(T, p.planId, P.staff);
  });

  it("ROLE-03 the treasurer who verified a party's bank change cannot approve a payment to that party; another person can", async () => {
    await cell.parties.register(T, P.staff, { partyId: "V-TREAS", entityId: "ent-r", kind: "vendor", name: "Treasury Test" });
    const { changeId } = await cell.parties.requestBankChange(T, P.staff, "V-TREAS", { bank: BANK });
    await cell.parties.verifyBankChange(T, P.treas, "V-TREAS", changeId, { method: "call_back", reference: "number on file" });
    await cell.parties.releaseBankChange(T, P.su, "V-TREAS", changeId);
    await post([L("BIZEXP", 400_000n), L("CREDITORS", -400_000n, { partyId: "V-TREAS" })], "2026-10-06");
    const pay = await cell.ops.plan(T, B, P.staff, "record", record("4,000", { account: "CREDITORS", party: "V-TREAS", narration: "Pay Treasury Test" }));
    await expect(cell.ops.commit(T, pay.planId, P.treas, pay.hash)).rejects.toThrow(/verified the bank details of V-TREAS/);
    await expect(cell.ops.approve(T, pay.planId, P.treas, pay.hash)).rejects.toThrow(/verified the bank details of V-TREAS/);
    // The payment is approved by someone who did not verify...
    expect((await cell.ops.commit(T, pay.planId, P.ctrl, pay.hash)).status).toBe("committed");
    // ...and the treasurer approves other treasury plans.
    const other = await cell.ops.plan(T, B, P.staff, "record", record("500"));
    expect((await cell.ops.commit(T, other.planId, P.treas, other.hash)).status).toBe("committed");
    // The treasurer cannot release a bank change (fresh approval) at all.
    const second = await cell.parties.requestBankChange(T, P.staff, "V-TREAS", { bank: BANK2 });
    await cell.parties.verifyBankChange(T, P.treas, "V-TREAS", second.changeId, { method: "penny_drop", reference: "PD-1" });
    await expect(cell.parties.releaseBankChange(T, P.treas, "V-TREAS", second.changeId)).rejects.toThrow(/treasurer may not party.bank.release/);
    await cell.parties.releaseBankChange(T, P.su, "V-TREAS", second.changeId);
  });

  it("ROLE-03 a treasurer approves treasury plans only, and never period operations", async () => {
    const close = await cell.ops.plan(T, B, P.ctrl, "close", { periodEnd: "2026-09-30" });
    await expect(cell.ops.commit(T, close.planId, P.treas, close.hash)).rejects.toThrow(/treasurer may not plan.approve.period/);
    await cell.ops.discard(T, close.planId, P.ctrl);
  });
});

// ================================================================= ROLE-04/05 agent checker
describe("ROLE-04 agent checker separation", () => {
  it("ROLE-04 an agent's policy-cleared commit records agent:policy as checker, distinct from the agent as maker", async () => {
    const p = await cell.ops.plan(T, B, P.agent, "record", record("300", { direction: "in", account: "FEES", narration: "Small receipt" }));
    expect(p.needsPerson).toBe(false);                                    // POL-502: L3 up to ₹25,000
    expect((await cell.ops.commit(T, p.planId, P.agent, p.hash)).status).toBe("committed");
    const [approved] = (await cell.store.readStream(T, `${T}/plan/${p.planId}`)).filter((e) => e.type === "PlanApproved");
    expect(approved!.meta.principal).toBe(P.agent);
    expect(approved!.data).toMatchObject({ preparedBy: P.agent, checker: POLICY_CHECKER });
    expect((approved!.data as { checker: string }).checker).not.toBe((approved!.data as { preparedBy: string }).preparedBy);
    await cell.settle();
    const [ev] = await cell.evidence.find(T, p.planId);
    expect(ev?.record.approval).toMatchObject({ kind: "plan", by: P.agent, checker: POLICY_CHECKER, sod: { preparedBy: P.agent, checker: POLICY_CHECKER, separate: true } });
  });

  it("ROLE-04 a person's commit records that person as checker; a maker never checks its own item above the limit", async () => {
    const p = await cell.ops.plan(T, B, P.staff, "record", record("200"));
    await cell.ops.commit(T, p.planId, P.ctrl, p.hash);
    const [approved] = (await cell.store.readStream(T, `${T}/plan/${p.planId}`)).filter((e) => e.type === "PlanApproved");
    expect(approved!.data).toMatchObject({ preparedBy: P.staff, checker: P.ctrl });
    const big = await cell.ops.plan(T, B, P.ctrl, "record", record("30,000"));
    await expect(cell.ops.commit(T, big.planId, P.ctrl, big.hash)).rejects.toThrow(/other than its preparer/);
    await cell.ops.discard(T, big.planId, P.ctrl);
  });

  it("ROLE-04 agent:policy is a recorded identity only: it can never act, nor be a member", async () => {
    const p = await cell.ops.plan(T, B, P.staff, "record", record("100"));
    await expect(cell.ops.commit(T, p.planId, POLICY_CHECKER, p.hash)).rejects.toThrow(/never acts/);
    await expect(cell.identity.permit(T, POLICY_CHECKER, "capture", { book: B })).rejects.toThrow(/never acts/);
    await expect(cell.identity.addMember(T, "operator:test", { principal: POLICY_CHECKER })).rejects.toThrow(/unknown role/);
    await cell.ops.discard(T, p.planId, P.staff);
  });
});

describe("ROLE-05 no language-model checker; excluded classes need a person", () => {
  it("ROLE-05 agent:copilot can never commit, approve or execute: a language model is never a checker", async () => {
    const p = await cell.ops.plan(T, B, "agent:copilot", "record", record("100"), { onBehalfOf: P.staff });
    await expect(cell.ops.commit(T, p.planId, "agent:copilot", p.hash)).rejects.toThrow(/never a checker/);
    await expect(cell.ops.approve(T, p.planId, "agent:copilot", p.hash)).rejects.toThrow(/never a checker/);
    await expect(cell.identity.check({ step: "execute", tenant: T, book: B, principal: P.staff, op: { name: "record", kind: "write", gate: "policy" },
      plan: p, approvedBy: "agent:copilot" })).rejects.toThrow(/never be the recorded approver/);
    await cell.ops.discard(T, p.planId, P.staff);
  });

  it("ROLE-05 period operations, payments and amounts above the limit wait for a person even when an agent commits", async () => {
    // Payment to a party: policy would clear the amount, but payments always need a human checker.
    const pay = await cell.ops.plan(T, B, P.agent, "record", record("1,000", { account: "CREDITORS", party: "V-VEND", narration: "Pay Vend" }));
    expect(pay.needsPerson).toBe(false);
    expect(await cell.ops.commit(T, pay.planId, P.agent, pay.hash)).toMatchObject({ status: "awaiting_person", message: expect.stringMatching(/payments .* always need a person/) });
    // Above the tenant's approval limit.
    await cell.identity.setSettings(T, P.su, { soloSuperuser: false, sodLimitPaise: "100000" });       // ₹1,000
    try {
      const over = await cell.ops.plan(T, B, P.agent, "record", record("5,000", { direction: "in", account: "FEES", narration: "Receipt" }));
      expect(over.needsPerson).toBe(false);
      expect(await cell.ops.commit(T, over.planId, P.agent, over.hash)).toMatchObject({ status: "awaiting_person", message: expect.stringMatching(/above the approval limit/) });
      await cell.ops.discard(T, over.planId, P.agent);
    } finally { await cell.identity.setSettings(T, P.su, { soloSuperuser: false, sodLimitPaise: null }); }
    // Period operations: an agent cannot even prepare them.
    await expect(cell.ops.plan(T, B, P.agent, "close", { periodEnd: "2026-09-30" })).resolves.toMatchObject({ gate: "human", needsPerson: true });
    // Master data and authority: an agent has no such action.
    await expect(cell.parties.register(T, P.agent, { partyId: "V-AG", entityId: "ent-r", kind: "vendor", name: "X" })).rejects.toThrow(/agent may not/);
    await expect(cell.identity.authority.setMatrix(T, P.agent, true)).rejects.toThrow(/not a member/);
    await cell.ops.discard(T, pay.planId, P.agent);
  });
});

// ================================================================= ROLE-06/07 party-bound portals
describe("ROLE-06 customer portal", () => {
  it("ROLE-06 a customer sees only its own party: statement, open items and payments received", async () => {
    const r = await as(P.cust, "GET", "/portal/customer");
    expect(r.statusCode).toBe(200);
    const body = r.json() as { statement: { partyId: string; balance: string; lines: { journalId: string; amount: string }[] };
      openItems: { amount: string; open: string; status: string }[]; paymentsReceived: { amount: string }[] };
    expect(body.statement).toMatchObject({ partyId: "C-ACME", balance: "300000" });                   // 10,000 + 5,000 - 12,000
    expect(body.statement.lines).toHaveLength(3);
    expect(body.openItems).toEqual([expect.objectContaining({ amount: "500000", open: "300000", status: "partly_paid" })]);
    expect(body.paymentsReceived).toEqual([expect.objectContaining({ amount: "1200000" })]);
    expect(JSON.stringify(body)).not.toContain("C-BETA");
    expect(JSON.stringify(body)).not.toContain("internal note");                                       // no internal narrations
    const beta = (await as(P.cust2, "GET", "/portal/customer")).json() as { statement: { partyId: string; balance: string } };
    expect(beta.statement).toMatchObject({ partyId: "C-BETA", balance: "700000" });
  });

  it("ROLE-06 the filter is at the module boundary: no ledger, parties or other portals, and no party taken from the request", async () => {
    expect((await as(P.cust, "GET", `/books/${B}/reports/trial-balance`)).statusCode).toBe(403);
    expect((await as(P.cust, "GET", "/parties/C-BETA")).statusCode).toBe(403);
    expect((await as(P.cust, "GET", "/portal/supplier")).statusCode).toBe(403);
    expect((await as(P.cust, "GET", "/portal/customer?party=C-BETA")).json()).toMatchObject({ statement: { partyId: "C-ACME" } });
    await expect(cell.identity.authorize(T, P.cust, "portal.customer.read", { party: "C-BETA" })).rejects.toThrow(/only for party C-ACME/);
    await expect(cell.identity.addMember(T, "operator:test", { principal: "customer:nobody" })).rejects.toThrow(/bound to one party/);
    await expect(cell.identity.addMember(T, "operator:test", { principal: "staff:x", partyId: "C-ACME" })).rejects.toThrow(/not bound to a party/);
  });

  it("ROLE-06 a customer raises a query, recorded as an event on its own party's portal stream", async () => {
    const r = await as(P.cust, "POST", "/portal/customer/queries", { subject: "Invoice 2", message: "Please send a copy" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ partyId: "C-ACME", status: "open" });
    const [e] = await cell.store.readStream(T, `${T}/portal/C-ACME`);
    expect(e).toMatchObject({ type: "PortalQueryOpened", meta: { principal: P.cust }, data: { partyId: "C-ACME", subject: "Invoice 2" } });
    expect((await as(P.cust, "GET", "/portal/customer/queries")).json()).toEqual([expect.objectContaining({ subject: "Invoice 2" })]);
    expect((await as(P.cust2, "GET", "/portal/customer/queries")).json()).toEqual([]);
    expect((await as(P.supp, "POST", "/portal/customer/queries", { subject: "x1", message: "y1" })).statusCode).toBe(403);
  });
});

describe("ROLE-07 supplier portal", () => {
  it("ROLE-07 a supplier sees its own bills and their payment status", async () => {
    const r = (await as(P.supp, "GET", "/portal/supplier")).json() as { statement: { partyId: string; balance: string }; bills: { amount: string; open: string; status: string }[]; payments: unknown[] };
    expect(r.statement).toMatchObject({ partyId: "V-VEND", balance: "500000" });
    expect(r.bills).toEqual([expect.objectContaining({ amount: "800000", open: "500000", status: "partly_paid" })]);
    expect(r.payments).toHaveLength(1);
    expect((await as(P.supp, "GET", "/portal/customer")).statusCode).toBe(403);
  });

  it("ROLE-07 a supplier's bank-detail request enters the POL-501 hold; the supplier can never verify or release it", async () => {
    const r = await as(P.supp, "POST", "/portal/supplier/bank-change", { bank: BANK2 });
    expect(r.statusCode).toBe(202);
    const { changeId } = r.json() as { changeId: string };
    expect(r.json()).toMatchObject({ status: "pending", hold: true });
    expect((await cell.parties.get(T, "V-VEND"))!.openChange).toMatchObject({ changeId, status: "pending", requestedBy: P.supp });
    expect((await as(P.supp, "GET", "/portal/supplier")).json()).toMatchObject({ paymentsHeld: true, bankChange: { changeId, status: "pending" } });
    // Payments to the party are now held.
    expect((await cell.ops.plan(T, B, P.staff, "record", record("100", { account: "CREDITORS", party: "V-VEND" }))).blocked).toBe(true);
    // The supplier holds no verify or release right, over HTTP or at the module.
    expect((await as(P.supp, "POST", `/parties/V-VEND/bank-changes/${changeId}/verify`, { method: "call_back", reference: "me" })).statusCode).toBe(403);
    expect((await as(P.supp, "POST", `/parties/V-VEND/bank-changes/${changeId}/release`, {})).statusCode).toBe(403);
    await expect(cell.parties.releaseBankChange(T, P.supp, "V-VEND", changeId)).rejects.toThrow(/supplier may not party.bank.release/);
    // It can request only for its own party.
    await expect(cell.parties.requestBankChange(T, P.supp, "C-ACME", { bank: BANK }, { action: "portal.supplier.bank_request" })).rejects.toThrow(/only for party V-VEND/);
    // People verify (out of band) and release; then the hold lifts.
    await cell.parties.verifyBankChange(T, P.treas, "V-VEND", changeId, { method: "call_back", reference: "number on file" });
    expect((await cell.parties.releaseBankChange(T, P.su, "V-VEND", changeId)).hold).toBe(false);
  });
});

// ================================================================= ROLE-08 investor, guest, tenancy
describe("ROLE-08 investors, guests and tenancy", () => {
  let published: string, unpublished: string;
  beforeAll(async () => {
    await cell.settle();
    published = (await cell.reporting.certify(T, B, "balance-sheet", { asOf: null }, P.su)).snapshotId;
    unpublished = (await cell.reporting.certify(T, B, "trial-balance", { asOf: null }, P.su)).snapshotId;
  });

  it("ROLE-08 investors see only snapshots published to investors; superuser or controller publishes", async () => {
    expect((await as(P.investor, "GET", "/portal/investor/snapshots")).json()).toEqual([]);
    expect((await as(P.staff, "POST", `/snapshots/${published}/publish`, { published: true })).statusCode).toBe(403);
    expect((await as(P.ctrl, "POST", `/snapshots/${published}/publish`, { published: true })).json()).toMatchObject({ published: true });
    expect((await cell.store.readStream(T, identityStream(T))).some((e) => e.type === "SnapshotPublished" && e.meta.principal === P.ctrl)).toBe(true);
    const list = (await as(P.investor, "GET", "/portal/investor/snapshots")).json() as { snapshotId: string }[];
    expect(list.map((s) => s.snapshotId)).toEqual([published]);
    expect((await as(P.investor, "GET", `/portal/investor/snapshots/${published}`)).json()).toMatchObject({ snapshotId: published, verified: true });
    expect((await as(P.investor, "GET", `/portal/investor/snapshots/${unpublished}`)).statusCode).toBe(404);
    expect((await as(P.investor, "GET", `/books/${B}/reports/trial-balance`)).statusCode).toBe(403);
    expect((await as(P.investor, "GET", "/parties/C-ACME")).statusCode).toBe(403);
    // Withdrawn: gone for investors.
    await as(P.su, "POST", `/snapshots/${published}/publish`, { published: false });
    expect((await as(P.investor, "GET", "/portal/investor/snapshots")).json()).toEqual([]);
    await as(P.su, "POST", `/snapshots/${published}/publish`, { published: true });
  });

  it("ROLE-08 a guest reads only what is shared with it, until the share expires", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    expect((await as(P.staff, "POST", "/shares", { grantee: P.guest, itemType: "snapshot", itemId: unpublished, expiresAt })).statusCode).toBe(403);
    expect((await as(P.su, "POST", "/shares", { grantee: P.staff, itemType: "snapshot", itemId: unpublished, expiresAt })).statusCode).toBe(404);   // guests only
    const snap = (await as(P.su, "POST", "/shares", { grantee: P.guest, itemType: "snapshot", itemId: unpublished, expiresAt })).json() as { shareId: string };
    const rep = (await as(P.ctrl, "POST", "/shares", { grantee: P.guest, itemType: "report", itemId: `${B}/trial-balance`, expiresAt })).json() as { shareId: string };
    expect(((await as(P.guest, "GET", "/shares/mine")).json() as unknown[]).length).toBe(2);
    expect((await as(P.guest, "GET", `/shares/${snap.shareId}`)).json()).toMatchObject({ snapshot: { snapshotId: unpublished } });
    expect((await as(P.guest, "GET", `/shares/${rep.shareId}`)).json()).toMatchObject({ report: { bookId: B, kind: "trial-balance" } });
    // Nothing else.
    expect((await as(P.guest, "GET", `/books/${B}/reports/trial-balance`)).statusCode).toBe(403);
    expect((await as(P.guest, "GET", "/portal/investor/snapshots")).statusCode).toBe(403);
    expect((await as(P.investor, "GET", `/shares/${snap.shareId}`)).statusCode).toBe(403);
    // Expiry: a short share lapses.
    const short = await cell.identity.grantShare(T, P.su, { grantee: P.guest, itemType: "snapshot", itemId: published, expiresAt: new Date(Date.now() + 1500).toISOString() });
    expect((await as(P.guest, "GET", `/shares/${short.shareId}`)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 1600));
    expect((await as(P.guest, "GET", `/shares/${short.shareId}`)).statusCode).toBe(404);
    expect(((await as(P.guest, "GET", "/shares/mine")).json() as { shareId: string }[]).map((s) => s.shareId)).not.toContain(short.shareId);
    await expect(cell.identity.grantShare(T, P.su, { grantee: P.guest, itemType: "snapshot", itemId: published, expiresAt: "2020-01-01T00:00:00Z" })).rejects.toThrow(/in the future/);
    // Revoked: gone.
    await cell.identity.revokeShare(T, P.su, snap.shareId);
    expect((await as(P.guest, "GET", `/shares/${snap.shareId}`)).statusCode).toBe(404);
  });

  it("ROLE-08 cross-tenant: an external member of one workspace sees nothing of another", async () => {
    await cell.gl.openBook(OTHER, B, OTHER, "freelancer", "superuser:olga", { legalEntityId: "ent-o" });
    await enrol(cell, OTHER, ["superuser:olga"]);
    for (const p of [P.cust, P.supp, P.investor, P.guest, P.admin]) {
      for (const url of ["/portal/customer", "/portal/supplier", "/portal/investor/snapshots", "/shares/mine", "/me"])
        expect((await as(p, "GET", url, undefined, OTHER)).statusCode).toBe(403);
    }
    // The assertion for one workspace cannot be replayed against another.
    expect((await send({ method: "GET", url: `/v1/tenants/${OTHER}/portal/customer`, tenant: T, principal: P.cust })).statusCode).toBe(403);
    await expect(cell.identity.boundParty(OTHER, P.cust, "portal.customer.read")).rejects.toThrow(/not a member/);
  });
});
