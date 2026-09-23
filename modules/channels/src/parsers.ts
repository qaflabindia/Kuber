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

export function parseBankCsv(text: string, instrument = "BANK"): RawTxn[] {
  const rows = readCsv(text.trim());
  if (rows.length < 1) throw new Error("CSV has no header row");
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col: Record<string, number> = {};
  for (const [k, names] of Object.entries(COLS)) { const i = header.findIndex((h) => names.includes(h)); if (i >= 0) col[k] = i; }
  if (col.date === undefined || col.narration === undefined) throw new Error(`CSV needs a date and a narration column; found ${rows[0]!.join(", ")}`);
  if (col.debit === undefined && col.credit === undefined && col.amount === undefined) throw new Error("CSV needs debit/credit columns or an amount column");
  const out: RawTxn[] = [];
  for (const r of rows.slice(1)) {
    const get = (k: string) => (col[k] !== undefined ? (r[col[k]!] ?? "").trim() : "");
    let dr = get("debit"), cr = get("credit");
    if (col.amount !== undefined && !dr && !cr) {
      const amt = get("amount"), typ = get("type").toLowerCase();
      const v = parseAmount(amt);
      if (typ.startsWith("cr") || (!typ && v > 0n)) cr = amt.replace(/^-/, ""); else dr = amt.replace(/^-/, "");
    }
    let direction: "in" | "out", amount: bigint;
    if (dr && parseAmount(dr) !== 0n) { direction = "out"; amount = parseAmount(dr); }
    else if (cr && parseAmount(cr) !== 0n) { direction = "in"; amount = parseAmount(cr); }
    else continue;
    if (amount < 0n) amount = -amount;
    const narration = get("narration");
    out.push({
      txnDate: parseDate(get("date")), amount: amount.toString(), direction, narration, instrument,
      reference: get("ref") || utr(narration) || undefined, counterpartyHint: vpa(narration) ?? upiName(narration) ?? undefined,
    });
  }
  return out;
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
