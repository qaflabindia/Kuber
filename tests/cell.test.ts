/**
 * End-to-end through events: channels -> agent -> GL -> reporting, on real PostgreSQL with the
 * in-memory bus. Mirrors the two-month freelancer scenario from the phase 0 specification.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { journalIdForRequest, uuid } from "@kuber/contracts";
import type { Cell } from "@kuber/core";
import { ROOT, startCell } from "./helpers.ts";

const T = "laksh", B = "main", OWNER = "owner:laksh";
const clock = { value: "2026-10-25" };
let cell: Cell, stop: () => Promise<void>;
const csv = (f: string) => readFileSync(join(ROOT, "samples", f), "utf8");

beforeAll(async () => {
  ({ cell, stop } = await startCell(clock));
  await cell.gl.openBook(T, B, "laksh", "freelancer", OWNER);
  for (const [acc, amt] of [["BANK", 12500000n], ["LOANS", -240000000n]] as const) {
    await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: `Opening ${acc}`, voucherType: "opening",
      lines: [{ accountId: acc, amount: amt.toString(), dimensions: {} }, { accountId: "OPENING", amount: (-amt).toString(), dimensions: {} }] }, { principal: OWNER });
  }
  await cell.settle();
});
afterAll(async () => { await stop(); });

describe("a freelancer's first two months, event-driven", () => {
  it("posts a cash chat entry directly and a bank chat entry provisionally", async () => {
    await cell.channels.submitChat(T, B, "Paid 450 to the plumber in cash", OWNER, "2026-10-05");
    await cell.channels.submitChat(T, B, "Received 1.18 lakh from Acme for invoice 17 via bank", OWNER, "2026-10-01");
    await cell.settle();
    const lines = await cell.reporting.drill(T, B, "FEES");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.provisional).toBe(true);
    expect((await cell.reporting.drill(T, B, "LIVING"))[0]!.amount).toBe("45000");
  });

  it("queues unknown counterparties, confirms the provisional entry, and never double-counts", async () => {
    const r = await cell.channels.submitStatement(T, B, csv("hdfc_2026_10.csv"), OWNER);
    expect(r.accepted).toBe(10);
    await cell.settle();
    const fees = await cell.reporting.trialBalance(T, B);
    expect(fees.rows.find((x) => x.label.startsWith("FEES"))?.amount).toBe(11800000n);     // once, not twice
    const q = await cell.agent.queue(T);
    expect(q).toHaveLength(9);                                                               // 10 lines, 1 confirmed provisional
    const acc = (d: (typeof q)[number]) => (d.proposal as { accountId: string; narration: string });
    expect(q.filter((d) => acc(d).accountId === "SUSPENSE").map((d) => acc(d).narration)).toEqual([expect.stringContaining("UNKNOWN MERCHANT")]);
    expect(acc(q.find((d) => acc(d).narration.includes("HOME LOAN"))!).accountId).toBe("LOANS");
  });

  it("does not ingest the same statement twice", async () => {
    const r = await cell.channels.submitStatement(T, B, csv("hdfc_2026_10.csv"), OWNER);
    expect(r.duplicate).toBe(true);
  });

  it("learns from approvals, then auto-posts known parties under policy in month two", async () => {
    for (const d of await cell.agent.queue(T)) {
      const p = d.proposal as { accountId: string; narration: string };
      if (p.accountId === "SUSPENSE" && !p.narration.includes("LOAN")) continue;          // leave the unknown 75,000 open
      await cell.agent.approveDraft(T, d.draft_id as string, OWNER, p.narration.includes("LOAN") ? "LOANS" : undefined);
    }
    await cell.settle();
    expect(await cell.agent.queue(T)).toHaveLength(1);

    clock.value = "2026-11-25";
    await cell.channels.submitStatement(T, B, csv("hdfc_2026_11.csv"), OWNER);
    await cell.settle();

    const rat = await cell.agent.openRatifications(T);
    expect(rat.map((r) => r.narration as string).some((n) => n.includes("GITHUB"))).toBe(true);   // L3: posted, awaiting ratification
    const pending = (await cell.agent.queue(T)).map((d) => ({ status: d.status, level: (d.decision as { level: string }).level,
      narration: (d.proposal as { narration: string }).narration }));
    expect(pending.find((p) => p.narration.includes("SWIGGY") && p.status === "awaiting_approval")?.level).toBe("L2");  // 70,000 > limit
    // "ACME SOLUTIONS" from the statement is a different party from "acme" typed in chat, and no approval has taught
    // the agent about it yet: the invoice keyword gives FEES at 0.85, below POL-502's 0.97, so it waits as a draft
    const acme = (await cell.agent.queue(T)).find((d) => (d.proposal as { narration: string }).narration.includes("ACME"));
    expect((acme?.proposal as { accountId: string }).accountId).toBe("FEES");
    expect((acme?.decision as { level: string }).level).toBe("L1");
  });

  it("a correction reverses, reposts, learns, and limits the agent for that counterparty", async () => {
    const github = (await cell.agent.openRatifications(T)).find((r) => (r.narration as string).includes("GITHUB"))!;
    const { newJournalId } = await cell.agent.correct(T, github.journal_id as string, "LIVING", OWNER);
    await cell.settle();
    const living = await cell.reporting.drill(T, B, "LIVING");
    expect(living.some((l) => l.journal_id === newJournalId)).toBe(true);
    expect((await cell.agent.openRatifications(T)).some((r) => r.journal_id === github.journal_id)).toBe(false);

    // the next GitHub charge must wait for a person
    await cell.channels.submitStatement(T, B, "Date,Narration,Withdrawal Amt,Deposit Amt\n21/11/2026,UPI/DR/1/GITHUB/github@hdfcbank,1680,\n", OWNER);
    await cell.settle();
    const q = (await cell.agent.queue(T)).find((d) => (d.proposal as { narration: string }).narration.includes("/1/GITHUB"));
    expect((q?.decision as { level: string; reasons: string[] }).level).toBe("L1");
    expect((q?.decision as { reasons: string[] }).reasons.join(" ")).toMatch(/limited to L1/);
  });

  it("keeps statements consistent and the hash chain intact", async () => {
    const tb = await cell.reporting.trialBalance(T, B);
    expect(tb.totals["Difference (must be 0)"]).toBe(0n);
    const bs = await cell.reporting.balanceSheet(T, B);
    expect(bs.totals["Assets - liabilities - equity (must be 0)"]).toBe(0n);
    const pl = await cell.reporting.profitAndLoss(T, B, "2026-10-01", "2026-11-30");
    const soa = await cell.reporting.statementOfAffairs(T, B, "2026-09-30", "2026-11-30");
    expect(soa.totals["Profit / (loss) for the period"]).toBe(pl.totals["Surplus / (deficit)"]);
    expect(await cell.gl.verify(T, B)).toBeNull();
  });

  it("rejects an invalid posting request with an event instead of failing silently", async () => {
    await cell.store.append("agent", T, { streamId: `${T}/txn/manual-bad`, expected: "any", events: [{ type: "PostingRequested", data: {
      requestId: "bad-1", bookId: B, txnDate: "2026-11-30", narration: "bad", voucherType: "journal", provisional: false, autonomy: "human",
      sourceStream: "test", lines: [{ accountId: "NOPE", amount: "100", dimensions: {} }, { accountId: "BANK", amount: "-100", dimensions: {} }] } }] },
      { principal: OWNER });
    await cell.settle();
    const rej = await cell.store.readStream(T, `${T}/gl-rejections/${B}`);
    expect(rej.at(-1)?.data).toMatchObject({ requestId: "bad-1" });
    expect(String((rej.at(-1)?.data as { reason: string }).reason)).toMatch(/no_account/);
    expect((await cell.reporting.drill(T, B, "BANK")).some((l) => l.journal_id === journalIdForRequest(T, "bad-1"))).toBe(false);
  });

  it("serialises many concurrent writers on one book without losing a journal", async () => {
    const n = 25;
    await Promise.all(Array.from({ length: n }, (_, i) => cell.gl.execute(T, B, { kind: "PostJournal", journalId: `conc-${i}`, txnDate: "2026-11-30",
      narration: `concurrent ${i}`, lines: [{ accountId: "LIVING", amount: "100", dimensions: {} }, { accountId: "CASH", amount: "-100", dimensions: {} }] },
      { principal: OWNER })));
    const st = await cell.gl.state(T, B);
    expect([...st.journals.keys()].filter((k) => k.startsWith("conc-"))).toHaveLength(n);
    await cell.settle();
    expect(await cell.gl.verify(T, B)).toBeNull();
  });

  it("isolates tenants end to end", async () => {
    await cell.gl.openBook("other", B, "someone", "individual", "owner:someone");
    await cell.settle();
    const tb = await cell.reporting.trialBalance("other", B);
    expect(tb.rows).toHaveLength(0);
    expect(await cell.agent.queue("other")).toHaveLength(0);
  });
});
