/** Channel parsers: bank statement CSV (authoritative) and chat text (user-asserted). Deterministic. */
import { parseAmount, type RawTxn } from "@kuber/contracts";

const COLS: Record<string, string[]> = {
  date: ["date", "txn date", "transaction date", "value date", "tran date"],
  narration: ["narration", "description", "particulars", "remarks", "details"],
  debit: ["debit", "withdrawal", "withdrawal amt", "withdrawal amount", "dr"],
  credit: ["credit", "deposit", "deposit amt", "deposit amount", "cr"],
  amount: ["amount"],
  type: ["type", "dr/cr", "cr/dr"],
  ref: ["ref", "reference", "chq/ref no", "ref no", "utr", "cheque no"],
  balance: ["closing balance", "balance", "running balance", "available balance", "bal"],
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseDate(s: string): string {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(t);
  if (m) return `${m[3]!.length === 2 ? "20" + m[3] : m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})$/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  throw new Error(`unrecognised date ${JSON.stringify(s)}`);
}

/** Minimal RFC 4180 CSV reader (quoted fields, escaped quotes). */
export function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** Version of the statement interpretation, recorded with every signal for lineage. */
export const STATEMENT_PARSER = "bank-csv/2";

export interface SkippedRow { row: number; reason: string }
export interface ControlTotals {
  /** reconciled: running balances agree with every movement (and with totals the caller declared);
   *  unverifiable: the file has no balance column and the caller declared nothing to check against;
   *  mismatch: something does not add up. */
  status: "reconciled" | "unverifiable" | "mismatch";
  debits: string; credits: string; opening?: string; closing?: string; problems: string[];
}
/** Figures the uploader (or the bank's statement summary) declares; each one given is checked. */
export interface DeclaredTotals { opening?: string; closing?: string; debits?: string; credits?: string; count?: number }
export interface ParsedStatement { txns: RawTxn[]; rows: number; skipped: SkippedRow[]; controls: ControlTotals; hasBalance: boolean }

const signedBalance = (s: string): bigint => {
  const m = /^(.*?)\s*(cr|dr)\.?$/i.exec(s.trim());
  const v = parseAmount(m ? m[1]! : s);
  return m && m[2]!.toLowerCase() === "dr" ? -(v < 0n ? -v : v) : v;
};

/**
 * Parse a bank statement CSV and prove its completeness where the file allows it.
 * Every data row gets a disposition: a transaction, or a skipped row with a reason. A row carrying
 * both a debit and a credit is ambiguous and is skipped (never guessed). With a running-balance
 * column, each movement must take the previous balance to the next one (either row order), which
 * also yields the opening and closing balances; declared totals are checked when given.
 */
export function parseBankStatement(text: string, instrument = "BANK", declared: DeclaredTotals = {}): ParsedStatement {
  const rows = readCsv(text.trim());
  if (rows.length < 1) throw new Error("CSV has no header row");
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col: Record<string, number> = {};
  for (const [k, names] of Object.entries(COLS)) { const i = header.findIndex((h) => names.includes(h)); if (i >= 0) col[k] = i; }
  if (col.date === undefined || col.narration === undefined) throw new Error(`CSV needs a date and a narration column; found ${rows[0]!.join(", ")}`);
  if (col.debit === undefined && col.credit === undefined && col.amount === undefined) throw new Error("CSV needs debit/credit columns or an amount column");
  const hasBalance = col.balance !== undefined;
  const out: RawTxn[] = [];
  const skipped: SkippedRow[] = [];
  const problems: string[] = [];
  let debits = 0n, credits = 0n;
  // (net movement, balance) per data row in file order, for the continuity proof
  const chain: { row: number; net: bigint; bal: bigint | null }[] = [];
  const data = rows.slice(1);
  for (let ri = 0; ri < data.length; ri++) {
    const r = data[ri]!, rowNo = ri + 1;
    const get = (k: string) => (col[k] !== undefined ? (r[col[k]!] ?? "").trim() : "");
    let dr = get("debit"), cr = get("credit");
    if (col.amount !== undefined && !dr && !cr) {
      const amt = get("amount"), typ = get("type").toLowerCase();
      const v = amt ? parseAmount(amt) : 0n;
      if (typ.startsWith("cr") || (!typ && v > 0n)) cr = amt.replace(/^-/, ""); else dr = amt.replace(/^-/, "");
    }
    const d = dr ? parseAmount(dr) : 0n, c = cr ? parseAmount(cr) : 0n;
    const dAbs = d < 0n ? -d : d, cAbs = c < 0n ? -c : c;
    debits += dAbs; credits += cAbs;
    const balText = hasBalance ? get("balance") : "";
    const bal = balText ? signedBalance(balText) : null;
    chain.push({ row: rowNo, net: cAbs - dAbs, bal });
    if (dAbs !== 0n && cAbs !== 0n) { skipped.push({ row: rowNo, reason: "both debit and credit present" }); continue; }
    if (dAbs === 0n && cAbs === 0n) { skipped.push({ row: rowNo, reason: "no amount" }); continue; }
    const direction: "in" | "out" = dAbs !== 0n ? "out" : "in";
    const amount = dAbs !== 0n ? dAbs : cAbs;
    const narration = get("narration");
    out.push({
      txnDate: parseDate(get("date")), amount: amount.toString(), direction, narration, instrument,
      reference: get("ref") || utr(narration) || undefined, counterpartyHint: vpa(narration) ?? upiName(narration) ?? undefined,
      ...(bal !== null ? { balance: bal.toString() } : {}), sourceRow: rowNo,
    });
  }

  // running-balance continuity: ascending (oldest first) or descending (newest first) order
  let opening: bigint | undefined, closing: bigint | undefined;
  if (hasBalance && chain.length) {
    const missing = chain.filter((x) => x.bal === null).map((x) => x.row);
    if (missing.length) problems.push(`rows without a balance: ${missing.join(", ")}`);
    else {
      const breaks = (seq: typeof chain) => {
        const bad: number[] = [];
        for (let i = 1; i < seq.length; i++) if (seq[i - 1]!.bal! + seq[i]!.net !== seq[i]!.bal!) bad.push(seq[i]!.row);
        return bad;
      };
      const asc = breaks(chain), desc = breaks([...chain].reverse());
      const ordered = asc.length <= desc.length ? chain : [...chain].reverse();
      const bad = asc.length <= desc.length ? asc : desc;
      if (bad.length) problems.push(`running balance does not follow the movements at row(s) ${bad.join(", ")}`);
      opening = ordered[0]!.bal! - ordered[0]!.net;
      closing = ordered.at(-1)!.bal!;
    }
  }
  let declaredChecked = false;
  const check = (label: string, want: bigint | undefined, got: bigint | undefined) => {
    if (want === undefined || got === undefined) return;
    declaredChecked = true;
    if (got !== want) problems.push(`declared ${label} ${want} but the file gives ${got}`);
  };
  const dOpen = declared.opening !== undefined ? parseAmount(declared.opening) as bigint : undefined;
  const dClose = declared.closing !== undefined ? parseAmount(declared.closing) as bigint : undefined;
  check("opening balance", dOpen, opening);
  check("closing balance", dClose, closing);
  check("total debits", declared.debits !== undefined ? parseAmount(declared.debits) : undefined, debits);
  check("total credits", declared.credits !== undefined ? parseAmount(declared.credits) : undefined, credits);
  check("row count", declared.count !== undefined ? BigInt(declared.count) : undefined, BigInt(data.length));
  if (opening === undefined && dOpen !== undefined && dClose !== undefined) {
    // no balance column: the declared opening plus the movements must give the declared closing
    declaredChecked = true;
    const net = chain.reduce((a, x) => a + x.net, 0n);
    if (dOpen + net !== dClose) problems.push(`declared opening ${dOpen} plus movements ${net} does not give declared closing ${dClose}`);
    opening = dOpen; closing = dClose;
  }
  const status = problems.length ? "mismatch" : (hasBalance && chain.length > 1) || declaredChecked ? "reconciled" : "unverifiable";
  return {
    txns: out, rows: data.length, skipped, hasBalance,
    controls: { status, debits: debits.toString(), credits: credits.toString(),
      ...(opening !== undefined ? { opening: opening.toString() } : {}),
      ...(closing !== undefined ? { closing: closing.toString() } : {}),
      problems },
  };
}

export function parseBankCsv(text: string, instrument = "BANK"): RawTxn[] {
  return parseBankStatement(text, instrument).txns;
}

const VPA = /\b([a-z0-9.\-_]{2,})@([a-z]{2,})\b/i;
const vpa = (s: string) => VPA.exec(s)?.[0].toLowerCase() ?? null;
const utr = (s: string) => /\b(\d{12})\b/.exec(s)?.[1] ?? null;
function upiName(s: string): string | null {
  const parts = s.split(/[/-]/);
  if (parts[0]?.toUpperCase() !== "UPI") return null;
  const c = parts.slice(1).find((p) => p && !/^\d+$/.test(p) && !["DR", "CR", "P2M", "P2A"].includes(p.toUpperCase()));
  return c ? c.trim().toLowerCase() : null;
}

// ---------------------------------------------------------------- chat
const INSTR: Record<string, string> = {
  cash: "CASH", card: "CARD", "credit card": "CARD", upi: "BANK", bank: "BANK", gpay: "BANK", phonepe: "BANK",
  paytm: "BANK", netbanking: "BANK", hdfc: "BANK", icici: "BANK", sbi: "BANK", axis: "BANK",
};

/**
 * Rule-based parser for short entries; returns null when it cannot parse (the caller then
 * uses the LLM extractor or asks). "Paid 450 to the plumber in cash",
 * "Received 1.18 lakh from Acme for invoice 17 via bank", "Spent 1,200 on groceries by card".
 */
export function parseChat(text: string, on: string): RawTxn | null {
  const low = text.trim().toLowerCase();
  const m = /(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d{1,2})?)\s*(k|lakhs?|l|crores?|cr)?\b/.exec(low);
  if (!m) return null;
  let amount = parseAmount(m[1]!);
  const unit = m[2];
  if (unit === "k") amount = (amount * 1000n) as typeof amount;
  else if (unit && /^(l|lakhs?)$/.test(unit)) amount = (amount * 100000n) as typeof amount;
  else if (unit && /^(cr|crores?)$/.test(unit)) amount = (amount * 10000000n) as typeof amount;
  if (amount <= 0n) return null;
  let direction: "in" | "out";
  if (/\b(received|got|credited|earned|collected)\b/.test(low)) direction = "in";
  else if (/\b(paid|spent|bought|gave|sent|transferred|debited)\b/.test(low)) direction = "out";
  else return null;
  let instrument = "BANK";
  for (const [w, acc] of Object.entries(INSTR).sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(`\\b(in|by|via|using|from|through|with)\\s+${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(low)) { instrument = acc; break; }
  }
  const stop = String.raw`(?=\s+(?:in|by|via|using|for|on|through|yesterday|today)\b|[.,]|$)`;
  const cp = new RegExp(String.raw`\b(?:to|from)\s+(?:the\s+)?([a-z][a-z0-9 .&'-]{1,40}?)` + stop).exec(low);
  const purpose = new RegExp(String.raw`\b(?:on|for)\s+([a-z][a-z0-9 .&'-]{1,40}?)` + stop.replace("for|on|", "")).exec(low);
  let date = on;
  if (/\byesterday\b/.test(low)) { const d = new Date(on + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); date = d.toISOString().slice(0, 10); }
  let hint = cp?.[1]?.trim();
  if (hint && INSTR[hint]) hint = undefined;
  return { txnDate: date, amount: amount.toString(), direction, narration: text.trim(), instrument,
    counterpartyHint: hint, purposeHint: purpose?.[1]?.trim() };
}
