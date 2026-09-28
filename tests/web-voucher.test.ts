/** The Record screen's voucher model: amounts in paise, live balance, line problems, and the core request it builds. */
import { describe, expect, it } from "vitest";
import { balanceOn, blankLine, evaluate, mirrorOf, paise, rupees, template, toInput, voucherLabel } from "../apps/web/src/lib/voucher.ts";

const accounts = [
  { account_id: "BANK", name: "Bank account", nature: "asset", is_cash_like: true },
  { account_id: "CASH", name: "Cash in hand", nature: "asset", is_cash_like: true },
  { account_id: "BIZEXP", name: "Business expenses", nature: "expense" },
  { account_id: "GSTIN", name: "GST input credit", nature: "asset" },
  { account_id: "CREDITORS", name: "Trade payables", nature: "liability", is_control: true },
  { account_id: "FEES", name: "Professional fees", nature: "income" },
];

describe("voucher model", () => {
  it("parses rupees to paise exactly and refuses what is not an amount", () => {
    expect(paise("10,000.5")).toBe(1000050n);
    expect(paise("₹ 1,18,000")).toBe(11800000n);
    expect(paise("")).toBe(0n);
    expect(paise("-5")).toBeNull();
    expect(paise("1.234")).toBeNull();
    expect(rupees(1180000n)).toBe("11,800");
    expect(rupees(1050n)).toBe("10.50");
  });

  it("templates start from the book's usual accounts", () => {
    expect(template("payment", accounts).map((l) => l.account)).toEqual(["", "BANK"]);
    expect(template("purchase", accounts).map((l) => l.account)).toEqual(["", "GSTIN", "CREDITORS"]);
  });

  it("tracks the difference, flags line problems, and balances on a chosen line", () => {
    const a = blankLine({ account: "BIZEXP", debit: "10,000" }), b = blankLine({ account: "GSTIN", debit: "1,800" }), c = blankLine({ account: "BANK", credit: "11,000" });
    const v = evaluate([a, b, c], accounts);
    expect(v.difference).toBe(80000n);
    expect(v.problems).toContain("Debits and credits differ by ₹800");
    const fixed = balanceOn([a, b, c], c.id);
    expect(fixed.find((l) => l.id === c.id)!.credit).toBe("11,800");
    expect(evaluate(fixed, accounts).problems).toEqual([]);
    const both = evaluate([blankLine({ account: "BIZEXP", debit: "1", credit: "1" }), c], accounts);
    expect([...both.lineProblems.values()]).toContain("A debit or a credit, not both");
    const control = evaluate([blankLine({ account: "BIZEXP", debit: "5" }), blankLine({ account: "CREDITORS", credit: "5" })], accounts);
    expect([...control.lineProblems.values()][0]).toMatch(/needs the customer or supplier/);
    expect(evaluate([blankLine({ account: "BIZEXP", debit: "5" }), blankLine({ account: "CREDITORS", credit: "5", party: "acme-supplies" })], accounts, [{ partyId: "acme-supplies" }]).problems).toEqual([]);
  });

  it("builds the core's journal input from the lines that carry an amount", () => {
    const input = toInput({ type: "payment", date: "2026-10-09", narration: " Rent ", reference: "INV-7",
      lines: [blankLine({ account: "BIZEXP", debit: "10,000", memo: "Oct" }), blankLine({ account: "BANK", credit: "10000" }), blankLine()] });
    expect(input).toEqual({ voucherType: "payment", date: "2026-10-09", narration: "Rent", reference: "INV-7",
      lines: [{ account: "BIZEXP", debit: "10000", memo: "Oct" }, { account: "BANK", credit: "10000" }] });
  });

  it("returns mirror the original voucher (debit ↔ credit, same party) and carry `against`", () => {
    const sale = { lines: [{ accountId: "DEBTORS", amount: "118000", partyId: "acme" }, { accountId: "FEES", amount: "-100000" }, { accountId: "GSTOUT", amount: "-18000" }] };
    const m = mirrorOf(sale);
    expect(m.map((l) => [l.account, l.debit, l.credit, l.party])).toEqual([["DEBTORS", "", "1,180", "acme"], ["FEES", "1,000", "", ""], ["GSTOUT", "180", "", ""]]);
    expect(evaluate(m, [...accounts, { account_id: "DEBTORS", name: "Trade receivables", nature: "asset", is_control: true }, { account_id: "GSTOUT", name: "GST output", nature: "liability" }], [{ partyId: "acme" }]).problems).toEqual([]);
    const input = toInput({ type: "sales_return", date: "2026-10-12", narration: "Credit note", reference: "", lines: m, against: "j-42" });
    expect(input).toMatchObject({ voucherType: "sales_return", against: "j-42" });
    expect(toInput({ type: "payment", date: "", narration: "x", reference: "", lines: m, against: "j-42" })).not.toHaveProperty("against");
    expect(template("purchase_return", accounts).map((l) => l.account)).toEqual(["CREDITORS", "", "GSTIN"]);
    expect([voucherLabel("sales_return"), voucherLabel("opening"), voucherLabel(null)]).toEqual(["Sales return", "Opening", "Journal"]);
  });
});
