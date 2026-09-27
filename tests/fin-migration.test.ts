/**
 * G1 legacy migration (Kuber CFO requirements §3.12; design 16.7):
 *   FIN-MIG-01  inventory, mapping and provenance; posted opening GL vs subledger open items
 *   FIN-MIG-02  rehearsal, delta import, numbering, bank coverage, authority switch, parallel run, signed go-live
 *   FIN-MIG-03  pre-cutover rollback vs post-cutover recovery; rehearsal cannot emit external effects; fallback
 *
 * Fixtures (tests/fixtures/migration): a Tally XML export (ledger masters with opening bills, stock
 * items, day book, trial balances at the cut-off and at the end of the parallel month) and a Zoho
 * Books CSV export (chart, contacts, trial balance, open invoices and bills). Fictitious data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer, RETENTION, SEALED_COLUMNS, type Cell } from "@kuber/core";
import { MigrationError, XmlError, bookBalances, parseGenericCsv, parseTally, parseXml, strictPaise, type Migration } from "@kuber/migration";
import { CORE_AUTH_SECRET, ROOT, SoftAuthenticator, enrol, signedInject, startCell, type SignedRequest } from "./helpers.ts";

const T = "migr", B = "main", Z = "zbook";
const P = { su: "superuser:ravi", ctrl: "controller:asha", staff: "staff:pia" };
const CUTOFF = "2026-03-31";
const clock = { value: "2026-05-02" };
const fx = (name: string) => readFileSync(join(ROOT, "tests", "fixtures", "migration", name), "utf8");
let cell: Cell, stop: () => Promise<void>, app: FastifyInstance, m: Migration;
let send: ReturnType<typeof signedInject>;
const keys: Record<string, SoftAuthenticator> = {};
const as = (principal: string | null, method: SignedRequest["method"], url: string, payload?: unknown) =>
  send({ method, url: `/v1/tenants/${T}${url}`, tenant: T, principal, payload });
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const balancesOf = async (book: string, asOf: string | null = null) => bookBalances((await cell.gl.state(T, book)).journals.values(), asOf).byAccount;
const nonZero = (m: Map<string, bigint>) => [...m].filter(([, v]) => v !== 0n);

beforeAll(async () => {
  ({ cell, stop } = await startCell(clock));
  app = buildServer(cell, { clock: () => clock.value, auth: { secret: CORE_AUTH_SECRET } });
  send = signedInject(app);
  m = cell.migration;
  // The superuser claims the workspace with a passkey (signs the go-live); the controller runs the migration.
  keys[P.su] = new SoftAuthenticator();
  const o = (await as(null, "POST", "/identity/registration/options", { displayName: "Ravi" })).json();
  expect((await as(null, "POST", "/identity/registration/verify", { displayName: "Ravi", response: keys[P.su]!.create(o) })).json().principal).toBe(P.su);
  await enrol(cell, T, [P.ctrl, P.staff]);
  await cell.gl.openBook(T, B, "kaveri", "company", P.su, { legalEntityId: "kaveri" });
  await cell.gl.openBook(T, Z, "zenith", "company", P.su, { legalEntityId: "zenith" });
});
afterAll(async () => { await app?.close(); await stop?.(); });

// ================================================================= parsers (defensive)
describe("FIN-MIG-01 source adapters parse untrusted files defensively", () => {
  it("FIN-MIG-01 the XML reader refuses DTDs and entity expansion, unknown entities and over-limit documents", () => {
    expect(() => parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')).toThrow(/document type declarations are not accepted/);
    expect(() => parseXml('<x>&ext;</x>')).toThrow(/entity &ext; is not allowed/);
    expect(() => parseXml("<a><b></a>")).toThrow(XmlError);
    expect(() => parseXml("<a>" + "<b>".repeat(70) + "</b>".repeat(70) + "</a>")).toThrow(/nesting deeper/);
    expect(() => parseXml("<a>x</a>", { maxChars: 4, maxElements: 10, maxDepth: 5, maxAttrs: 2, maxText: 10 })).toThrow(/larger than/);
    expect(parseXml("<a n='1 &amp; 2'>&#65;&lt;&#x42;</a>")).toMatchObject({ name: "a", attrs: { n: "1 & 2" }, text: "A<B" });
    expect(() => parseTally("<ENVELOPE><!ENTITY x SYSTEM 'file:///etc/passwd'></ENVELOPE>", { fileHash: "0".repeat(64), purpose: "source", asOf: null })).toThrow(MigrationError);
  });
  it("FIN-MIG-01 amounts are integer paise with at most two decimals (never rounded); the generic CSV template parses", () => {
    expect(strictPaise("1,20,000.50")).toBe(12000050n);
    expect(strictPaise("-5900.00")).toBe(-590000n);
    expect(() => strictPaise("10.005")).toThrow(/at most two decimals/);
    const g = parseGenericCsv(fx("generic-template.csv"), { fileHash: "1".repeat(64), purpose: "source", asOf: null });
    expect(g.problems).toEqual([]);
    expect(g.openingBalances.reduce((a, b) => a + BigInt(b.amount), 0n)).toBe(0n);
    expect(g.schedules.map((s) => s.kind).sort()).toEqual(["assets", "commitments"]);
  });
});

// ================================================================= Tally: inventory, mapping, rehearsal, load
let project: string, rehearsal: { loadId: string; bookId: string }, target: { loadId: string };

describe("FIN-MIG-01 inventory, mapping and provenance (Tally)", () => {
  it("FIN-MIG-01 Tally fixtures load: masters, opening bills, stock, day book and the cut-off trial balance are inventoried", async () => {
    // Over HTTP: create the project (controller), upload the files.
    const created = await as(P.ctrl, "POST", "/migrations", { bookId: B, sourceSystem: "tally", cutoff: CUTOFF, projectId: "kaveri-tally" });
    expect(created.statusCode, created.body).toBe(201);
    project = created.json().projectId;
    expect((await as(P.staff, "POST", "/migrations", { bookId: Z, sourceSystem: "zoho", cutoff: CUTOFF })).statusCode).toBe(403);   // not a staff action
    const up = (name: string, extra: Record<string, unknown> = {}) => as(P.ctrl, "POST", `/migrations/${project}/files`, { name, content: fx(name), ...extra });
    const masters = await up("tally-masters.xml");
    expect(masters.statusCode, masters.body).toBe(201);
    expect(masters.json().counts).toMatchObject({ accounts: 9, parties: 2, balances: 7, open_items: 3, stock: 2, tax: 1 });
    expect((await up("tally-daybook.xml")).json().counts).toMatchObject({ vouchers: 6 });
    expect((await up("tally-tb-2026-03-31.xml", { asOf: CUTOFF })).json().counts).toMatchObject({ trial_balance_rows: 7 });
    expect((await up("tally-masters.xml")).json()).toMatchObject({ duplicate: true });                   // same bytes: nothing new
    const inv = await m.inventory(T, project);
    const cat = Object.fromEntries(inv.categories.map((c) => [c.category, c]));
    expect(cat.masters).toMatchObject({ inScope: true, detail: { accounts: 9, parties: 2, partiesWithBankDetails: 2 } });
    expect(cat.opening_balances).toMatchObject({ count: 7, detail: { debits: "57700000", credits: "57700000", basis: "books_start" } });
    expect(cat.stock).toMatchObject({ count: 2, detail: { value: "12400000" } });
    expect(cat.history).toMatchObject({ count: 1, detail: { vouchersAfterCutoff: 4, cancelled: 1 } });
    // Originals are retained sealed with their hash; bank details never appear in plaintext.
    const files = await m.files(T, project);
    const orig = await m.original(T, project, files[0]!.fileId);
    expect(orig).toMatchObject({ verified: true });
    const [raw] = await cell.store.tenantTx(T, (tx) => tx<{ extract: string; original: string }[]>`SELECT extract, original FROM migration.files WHERE tenant_id = ${T} LIMIT 1`);
    expect(raw!.extract + raw!.original).not.toContain("50100012345678");
    expect(SEALED_COLUMNS.map((c) => `${c.table}.${c.column}`)).toEqual(expect.arrayContaining(["migration.files.extract", "migration.mappings.detail", "migration.records.source"]));
    expect(RETENTION).toMatchObject({ "migration.files": "purge", "migration.open_items": "purge", "migration.records": "purge" });
  });

  it("FIN-MIG-01 mapping approval gate: suggestions wait for a person, unmapped ledgers block the load, suspense is refused", async () => {
    const map = await m.mapping(T, project);
    const by = Object.fromEntries(map.rows.map((r) => [r.sourceKey, r]));
    expect(by["Sharma Traders"]).toMatchObject({ status: "suggested", accountId: "DEBTORS", party: "customer" });
    expect(by["Mehta Supplies & Co"]).toMatchObject({ accountId: "CREDITORS", party: "vendor" });
    expect(by["HDFC Bank A/c 5678"]).toMatchObject({ accountId: "BANK", bank: true });
    expect(by["Output GST"]).toMatchObject({ accountId: "GSTOUT" });
    expect(by["Stock"]!.newAccount).toMatchObject({ nature: "asset" });
    expect(map.summary.unmapped).toBeGreaterThan(0);
    // Nothing is approved yet: the rehearsal is blocked.
    const blocked = await m.rehearse(T, P.ctrl, project).catch((e: MigrationError) => e);
    expect(blocked).toBeInstanceOf(MigrationError);
    expect((blocked as MigrationError).code).toBe("load_blocked");
    expect(((blocked as MigrationError).detail as { code: string }[]).every((p) => p.code === "unmapped")).toBe(true);
    // Suspense cannot hide a mapping gap; a nature mismatch and a party ledger to a non-control account are refused.
    expect(await code(m.approveMapping(T, P.ctrl, project, { rows: [{ sourceKey: "Stock", accountId: "SUSPENSE" }] }))).toBe("suspense_target");
    expect(await code(m.approveMapping(T, P.ctrl, project, { rows: [{ sourceKey: "Capital Account", accountId: "BANK" }] }))).toBe("nature_mismatch");
    expect(await code(m.approveMapping(T, P.ctrl, project, { rows: [{ sourceKey: "Sharma Traders", accountId: "BANK" }] }))).toBe("needs_control");
    expect((await as(P.staff, "POST", `/migrations/${project}/mapping/approve`, { acceptSuggested: true })).statusCode).toBe(403);
    // A person approves one mapping explicitly and the rest as suggested.
    await m.approveMapping(T, P.ctrl, project, { rows: [{ sourceKey: "Capital Account", accountId: "CAPITAL" }] });
    const r = await as(P.ctrl, "POST", `/migrations/${project}/mapping/approve`, { acceptSuggested: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().summary).toMatchObject({ unmapped: 0 });
    const events = await cell.store.readStream(T, `${T}/migration/${project}`);
    expect(events.filter((e) => e.type === "MigrationMappingApproved").length).toBe(map.rows.length);
    expect(events.every((e) => e.meta.principal === P.ctrl)).toBe(true);
  });

  it("FIN-MIG-02 rehearsal in an isolated book; FIN-MIG-01 TB reconciliation by account, totals and counts", async () => {
    const before = await balancesOf(B);
    const r = await m.rehearse(T, P.ctrl, project);
    rehearsal = r;
    expect(r.bookId).toBe(`${B}.rh1`);
    expect((await cell.gl.state(T, r.bookId)).config).toMatchObject({ basis: "scenario", legalEntityId: "kaveri" });
    expect(await balancesOf(B)).toEqual(before);                                  // the target book is untouched
    const rec = r.reconciliation;
    expect(rec.checks).toEqual({ trialBalance: true, totals: true, openItemsByParty: true, counts: true, noGlRepost: true, sourceTotals: true, schedules: true });
    expect(rec.reconciled).toBe(true);
    expect(rec.totals).toEqual({ source: { debits: "57700000", credits: "57700000" }, target: { debits: "57700000", credits: "57700000" } });
    const tb = Object.fromEntries((rec.trialBalance as unknown as { accountId: string; target: string; difference: string }[]).map((x) => [x.accountId, x]));
    expect(tb.BANK).toMatchObject({ target: "36720000", difference: "0" });      // opening + the receipt before the cut-off
    expect(tb.DEBTORS).toMatchObject({ target: "7080000", difference: "0" });
    expect(tb.CAPITAL).toMatchObject({ target: "-50000000" });
    expect(rec.counts).toMatchObject({ sourceLedgers: 7, loadedLedgers: 7, sourceOpenItems: 2, loadedOpenItems: 2, openingJournals: 1, journalsToCutoff: 1 });
    expect(rec.schedules).toEqual([expect.objectContaining({ kind: "stock", accountKey: "Stock", items: 2, scheduleValue: "12400000", ties: true })]);
  });

  it("FIN-MIG-03 rehearsal cannot emit external effects: every write operation is refused in a rehearsal book", async () => {
    const refused = await cell.ops.plan(T, rehearsal.bookId, P.su, "rebalance", { targets: [{ account: "BANK", pct: 50 }, { account: "CASH", pct: 50 }] }).catch((e) => e);
    expect(refused).toMatchObject({ code: "book_restricted" });
    expect(String(refused.message)).toMatch(/load-only/);
    expect(await code(cell.ops.plan(T, rehearsal.bookId, P.su, "record", { date: "2026-04-02", amount: "100", from: "BANK", to: "BIZEXP", narration: "x" }))).toBe("book_restricted");
    // Read operations still run (the rehearsal is inspected), and the target book is not restricted.
    expect((await cell.ops.plan(T, rehearsal.bookId, P.su, "balance", {})).kind).toBe("read");
    expect(await m.rehearsalGate(T, B, { name: "rebalance", kind: "write" })).toBeNull();
    // The migration itself issues nothing: documents the source issued are only recorded.
    const http = await as(P.su, "POST", `/books/${rehearsal.bookId}/ops/rebalance`, { targets: [{ account: "BANK", pct: 50 }, { account: "CASH", pct: 50 }] });
    expect(http.statusCode).toBe(409);
    expect(http.json().error).toBe("book_restricted");
  });

  it("FIN-MIG-03 rollback of a rehearsal discards the rehearsal book whole; the target book never saw it", async () => {
    const before = await balancesOf(B);
    const r = await m.rollback(T, P.ctrl, project, { loadId: rehearsal.loadId, reason: "rehearsal reviewed" });
    expect(r).toMatchObject({ method: "discard_book", reversals: [] });
    expect(await balancesOf(B)).toEqual(before);
    expect(await code(cell.ops.plan(T, rehearsal.bookId, P.su, "balance", {}))).toBe("book_restricted");   // nothing runs in a discarded rehearsal
    expect(await code(m.delta(T, P.ctrl, project, { loadId: rehearsal.loadId }))).toBe("load_voided");
  });

  it("FIN-MIG-01 open items reconcile to control accounts with no GL repost (target load)", async () => {
    const r = await as(P.ctrl, "POST", `/migrations/${project}/load`, {});
    expect(r.statusCode, r.body).toBe(201);
    target = r.json();
    const rec = r.json().reconciliation;
    expect(rec.reconciled).toBe(true);
    // One opening journal; the open items are a subledger: they did not post anything.
    const st = await cell.gl.state(T, B);
    expect([...st.journals.values()].map((j) => j.voucherType)).toEqual(["opening"]);
    expect(rec.counts).toMatchObject({ journalsToCutoff: 1, openingJournals: 1 });
    const items = await m.openItems(T, project, target.loadId);
    expect(items.map((i) => [i.docNo, i.amount, i.kind])).toEqual(expect.arrayContaining([["INV-101", "7080000", "receivable"], ["PB-55", "-5900000", "payable"]]));
    expect(items.find((i) => i.docNo === "PB-55")).toMatchObject({ docDate: "2026-03-20", dueDate: "2026-05-04" });
    expect(items.some((i) => i.docNo === "INV-102")).toBe(false);                    // settled by the receipt before the cut-off
    // Per control account and party: open items = GL control balance at the cut-off.
    for (const row of rec.openItems) expect(row.difference).toBe("0");
    expect(rec.controlTotals).toEqual(expect.arrayContaining([{ accountId: "DEBTORS", openItems: "7080000", control: "7080000" }, { accountId: "CREDITORS", openItems: "-5900000", control: "-5900000" }]));
    // Parties are in the party master; their migrated bank details wait for maker-checker verification (on hold).
    expect(r.json().bankDetailsAwaitingVerification.length).toBe(2);
    const sharma = rec.openItems.find((x: { accountId: string }) => x.accountId === "DEBTORS").partyId;
    expect(await cell.parties.get(T, sharma)).toMatchObject({ name: "Sharma Traders", entityId: "kaveri", hold: true, taxStatus: { gstin: "33ABCDE1234F1Z5" } });
    // A second target load of the same book is refused while one is active.
    expect(await code(m.load(T, P.ctrl, project))).toBe("book_not_empty");
    // Invoices and bills the source issued before the cut-off are in the external-document register.
    expect((await m.externalDocuments(T, project)).map((d) => [d.docKind, d.docNo])).toEqual(expect.arrayContaining([["invoice", "INV-101"], ["bill", "PB-55"]]));
    expect(await m.externalDocument(T, "invoice", "INV-101")).toMatchObject({ sourceSystem: "tally" });
  });

  it("FIN-MIG-01 provenance on every record: source system, file hash, source id and row", async () => {
    const prov = await m.provenance(T, project, target.loadId);
    const files = new Set((await m.files(T, project)).map((f) => f.fileHash));
    expect(prov.length).toBeGreaterThan(0);
    for (const r of prov) {
      expect(r.sourceSystem).toBe("tally");
      expect(files.has(r.fileHash)).toBe(true);
      expect(r.sourceId.length).toBeGreaterThan(0);
      expect(r.sourceRow).toBeGreaterThan(0);
    }
    const kinds = new Set(prov.map((r) => r.kind));
    for (const k of ["opening_line", "open_item", "party", "account", "schedule"]) expect(kinds.has(k)).toBe(true);
    // Every opening line and every open item has a record.
    const st = await cell.gl.state(T, B);
    const opening = [...st.journals.entries()].find(([, j]) => j.voucherType === "opening")!;
    opening[1].lines.forEach((_l, i) => expect(prov.some((r) => r.kind === "opening_line" && r.targetId === `${opening[0]}#${i + 1}`)).toBe(true));
    for (const i of await m.openItems(T, project, target.loadId)) expect(prov.some((r) => r.kind === "open_item" && r.targetId === i.itemId)).toBe(true);
    expect(prov.find((r) => r.kind === "open_item" && r.ref === "INV-101")).toMatchObject({ sourceId: "Sharma Traders|INV-101" });
    // Source names are sealed at rest.
    const [raw] = await cell.store.tenantTx(T, (tx) => tx<{ source: string }[]>`SELECT source FROM migration.records WHERE tenant_id = ${T} AND kind = 'party' LIMIT 1`);
    expect(raw!.source).not.toMatch(/Sharma|Mehta/);
  });
});

// ================================================================= parallel run
let comparisonId: string;

describe("FIN-MIG-02 delta import, coverage, authority and parallel run", () => {
  it("FIN-MIG-02 idempotent delta reimport: vouchers after the cut-off post once; a reimport creates no duplicates", async () => {
    const first = await m.delta(T, P.ctrl, project, { asOf: "2026-04-30" });
    expect(first).toMatchObject({ vouchers: 4, created: 4, duplicates: 0, changed: [], held: [] });
    const after = await cell.gl.state(T, B);
    const count = after.journals.size;
    // Source numbers are kept (narration and provenance) and the numbering gap S-002 is reported.
    expect([...after.journals.values()].map((j) => j.narration)).toEqual(expect.arrayContaining(["Sales S-001: 10 valves", "Payment P-001: NEFT to Mehta against PB-55"]));
    expect(first.numbering.find((n) => n.type === "Sales")).toMatchObject({ first: "S-001", last: "S-004", gaps: [2] });
    // Reimport: the same file again (a duplicate upload) and the delta again.
    expect((await m.importFile(T, P.ctrl, project, { name: "daybook.xml", content: fx("tally-daybook.xml") })).duplicate).toBe(true);
    const again = await m.delta(T, P.ctrl, project, { asOf: "2026-04-30" });
    expect(again).toMatchObject({ created: 0, duplicates: 4, changed: [] });
    expect((await cell.gl.state(T, B)).journals.size).toBe(count);
    // A voucher changed in the source after import is a difference to resolve, never an overwrite.
    const altered = fx("tally-daybook.xml").replace("<AMOUNT>-20000.00</AMOUNT>", "<AMOUNT>-21000.00</AMOUNT>").replace("<AMOUNT>20000.00</AMOUNT>", "<AMOUNT>21000.00</AMOUNT>");
    await m.importFile(T, P.ctrl, project, { name: "daybook-corrected.xml", content: altered, purpose: "delta" });
    const third = await m.delta(T, P.ctrl, project, { asOf: "2026-04-30" });
    expect(third).toMatchObject({ created: 0, duplicates: 3, changed: [{ number: "P-002", type: "Payment", date: "2026-04-25" }] });
    expect((await cell.gl.state(T, B)).journals.size).toBe(count);
    expect((await balancesOf(B, "2026-04-30")).get("BANK")).toBe(28820000n);
    // Sales from the source are in the external-document register (issued by Tally, never by Kuber).
    expect(await m.externalDocument(T, "invoice", "S-001")).toMatchObject({ sourceSystem: "tally" });
  });

  it("FIN-MIG-02 bank coverage: statements from the cut-off onward, checked against the channels' statement lines", async () => {
    expect((await m.coverage(T, project, { asOf: "2026-04-30" })).ok).toBe(false);          // no statements yet
    const csv = ["Date,Narration,Debit,Credit,Balance", "02/04/2026,Opening transfer,,0.01,367200.01", "10/04/2026,NEFT MEHTA,59000.00,,308200.01",
      "25/04/2026,RENT APRIL,20000.00,,288200.01", "28/04/2026,CHARGES,500.00,,287700.01"].join("\n");
    await cell.channels.submitStatement(T, B, csv, P.ctrl, { instrument: "BANK" });
    const cov = await m.coverage(T, project, { asOf: "2026-04-30" });
    expect(cov).toMatchObject({ ok: true, accounts: [{ accountId: "BANK", first: "2026-04-02", last: "2026-04-28", ok: true }] });
    expect((await as(P.ctrl, "GET", `/migrations/${project}/coverage?asOf=2026-06-30`)).json().ok).toBe(false);  // stops short of June
  });

  it("FIN-MIG-02 authority switch and FIN-MIG-03 fallback operators are recorded decisions", async () => {
    const auth = await as(P.ctrl, "POST", `/migrations/${project}/decisions`, { kind: "authority", processes: [
      { process: "Sales invoices and e-invoice IRN", duringParallel: "source", afterCutover: "kuber" },
      { process: "Bank entries", duringParallel: "kuber", afterCutover: "kuber" },
      { process: "GST returns", duringParallel: "source", afterCutover: "kuber" }] });
    expect(auth.statusCode, auth.body).toBe(201);
    expect(auth.json()).toMatchObject({ kind: "authority", bookOfRecord: "source" });
    expect((await as(P.ctrl, "POST", `/migrations/${project}/decisions`, { kind: "fallback", processes: [{ process: "Sales invoices" }] })).statusCode).toBe(400);
    const fb = await m.recordDecision(T, P.ctrl, project, { kind: "fallback", until: "2026-06-30", processes: [
      { process: "Sales invoices", system: "source", operator: "controller:asha" }, { process: "Bank entries", system: "kuber", operator: "controller:asha" },
      { process: "Payroll", system: "provider", operator: "external payroll provider" }] });
    expect(fb).toMatchObject({ kind: "fallback", until: "2026-06-30" });
    expect((await m.decisions(T, project)).map((d) => d.kind)).toEqual(["authority", "fallback"]);
  });

  it("FIN-MIG-02 parallel-run comparison: Kuber's TB and P&L against Tally's for April, differences listed by process and explained", async () => {
    expect(await code(m.compare(T, P.ctrl, project, { from: "2026-04-01", to: "2026-04-30" }))).toBe("source_tb_required");
    await m.importFile(T, P.ctrl, project, { name: "tb-april.xml", content: fx("tally-tb-2026-04-30.xml"), purpose: "comparison", asOf: "2026-04-30" });
    const c = await m.compare(T, P.ctrl, project, { from: "2026-04-01", to: "2026-04-30" });
    comparisonId = c.comparisonId;
    const d = Object.fromEntries(c.differences.map((x) => [x.key, x]));
    expect(Object.keys(d).sort()).toEqual(["pnl:M_RENT", "tb:BANK", "tb:M_RENT"]);
    expect(d["tb:BANK"]).toMatchObject({ source: "28770000", kuber: "28820000", difference: "50000", process: "Bank and cash entries", status: "open" });
    expect(d["pnl:M_RENT"]).toMatchObject({ source: "2050000", kuber: "2000000", difference: "-50000", process: "Purchase bills and expenses" });
    expect(c.pnl).toEqual({ source: { income: "1500000", expense: "2050000", net: "-550000" }, kuber: { income: "1500000", expense: "2000000", net: "-500000" } });
    expect(c.open).toBe(3);
    // Go-live is not ready while differences are open.
    const intent = await m.goLiveIntent(T, project, comparisonId);
    expect(intent.ready).toBe(false);
    expect(intent.checklist.find((x) => x.label === "Every parallel-run difference is explained")).toMatchObject({ ok: false });
    for (const key of Object.keys(d)) {
      await m.explain(T, P.ctrl, project, comparisonId, { key, category: "timing", note: "Rs 500 bank charge of 28 Apr booked to Rent in Tally; Kuber has the statement line, to post after cut-over" });
    }
    expect(await code(m.explain(T, P.ctrl, project, comparisonId, { key: "tb:CASH", category: "timing", note: "no such" }))).toBe("no_difference");
    expect((await m.comparison(T, project, comparisonId)).open).toBe(0);
  });

  it("FIN-MIG-02 go-live needs a superuser's passkey signature over the comparison and checklist; the book of record switches to Kuber", async () => {
    const intent = await m.goLiveIntent(T, project, comparisonId);
    expect(intent.checklist.filter((x) => !x.ok)).toEqual([]);
    // The controller cannot take the cut-over decision; the superuser must sign.
    expect((await as(P.ctrl, "POST", `/migrations/${project}/go-live`, { comparisonId })).statusCode).toBe(403);
    const unsigned = await as(P.su, "POST", `/migrations/${project}/go-live`, { comparisonId });
    expect(unsigned.statusCode).toBe(403);
    expect(unsigned.json()).toMatchObject({ error: "step_up_required", signing: { action: "migration.golive" } });
    const o = await as(P.su, "POST", "/signing/options", { action: "migration.golive", projectId: project, comparisonId });
    expect(o.statusCode, o.body).toBe(200);
    expect(o.json()).toMatchObject({ required: true, inputs: { action: "migration.golive", book: B, subject: `${project}:${comparisonId}`, subjectHash: intent.subjectHash } });
    expect(o.json().summary.lines.join("\n")).toMatch(/Kuber/);
    const live = await as(P.su, "POST", `/migrations/${project}/go-live`, { comparisonId, assertion: keys[P.su]!.get(o.json().options) });
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json()).toMatchObject({ status: "live", bookOfRecord: "kuber", goLive: clock.value });
    const ev = (await cell.store.readStream(T, `${T}/migration/${project}`)).find((e) => e.type === "MigrationWentLive")!;
    expect((ev.data as { signature: { kind: string } }).signature.kind).toBe("webauthn");
    const report = await cell.identity.verifySignatures(T);
    expect(report.failures).toEqual([]);
    expect(report.valid).toBeGreaterThanOrEqual(1);
  });

  it("FIN-MIG-03 after cut-over rollback is refused: recovery is the documented procedure; post-cutover entries survive", async () => {
    expect(await code(m.rollback(T, P.ctrl, project, { loadId: target.loadId, reason: "try" }))).toBe("post_cutover");
    expect(await code(m.delta(T, P.ctrl, project, {}))).toBe("post_cutover");
    const r = (await as(P.ctrl, "GET", `/migrations/${project}/recovery`)).json();
    expect(r).toMatchObject({ status: "live", bookOfRecord: "kuber", rollbackAvailable: false, fallback: { kind: "fallback" } });
    expect(r.procedure.join(" ")).toMatch(/Do not roll back/);
    expect(r.externalDocuments).toBeGreaterThanOrEqual(4);
    // The book keeps everything it holds (opening, the parallel month): nothing was removed.
    expect(nonZero(await balancesOf(B)).length).toBeGreaterThan(0);
  });
});

// ================================================================= Zoho and pre-cutover rollback of a target load
describe("FIN-MIG-01/03 Zoho source and target-load rollback", () => {
  let zp: string;
  it("FIN-MIG-01 Zoho fixtures load: the receivable and payable control balances are split by party through the open items", async () => {
    zp = (await m.createProject(T, P.ctrl, { bookId: Z, sourceSystem: "zoho", cutoff: CUTOFF })).projectId;
    for (const f of ["zoho-chart-of-accounts.csv", "zoho-contacts.csv", "zoho-trial-balance-2026-03-31.csv", "zoho-invoices-open-2026-03-31.csv", "zoho-bills-open-2026-03-31.csv"])
      await m.importFile(T, P.ctrl, zp, { name: f, content: fx(f), asOf: f.includes("trial") ? CUTOFF : undefined });
    const map = await m.mapping(T, zp);
    expect(map.rows.find((r) => r.sourceKey === "Accounts Receivable")).toMatchObject({ control: "receivable", accountId: "DEBTORS" });
    expect(map.rows.some((r) => r.sourceKey === "Old Suspense")).toBe(false);          // inactive accounts are left out
    await m.approveMapping(T, P.ctrl, zp, { acceptSuggested: true });
    expect((await m.mapping(T, zp)).summary.unmapped).toBe(0);
    const r = await m.rehearse(T, P.ctrl, zp);
    expect(r.reconciliation.reconciled).toBe(true);
    const lines = (await cell.gl.state(T, r.bookId)).journals.values().next().value!.lines;
    expect(lines.filter((l) => l.accountId === "DEBTORS").map((l) => l.amount).sort()).toEqual(["3000000", "5000000"]);
    expect(r.reconciliation.controlTotals).toEqual(expect.arrayContaining([{ accountId: "DEBTORS", openItems: "8000000", control: "8000000" }]));
  });

  it("FIN-MIG-03 rollback leaves no trace in the target book's balances (pre-cutover load voided with reversing entries)", async () => {
    expect(nonZero(await balancesOf(Z))).toEqual([]);
    const l = await m.load(T, P.ctrl, zp);
    expect(l.reconciliation.reconciled).toBe(true);
    expect(nonZero(await balancesOf(Z, CUTOFF)).length).toBeGreaterThan(0);
    const rb = await as(P.ctrl, "POST", `/migrations/${zp}/loads/${l.loadId}/rollback`, { reason: "mapping of Owner's Equity to be revised" });
    expect(rb.statusCode, rb.body).toBe(200);
    expect(rb.json()).toMatchObject({ method: "reversing_entries" });
    expect(rb.json().reversals.length).toBe(1);
    // Every balance on every date is back to nil; the load's open items and provenance are voided.
    for (const d of [CUTOFF, "2026-04-30", null]) expect(nonZero(await balancesOf(Z, d))).toEqual([]);
    expect((await m.openItems(T, zp, l.loadId)).every((i) => i.status === "voided")).toBe(true);
    expect((await m.provenance(T, zp, l.loadId)).every((r) => r.status === "voided")).toBe(true);
    expect(await code(m.rollback(T, P.ctrl, zp, { loadId: l.loadId, reason: "again" }))).toBe("load_voided");
    // A fresh load after the rollback works (new journal ids) and reconciles.
    const again = await m.load(T, P.ctrl, zp);
    expect(again.loadId).not.toBe(l.loadId);
    expect(again.reconciliation.reconciled).toBe(true);
  });
});
