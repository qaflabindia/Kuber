/**
 * The common shape every source adapter produces (Tally XML, Zoho Books CSV, the generic CSV
 * template). Amounts are paise as decimal strings, debit positive; dates are real calendar dates.
 * Every record carries its provenance: the SHA-256 of the file it came from and its row (a CSV
 * data row, or the ordinal of the XML element of that kind in the file).
 */
import type { BankDetails } from "@kuber/contracts";

export type SourceSystem = "tally" | "zoho" | "csv";
export type Nature = "asset" | "liability" | "equity" | "income" | "expense";
export type PartyRole = "customer" | "vendor";
/** Inventory categories (FIN-MIG-01): what a project may take in scope. */
export const INVENTORY = ["masters", "opening_balances", "open_items", "tax", "stock", "assets", "commitments", "history"] as const;
export type InventoryCategory = (typeof INVENTORY)[number];

export interface Prov { file: string; row: number }

/** A ledger / account of the source chart (a Tally ledger or group-level ledger, a Zoho account). */
export interface SrcAccount extends Prov {
  key: string; name: string; group: string | null; code?: string;
  /** Nature from the source's group or type, when it can be told. */
  nature: Nature | null;
  /** A party ledger (Tally Sundry Debtors / Creditors): its lines go to a control account with the party. */
  party: PartyRole | null;
  /** A bank ledger (Tally Bank Accounts, Zoho type Bank): bank coverage is checked for it. */
  bank: boolean;
  /** The source's receivable or payable control account (Zoho Accounts Receivable/Payable): split by party through open items. */
  control?: "receivable" | "payable";
}
export interface SrcGroup extends Prov { name: string; parent: string | null }
export interface SrcParty extends Prov {
  key: string; name: string; kind: PartyRole | "both";
  /** The source ledger of this party (Tally), or the source's receivable/payable account (Zoho). */
  ledgerKey: string | null;
  gstin?: string; pan?: string; creditDays?: number;
  /** Beneficiary bank details: sealed at rest, and registered only through the party master's maker-checker. */
  bank?: BankDetails;
}
/** The source balance of one ledger at the cut-off (debit positive). */
export interface SrcBalance extends Prov { accountKey: string; amount: string }
/** One open receivable or payable (bill-wise) at the cut-off. amount: debit positive (receivable > 0, payable < 0). */
export interface SrcOpenItem extends Prov {
  key: string; partyKey: string; docNo: string; docDate: string; dueDate: string | null; amount: string; kind: "receivable" | "payable";
  /** Carried on account (the party's balance not allocated to bills). */
  onAccount?: boolean;
}
export interface SrcVoucherLine { accountKey: string; partyKey?: string; amount: string;
  /** Bill-wise allocations (Tally): New Ref / Agst Ref by bill name, debit positive. */
  bills?: { name: string; type: string; amount: string }[] }
export interface SrcVoucher extends Prov {
  /** Stable source key: Tally GUID, Zoho invoice/bill id. */
  key: string; number: string; type: string; date: string; narration: string; lines: SrcVoucherLine[];
  cancelled: boolean;
  /** Kind of external document the source issued (sales invoice, payment), for the external-document register. */
  external?: "invoice" | "bill" | "payment" | "receipt" | null;
}
/** A trial balance the source reported (Tally Trial Balance report, Zoho TB export), per ledger, debit positive. */
export interface SrcTb { file: string; asOf: string | null; rows: (Prov & { accountKey: string; amount: string })[] }
/** Tax registrations, stock, fixed assets and commitments: inventoried and tied to the GL, not posted. */
export interface SrcSchedule extends Prov {
  kind: "tax" | "stock" | "assets" | "commitments"; key: string; name: string; accountKey: string | null;
  quantity: string | null; value: string | null;
}

export interface SourceFile { hash: string; name: string; bytes: number; kinds: string[]; purpose: "source" | "delta" | "comparison"; asOf: string | null }

export interface Extract {
  system: SourceSystem;
  files: SourceFile[];
  groups: SrcGroup[];
  accounts: SrcAccount[];
  parties: SrcParty[];
  /** Ledger opening balances as the source states them (Tally: at the start of its books; Zoho/CSV: at the cut-off). */
  openingBalances: SrcBalance[];
  /**
   * When `openingBalances` apply: "cutoff" (the balances ARE the cut-off trial balance), or
   * "books_start" (Tally ledger masters: the cut-off balance adds the vouchers dated on or before the cut-off).
   */
  openingAsOf: "cutoff" | "books_start";
  openItems: SrcOpenItem[];
  vouchers: SrcVoucher[];
  trialBalances: SrcTb[];
  schedules: SrcSchedule[];
  problems: string[];
}

export const emptyExtract = (system: SourceSystem): Extract => ({ system, files: [], groups: [], accounts: [], parties: [], openingBalances: [], openingAsOf: system === "tally" ? "books_start" : "cutoff",
  openItems: [], vouchers: [], trialBalances: [], schedules: [], problems: [] });

export class MigrationError extends Error {
  constructor(public code: string, message: string, public status = 409, public detail?: unknown) { super(message); }
}
