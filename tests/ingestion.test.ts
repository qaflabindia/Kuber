/**
 * Ingestion integrity (F05, F06, F18): overlapping imports never lose a line, provisional entries are
 * confirmed only on real evidence and the confirmation reaches the GL, reporting and reconciliation,
 * and every upload's original is retained sealed with its control totals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { canonical, sha256, uuid } from "@kuber/contracts";
import { IngestionError, parseBankStatement } from "@kuber/channels";
import { KeyAdmin, buildServer, type Cell } from "@kuber/core";
import { Keyring, MemoryKms } from "@kuber/crypto";
import { EventStore } from "@kuber/eventstore";
import { CORE_AUTH_SECRET, ROOT, enrol, signed, startCell } from "./helpers.ts";

const T = "ingest", B = "main", OWNER = "owner:ingest";
const kms = new MemoryKms();
let cell: Cell, stop: () => Promise<void>, ownerUrl: string;
const HDR = "Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance";
const csvNoBal = (...rows: string[]) => "Date,Narration,Withdrawal Amt,Deposit Amt\n" + rows.join("\n") + "\n";
const csvBal = (...rows: string[]) => HDR + "\n" + rows.join("\n") + "\n";
const sample = (f: string) => readFileSync(join(ROOT, "samples", f), "utf8");

const extractedCount = async () => (await cell.store.tenantTx(T, (tx) =>
  tx<{ n: number }[]>`SELECT count(*)::int AS n FROM es.events WHERE tenant_id = ${T} AND type = 'TransactionExtracted'`))[0]!.n;
const journals = async () => [...(await cell.gl.state(T, B)).journals.entries()];
const queueNarrations = async () => (await cell.agent.queue(T)).map((d) => (d.proposal as { narration: string }).narration);
const reconcile = (statementBalance: string, asOf = "2026-10-31") =>
  cell.ops.plan(T, B, OWNER, "reconcile", { account: "BANK", statementBalance, asOf });
const timingItems = (plan: Awaited<ReturnType<typeof reconcile>>) =>
  (plan.sections ?? []).find((s) => s.title === "Timing items")?.rows ?? [];

beforeEach(async () => {
  const f = await startCell({ value: "2026-11-25" }, { kms });
  ({ cell, stop } = f); ownerUrl = f.db.ownerUrl;
  // The only person in this workspace: owner with the explicit single-owner exception (identity.test.ts covers maker-checker).
  await enrol(cell, T, [OWNER]);
  await cell.identity.setSettings(T, OWNER, { soloOwner: true, sodLimitPaise: null });
  await cell.gl.openBook(T, B, T, "individual", OWNER);
  await cell.settle();
});
afterEach(async () => { vi.restoreAllMocks(); await stop(); });

// ---------------------------------------------------------------- F05
describe("F05: overlapping imports", () => {
  it("concurrent overlapping imports store every distinct line and report each row's disposition", async () => {
    // both imports compute their identities before either writes (the interleaving that lost a line)
    const keys = cell.store.keys.bind(cell.store);
    let calls = 0, release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    vi.spyOn(cell.store, "keys").mockImplementation(async (t) => { const k = await keys(t); if (++calls === 2) release(); await barrier; return k; });
    const shared = "01/10/2026,Shared row,100,";
    const [a, b] = await Promise.all([
      cell.channels.submitStatement(T, B, csvNoBal(shared, "02/10/2026,Unique A,200,"), OWNER),
      cell.channels.submitStatement(T, B, csvNoBal(shared, "03/10/2026,Unique B,300,"), OWNER),
    ]);
    vi.restoreAllMocks();
    expect(await extractedCount()).toBe(3);
    expect(a.duplicate || b.duplicate).toBe(false);
    for (const r of [a, b]) {
      expect(r.rows).toBe(2);
      expect(r.accepted + r.duplicates + r.skipped).toBe(r.rows);
      expect(r.dispositions.map((d) => d.row)).toEqual([1, 2]);
    }
    expect(a.accepted + b.accepted).toBe(3);
    expect(a.duplicates + b.duplicates).toBe(1);
    // the second import added exactly the missing line: the shared row is a duplicate in one of them
    const dupe = [a, b].find((r) => r.duplicates === 1)!;
    expect(dupe.dispositions[0]).toMatchObject({ row: 1, disposition: "duplicate" });
    expect(dupe.dispositions[1]).toMatchObject({ row: 2, disposition: "accepted" });
  });

  it("concurrent uploads of the same file ingest it once", async () => {
    const file = csvNoBal("01/10/2026,Only row,100,", "02/10/2026,Second row,50,");
    const results = await Promise.all([1, 2, 3].map(() => cell.channels.submitStatement(T, B, file, OWNER)));
    expect(results.filter((r) => r.duplicate)).toHaveLength(2);
    expect(results.find((r) => !r.duplicate)!.accepted).toBe(2);
    expect(await extractedCount()).toBe(2);
  });

  it("a repeated identical payment in a later file is told apart by the running balance", async () => {
    const x1 = "05/10/2026,UPI/DR/SWIGGY/swiggy@icici,,100.00,,900.00";
    const y = "05/10/2026,UPI/DR/AWS/aws@axisbank,,200.00,,700.00";
    const x2 = "05/10/2026,UPI/DR/SWIGGY/swiggy@icici,,100.00,,600.00";     // same day, same amount, same narration
    const first = await cell.channels.submitStatement(T, B, csvBal(x1, y), OWNER);
    expect(first.accepted).toBe(2);
    const second = await cell.channels.submitStatement(T, B, csvBal(y, x2), OWNER);
    expect(second).toMatchObject({ duplicate: false, rows: 2, accepted: 1, duplicates: 1, skipped: 0 });
    expect(await extractedCount()).toBe(3);
    // and the overlap is idempotent: a third, wider file adds nothing that is already there
    const third = await cell.channels.submitStatement(T, B, csvBal(x1, y, x2), OWNER);
    expect(third).toMatchObject({ accepted: 0, duplicates: 3 });
  });

  it("lines imported before the v2 identity (existing databases) are recognised as duplicates", async () => {
    const txn = { txnDate: "2026-10-01", amount: "10000", direction: "out" as const, narration: "Old import", instrument: "BANK" };
    const legacyId = sha256(`${canonical({ bookId: B, instrument: "BANK", txnDate: txn.txnDate, amount: txn.amount, direction: txn.direction,
      narration: txn.narration.toLowerCase(), reference: null })}|1`).slice(0, 32);
    await cell.store.append("channels", T, { streamId: `${T}/txn/${legacyId}`, expected: "no_stream", events: [{ type: "TransactionExtracted",
      data: { txnId: legacyId, signalId: "legacy", bookId: B, trust: "authoritative", channel: "statement_csv", txn } }] }, { principal: OWNER });
    const r = await cell.channels.submitStatement(T, B, csvNoBal("01/10/2026,Old import,100,", "02/10/2026,New line,100,"), OWNER);
    expect(r).toMatchObject({ accepted: 1, duplicates: 1 });
  });

  it("identical lines within one file are separate transactions", async () => {
    const r = await cell.channels.submitStatement(T, B, csvNoBal("01/10/2026,Coffee,100,", "01/10/2026,Coffee,100,"), OWNER);
    expect(r.accepted).toBe(2);
    expect(r.warnings.join(" ")).toMatch(/no running balance/);
  });

  it("rows that are not transactions are skipped with a reason, never guessed", async () => {
    const r = await cell.channels.submitStatement(T, B, csvNoBal("01/10/2026,Real,100,", "02/10/2026,Nothing,,", "03/10/2026,Both sides,100,50"), OWNER);
    expect(r).toMatchObject({ rows: 3, accepted: 1, duplicates: 0, skipped: 2 });
    expect(r.dispositions.filter((d) => d.disposition === "skipped").map((d) => d.reason)).toEqual(["no amount", "both debit and credit present"]);
  });
});

// ---------------------------------------------------------------- F18
describe("F18: source originals and control totals", () => {
  it("retains the original sealed, with hash, row count and control totals, retrievable by signal id", async () => {
    const file = sample("hdfc_2026_10.csv");
    const r = await cell.channels.submitStatement(T, B, file, OWNER);
    expect(r.controls).toMatchObject({ status: "reconciled", opening: "12500000", closing: "13020650", problems: [] });
    expect(r.controls!.credits).toBe("11986000");                       // 1,18,000 + 1,860
    expect(r.controls!.debits).toBe((12500000n + 11986000n - 13020650n).toString());
    const o = await cell.channels.original(T, r.signalId);
    expect(o).toMatchObject({ content: file, verified: true, rows: 10, accepted: 10, duplicates: 0, skipped: 0, controlStatus: "reconciled",
      parser: "bank-csv/2", uploadedBy: OWNER, bookId: B });
    expect(o!.dispositions).toHaveLength(10);
    // the extracted transactions carry row lineage back to the original
    const ev = await cell.store.readStream(T, `${T}/txn/${r.txnIds[3]}`);
    expect((ev[0]!.data as { signalId: string; txn: { sourceRow: number; balance: string } })).toMatchObject({ signalId: r.signalId, txn: { sourceRow: 4, balance: "23842750" } });

    // at rest: nothing readable
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      const [row] = await owner`SELECT row_to_json(s)::text AS j, original, detail FROM channels.signals s WHERE signal_id = ${r.signalId}`;
      expect(row!.original).toMatch(/^kb1\./);
      expect(row!.detail).toMatch(/^kb1\./);
      for (const s of ["SWIGGY", "ACME", "HOME LOAN", "243000"]) expect(row!.j as string).not.toContain(s);
      // registered as sealed columns: verification sees no plaintext, and the application cannot rewrite originals
      const ownerKeys = new Keyring(owner, kms, 0);
      const admin = new KeyAdmin(owner, ownerKeys, new EventStore(owner, "admin", { keyring: ownerKeys, legacy: "allow" }), 0);
      expect((await admin.verify(true)).plaintext).toEqual({});
      await expect(cell.store.tenantTx(T, (tx) => tx`UPDATE channels.signals SET accepted = 0`)).rejects.toThrow(/permission denied/);
    } finally { await owner.end(); }
  });

  it("refuses a statement whose running balance does not follow its movements, and stores nothing", async () => {
    const bad = csvBal("01/10/2026,A,,100.00,,900.00", "02/10/2026,B,,100.00,,750.00");
    await expect(cell.channels.submitStatement(T, B, bad, OWNER)).rejects.toSatisfy((e: unknown) =>
      e instanceof IngestionError && e.code === "control_totals" && /row\(s\) 2/.test(e.message));
    expect(await extractedCount()).toBe(0);
    // explicitly accepted: stored, but flagged in the result, the signal and the retained record
    const r = await cell.channels.submitStatement(T, B, bad, OWNER, { allowUnreconciled: true });
    expect(r.controls!.status).toBe("mismatch");
    expect(r.warnings.join(" ")).toMatch(/do not reconcile/);
    expect((await cell.channels.original(T, r.signalId))!.controlStatus).toBe("mismatch");
    const [sig] = await cell.store.readStream(T, `${T}/signal/${r.signalId}`);
    expect((sig!.data as { controls: { status: string } }).controls.status).toBe("mismatch");
  });

  it("checks declared totals, in either row order, with or without a balance column", async () => {
    const desc = csvBal("02/10/2026,B,,100.00,,800.00", "01/10/2026,A,,100.00,,900.00");   // newest first
    expect(parseBankStatement(desc).controls).toMatchObject({ status: "reconciled", opening: "100000", closing: "80000" });
    expect(parseBankStatement(desc, "BANK", { closing: "800" }).controls.status).toBe("reconciled");
    expect(parseBankStatement(desc, "BANK", { closing: "700" }).controls.status).toBe("mismatch");
    const noBal = csvNoBal("01/10/2026,A,100,", "02/10/2026,B,,40");
    expect(parseBankStatement(noBal).controls.status).toBe("unverifiable");
    expect(parseBankStatement(noBal, "BANK", { opening: "1000", closing: "940" }).controls.status).toBe("reconciled");
    expect(parseBankStatement(noBal, "BANK", { debits: "100", credits: "40", count: 2 }).controls.status).toBe("reconciled");
    await expect(cell.channels.submitStatement(T, B, noBal, OWNER, { declared: { opening: "1000", closing: "900" } })).rejects.toThrow(/does not give declared closing/);
  });

  it("keeps the original of a chat entry too", async () => {
    const r = await cell.channels.submitChat(T, B, "Paid 100 to Alice via bank", OWNER, "2026-10-01");
    const o = await cell.channels.original(T, r!.signalId);
    expect(o!.content).toBe(`2026-10-01|${OWNER}|Paid 100 to Alice via bank`);
    expect(o!.verified).toBe(true);
  });
});

// ---------------------------------------------------------------- F06
describe("F06: provisional confirmation", () => {
  const provisional = async (text: string, on = "2026-10-01") => {
    await cell.channels.submitChat(T, B, text, OWNER, on);
    await cell.settle();
  };
  const provisionalIds = async () => (await journals()).filter(([, j]) => j.provisional).map(([id]) => id);

  it("a different payee with the same amount and date does not confirm; it is processed as its own transaction", async () => {
    await provisional("Paid 100 to Alice via bank");
    await cell.channels.submitStatement(T, B, csvNoBal("01/10/2026,Payment to Bob reference B,100,"), OWNER);
    await cell.settle();
    const [row] = await cell.store.tenantTx(T, (tx) => tx`SELECT confirmed FROM agent.journal_index WHERE tenant_id = ${T}`);
    expect(row!.confirmed).toBe(false);
    expect(await queueNarrations()).toEqual([expect.stringContaining("Bob")]);
    expect(await provisionalIds()).toHaveLength(1);
    expect(await cell.agent.openMatchReviews(T)).toHaveLength(0);
  });

  it("a matching line confirms, and the confirmation reaches the GL, reporting and reconciliation", async () => {
    await provisional("Paid 100 to Alice via bank");
    const jid = (await journals())[0]![0];
    const before = await reconcile("-100");
    expect(timingItems(before)).toHaveLength(1);

    await cell.channels.submitStatement(T, B, csvNoBal("01/10/2026,UPI/DR/ALICE K/alice@okaxis,100,"), OWNER);
    await cell.settle();
    const j = (await cell.gl.state(T, B)).journals.get(jid!)!;
    expect(j.provisional).toBe(false);
    expect(j.confirmedBy).toMatch(new RegExp(`^${T}/txn/`));
    expect((await cell.reporting.recentJournals(T, B))[0]!.provisional).toBe(false);
    expect(await cell.agent.queue(T)).toHaveLength(0);
    expect((await cell.gl.state(T, B)).seq).toBe(1);                       // confirmed, not posted twice
    const after = await reconcile("-100");
    expect(timingItems(after)).toHaveLength(0);
    expect(after.checks.find((c) => c.label.startsWith("Statement agrees"))!.ok).toBe(true);
    const book = await cell.store.readStream(T, `${T}/book/${B}`);
    expect(book.at(-1)).toMatchObject({ type: "JournalConfirmed", data: { journalId: jid, basis: "counterparty" } });
    expect(await cell.gl.verify(T, B)).toBeNull();                           // the original journal is not rewritten
  });

  it("a shared reference confirms even when the names differ", async () => {
    await provisional("Paid 5000 to Ramesh via bank utr 424512345601");
    await cell.channels.submitStatement(T, B, csvBal("02/10/2026,NEFT DR-R KUMAR,424512345601,5000.00,,95000.00"), OWNER);
    await cell.settle();
    expect(await provisionalIds()).toHaveLength(0);
    const book = await cell.store.readStream(T, `${T}/book/${B}`);
    expect(book.at(-1)).toMatchObject({ type: "JournalConfirmed", data: { basis: "reference" } });
  });

  it("several matching entries become a review item; a person links one and the GL records it", async () => {
    await provisional("Paid 100 to Alice via bank", "2026-10-01");
    await provisional("Paid 100 to Alice for books via bank", "2026-10-02");
    await cell.channels.submitStatement(T, B, csvNoBal("01/10/2026,Payment to Alice,100,"), OWNER);
    await cell.settle();
    expect(await provisionalIds()).toHaveLength(2);                        // nothing auto-confirmed
    expect(await cell.agent.queue(T)).toHaveLength(0);                     // and nothing posted or drafted
    const [rev] = await cell.agent.openMatchReviews(T);
    expect(rev!.candidates).toHaveLength(2);
    expect(rev!.detail).toMatchObject({ narration: "Payment to Alice", amount: "10000", direction: "out" });
    // reconciliation sees the pending line as on the statement, not yet in the books
    const plan = await reconcile("-100");
    expect(timingItems(plan)).toHaveLength(3);
    expect(plan.checks.find((c) => c.label.startsWith("Statement agrees"))!.ok).toBe(true);

    await expect(cell.agent.resolveMatch(T, rev!.review_id, OWNER, "not-a-journal")).rejects.toThrow(/not an open provisional/);
    await cell.agent.resolveMatch(T, rev!.review_id, OWNER, rev!.candidates[1]!);
    await cell.settle();
    expect(await provisionalIds()).toEqual([rev!.candidates[0]]);
    expect(await cell.agent.openMatchReviews(T)).toHaveLength(0);
    await expect(cell.agent.resolveMatch(T, rev!.review_id, OWNER, null)).rejects.toThrow(/no open match review/);
  });

  it("an entry with no counterparty to compare goes to review; 'not a match' processes the line as new", async () => {
    await provisional("Spent 1,200 on groceries via upi");
    await cell.channels.submitStatement(T, B, csvNoBal("01/10/2026,UPI/DR/BIGBASKET/bigbasket@ybl,1200,"), OWNER);
    await cell.settle();
    const [rev] = await cell.agent.openMatchReviews(T);
    expect(rev!.detail.reason).toMatch(/cannot be compared/);
    await cell.agent.resolveMatch(T, rev!.review_id, OWNER, null);
    await cell.settle();
    expect(await queueNarrations()).toEqual([expect.stringContaining("BIGBASKET")]);
    expect(await provisionalIds()).toHaveLength(1);
    const txn = await cell.store.readStream(T, `${T}/txn/${rev!.txn_id}`);
    expect(txn.map((e) => e.type)).toEqual(expect.arrayContaining(["MatchReviewQueued", "MatchReviewResolved", "DraftQueued"]));
  });

  it("amount outside the date window or in the other direction never matches", async () => {
    await provisional("Paid 100 to Alice via bank", "2026-10-01");
    await cell.channels.submitStatement(T, B, csvNoBal("10/10/2026,Payment to Alice,100,", "01/10/2026,Refund from Alice,,100"), OWNER);
    await cell.settle();
    expect(await provisionalIds()).toHaveLength(1);
    expect(await cell.agent.openMatchReviews(T)).toHaveLength(0);
    expect(await cell.agent.queue(T)).toHaveLength(2);
  });

  it("confirmations recorded only by the agent before propagation are backfilled into the GL", async () => {
    await provisional("Paid 100 to Alice via bank");
    const jid = (await journals())[0]![0];
    // an existing database: journal_index says confirmed, the GL never heard of it
    await cell.store.tenantTx(T, (tx) => tx`UPDATE agent.journal_index SET confirmed = true WHERE tenant_id = ${T}`);
    expect(await cell.agent.backfillConfirmations(T)).toEqual({ emitted: 1 });
    expect(await cell.agent.backfillConfirmations(T)).toEqual({ emitted: 0 });
    await cell.settle();
    expect((await cell.gl.state(T, B)).journals.get(jid!)!.provisional).toBe(false);
    expect((await cell.reporting.recentJournals(T, B))[0]!.provisional).toBe(false);
  });

  it("a confirmation cannot apply to a reversed journal, and repeating it is harmless", async () => {
    await provisional("Paid 100 to Alice via bank");
    const jid = (await journals())[0]![0];
    const confirm = { kind: "ConfirmJournal" as const, journalId: jid!, source: "test" };
    expect(await cell.gl.execute(T, B, confirm, { principal: OWNER })).toHaveLength(1);
    expect(await cell.gl.execute(T, B, confirm, { principal: OWNER })).toHaveLength(0);
    await provisional("Paid 200 to Carol via bank");
    const carol = (await journals()).find(([, j]) => j.provisional)![0];
    await cell.gl.execute(T, B, { kind: "ReverseJournal", journalId: carol, reversalJournalId: uuid(), reason: "typo" }, { principal: OWNER });
    await expect(cell.gl.execute(T, B, { ...confirm, journalId: carol }, { principal: OWNER })).rejects.toThrow(/reversed/);
  });
});

// ---------------------------------------------------------------- HTTP
describe("HTTP", () => {
  it("refuses an unreconciled statement with 422, serves originals and resolves match reviews", async () => {
    const app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
    const headers = { "x-kuber-tenant": T, "x-kuber-principal": OWNER };
    try {
      const bad = await app.inject(signed({ method: "POST", url: `/v1/tenants/${T}/books/${B}/statements`, headers,
        payload: { csv: csvBal("01/10/2026,A,,100.00,,900.00", "02/10/2026,B,,100.00,,750.00") } }));
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toMatchObject({ error: "control_totals", detail: { status: "mismatch" } });
      await cell.channels.submitChat(T, B, "Spent 1,200 on groceries via upi", OWNER, "2026-10-01");
      await cell.settle();
      const ok = await app.inject(signed({ method: "POST", url: `/v1/tenants/${T}/books/${B}/statements`, headers: { ...headers, "content-type": "text/csv" },
        payload: csvNoBal("01/10/2026,UPI/DR/BIGBASKET/bigbasket@ybl,1200,") }));
      expect(ok.statusCode).toBe(202);
      const orig = await app.inject(signed({ method: "GET", url: `/v1/tenants/${T}/signals/${ok.json().signalId}/original`, headers }));
      expect(orig.json()).toMatchObject({ verified: true, rows: 1, accepted: 1 });
      await cell.settle();
      const reviews = await app.inject(signed({ method: "GET", url: `/v1/tenants/${T}/match-reviews`, headers }));
      expect(reviews.json()).toHaveLength(1);
      const res = await app.inject(signed({ method: "POST", url: `/v1/tenants/${T}/match-reviews/${reviews.json()[0].review_id}/resolve`, headers,
        payload: { journalId: reviews.json()[0].candidates[0] } }));
      expect(res.statusCode).toBe(202);
      await cell.settle();
      expect([...(await cell.gl.state(T, B)).journals.values()].every((j) => !j.provisional)).toBe(true);
    } finally { await app.close(); }
  });
});
