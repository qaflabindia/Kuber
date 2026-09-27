/**
 * Source adapters (FIN-MIG-01, design 16.7 "file import"). Each turns one untrusted export file into
 * the common Extract (types.ts). They are pure and deterministic, parse defensively (size and row
 * limits, strict amounts and dates, no entity expansion in XML) and never guess: a value they cannot
 * read is a problem listed with its row, not a default.
 *
 *   Tally XML   ledger masters (groups, ledgers with opening balances, party GSTIN/PAN, bank
 *               payment details, opening bill allocations), vouchers (day book: ledger entries,
 *               accounting allocations of item invoices, bill allocations), stock item masters and
 *               the Trial Balance report (DSPACCNAME / DSPACCINFO). Tally's sign convention is
 *               negative = debit; Kuber's is debit positive.
 *   Zoho Books  CSV exports recognised by their header: Chart of Accounts, Contacts, Trial Balance,
 *               Invoices, Bills.
 *   Generic CSV one file with a `record` column (account, party, balance, open_item, voucher, tb,
 *               tax, stock, assets, commitments); see CSV_TEMPLATE_HEADER.
 */
import { createHash } from "node:crypto";
import { BankDetails, isIsoDate } from "@kuber/contracts";
import { readCsv } from "@kuber/channels";
import { XmlError, childText, findAll, kids, parseXml, type XmlElement } from "./xml.ts";
import { emptyExtract, MigrationError, type Extract, type Nature, type PartyRole, type SourceSystem, type SrcAccount, type SrcParty, type SrcVoucher, type SrcVoucherLine } from "./types.ts";

/** Largest source file accepted (decoded characters). */
export const MAX_FILE_CHARS = 8 * 1024 * 1024;
/** Most records of one kind in one file. */
export const MAX_RECORDS = 50_000;

export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/**
 * Bytes of an upload as text: UTF-8, or UTF-16 LE/BE when the file starts with its byte-order mark
 * (Tally writes UTF-16 by default). Refuses NUL-riddled text that is not UTF-16.
 */
export function decodeUpload(content: string, encoding: "utf8" | "base64" = "utf8"): { text: string; bytes: Buffer } {
  if (encoding === "utf8") return { text: content.replace(/^﻿/, ""), bytes: Buffer.from(content, "utf8") };
  if (!/^[A-Za-z0-9+/=\s]*$/.test(content)) throw new MigrationError("bad_file", "the file is not valid base64", 400);
  const bytes = Buffer.from(content, "base64");
  if (bytes.length > MAX_FILE_CHARS * 2) throw new MigrationError("file_too_large", `the file is larger than ${MAX_FILE_CHARS * 2} bytes`, 413);
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString("utf16le");
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { const sw = Buffer.from(bytes.subarray(2)); sw.swap16(); text = sw.toString("utf16le"); }
  else text = bytes.toString("utf8").replace(/^﻿/, "");
  if (text.includes("\u0000")) throw new MigrationError("bad_file", "the file contains NUL characters: not a text export", 400);
  return { text, bytes };
}

// ------------------------------------------------------------------ strict values
/** An amount as paise (debit positive as written): digits, optional thousands commas, at most two decimals. No rounding. */
export function strictPaise(text: string): bigint {
  let t = text.replace(/[,\s₹]/g, "").replace(/^(?:INR|Rs\.?)/i, "");
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1); } else if (t.startsWith("+")) t = t.slice(1);
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) throw new Error(`not an amount in rupees with at most two decimals: ${JSON.stringify(text.slice(0, 40))}`);
  const p = BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  return neg ? -p : p;
}
const optPaise = (text: string) => (text.trim() === "" ? 0n : strictPaise(text));
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A date as YYYY-MM-DD from YYYYMMDD (Tally), YYYY-MM-DD, DD/MM/YYYY or D-Mon-YYYY; impossible dates refused. */
export function strictDate(text: string): string {
  const t = text.trim();
  let d = "";
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) d = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) d = t;
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t))) d = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  else if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})$/.exec(t))) {
    const mi = MONTHS.indexOf(m[2]!.toLowerCase());
    if (mi >= 0) d = `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  if (!d || !isIsoDate(d)) throw new Error(`not a real date: ${JSON.stringify(t.slice(0, 40))}`);
  return d;
}
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const clean = (s: string, max = 200) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function bankOf(accountNumber: string, ifsc: string, holder: string): { bank?: BankDetails; problem?: string } {
  if (!accountNumber.trim() && !ifsc.trim()) return {};
  const r = BankDetails.safeParse({ accountNumber: accountNumber.replace(/\s/g, ""), ifsc: ifsc.trim().toUpperCase(), holderName: clean(holder) || "unknown" });
  return r.success ? { bank: r.data } : { problem: `bank details not usable (${r.error.issues.map((i) => i.message).join("; ")})` };
}
const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/, PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// ------------------------------------------------------------------ Tally
/** Tally's reserved groups and their nature (primary groups and the reserved sub-groups). */
const TALLY_GROUPS: Record<string, { nature: Nature; parent?: string }> = {
  "Capital Account": { nature: "equity" }, "Reserves & Surplus": { nature: "equity", parent: "Capital Account" },
  "Loans (Liability)": { nature: "liability" }, "Secured Loans": { nature: "liability", parent: "Loans (Liability)" },
  "Unsecured Loans": { nature: "liability", parent: "Loans (Liability)" }, "Bank OD A/c": { nature: "liability", parent: "Loans (Liability)" },
  "Current Liabilities": { nature: "liability" }, "Duties & Taxes": { nature: "liability", parent: "Current Liabilities" },
  "Provisions": { nature: "liability", parent: "Current Liabilities" }, "Sundry Creditors": { nature: "liability", parent: "Current Liabilities" },
  "Fixed Assets": { nature: "asset" }, "Investments": { nature: "asset" }, "Current Assets": { nature: "asset" },
  "Bank Accounts": { nature: "asset", parent: "Current Assets" }, "Cash-in-Hand": { nature: "asset", parent: "Current Assets" },
  "Deposits (Asset)": { nature: "asset", parent: "Current Assets" }, "Loans & Advances (Asset)": { nature: "asset", parent: "Current Assets" },
  "Stock-in-Hand": { nature: "asset", parent: "Current Assets" }, "Sundry Debtors": { nature: "asset", parent: "Current Assets" },
  "Misc. Expenses (ASSET)": { nature: "asset" }, "Suspense A/c": { nature: "liability" }, "Branch / Divisions": { nature: "liability" },
  "Sales Accounts": { nature: "income" }, "Direct Incomes": { nature: "income" }, "Indirect Incomes": { nature: "income" },
  "Purchase Accounts": { nature: "expense" }, "Direct Expenses": { nature: "expense" }, "Indirect Expenses": { nature: "expense" },
};
const VOUCHER_EXTERNAL: Record<string, SrcVoucher["external"]> = { sales: "invoice", purchase: "bill", payment: "payment", receipt: "receipt" };
const nameOf = (e: XmlElement) => clean(e.attrs.NAME ?? childText(e, "NAME"));
/** Tally writes "&#4; Primary" (or nothing) for a primary group's parent. */
const parentOf = (e: XmlElement) => { const p = clean(childText(e, "PARENT")); return !p || /^primary$/i.test(p) ? null : p; };
/** Tally amounts are negative for debit: Kuber's debit-positive paise. */
const tallyAmount = (text: string) => -strictPaise(text);

export interface ParseOptions { fileHash: string; purpose: "source" | "delta" | "comparison"; asOf: string | null }

export function parseTally(text: string, o: ParseOptions): Extract {
  if (text.length > MAX_FILE_CHARS) throw new MigrationError("file_too_large", `the file is larger than ${MAX_FILE_CHARS} characters`, 413);
  let root: XmlElement;
  try { root = parseXml(text); } catch (e) { throw new MigrationError("bad_xml", e instanceof XmlError ? `not a readable Tally XML export: ${e.message}` : String(e), 400); }
  const x = emptyExtract("tally");
  const problem = (kind: string, row: number, m: string) => { if (x.problems.length < 500) x.problems.push(`${kind} ${row}: ${m}`); };
  const limit = <T>(xs: T[], what: string) => { if (xs.length > MAX_RECORDS) throw new MigrationError("too_many_records", `more than ${MAX_RECORDS} ${what} in one file`, 413); return xs; };

  // Groups: the file's own, over Tally's reserved ones.
  const groupParent = new Map<string, string | null>();
  for (const [n, g] of Object.entries(TALLY_GROUPS)) groupParent.set(n, g.parent ?? null);
  limit(findAll(root, "GROUP"), "groups").forEach((g, i) => {
    const name = nameOf(g);
    if (!name) return problem("group", i + 1, "no name");
    groupParent.set(name, parentOf(g));
    x.groups.push({ file: o.fileHash, row: i + 1, name, parent: parentOf(g) });
  });
  /** The chain of groups from `g` up to its primary group (cycle-safe). */
  const chain = (g: string | null) => { const out: string[] = []; let cur = g; while (cur && !out.includes(cur) && out.length < 32) { out.push(cur); cur = groupParent.get(cur) ?? null; } return out; };
  const natureOf = (g: string | null): Nature | null => { for (const c of chain(g)) { const t = TALLY_GROUPS[c]; if (t) return t.nature; } return null; };
  const partyOf = (g: string | null): PartyRole | null => { const c = chain(g); return c.includes("Sundry Debtors") ? "customer" : c.includes("Sundry Creditors") ? "vendor" : null; };

  // Ledgers.
  const ledgers = limit(findAll(root, "LEDGER"), "ledgers");
  ledgers.forEach((l, i) => {
    const row = i + 1, name = nameOf(l);
    if (!name) return problem("ledger", row, "no name");
    const group = parentOf(l);
    const party = partyOf(group);
    const acc: SrcAccount = { file: o.fileHash, row, key: name, name, group, nature: natureOf(group), party, bank: chain(group).includes("Bank Accounts") || chain(group).includes("Bank OD A/c") };
    if (!acc.nature) problem("ledger", row, `group ${JSON.stringify(group)} is not a known Tally group: the ledger's nature must be mapped by a person`);
    x.accounts.push(acc);
    const ob = childText(l, "OPENINGBALANCE");
    if (ob) {
      try { const v = tallyAmount(ob); if (v !== 0n) x.openingBalances.push({ file: o.fileHash, row, accountKey: name, amount: v.toString() }); }
      catch (e) { problem("ledger", row, `opening balance: ${(e as Error).message}`); }
    }
    const credit = /^(\d{1,4})\s*days?$/i.exec(childText(l, "BILLCREDITPERIOD"));
    if (party) {
      const gstin = childText(l, "PARTYGSTIN").toUpperCase(), pan = childText(l, "INCOMETAXNUMBER").toUpperCase();
      const pd = kids(l, "PAYMENTDETAILS.LIST")[0];
      const b = pd ? bankOf(childText(pd, "ACCOUNTNUMBER"), childText(pd, "IFSCODE"), childText(pd, "PAYMENTFAVOURING") || name) : {};
      if (b.problem) problem("ledger", row, b.problem);
      if (gstin && !GSTIN.test(gstin)) problem("ledger", row, "GSTIN is not valid: left out");
      const p: SrcParty = { file: o.fileHash, row, key: name, name, kind: party, ledgerKey: name,
        ...(gstin && GSTIN.test(gstin) ? { gstin } : {}), ...(pan && PAN.test(pan) ? { pan } : {}), ...(credit ? { creditDays: Number(credit[1]) } : {}), ...(b.bank ? { bank: b.bank } : {}) };
      x.parties.push(p);
      // Opening bills (bill-wise details at the start of the books).
      kids(l, "BILLALLOCATIONS.LIST").forEach((ba, j) => {
        try {
          const docNo = clean(childText(ba, "NAME"), 100), amount = tallyAmount(childText(ba, "OPENINGBALANCE") || childText(ba, "AMOUNT"));
          if (!docNo || amount === 0n) return;
          const docDate = strictDate(childText(ba, "BILLDATE"));
          const bcp = /^(\d{1,4})\s*days?$/i.exec(childText(ba, "BILLCREDITPERIOD"));
          const days = bcp ? Number(bcp[1]) : credit ? Number(credit[1]) : null;
          x.openItems.push({ file: o.fileHash, row, key: `${name}|${docNo}`, partyKey: name, docNo, docDate, dueDate: days !== null ? addDays(docDate, days) : null,
            amount: amount.toString(), kind: party === "customer" ? "receivable" : "payable" });
        } catch (e) { problem("ledger", row, `bill ${j + 1}: ${(e as Error).message}`); }
      });
    }
    if (chain(group).includes("Duties & Taxes")) x.schedules.push({ file: o.fileHash, row, kind: "tax", key: name, name, accountKey: name, quantity: null, value: null });
  });

  // Vouchers (day book).
  limit(findAll(root, "VOUCHER"), "vouchers").forEach((v, i) => {
    const row = i + 1;
    try {
      const type = clean(childText(v, "VOUCHERTYPENAME") || v.attrs.VCHTYPE || "Journal", 60);
      const guid = clean(childText(v, "GUID"), 120);
      const number = clean(childText(v, "VOUCHERNUMBER"), 60);
      const date = strictDate(childText(v, "DATE"));
      const entries = [...kids(v, "ALLLEDGERENTRIES.LIST"), ...kids(v, "LEDGERENTRIES.LIST"),
        ...kids(v, "ALLINVENTORYENTRIES.LIST").flatMap((ie) => kids(ie, "ACCOUNTINGALLOCATIONS.LIST"))];
      const lines: SrcVoucherLine[] = entries.map((e) => {
        const ledger = clean(childText(e, "LEDGERNAME"));
        if (!ledger) throw new Error("a ledger entry has no ledger name");
        const bills = kids(e, "BILLALLOCATIONS.LIST").map((b) => ({ name: clean(childText(b, "NAME"), 100), type: clean(childText(b, "BILLTYPE"), 30), amount: tallyAmount(childText(b, "AMOUNT")).toString() }))
          .filter((b) => b.name && b.amount !== "0");
        return { accountKey: ledger, amount: tallyAmount(childText(e, "AMOUNT")).toString(), ...(bills.length ? { bills } : {}) };
      }).filter((l) => l.amount !== "0");
      const key = guid || `${type}|${number}|${date}`;
      if (!guid) problem("voucher", row, "no GUID: keyed by type, number and date");
      x.vouchers.push({ file: o.fileHash, row, key, number, type, date, narration: clean(childText(v, "NARRATION"), 500), lines,
        cancelled: /^yes$/i.test(childText(v, "ISCANCELLED")) || /^yes$/i.test(childText(v, "ISDELETED")), external: VOUCHER_EXTERNAL[type.toLowerCase()] ?? null });
    } catch (e) { problem("voucher", row, (e as Error).message); }
  });

  // Stock item masters: quantity and value at the start of the books.
  const stockLedgers = x.accounts.filter((a) => chain(a.group).includes("Stock-in-Hand"));
  limit(findAll(root, "STOCKITEM"), "stock items").forEach((s, i) => {
    const row = i + 1, name = nameOf(s);
    try {
      const val = childText(s, "OPENINGVALUE");
      x.schedules.push({ file: o.fileHash, row, kind: "stock", key: name, name, accountKey: stockLedgers.length === 1 ? stockLedgers[0]!.key : null,
        quantity: clean(childText(s, "OPENINGBALANCE"), 60) || null, value: val ? tallyAmount(val).toString() : null });
    } catch (e) { problem("stock item", row, (e as Error).message); }
  });

  // Trial Balance report: DSPACCNAME followed by its DSPACCINFO, closing Dr (negative) and Cr (positive).
  const names = findAll(root, "DSPACCNAME");
  if (names.length) {
    const tb = { file: o.fileHash, asOf: o.asOf, rows: [] as { file: string; row: number; accountKey: string; amount: string }[] };
    const parentKids = (el: XmlElement): XmlElement[] => { const stack = [root]; while (stack.length) { const c = stack.pop()!; if (c.children.includes(el)) return c.children; stack.push(...c.children); } return []; };
    names.forEach((n, i) => {
      const row = i + 1;
      const siblings = parentKids(n), at = siblings.indexOf(n), info = siblings[at + 1];
      const name = clean(childText(n, "DSPDISPNAME"));
      if (!info || info.name !== "DSPACCINFO" || !name) return problem("trial balance row", row, "no account info after the account name");
      try {
        const dr = optPaise(childText(kids(info, "DSPCLDRAMT")[0] ?? info, "DSPCLDRAMTA")), cr = optPaise(childText(kids(info, "DSPCLCRAMT")[0] ?? info, "DSPCLCRAMTA"));
        const amount = -(dr + cr);
        tb.rows.push({ file: o.fileHash, row, accountKey: name, amount: amount.toString() });
      } catch (e) { problem("trial balance row", row, (e as Error).message); }
    });
    x.trialBalances.push(tb);
  }
  return x;
}

// ------------------------------------------------------------------ CSV helpers
function csvTable(text: string) {
  if (text.length > MAX_FILE_CHARS) throw new MigrationError("file_too_large", `the file is larger than ${MAX_FILE_CHARS} characters`, 413);
  const rows = readCsv(text.trim());
  if (!rows.length) throw new MigrationError("bad_csv", "the CSV file is empty", 400);
  if (rows.length - 1 > MAX_RECORDS) throw new MigrationError("too_many_records", `more than ${MAX_RECORDS} rows in one file`, 413);
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));
  const idx = (...names: string[]) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const data = rows.slice(1).map((r, i) => ({ row: i + 1, get: (i2: number) => (i2 >= 0 ? (r[i2] ?? "").trim() : "") }));
  return { header, idx, data };
}

// ------------------------------------------------------------------ Zoho Books
const ZOHO_TYPES: Record<string, { nature: Nature; bank?: boolean; control?: "receivable" | "payable" }> = {
  bank: { nature: "asset", bank: true }, cash: { nature: "asset" }, "accounts receivable": { nature: "asset", control: "receivable" },
  "other current asset": { nature: "asset" }, "fixed asset": { nature: "asset" }, "other asset": { nature: "asset" }, stock: { nature: "asset" }, "input tax": { nature: "asset" },
  "accounts payable": { nature: "liability", control: "payable" }, "other current liability": { nature: "liability" }, "long term liability": { nature: "liability" },
  "other liability": { nature: "liability" }, "credit card": { nature: "liability" }, "output tax": { nature: "liability" },
  equity: { nature: "equity" }, income: { nature: "income" }, "other income": { nature: "income" },
  expense: { nature: "expense" }, "cost of goods sold": { nature: "expense" }, "other expense": { nature: "expense" },
};
/** Which Zoho export a CSV is, from its header. */
export function zohoKind(header: string[]): "accounts" | "contacts" | "trial_balance" | "invoices" | "bills" | null {
  const has = (h: string) => header.includes(h);
  if (has("invoice number") && has("invoice date")) return "invoices";
  if (has("bill number") && has("bill date")) return "bills";
  if (has("account name") && has("debit") && has("credit")) return "trial_balance";
  if (has("account name") && has("account type")) return "accounts";
  if ((has("contact name") || has("display name")) && has("contact type")) return "contacts";
  return null;
}

export function parseZoho(text: string, o: ParseOptions): Extract {
  const { header, idx, data } = csvTable(text);
  const kind = zohoKind(header);
  if (!kind) throw new MigrationError("unknown_export", "not a recognised Zoho Books export (Chart of Accounts, Contacts, Trial Balance, Invoices or Bills)", 400);
  const x = emptyExtract("zoho");
  const problem = (row: number, m: string) => { if (x.problems.length < 500) x.problems.push(`${kind} row ${row}: ${m}`); };
  if (kind === "accounts") {
    const cName = idx("account name"), cType = idx("account type"), cCode = idx("account code"), cParent = idx("parent account"), cStatus = idx("status");
    for (const r of data) {
      const name = clean(r.get(cName));
      if (!name) { problem(r.row, "no account name"); continue; }
      if (/^inactive$/i.test(r.get(cStatus))) continue;
      const t = ZOHO_TYPES[r.get(cType).toLowerCase()];
      if (!t) problem(r.row, `account type ${JSON.stringify(r.get(cType))} is not known: its nature must be mapped by a person`);
      x.accounts.push({ file: o.fileHash, row: r.row, key: name, name, group: clean(r.get(cParent)) || clean(r.get(cType)) || null, ...(r.get(cCode) ? { code: r.get(cCode) } : {}),
        nature: t?.nature ?? null, party: null, bank: !!t?.bank, ...(t?.control ? { control: t.control } : {}) });
    }
  } else if (kind === "contacts") {
    const cId = idx("contact id"), cName = idx("contact name", "display name"), cType = idx("contact type"), cGst = idx("gst identification number (gstin)", "gstin"),
      cPan = idx("pan number", "pan"), cTerms = idx("payment terms"), cAcc = idx("account number", "bank account number"), cIfsc = idx("ifsc", "ifsc code"), cHolder = idx("beneficiary name");
    for (const r of data) {
      const name = clean(r.get(cName)), t = r.get(cType).toLowerCase();
      if (!name) { problem(r.row, "no contact name"); continue; }
      const k = t === "customer" ? "customer" : t === "vendor" ? "vendor" : null;
      if (!k) { problem(r.row, `contact type ${JSON.stringify(r.get(cType))} is neither customer nor vendor`); continue; }
      const gstin = r.get(cGst).toUpperCase(), pan = r.get(cPan).toUpperCase(), terms = /^(\d{1,4})/.exec(r.get(cTerms).replace(/^net\s*/i, ""));
      const b = bankOf(r.get(cAcc), r.get(cIfsc), r.get(cHolder) || name);
      if (b.problem) problem(r.row, b.problem);
      if (gstin && !GSTIN.test(gstin)) problem(r.row, "GSTIN is not valid: left out");
      x.parties.push({ file: o.fileHash, row: r.row, key: clean(r.get(cId)) || name, name, kind: k, ledgerKey: null,
        ...(gstin && GSTIN.test(gstin) ? { gstin } : {}), ...(pan && PAN.test(pan) ? { pan } : {}), ...(terms ? { creditDays: Number(terms[1]) } : {}), ...(b.bank ? { bank: b.bank } : {}) });
    }
  } else if (kind === "trial_balance") {
    const cName = idx("account name"), cDr = idx("debit"), cCr = idx("credit");
    const rows: { file: string; row: number; accountKey: string; amount: string }[] = [];
    for (const r of data) {
      const name = clean(r.get(cName));
      if (!name || /^total/i.test(name)) continue;
      try {
        const v = optPaise(r.get(cDr)) - optPaise(r.get(cCr));
        rows.push({ file: o.fileHash, row: r.row, accountKey: name, amount: v.toString() });
      } catch (e) { problem(r.row, (e as Error).message); }
    }
    if (o.purpose === "comparison") x.trialBalances.push({ file: o.fileHash, asOf: o.asOf, rows });
    else { x.openingBalances.push(...rows.filter((r) => r.amount !== "0")); x.trialBalances.push({ file: o.fileHash, asOf: o.asOf, rows }); }
  } else {
    // Invoices (receivables) and bills (payables): open items at the cut-off, and vouchers.
    const inv = kind === "invoices";
    const cId = idx(inv ? "invoice id" : "bill id"), cNo = idx(inv ? "invoice number" : "bill number"), cDate = idx(inv ? "invoice date" : "bill date"), cDue = idx("due date"),
      cParty = idx(inv ? "customer id" : "vendor id"), cPartyName = idx(inv ? "customer name" : "vendor name"), cAcc = idx("account"), cSub = idx("subtotal", "sub total"),
      cTax = idx("tax", "tax total"), cTaxAcc = idx("tax account"), cTotal = idx("total"), cBal = idx("balance"), cStatus = idx("status"), cCtl = idx(inv ? "receivable account" : "payable account");
    for (const r of data) {
      try {
        const status = r.get(cStatus).toLowerCase();
        if (status === "void" || status === "draft") continue;
        const docNo = clean(r.get(cNo), 100), date = strictDate(r.get(cDate)), partyKey = clean(r.get(cParty)) || clean(r.get(cPartyName));
        if (!docNo || !partyKey) { problem(r.row, "no document number or party"); continue; }
        const total = strictPaise(r.get(cTotal)), sub = cSub >= 0 && r.get(cSub) ? strictPaise(r.get(cSub)) : total, tax = cTax >= 0 && r.get(cTax) ? strictPaise(r.get(cTax)) : 0n;
        if (sub + tax !== total) { problem(r.row, `subtotal ${sub} plus tax ${tax} is not the total ${total} (paise)`); continue; }
        const sign = inv ? 1n : -1n;
        const control = clean(r.get(cCtl)) || (inv ? "Accounts Receivable" : "Accounts Payable");
        const lines: SrcVoucherLine[] = [{ accountKey: control, partyKey, amount: (sign * total).toString() }, { accountKey: clean(r.get(cAcc)) || (inv ? "Sales" : "Cost of Goods Sold"), amount: (-sign * sub).toString() }];
        if (tax !== 0n) lines.push({ accountKey: clean(r.get(cTaxAcc)) || (inv ? "Output GST" : "Input GST"), amount: (-sign * tax).toString() });
        x.vouchers.push({ file: o.fileHash, row: r.row, key: `${inv ? "invoice" : "bill"}:${clean(r.get(cId)) || docNo}`, number: docNo, type: inv ? "Sales Invoice" : "Bill", date,
          narration: `${inv ? "Invoice" : "Bill"} ${docNo}`, lines: lines.filter((l) => l.amount !== "0"), cancelled: false, external: inv ? "invoice" : "bill" });
        const bal = cBal >= 0 && r.get(cBal) ? strictPaise(r.get(cBal)) : 0n;
        if (o.purpose === "source" && bal !== 0n) {
          x.openItems.push({ file: o.fileHash, row: r.row, key: `${inv ? "invoice" : "bill"}:${clean(r.get(cId)) || docNo}`, partyKey, docNo, docDate: date,
            dueDate: r.get(cDue) ? strictDate(r.get(cDue)) : null, amount: (sign * bal).toString(), kind: inv ? "receivable" : "payable" });
        }
      } catch (e) { problem(r.row, (e as Error).message); }
    }
  }
  return x;
}

// ------------------------------------------------------------------ generic CSV template
export const CSV_TEMPLATE_HEADER = ["record", "key", "name", "group", "nature", "control", "bank", "party_kind", "gstin", "pan", "credit_days", "ifsc", "account_number",
  "holder", "account", "party", "doc_no", "doc_date", "due_date", "voucher_type", "narration", "debit", "credit", "quantity", "value"] as const;
const NATURES = ["asset", "liability", "equity", "income", "expense"];

export function parseGenericCsv(text: string, o: ParseOptions): Extract {
  const { header, idx, data } = csvTable(text);
  if (!header.includes("record")) throw new MigrationError("bad_csv", `the generic template needs a "record" column: ${CSV_TEMPLATE_HEADER.join(",")}`, 400);
  const x = emptyExtract("csv");
  const c = Object.fromEntries(CSV_TEMPLATE_HEADER.map((h) => [h, idx(h)])) as Record<(typeof CSV_TEMPLATE_HEADER)[number], number>;
  const problem = (row: number, m: string) => { if (x.problems.length < 500) x.problems.push(`row ${row}: ${m}`); };
  const vouchers = new Map<string, SrcVoucher>();
  const tb = { file: o.fileHash, asOf: o.asOf, rows: [] as { file: string; row: number; accountKey: string; amount: string }[] };
  for (const r of data) {
    const rec = r.get(c.record).toLowerCase(), key = clean(r.get(c.key)), name = clean(r.get(c.name));
    const amt = () => optPaise(r.get(c.debit)) - optPaise(r.get(c.credit));
    try {
      switch (rec) {
        case "account": {
          const nature = r.get(c.nature).toLowerCase();
          const ctl = r.get(c.control).toLowerCase();
          x.accounts.push({ file: o.fileHash, row: r.row, key: key || name, name: name || key, group: clean(r.get(c.group)) || null,
            nature: NATURES.includes(nature) ? (nature as Nature) : null, party: null, bank: /^(y|yes|true|1)$/i.test(r.get(c.bank)),
            ...(ctl === "receivable" || ctl === "payable" ? { control: ctl as "receivable" | "payable" } : {}) });
          if (!NATURES.includes(nature)) problem(r.row, `nature ${JSON.stringify(nature)} is not one of ${NATURES.join(", ")}`);
          break;
        }
        case "party": {
          const k = r.get(c.party_kind).toLowerCase();
          if (k !== "customer" && k !== "vendor" && k !== "both") { problem(r.row, "party_kind must be customer, vendor or both"); break; }
          const b = bankOf(r.get(c.account_number), r.get(c.ifsc), r.get(c.holder) || name);
          if (b.problem) problem(r.row, b.problem);
          const gstin = r.get(c.gstin).toUpperCase(), pan = r.get(c.pan).toUpperCase(), cd = r.get(c.credit_days);
          x.parties.push({ file: o.fileHash, row: r.row, key: key || name, name: name || key, kind: k, ledgerKey: clean(r.get(c.account)) || null,
            ...(GSTIN.test(gstin) ? { gstin } : {}), ...(PAN.test(pan) ? { pan } : {}), ...(/^\d{1,4}$/.test(cd) ? { creditDays: Number(cd) } : {}), ...(b.bank ? { bank: b.bank } : {}) });
          break;
        }
        case "balance": { const v = amt(); if (v !== 0n) x.openingBalances.push({ file: o.fileHash, row: r.row, accountKey: clean(r.get(c.account)), amount: v.toString() }); break; }
        case "tb": tb.rows.push({ file: o.fileHash, row: r.row, accountKey: clean(r.get(c.account)), amount: amt().toString() }); break;
        case "open_item": {
          const v = amt(), docDate = strictDate(r.get(c.doc_date));
          x.openItems.push({ file: o.fileHash, row: r.row, key: key || `${r.get(c.party)}|${r.get(c.doc_no)}`, partyKey: clean(r.get(c.party)), docNo: clean(r.get(c.doc_no), 100),
            docDate, dueDate: r.get(c.due_date) ? strictDate(r.get(c.due_date)) : null, amount: v.toString(), kind: v >= 0n ? "receivable" : "payable" });
          break;
        }
        case "voucher": {
          if (!key) { problem(r.row, "a voucher line needs the voucher key"); break; }
          const date = strictDate(r.get(c.doc_date)), type = clean(r.get(c.voucher_type), 60) || "Journal";
          const v = vouchers.get(key) ?? { file: o.fileHash, row: r.row, key, number: clean(r.get(c.doc_no), 60), type, date, narration: clean(r.get(c.narration), 500), lines: [],
            cancelled: false, external: VOUCHER_EXTERNAL[type.toLowerCase()] ?? null };
          if (v.date !== date) { problem(r.row, `voucher ${key} has lines on two dates`); break; }
          const party = clean(r.get(c.party));
          v.lines.push({ accountKey: clean(r.get(c.account)), ...(party ? { partyKey: party } : {}), amount: amt().toString() });
          vouchers.set(key, v);
          break;
        }
        case "tax": case "stock": case "assets": case "commitments": {
          const value = r.get(c.value) ? strictPaise(r.get(c.value)) : r.get(c.debit) || r.get(c.credit) ? amt() : null;
          x.schedules.push({ file: o.fileHash, row: r.row, kind: rec, key: key || name, name: name || key, accountKey: clean(r.get(c.account)) || null,
            quantity: clean(r.get(c.quantity), 60) || null, value: value === null ? null : value.toString() });
          break;
        }
        default: problem(r.row, `unknown record type ${JSON.stringify(rec)}`);
      }
    } catch (e) { problem(r.row, (e as Error).message); }
  }
  x.vouchers.push(...vouchers.values());
  if (tb.rows.length) x.trialBalances.push(tb);
  return x;
}

/** Parse one file with the adapter of the project's source system. */
export function parseSource(system: SourceSystem, text: string, o: ParseOptions): Extract {
  return system === "tally" ? parseTally(text, o) : system === "zoho" ? parseZoho(text, o) : parseGenericCsv(text, o);
}

/** Kinds of records a file contributed (for the inventory and the file list). */
export function kindsOf(x: Extract): Record<string, number> {
  const counts: Record<string, number> = { groups: x.groups.length, accounts: x.accounts.length, parties: x.parties.length, balances: x.openingBalances.length,
    open_items: x.openItems.length, vouchers: x.vouchers.length, trial_balance_rows: x.trialBalances.reduce((n, t) => n + t.rows.length, 0) };
  for (const s of x.schedules) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

/**
 * Merge the files of a project into one extract, oldest first. A later file's record with the same
 * key replaces an earlier one (a corrected re-export); for a voucher already imported, the delta
 * import then reports the change as a difference to resolve and never overwrites the journal.
 */
export function mergeExtracts(system: SourceSystem, parts: Extract[]): Extract {
  const x = emptyExtract(system);
  const byKey = <T>(get: (e: Extract) => T[], key: (t: T) => string, keepFirst = false) => {
    const m = new Map<string, T>();
    for (const p of parts) for (const t of get(p)) if (!keepFirst || !m.has(key(t))) m.set(key(t), t);
    return [...m.values()];
  };
  x.files = parts.flatMap((p) => p.files);
  x.groups = byKey((e) => e.groups, (g) => g.name);
  x.accounts = byKey((e) => e.accounts, (a) => a.key);
  x.parties = byKey((e) => e.parties, (p) => p.key);
  x.openingBalances = byKey((e) => e.openingBalances, (b) => b.accountKey);
  x.openItems = byKey((e) => e.openItems, (i) => i.key);
  x.vouchers = byKey((e) => e.vouchers, (v) => v.key);
  x.trialBalances = parts.flatMap((p) => p.trialBalances);
  x.schedules = byKey((e) => e.schedules, (s) => `${s.kind}|${s.key}`);
  x.problems = parts.flatMap((p) => p.problems);
  // Accounts named only by balances or vouchers (a Zoho TB without the chart) are known by name.
  const known = new Set(x.accounts.map((a) => a.key));
  const implied = (key: string, file: string, row: number) => { if (key && !known.has(key)) { known.add(key); x.accounts.push({ file, row, key, name: key, group: null, nature: null, party: null, bank: false }); } };
  for (const b of x.openingBalances) implied(b.accountKey, b.file, b.row);
  for (const v of x.vouchers) for (const l of v.lines) implied(l.accountKey, v.file, v.row);
  return x;
}
