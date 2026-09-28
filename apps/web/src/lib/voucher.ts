/**
 * The Record screen's voucher model (plain TypeScript, tested in tests/web-voucher.test.ts). Amounts are
 * typed in rupees ("10,000.50") and held as paise (bigint): no floating point. The core re-checks everything
 * (ops `journal`); this model only gives the person immediate feedback while they type.
 */
export const VOUCHER_TYPES = ["payment", "receipt", "contra", "journal", "sales", "purchase", "sales_return", "purchase_return"] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

export interface AccountRef { account_id: string; name: string; nature: string; is_control?: boolean; is_cash_like?: boolean }
export interface DraftLine { id: number; account: string; party: string; debit: string; credit: string; memo: string }

export const VOUCHER_INFO: Record<VoucherType, { label: string; hint: string; key: string }> = {
  payment: { label: "Payment", key: "P", hint: "Money paid out of a bank, cash or card account: what it was for (debit), and where it was paid from (credit)." },
  receipt: { label: "Receipt", key: "R", hint: "Money received into a bank, cash or card account (debit), and what it was for (credit)." },
  contra: { label: "Contra", key: "C", hint: "Money moved between your own bank, cash and card accounts: a deposit, a withdrawal or a card payment." },
  journal: { label: "Journal", key: "J", hint: "Any other entry: accruals, adjustments, depreciation, reclassifications. Debits must equal credits." },
  sales: { label: "Sales", key: "S", hint: "An invoice you raised: the customer owes you (debit Trade receivables) for income (credit), with output GST if any." },
  purchase: { label: "Purchase", key: "U", hint: "A bill you received: the expense or asset (debit), input GST if any, owed to the supplier (credit Trade payables)." },
  sales_return: { label: "Sales return", key: "N", hint: "A credit note: goods or services returned by a customer. Choose the original invoice; Kuber reverses it line by line and checks you do not return more than was sold." },
  purchase_return: { label: "Purchase return", key: "D", hint: "A debit note: goods returned to a supplier. Choose the original bill; Kuber reverses it line by line and checks you do not return more than was bought." },
};

/** The original voucher type a return reverses. */
export const RETURN_OF: Partial<Record<VoucherType, "sales" | "purchase">> = { sales_return: "sales", purchase_return: "purchase" };

/** How a stored voucher type reads ("sales_return" → "Sales return"). */
export function voucherLabel(t: string | null | undefined): string {
  const k = (t ?? "journal") as VoucherType;
  if (VOUCHER_INFO[k]) return VOUCHER_INFO[k].label;
  return (t ?? "journal").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** "10,000.50" → 1000050n; blank → 0n; anything else (letters, negative, more than 2 decimals) → null. */
export function paise(text: string): bigint | null {
  const t = text.replace(/[,\s₹]/g, "");
  if (t === "") return 0n;
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}

/** Paise → the rupee text an amount field shows ("11800.00" → "11,800", "1050" → "10.50"). */
export function rupees(p: bigint): string {
  const neg = p < 0n, a = neg ? -p : p;
  const whole = (a / 100n).toLocaleString("en-IN"), frac = a % 100n;
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac.toString().padStart(2, "0") : ""}`;
}

let seq = 0;
export const blankLine = (over: Partial<DraftLine> = {}): DraftLine => ({ id: ++seq, account: "", party: "", debit: "", credit: "", memo: "", ...over });

const pick = (accounts: AccountRef[], ...ids: string[]) => ids.find((id) => accounts.some((a) => a.account_id === id)) ?? "";
const firstCash = (accounts: AccountRef[]) => pick(accounts, "BANK", ...accounts.filter((a) => a.is_cash_like).map((a) => a.account_id));

/** The starting lines for a voucher type, using the book's accounts where the usual ones exist. */
export function template(type: VoucherType, accounts: AccountRef[]): DraftLine[] {
  const cash = firstCash(accounts);
  const income = pick(accounts, "FEES", "SALES", ...accounts.filter((a) => a.nature === "income").map((a) => a.account_id));
  switch (type) {
    case "payment": return [blankLine(), blankLine({ account: cash })];
    case "receipt": return [blankLine({ account: cash }), blankLine()];
    case "contra": return [blankLine({ account: pick(accounts, "CASH", "BANK") }), blankLine({ account: cash === "CASH" ? "" : cash })];
    case "sales": return [blankLine({ account: pick(accounts, "DEBTORS") }), blankLine({ account: income }), blankLine({ account: pick(accounts, "GSTOUT") })];
    case "purchase": return [blankLine(), blankLine({ account: pick(accounts, "GSTIN") }), blankLine({ account: pick(accounts, "CREDITORS") })];
    case "sales_return": return [blankLine({ account: income }), blankLine({ account: pick(accounts, "GSTOUT") }), blankLine({ account: pick(accounts, "DEBTORS") })];
    case "purchase_return": return [blankLine({ account: pick(accounts, "CREDITORS") }), blankLine(), blankLine({ account: pick(accounts, "GSTIN") })];
    default: return [blankLine(), blankLine()];
  }
}

/** Which side a line's amount goes on by default for a type and position (so the person types one amount). */
export function defaultSide(type: VoucherType, index: number, count: number): "debit" | "credit" {
  if (type === "payment" || type === "purchase") return index === count - 1 ? "credit" : "debit";
  if (type === "receipt" || type === "sales" || type === "purchase_return") return index === 0 ? "debit" : "credit";
  if (type === "sales_return") return index === count - 1 ? "credit" : "debit";
  return index % 2 === 0 ? "debit" : "credit";
}

export interface VoucherState {
  debits: bigint; credits: bigint; difference: bigint;
  /** Lines with an account and an amount (blank rows are ignored). */
  used: number;
  /** Problems to fix before previewing; empty means the core can be asked. */
  problems: string[];
  /** Per line: the problem on that line, if any. */
  lineProblems: Map<number, string>;
}

export function evaluate(lines: DraftLine[], accounts: AccountRef[], parties: { partyId: string }[] = [], controlledAdjustment = false): VoucherState {
  let debits = 0n, credits = 0n, used = 0;
  const lineProblems = new Map<number, string>(), problems: string[] = [];
  const byId = new Map(accounts.map((a) => [a.account_id, a]));
  const partyIds = new Set(parties.map((p) => p.partyId));
  lines.forEach((l, i) => {
    const dr = paise(l.debit), cr = paise(l.credit);
    const blank = !l.account && !l.debit.trim() && !l.credit.trim();
    if (blank) return;
    if (dr === null || cr === null) { lineProblems.set(l.id, "Amounts are rupees, e.g. 10,000.50"); return; }
    if (!l.account) { lineProblems.set(l.id, "Choose an account"); return; }
    if (dr > 0n && cr > 0n) { lineProblems.set(l.id, "A debit or a credit, not both"); return; }
    if (dr === 0n && cr === 0n) { lineProblems.set(l.id, "Enter an amount"); return; }
    const acc = byId.get(l.account);
    if (acc?.is_control && !l.party && !controlledAdjustment) { lineProblems.set(l.id, `${acc.name} needs the customer or supplier`); return; }
    if (acc?.is_control && l.party && !partyIds.has(l.party) && !controlledAdjustment) { lineProblems.set(l.id, "Not a registered party"); return; }
    debits += dr; credits += cr; used++;
    void i;
  });
  if (lineProblems.size) problems.push(lineProblems.size === 1 ? "One line needs attention" : `${lineProblems.size} lines need attention`);
  if (used < 2) problems.push("A voucher needs at least two lines");
  if (debits !== credits) problems.push(`Debits and credits differ by ₹${rupees(debits > credits ? debits - credits : credits - debits)}`);
  return { debits, credits, difference: debits - credits, used, problems, lineProblems };
}

/** Put the difference on line `id` (on the side that balances the voucher). */
export function balanceOn(lines: DraftLine[], id: number): DraftLine[] {
  let dr = 0n, cr = 0n;
  for (const l of lines) if (l.id !== id) { dr += paise(l.debit) ?? 0n; cr += paise(l.credit) ?? 0n; }
  const diff = dr - cr;
  return lines.map((l) => l.id !== id ? l : diff > 0n ? { ...l, credit: rupees(diff), debit: "" } : diff < 0n ? { ...l, debit: rupees(-diff), credit: "" } : l);
}

/**
 * A return's starting lines from its original voucher: every line mirrored (debit ↔ credit), with its party.
 * The person then reduces amounts for a partial return; the core checks what is left to return.
 */
export function mirrorOf(original: { lines: { accountId: string; amount: string; partyId?: string | null }[] }): DraftLine[] {
  return original.lines.map((l) => {
    const a = BigInt(l.amount);
    return blankLine({ account: l.accountId, party: l.partyId ?? "", ...(a > 0n ? { credit: rupees(a) } : { debit: rupees(-a) }) });
  });
}

/** The body of the core's `journal` operation for these lines. */
export function toInput(v: { type: VoucherType; date: string; narration: string; reference: string; lines: DraftLine[]; adjustmentReason?: string; against?: string }) {
  const lines = v.lines.filter((l) => l.account && ((paise(l.debit) ?? 0n) > 0n || (paise(l.credit) ?? 0n) > 0n)).map((l) => {
    const dr = paise(l.debit) ?? 0n, cr = paise(l.credit) ?? 0n;
    return { account: l.account, ...(dr > 0n ? { debit: rupees(dr).replace(/,/g, "") } : { credit: rupees(cr).replace(/,/g, "") }),
      ...(l.party ? { party: l.party } : {}), ...(l.memo.trim() ? { memo: l.memo.trim() } : {}) };
  });
  return { voucherType: v.type, ...(v.date ? { date: v.date } : {}), narration: v.narration.trim(), ...(v.reference.trim() ? { reference: v.reference.trim() } : {}),
    ...(v.against && RETURN_OF[v.type] ? { against: v.against } : {}), lines,
    ...(v.adjustmentReason?.trim() ? { controlledAdjustment: { reason: v.adjustmentReason.trim() } } : {}) };
}
