/**
 * G0 master data (Kuber CFO requirements §2, §3.1):
 *   FIN-MDM-01  book / entity configuration
 *   FIN-MDM-02  chart of accounts controls
 *   FIN-MDM-03  party master (vendor / customer), bank-detail changes and payment holds
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuid, type Envelope, type Line, type Meta } from "@kuber/contracts";
import { DomainError, SEEDS, emptyParty, evolveParty, decideParty, verifyChain, type BookState } from "@kuber/gl";
import { decide, emptyBook, evolve, fold, type BookCommand } from "../modules/gl/src/book.ts";
import { deserialize, serialize } from "../modules/gl/src/snapshot.ts";
import { balancesFromState, financialYear, type Plan } from "@kuber/ops";
import { buildServer, SEALED_COLUMNS, RETENTION, type Cell } from "@kuber/core";
import { CORE_AUTH_SECRET, enrol, signedInject, startCell } from "./helpers.ts";

// ---------------------------------------------------------------- pure helpers
const meta = (principal: string): Meta => ({ tenantId: "t1", cellId: "local", correlationId: uuid(), principal, occurredAt: "" });
const envOf = (type: string, data: unknown, v: number, principal = "owner:laksh") =>
  ({ eventId: uuid(), globalPosition: String(v), streamId: "t1/book/b", streamVersion: v, type, schemaVersion: 1,
     data: JSON.parse(JSON.stringify(data)), meta: meta(principal), recordedAt: "" }) as Envelope;
function apply(s: BookState, c: BookCommand, principal = "owner:laksh", ctx = {}) {
  const evs = decide(s, c, principal, ctx).map((e, i) => envOf(e.type, e.data, s.version + i + 1, principal));
  return { state: evs.reduce(evolve, s), events: evs };
}
const L = (accountId: string, amount: bigint, extra: Partial<Line> = {}): Line => ({ accountId, amount: amount.toString(), dimensions: {}, ...extra });
const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return e instanceof DomainError ? e.code : String(e); } };

// ---------------------------------------------------------------- cell
const T = "mdm", B = "main", B_OTHER = "other", B_CAL = "cal", B_BUDGET = "budget";
const P = { owner: "owner:ravi", controller: "controller:asha", preparer: "preparer:dev", approver: "approver:meena", member: "member:anu", agent: "agent:bot" };
const clock = { value: "2026-10-25" };
let cell: Cell, stop: () => Promise<void>, app: FastifyInstance;
let send: ReturnType<typeof signedInject>;
const plan = (op: string, input: unknown, who = P.owner, book = B) => cell.ops.plan(T, book, who, op, input);
const commit = (p: Plan, who = P.owner) => cell.ops.commit(T, p.planId, who, p.hash);
const post = (lines: Line[], txnDate = "2026-10-05", book = B, who = P.owner, journalId = uuid()) =>
  cell.gl.execute(T, book, { kind: "PostJournal", journalId, txnDate, narration: "test", lines }, { principal: who }).then(() => journalId);
const BANK1 = { accountNumber: "50100012345678", ifsc: "HDFC0001234", holderName: "Sharma Traders" };
const BANK2 = { accountNumber: "91020033334444", ifsc: "ICIC0004321", holderName: "Sharma Traders" };

beforeAll(async () => {
  ({ cell, stop } = await startCell(clock));
  await enrol(cell, T, [P.owner, P.controller, P.preparer, P.approver, P.member]);
  await enrol(cell, T, [P.agent], [B]);
  // The single-owner exception covers plan maker-checker only; POL-501 has no exceptions.
  await cell.identity.setSettings(T, P.owner, { soloOwner: true, sodLimitPaise: null });
  await cell.gl.openBook(T, B, "ravi", "freelancer", P.owner, { legalEntityId: "ent-a", framework: "AS (ICAI)" });
  await cell.gl.openBook(T, B_OTHER, "sister", "company", P.owner, { legalEntityId: "ent-b", framework: "Ind AS" });
  await post([L("BANK", 10000000n), L("OPENING", -10000000n)], "2026-09-30");
  app = buildServer(cell, { clock: () => clock.value, auth: { secret: CORE_AUTH_SECRET } });
  send = signedInject(app);
});
afterAll(async () => { await app?.close(); await stop(); });

const as = (principal: string, method: "GET" | "POST", url: string, payload?: unknown) => send({ method, url, tenant: T, principal, payload });

// ================================================================= FIN-MDM-01
describe("FIN-MDM-01 book and entity configuration", () => {
  it("FIN-MDM-01 OpenBook records legal entity, framework, basis, functional currency, fiscal year start and purpose", async () => {
    const s = await cell.gl.state(T, B);
    expect(s.config).toEqual({ legalEntityId: "ent-a", entityType: "freelancer", basis: "statutory", framework: "AS (ICAI)",
      functionalCurrency: { code: "INR", exponent: 2 }, fiscalYearStartMonth: 4, purpose: "business" });
    // The legal entity is configuration, separate from the entity id, branches and dimensions.
    expect(s.entityId).toBe("ravi");
    const r = apply(emptyBook(), { kind: "OpenBook", bookId: "b", entityId: "e", entityType: "individual", accounts: SEEDS.individual!,
      legalEntityId: "le-1", fiscalYearStartMonth: 1, framework: "ITR", purpose: "business", basis: "management" });
    expect(r.state.config).toMatchObject({ legalEntityId: "le-1", fiscalYearStartMonth: 1, framework: "ITR", purpose: "business", basis: "management" });
    expect(code(() => decide(emptyBook(), { kind: "OpenBook", bookId: "b", entityId: "e", entityType: "individual", accounts: [], fiscalYearStartMonth: 13 }, "owner:x"))).toBe("bad_fiscal_year");
  });

  it("FIN-MDM-01 BookOpened events from before the configuration replay with defaults (individual → personal, April, unspecified)", () => {
    // Exactly the stored shape of a pre-FIN-MDM-01 event: no configuration fields at all.
    const legacy = (entityType: string) => fold([envOf("BookOpened", { bookId: "b", entityId: "e1", entityType, basis: "statutory", currency: "INR", accounts: SEEDS.individual! }, 1)]);
    expect(legacy("individual").config).toEqual({ legalEntityId: "e1", entityType: "individual", basis: "statutory", framework: "unspecified",
      functionalCurrency: { code: "INR", exponent: 2 }, fiscalYearStartMonth: 4, purpose: "personal" });
    expect(legacy("household").config.purpose).toBe("personal");
    expect(legacy("freelancer").config.purpose).toBe("business");
    expect(legacy("company").config.purpose).toBe("business");
    // Snapshots keep the configuration (and closed accounts) across a save and load.
    const s = legacy("company");
    expect(deserialize(JSON.parse(JSON.stringify(serialize(s, null)))).config).toEqual(s.config);
  });

  it("FIN-MDM-01 two entities cannot share a posting: a journal naming another entity's party is refused", async () => {
    await cell.parties.register(T, P.preparer, { partyId: "V-A", entityId: "ent-a", kind: "vendor", name: "Alpha Supplies" });
    await cell.parties.register(T, P.preparer, { partyId: "V-B", entityId: "ent-b", kind: "vendor", name: "Beta Supplies" });
    const seq = (await cell.gl.state(T, B)).seq;
    await expect(post([L("BIZEXP", 1000n), L("CREDITORS", -1000n, { partyId: "V-B" })])).rejects.toThrow(/party V-B belongs to entity ent-b/);
    expect((await cell.gl.state(T, B)).seq).toBe(seq);
    await post([L("BIZEXP", 1000n), L("CREDITORS", -1000n, { partyId: "V-A" })]);
    // The same party posts fine in its own entity's book.
    await post([L("BIZEXP", 1000n), L("CREDITORS", -1000n, { partyId: "V-B" })], "2026-10-05", B_OTHER);
    // The entity cannot be smuggled in as a dimension either.
    const s = await cell.gl.state(T, B);
    expect(code(() => decide(s, { kind: "PostJournal", journalId: "x", txnDate: "2026-10-05", narration: "n",
      lines: [L("BIZEXP", 1n, { dimensions: { entity: "ent-b" } }), L("BANK", -1n)] }, P.owner))).toBe("cross_entity");
  });

  it("FIN-MDM-01 statutory actuals exclude simulation: simulate never posts and cannot be committed", async () => {
    const before = await cell.gl.state(T, B);
    const plans = async () => (await cell.store.tenantTx(T, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ops.plans WHERE tenant_id = ${T}`))[0]!.n;
    const plansBefore = await plans();
    const p = await plan("simulate", { entries: [{ narration: "New laptop", amount: 90000, direction: "out", account: "BIZEXP", via: "BANK", date: "2026-10-20" }],
      monthlyChange: { expenses: 15000 } });
    expect(p.kind).toBe("read");
    expect(p.status).toBe("preview");
    expect(p.journals).toEqual([]);
    await expect(commit(p)).rejects.toThrow(/no plan/);
    const after = await cell.gl.state(T, B);
    expect(after.version).toBe(before.version);
    expect(balancesFromState(after)).toEqual(balancesFromState(before));
    expect(await plans()).toBe(plansBefore);
  });

  it("FIN-MDM-01 a budget book is a separate basis: its entries never reach the statutory book", async () => {
    await cell.gl.openBook(T, B_BUDGET, "ravi", "freelancer", P.owner, { legalEntityId: "ent-a", basis: "budget" });
    const budget = await cell.gl.state(T, B_BUDGET);
    expect(budget.config.basis).toBe("budget");
    const actual = balancesFromState(await cell.gl.state(T, B));
    await post([L("BIZEXP", 5000000n), L("BANK", -5000000n)], "2026-11-01", B_BUDGET);
    expect(balancesFromState(await cell.gl.state(T, B))).toEqual(actual);
    expect((await cell.gl.state(T, B)).config.basis).toBe("statutory");
  });

  it("FIN-MDM-01 periods and locks respect the fiscal year: a January-start book closes and carries forward on 31 December", async () => {
    expect(financialYear("2026-10-25")).toEqual({ from: "2026-04-01", to: "2027-03-31", label: "FY 2026-27" });
    expect(financialYear("2026-10-25", 1)).toEqual({ from: "2026-01-01", to: "2026-12-31", label: "FY 2026" });
    expect(financialYear("2026-02-10", 7)).toEqual({ from: "2025-07-01", to: "2026-06-30", label: "FY 2025-26" });
    await cell.gl.openBook(T, B_CAL, "cal", "company", P.owner, { legalEntityId: "ent-c", fiscalYearStartMonth: 1 });
    await post([L("BANK", 500000n), L("FEES", -500000n)], "2026-06-10", B_CAL);
    const saved = clock.value;
    clock.value = "2027-01-05";
    try {
      const wrongEnd = await plan("carry_forward", { yearEnd: "2027-03-31" }, P.owner, B_CAL);
      expect(wrongEnd.blocked).toBe(true);
      expect(wrongEnd.checks.find((c) => c.label === "Date is the fiscal year end")).toMatchObject({ ok: false, detail: "FY 2027 ends 2027-12-31" });
      const close = await plan("close", { periodEnd: "2026-12-31" }, P.owner, B_CAL);
      expect(close.title).toBe("Close FY 2026");
      expect(close.journals.map((j) => j.voucherType)).toEqual(["closing"]);          // year-end: closing voucher
      await commit(close, P.controller);                                           // a period operation: a second person
      const s = await cell.gl.state(T, B_CAL);
      expect(s.locks).toContainEqual({ periodEnd: "2026-12-31", level: "hard" });
      expect(balancesFromState(s).get("FEES") ?? 0n).toBe(0n);
      const cf = await plan("carry_forward", { yearEnd: "2026-12-31" }, P.owner, B_CAL);
      expect(cf.blocked).toBe(false);
      expect(cf.title).toBe("Open FY 2027");
      // An April book treats 31 December as an ordinary period end (no closing voucher).
      const aprilClose = await plan("close", { periodEnd: "2026-12-31" }, P.owner, B_BUDGET);
      expect(aprilClose.journals).toEqual([]);
    } finally { clock.value = saved; }
  });
});

// ================================================================= FIN-MDM-02
describe("FIN-MDM-02 chart of accounts controls", () => {
  it("FIN-MDM-02 every account maps to a statement line; unmapped accounts are exceptions in the books-in-order check", async () => {
    const ok = await plan("balance", {});
    expect(ok.checks.find((c) => c.label === "Every account maps to a statement line")).toMatchObject({ ok: true });
    await cell.gl.execute(T, B, { kind: "AddAccount", account: { accountId: "GIFTS", name: "Gifts", nature: "expense", isControl: false, isCashLike: false, requiredDims: [] } }, { principal: P.owner });
    const bad = await plan("balance", {});
    expect(bad.checks.find((c) => c.label === "Every account maps to a statement line")).toMatchObject({ ok: false, blocking: false, detail: "unmapped: GIFTS" });
    expect(bad.title).toBe("Books balance; some items are open");
    // Mapping it clears the exception; the change is an event that records the previous mapping.
    const w = await cell.gl.execute(T, B, { kind: "ChangeAccountControls", accountId: "GIFTS", taxonomyTag: "PL.other_expenses", reason: "map" }, { principal: P.controller });
    expect(w[0]!.data).toMatchObject({ accountId: "GIFTS", taxonomyTag: "PL.other_expenses", previous: { taxonomyTag: null, requiredDims: [] } });
    expect((await plan("balance", {})).checks.find((c) => c.label === "Every account maps to a statement line")).toMatchObject({ ok: true });
    // Only an owner or controller changes account controls.
    await expect(cell.gl.execute(T, B, { kind: "ChangeAccountControls", accountId: "GIFTS", taxonomyTag: "PL.x" }, { principal: P.preparer })).rejects.toThrow(/owner or controller/);
  });

  it("FIN-MDM-02 mandatory dimensions per account: a line missing one (or with it blank) is refused", async () => {
    await cell.gl.execute(T, B, { kind: "ChangeAccountControls", accountId: "BIZEXP", requiredDims: ["branch"] }, { principal: P.owner });
    await expect(post([L("BIZEXP", 100n), L("BANK", -100n)])).rejects.toThrow(/requires dimensions branch/);
    await expect(post([L("BIZEXP", 100n, { dimensions: { branch: " " } }), L("BANK", -100n)])).rejects.toThrow(/requires dimensions branch/);
    await post([L("BIZEXP", 100n, { dimensions: { branch: "chennai" } }), L("BANK", -100n)]);
    // An ops plan shows the refusal as a blocking check before anything is stored.
    const p = await plan("record", { narration: "Stationery", amount: 10, direction: "out", account: "BIZEXP", via: "BANK", date: "2026-10-06" });
    expect(p.blocked).toBe(true);
    expect(p.checks.find((c) => c.label === "Ledger rules satisfied")?.detail).toMatch(/requires dimensions branch/);
    await cell.gl.execute(T, B, { kind: "ChangeAccountControls", accountId: "BIZEXP", requiredDims: [] }, { principal: P.owner });
  });

  it("FIN-MDM-02 CloseAccount stops ordinary entries but still allows reversals and corrections of historical journals", async () => {
    await cell.gl.execute(T, B, { kind: "AddAccount", account: { accountId: "PROMO", name: "Promotions", nature: "expense", taxonomyTag: "PL.other_expenses",
      isControl: false, isCashLike: false, requiredDims: [] } }, { principal: P.owner });
    const j1 = await post([L("PROMO", 50000n), L("BANK", -50000n)], "2026-10-07");
    await expect(cell.gl.execute(T, B, { kind: "CloseAccount", accountId: "PROMO", reason: "campaign over" }, { principal: P.owner })).rejects.toThrow(/has a balance/);
    const j2 = await post([L("BANK", 50000n), L("PROMO", -50000n)], "2026-10-08");     // refund clears it
    await expect(cell.gl.execute(T, B, { kind: "CloseAccount", accountId: "PROMO", reason: "x" }, { principal: P.preparer })).rejects.toThrow(/owner or controller/);
    await cell.gl.execute(T, B, { kind: "CloseAccount", accountId: "PROMO", reason: "campaign over" }, { principal: P.owner });
    // Idempotent; new ordinary entries are refused, directly and in plans.
    expect(await cell.gl.execute(T, B, { kind: "CloseAccount", accountId: "PROMO", reason: "again" }, { principal: P.owner })).toEqual([]);
    await expect(post([L("PROMO", 100n), L("BANK", -100n)], "2026-10-09")).rejects.toThrow(/PROMO is closed/);
    const p = await plan("record", { narration: "Flyers", amount: 5, direction: "out", account: "PROMO", via: "BANK", date: "2026-10-09" });
    expect(p.blocked).toBe(true);
    await expect(cell.gl.execute(T, B, { kind: "AddAccount", account: { accountId: "PROMO2", name: "Sub", nature: "expense", parentId: "PROMO",
      isControl: false, isCashLike: false, requiredDims: [] } }, { principal: P.owner })).rejects.toThrow(/parent PROMO is closed/);
    // A reversal of a historical journal still posts to the closed account.
    await cell.gl.execute(T, B, { kind: "ReverseJournal", journalId: j1, reversalJournalId: uuid(), reason: "duplicate" }, { principal: P.owner });
    // A correction out of the closed account posts; one into it is refused.
    await cell.gl.execute(T, B, { kind: "CorrectJournal", journalId: j2, fromAccount: "PROMO", toAccount: "OTHINC", reversalJournalId: uuid(), newJournalId: uuid() }, { principal: P.owner });
    const other = await post([L("LIVING", 700n), L("BANK", -700n)], "2026-10-09");
    await expect(cell.gl.execute(T, B, { kind: "CorrectJournal", journalId: other, fromAccount: "LIVING", toAccount: "PROMO", reversalJournalId: uuid(), newJournalId: uuid() },
      { principal: P.owner })).rejects.toThrow(/PROMO is closed/);
    const s = await cell.gl.state(T, B);
    expect(s.closed.has("PROMO")).toBe(true);
    expect(balancesFromState(s).get("PROMO")).toBe(0n);
    // HTTP: closing needs account.close (owner, controller).
    expect((await as(P.preparer, "POST", `/v1/tenants/${T}/books/${B}/accounts/GIFTS/close`, { reason: "unused" })).statusCode).toBe(403);
    expect((await as(P.controller, "POST", `/v1/tenants/${T}/books/${B}/accounts/GIFTS/close`, { reason: "unused" })).statusCode).toBe(201);
  });

  it("FIN-MDM-02 reclassification preserves history: the original journal stays, reversed and reposted, and the chain verifies", async () => {
    const j = await post([L("LIVING", 12300n), L("BANK", -12300n)], "2026-10-10");
    const rev = uuid(), repost = uuid();
    await cell.gl.execute(T, B, { kind: "CorrectJournal", journalId: j, fromAccount: "LIVING", toAccount: "BIZEXP", reversalJournalId: rev, newJournalId: repost }, { principal: P.owner });
    const s = await cell.gl.state(T, B);
    expect(s.journals.get(j)).toMatchObject({ reversedBy: rev, lines: [expect.objectContaining({ accountId: "LIVING", amount: "12300" }), expect.anything()] });
    expect(s.journals.get(rev)!.lines.map((l) => [l.accountId, l.amount])).toEqual([["LIVING", "-12300"], ["BANK", "12300"]]);
    expect(s.journals.get(repost)!.lines.map((l) => [l.accountId, l.amount])).toEqual([["BIZEXP", "12300"], ["BANK", "-12300"]]);
    expect(await cell.gl.verify(T, B, { full: true })).toBeNull();
    // A statement remapping is also history, not an overwrite: replaying up to before it gives the old mapping.
    const events = await cell.store.readStream(T, `${T}/book/${B}`);
    const at = events.findIndex((e) => e.type === "AccountControlsChanged" && (e.data as { accountId: string }).accountId === "GIFTS");
    expect(fold(events.slice(0, at)).accounts.get("GIFTS")!.taxonomyTag).toBeUndefined();
    expect(fold(events).accounts.get("GIFTS")!.taxonomyTag).toBe("PL.other_expenses");
    expect(verifyChain(events)).toBeNull();
  });
});

// ================================================================= FIN-MDM-03
describe("FIN-MDM-03 party master", () => {
  it("FIN-MDM-03 identity, terms and tax status are effective-dated", async () => {
    await cell.parties.register(T, P.preparer, { partyId: "V-TERMS", entityId: "ent-a", kind: "vendor", name: "Old Name Pvt Ltd", effectiveFrom: "2026-04-01",
      terms: { creditDays: 30, msme: true }, taxStatus: { gstRegistered: true, gstin: "33ABCDE1234F1Z5", pan: "ABCDE1234F" } });
    await cell.parties.changeDetails(T, P.preparer, "V-TERMS", { effectiveFrom: "2026-10-01", name: "New Name Pvt Ltd", terms: { creditDays: 45, msme: true } });
    const before = await cell.parties.get(T, "V-TERMS", "2026-09-30");
    const after = await cell.parties.get(T, "V-TERMS", "2026-10-15");
    expect(before).toMatchObject({ name: "Old Name Pvt Ltd", terms: { creditDays: 30 }, taxStatus: { gstin: "33ABCDE1234F1Z5" }, entityId: "ent-a" });
    expect(after).toMatchObject({ name: "New Name Pvt Ltd", terms: { creditDays: 45 }, taxStatus: { gstin: "33ABCDE1234F1Z5" } });
    expect(await cell.parties.get(T, "V-TERMS", "2026-03-31")).toMatchObject({ name: null, terms: null });
  });

  it("FIN-MDM-03 creating, verifying and releasing a bank change are separate rights, and never the same person as the maker", async () => {
    await expect(cell.parties.register(T, P.member, { partyId: "V-X", entityId: "ent-a", kind: "vendor", name: "X" })).rejects.toThrow(/may not party.manage/);
    await expect(cell.parties.register(T, P.agent, { partyId: "V-X", entityId: "ent-a", kind: "vendor", name: "X" })).rejects.toThrow(/agent may not/);
    await cell.parties.register(T, P.preparer, { partyId: "V-RIGHTS", entityId: "ent-a", kind: "vendor", name: "Rights Co" });
    const { changeId } = await cell.parties.requestBankChange(T, P.controller, "V-RIGHTS", { bank: BANK2, source: "email from accounts@rights.example" });
    await expect(cell.parties.verifyBankChange(T, P.preparer, "V-RIGHTS", changeId, { method: "call_back", reference: "x" })).rejects.toThrow(/may not party.bank.verify/);
    await expect(cell.parties.verifyBankChange(T, P.controller, "V-RIGHTS", changeId, { method: "call_back", reference: "x" })).rejects.toThrow(/cannot verify it/);
    await expect(cell.parties.releaseBankChange(T, P.approver, "V-RIGHTS", changeId)).rejects.toThrow(/must be verified before release/);
    await cell.parties.verifyBankChange(T, P.approver, "V-RIGHTS", changeId, { method: "penny_drop", reference: "PD-77" });
    await expect(cell.parties.releaseBankChange(T, P.preparer, "V-RIGHTS", changeId)).rejects.toThrow(/may not party.bank.release/);
    await expect(cell.parties.releaseBankChange(T, P.controller, "V-RIGHTS", changeId)).rejects.toThrow(/cannot release it/);
    expect(await cell.parties.releaseBankChange(T, P.owner, "V-RIGHTS", changeId)).toEqual({ changeId, status: "released", hold: false });
    // The agent may never approve (pure rule, independent of any role table).
    const s = { ...emptyParty(), exists: true, partyId: "p", bankChanges: [{ changeId: "c", effectiveFrom: "2026-01-01", bank: BANK1, accountIdx: "i", status: "verified" as const, requestedBy: "preparer:dev" }] };
    expect(code(() => decideParty(s, { kind: "ReleaseBankChange", changeId: "c" }, "agent:bot"))).toBe("forbidden");
    // HTTP: the same rights at the boundary.
    const r = await as(P.preparer, "POST", `/v1/tenants/${T}/parties/V-RIGHTS/bank-changes`, { bank: BANK1 });
    expect(r.statusCode).toBe(201);
    expect((await as(P.preparer, "POST", `/v1/tenants/${T}/parties/V-RIGHTS/bank-changes/${r.json().changeId}/verify`, { method: "call_back", reference: "c" })).statusCode).toBe(403);
    const shown = (await as(P.member, "GET", `/v1/tenants/${T}/parties/V-RIGHTS`)).json();
    expect(shown.bank.accountNumber).toBe("••••4444");                    // masked; the released BANK2
    expect(shown.hold).toBe(true);
  });

  it("FIN-MDM-03 an unverified bank change holds new and previously proposed payments; verification plus fresh approval releases them", async () => {
    await cell.parties.register(T, P.preparer, { partyId: "V-PAY", entityId: "ent-a", kind: "vendor", name: "Sharma Traders" });
    const first = await cell.parties.requestBankChange(T, P.preparer, "V-PAY", { bank: BANK1 });
    await cell.parties.verifyBankChange(T, P.approver, "V-PAY", first.changeId, { method: "call_back", reference: "call 1" });
    await cell.parties.releaseBankChange(T, P.controller, "V-PAY", first.changeId);
    await post([L("BIZEXP", 2500000n), L("CREDITORS", -2500000n, { partyId: "V-PAY" })], "2026-10-11");       // the bill
    const pay = { narration: "Pay Sharma Traders", amount: 25000, direction: "out", account: "CREDITORS", via: "BANK", date: "2026-10-20", party: "V-PAY" };
    const earlier = await plan("record", pay);                                  // proposed while details were approved
    expect(earlier.status).toBe("proposed");
    expect(earlier.checks.find((c) => c.label.startsWith("No payment to a party on hold"))).toMatchObject({ ok: true });

    const change = await cell.parties.requestBankChange(T, P.preparer, "V-PAY", { bank: BANK2, source: "WhatsApp: 'update urgently'" });
    expect(change).toMatchObject({ status: "pending", hold: true });
    // New proposals are blocked with a blocking check (shown, never stored) ...
    const fresh = await plan("record", { ...pay, narration: "Pay Sharma again" });
    expect(fresh.blocked).toBe(true);
    expect(fresh.status).toBe("preview");
    expect(fresh.checks.find((c) => c.label === "No payment to a party on hold (POL-501)")).toMatchObject({ ok: false, blocking: true });
    // ... and the earlier, unpaid proposal is held at commit, nothing applied, still open.
    const seq = (await cell.gl.state(T, B)).seq;
    await expect(commit(earlier)).rejects.toThrow(/held/);
    expect((await cell.ops.get(T, earlier.planId)).status).toBe("proposed");
    expect((await cell.gl.state(T, B)).seq).toBe(seq);
    // Receipts from the party are not payments and are not held.
    expect((await plan("record", { narration: "Refund from Sharma", amount: 10, direction: "in", account: "CREDITORS", via: "BANK", date: "2026-10-20", party: "V-PAY" })).blocked).toBe(false);

    // Verification alone does not release; the fresh approval does.
    await cell.parties.verifyBankChange(T, P.approver, "V-PAY", change.changeId, { method: "call_back", reference: "number on file" });
    await expect(commit(earlier)).rejects.toThrow(/held/);
    await cell.parties.releaseBankChange(T, P.controller, "V-PAY", change.changeId);
    expect(await commit(earlier)).toMatchObject({ status: "committed" });
    expect(await cell.parties.get(T, "V-PAY")).toMatchObject({ hold: false, bank: BANK2, openChange: null });
  });

  it("FIN-MDM-03 drafts paying a party on hold cannot be approved, directly or through a post plan", async () => {
    const csv = ["Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance",
      "12/10/2026,NEFT DR-KAVERI PACKAGING WORKS-INV 88,N99001,8800.00,,91200.00"].join("\n");
    await cell.channels.submitStatement(T, B, csv, P.owner);
    await cell.settle();
    const drafts = (await cell.agent.queue(T, { bookId: B })) as unknown as { draft_id: string; proposal: { lines: Line[]; narration: string } }[];
    const d = drafts.find((x) => /KAVERI/.test(x.proposal.narration))!;
    const partyId = d.proposal.lines.find((l) => l.partyId)!.partyId!;
    // The agent's counterparty becomes a master party; its bank details are then changed.
    await cell.parties.register(T, P.preparer, { partyId, entityId: "ent-a", kind: "vendor", name: "Kaveri Packaging Works" });
    const ch = await cell.parties.requestBankChange(T, P.preparer, partyId, { bank: { ...BANK1, accountNumber: "77770000111122", holderName: "Kaveri" } });
    const p = await plan("post", { draftIds: [d.draft_id], overrides: { [d.draft_id]: "BIZEXP" } });
    expect(p.blocked).toBe(true);
    expect(p.checks.find((c) => c.label === "No payment to a party on hold (POL-501)")?.ok).toBe(false);
    await expect(cell.agent.approveDraft(T, d.draft_id, P.owner, "BIZEXP")).rejects.toThrow(/held/);
    // A rejected change (verification failed) lifts the hold; the earlier approved details stay in force.
    expect(await cell.parties.rejectBankChange(T, P.approver, partyId, ch.changeId, "vendor denies the change on the number on file")).toMatchObject({ status: "rejected", hold: false });
    expect(await cell.agent.approveDraft(T, d.draft_id, P.owner, "BIZEXP")).toMatchObject({ status: "approved" });
  });

  it("FIN-MDM-03 a shared bank account on two parties raises a review item, not a merge", async () => {
    await cell.parties.register(T, P.preparer, { partyId: "V-SH1", entityId: "ent-a", kind: "vendor", name: "Shared One" });
    await cell.parties.register(T, P.preparer, { partyId: "V-SH2", entityId: "ent-a", kind: "vendor", name: "Shared Two" });
    const acct = { accountNumber: "000123456789012", ifsc: "SBIN0001111", holderName: "Shared" };
    expect((await cell.parties.requestBankChange(T, P.preparer, "V-SH1", { bank: acct })).sharedWith).toEqual([]);
    // Same account (leading zeros and all), different party.
    const second = await cell.parties.requestBankChange(T, P.preparer, "V-SH2", { bank: { ...acct, accountNumber: "123456789012" } });
    expect(second.sharedWith).toEqual(["V-SH1"]);
    const reviews = await cell.parties.reviews(T);
    expect(reviews).toContainEqual({ reviewId: expect.any(String), partyId: "V-SH2", otherPartyId: "V-SH1", reason: "shared_bank_account" });
    // Both parties remain distinct.
    expect(await cell.parties.get(T, "V-SH1")).toMatchObject({ partyId: "V-SH1", name: "Shared One" });
    expect(await cell.parties.get(T, "V-SH2")).toMatchObject({ partyId: "V-SH2", name: "Shared Two" });
    expect((await as(P.member, "GET", `/v1/tenants/${T}/parties/reviews`)).json()).toHaveLength(reviews.length);
  });

  it("FIN-MDM-03 bank details are sealed at rest and the change is governed by POL-501", async () => {
    const [r] = await cell.store.tenantTx(T, (tx) => tx<{ bank: string; account_idx: string }[]>`
      SELECT bank, account_idx FROM mdm.bank_changes WHERE tenant_id = ${T} AND party_id = 'V-PAY' ORDER BY requested_at DESC LIMIT 1`);
    if (!r) throw new Error("no bank change row");
    expect(r.bank).not.toContain(BANK2.accountNumber);
    expect(r.account_idx).not.toContain(BANK2.accountNumber);
    const [detail] = await cell.store.tenantTx(T, (tx) => tx<{ detail: string }[]>`SELECT detail FROM mdm.parties WHERE tenant_id = ${T} AND party_id = 'V-PAY'`);
    expect(detail!.detail).not.toContain("Sharma");
    expect(SEALED_COLUMNS.map((c) => `${c.table}.${c.column}`)).toEqual(expect.arrayContaining(["mdm.parties.detail", "mdm.bank_changes.bank"]));
    expect(RETENTION).toMatchObject({ "mdm.parties": "purge", "mdm.bank_changes": "purge", "mdm.reviews": "purge" });
    // Event payloads are sealed like every event.
    const [raw] = await cell.store.tenantTx(T, (tx) => tx<{ data: unknown }[]>`SELECT data FROM es.events WHERE stream_id = ${`${T}/party/V-PAY`} AND type = 'BankChangeRequested' LIMIT 1`);
    expect(JSON.stringify(raw!.data)).not.toContain(BANK1.accountNumber);
    // POL-501 governs the event: L1 (a person decides), and the request carries it.
    expect(cell.policies.decide({ eventCode: "EVT-VENDOR-BANK-CHANGE", on: "2026-10-25", confidence: 1 })).toMatchObject({ policyIds: ["POL-501"], level: "L1" });
    const events = await cell.store.readStream(T, `${T}/party/V-PAY`);
    expect(events.find((e) => e.type === "BankChangeRequested")!.meta.policyIds).toEqual(["POL-501"]);
    // The pure aggregate replays to the same hold state.
    expect(events.reduce(evolveParty, emptyParty()).bankChanges.map((c) => c.status)).toEqual(["released", "released"]);
  });
});
