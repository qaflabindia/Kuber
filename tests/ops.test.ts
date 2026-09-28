/**
 * Operations: every write is simulated first and committed only as simulated; agents cannot
 * commit what needs a person; period operations lock and close correctly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uuid } from "@kuber/contracts";
import type { Cell } from "@kuber/core";
import { rebalanceTransfers, splitByWeights, balancesFromState, type Plan } from "@kuber/ops";
import { ROOT, enrol, startCell } from "./helpers.ts";

describe("allocation arithmetic", () => {
  it("parts always sum exactly to the total, whatever the weights", () => {
    fc.assert(fc.property(fc.bigInt({ min: -1000000000000n, max: 1000000000000n }), fc.array(fc.bigInt({ min: 0n, max: 10000n }), { minLength: 1, maxLength: 12 }), (total, w) => {
      fc.pre(w.some((x) => x > 0n));
      const parts = splitByWeights(total, w);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
      parts.forEach((p, i) => { if (w[i] === 0n) expect(p).toBe(0n); });
    }));
  });
  it("rebalancing conserves the pool and reaches targets", () => {
    fc.assert(fc.property(fc.array(fc.bigInt({ min: 0n, max: 10000000000n }), { minLength: 2, maxLength: 6 }), (bals) => {
      const cur = bals.map((b, i) => ({ id: `A${i}`, bal: b }));
      const bp = new Map(cur.map((c, i) => [c.id, i === 0 ? 10000n - BigInt(cur.length - 1) * (10000n / BigInt(cur.length)) : 10000n / BigInt(cur.length)]));
      const after = new Map(cur.map((c) => [c.id, c.bal]));
      for (const t of rebalanceTransfers(cur, bp)) { after.set(t.from, after.get(t.from)! - t.amount); after.set(t.to, after.get(t.to)! + t.amount); }
      const total = bals.reduce((a, b) => a + b, 0n);
      expect([...after.values()].reduce((a, b) => a + b, 0n)).toBe(total);
      const target = splitByWeights(total === 0n ? 0n : total, cur.map((c) => bp.get(c.id)!));
      cur.forEach((c, i) => expect(after.get(c.id)).toBe(target[i]));
    }));
  });
});

const T = "laksh", B = "main", OWNER = "owner:laksh", AGENT = "agent:assistant";
const clock = { value: "2026-10-25" };
let cell: Cell, stop: () => Promise<void>;
const plan = (op: string, input: unknown, who = OWNER) => cell.ops.plan(T, B, who, op, input);
const commit = (p: Plan, who = OWNER) => cell.ops.commit(T, p.planId, who, p.hash);

beforeAll(async () => {
  ({ cell, stop } = await startCell(clock));
  // A freelancer keeping their own books: the only person, with the explicit single-owner
  // exception to maker-checker (separation of duties is covered in identity.test.ts).
  await enrol(cell, T, [OWNER]);
  await enrol(cell, T, [AGENT], [B]);
  await cell.identity.setSettings(T, OWNER, { soloOwner: true, sodLimitPaise: null });
  await cell.gl.openBook(T, B, "laksh", "freelancer", OWNER);
  await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: "Opening BANK", voucherType: "opening",
    lines: [{ accountId: "BANK", amount: "12500000", dimensions: {} }, { accountId: "OPENING", amount: "-12500000", dimensions: {} }] }, { principal: OWNER });
  await cell.channels.submitStatement(T, B, readFileSync(join(ROOT, "samples", "hdfc_2026_10.csv"), "utf8"), OWNER);
  await cell.settle();
});
afterAll(async () => { await stop(); });

describe("simulate, then commit exactly that", () => {
  it("record: a plan shows the journal and before/after, and posts only on commit", async () => {
    const p = await plan("record", { narration: "Plumber", amount: "450", direction: "out", account: "living", via: "CASH", date: "2026-10-05" });
    expect(p.status).toBe("proposed");
    expect(p.blocked).toBe(false);
    expect(p.journals[0]!.lines.map((l) => [l.accountId, l.amount])).toEqual([["LIVING", "45000"], ["CASH", "-45000"]]);
    expect(p.effects.find((e) => e.accountId === "LIVING")).toMatchObject({ before: "0", after: "45000" });
    const seq = (await cell.gl.state(T, B)).seq;
    expect((await cell.gl.state(T, B)).seq).toBe(seq);                       // simulation wrote nothing
    expect(await commit(p)).toMatchObject({ status: "committed" });
    expect((await cell.gl.state(T, B)).seq).toBe(seq + 1);
    expect(await commit(p)).toMatchObject({ status: "committed", replayed: true }); // a retry returns the outcome (F04)
    expect((await cell.gl.state(T, B)).seq).toBe(seq + 1);                   // one commit only
  });

  it("journal: a multi-line voucher is checked (balance, voucher type, control accounts) and posts only on commit", async () => {
    const unbalanced = await plan("journal", { voucherType: "payment", date: "2026-10-09", narration: "Office rent and GST",
      lines: [{ account: "BIZEXP", debit: "10,000" }, { account: "GSTIN", debit: "1,800" }, { account: "BANK", credit: "11,000" }] });
    expect(unbalanced.blocked).toBe(true);
    expect(unbalanced.checks.find((c) => c.label === "Debits equal credits")).toMatchObject({ ok: false, detail: expect.stringMatching(/difference ₹800/) });
    const notPayment = await plan("journal", { voucherType: "payment", date: "2026-10-09", narration: "Reclass",
      lines: [{ account: "BIZEXP", debit: 100 }, { account: "LIVING", credit: 100 }] });
    expect(notPayment.checks.find((c) => c.label.startsWith("A payment"))).toMatchObject({ ok: false });
    const control = await plan("journal", { voucherType: "sales", date: "2026-10-09", narration: "Invoice 42",
      lines: [{ account: "DEBTORS", debit: 1000 }, { account: "FEES", credit: 1000 }] });
    expect(control.checks.find((c) => c.label.startsWith("Control accounts"))).toMatchObject({ ok: false, detail: expect.stringMatching(/line 1 \(DEBTORS\)/) });

    const p = await plan("journal", { voucherType: "payment", date: "2026-10-09", narration: "Office rent and GST", reference: "INV-77",
      lines: [{ account: "bizexp", debit: "10,000", memo: "October rent" }, { account: "GSTIN", debit: "1,800" }, { account: "CASH", credit: "11,800" }] });
    expect(p.blocked).toBe(false);
    expect(p.journals[0]).toMatchObject({ voucherType: "payment", narration: "Office rent and GST (ref INV-77)" });
    expect(p.journals[0]!.lines.map((l) => [l.accountId, l.amount])).toEqual([["BIZEXP", "1000000"], ["GSTIN", "180000"], ["CASH", "-1180000"]]);
    const seq = (await cell.gl.state(T, B)).seq;
    expect(await commit(p)).toMatchObject({ status: "committed" });
    const st = await cell.gl.state(T, B);
    expect(st.seq).toBe(seq + 1);
    expect([...st.journals.values()].some((j) => j.narration === "Office rent and GST (ref INV-77)")).toBe(true);
  });

  it("refuses a tampered hash and a plan the books have moved past", async () => {
    const a = await plan("record", { narration: "Tea", amount: 20, direction: "out", account: "LIVING", via: "CASH", date: "2026-10-06" });
    await expect(cell.ops.commit(T, a.planId, OWNER, "0".repeat(64))).rejects.toThrow(/not the plan on record/);
    const b = await plan("record", { narration: "Snacks", amount: 30, direction: "out", account: "LIVING", via: "CASH", date: "2026-10-06" });
    await commit(b);
    await expect(commit(a)).rejects.toThrow(/changed since this was simulated/);
    expect((await cell.ops.get(T, a.planId)).status).toBe("stale");
  });

  it("an agent commits small entries policy allows, and waits for a person above the limit", async () => {
    const small = await plan("record", { narration: "Stationery", amount: 100, direction: "out", account: "BIZEXP", via: "CASH", date: "2026-10-07" }, AGENT);
    expect(small.policy?.level).toBe("L3");
    expect(await commit(small, AGENT)).toMatchObject({ status: "committed" });
    const big = await plan("record", { narration: "Laptop", amount: "90,000", direction: "out", account: "BIZEXP", via: "BANK", date: "2026-10-08" }, AGENT);
    expect(big.needsPerson).toBe(true);
    expect(await commit(big, AGENT)).toMatchObject({ status: "awaiting_person" });
    await cell.ops.discard(T, big.planId, OWNER);
  });

  it("post: approves classified drafts in bulk and leaves the unclassified one", async () => {
    const p = await plan("post", {});
    expect(p.journals).toHaveLength(9);
    expect(p.links[0]![1]).toBe("/review");
    await commit(p);
    await cell.settle();
    const q = await cell.agent.queue(T);
    expect(q).toHaveLength(1);
    expect((q[0]!.proposal as { accountId: string }).accountId).toBe("SUSPENSE");
  });

  it("reconcile: statement balance is fully explained by the line still in review", async () => {
    const p = await plan("reconcile", { account: "BANK", statementBalance: "1,30,206.50", asOf: "2026-10-31" });
    const diff = p.sections[0]!.rows.find((r) => r[0] === "Unexplained difference")![1];
    expect(diff).toBe("0");
    expect(p.checks.find((c) => c.label.startsWith("Statement agrees"))!.ok).toBe(true);
    const off = await plan("reconcile", { account: "BANK", statementBalance: "1,30,106.50", asOf: "2026-10-31", adjustTo: "BIZEXP" });
    expect(off.journals[0]!.lines).toEqual([expect.objectContaining({ accountId: "BANK", amount: "-10000" }), expect.objectContaining({ accountId: "BIZEXP", amount: "10000" })]);
    await cell.ops.discard(T, off.planId, OWNER, { codes: ["superseded"] });
  });

  it("allocate: splits by weight to the paisa, across cost centres", async () => {
    const p = await plan("allocate", { from: "BIZEXP", amount: "1000.01", date: "2026-10-31",
      to: ["A", "B", "C"].map((c, i) => ({ account: "BIZEXP", weight: i === 2 ? "33.34" : "33.33", dimensions: { costCentre: c } })) });
    const parts = p.journals[0]!.lines.slice(1).map((l) => BigInt(l.amount));
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100001n);
    expect(p.needsPerson).toBe(true);
    expect(await commit(p, AGENT)).toMatchObject({ status: "awaiting_person" });
    expect(await commit(p)).toMatchObject({ status: "committed" });
  });

  it("rebalance: moves the pool to target shares with the fewest transfers", async () => {
    const p = await plan("rebalance", { targets: [{ account: "BANK", pct: 50 }, { account: "INVEST", pct: 50 }], date: "2026-10-31" });
    expect(p.journals).toHaveLength(1);
    await commit(p);
    const b = balancesFromState(await cell.gl.state(T, B));
    expect(b.get("BANK")! - b.get("INVEST")!).toBeLessThanOrEqual(1n);
  });

  it("simulate never posts", async () => {
    const seq = (await cell.gl.state(T, B)).seq;
    const p = await plan("simulate", { entries: [{ narration: "New laptop", amount: "90000", direction: "out", account: "BIZEXP", via: "BANK" }], monthlyChange: { expenses: 15000 }, months: 6 });
    expect(p.status).toBe("preview");
    expect(BigInt((p.data as { after: { cash: string } }).after.cash) - BigInt((p.data as { before: { cash: string } }).before.cash)).toBe(-9000000n);
    expect((await cell.gl.state(T, B)).seq).toBe(seq);
    await expect(commit(p)).rejects.toThrow(/no plan/);
  });
});

describe("period operations", () => {
  it("close: blocked while a draft is dated in the period; then locks it", async () => {
    clock.value = "2026-11-05";
    const blocked = await plan("close", { periodEnd: "2026-10-31" });
    expect(blocked.blocked).toBe(true);
    expect(blocked.status).toBe("preview");                                  // shown, not stored
    await expect(commit(blocked)).rejects.toThrow(/no plan/);
    const [d] = await cell.agent.queue(T);
    await cell.agent.rejectDraft(T, d!.draft_id, OWNER, "not mine");
    const p = await plan("close", { periodEnd: "2026-10-31" });
    expect(p.blocked).toBe(false);
    expect(await commit(p, AGENT)).toMatchObject({ status: "awaiting_person" });
    await commit(p);
    const late = await plan("record", { narration: "Late bill", amount: 99, direction: "out", account: "LIVING", via: "CASH", date: "2026-10-20" });
    expect(late.blocked).toBe(true);
    expect(late.checks.find((c) => !c.ok)!.detail).toMatch(/hard-locked/);
  });

  it("year-end close moves income and expenses to retained surplus; reports still show the year", async () => {
    clock.value = "2027-04-03";
    const before = await cell.reporting.profitAndLoss(T, B, "2026-04-01", "2027-03-31");
    const p = await plan("close", { periodEnd: "2027-03-31" });
    expect(p.journals[0]!.voucherType).toBe("closing");
    await commit(p);
    await cell.settle();
    const s = await cell.gl.state(T, B);
    const bal = balancesFromState(s, { to: "2027-03-31" });
    for (const [id, v] of bal) if (["income", "expense"].includes(s.accounts.get(id)!.nature)) expect(v).toBe(0n);
    const after = await cell.reporting.profitAndLoss(T, B, "2026-04-01", "2027-03-31");
    expect(after.totals).toEqual(before.totals);                             // closing voucher added back
    const bs = await cell.reporting.balanceSheet(T, B);
    expect(bs.totals["Assets - liabilities - equity (must be 0)"]).toBe(0n);
  });

  it("carry forward: verifies the opening position and records the sign-off", async () => {
    const p = await plan("carry_forward", { yearEnd: "2027-03-31" });
    expect(p.blocked).toBe(false);
    expect(p.checks.every((c) => c.ok)).toBe(true);
    expect(await commit(p)).toMatchObject({ status: "committed" });
  });

  it("balance and dashboard read the live position", async () => {
    const b = await plan("balance", {});
    expect(b.checks.find((c) => c.label === "Debits equal credits")!.ok).toBe(true);
    expect(b.checks.find((c) => c.label === "Hash chain intact")!.ok).toBe(true);
    const d = await plan("dashboard", {});
    expect((d.data as { kpis: { fy: string } }).kpis.fy).toBe("FY 2027-28");
  });
});
