/** Seed charts of accounts (design section 5.1). Each entity starts small and grows. */
import type { Account } from "@kuber/contracts";

const a = (accountId: string, name: string, nature: Account["nature"], taxonomyTag: string,
           opts: Partial<Account> = {}): Account =>
  ({ accountId, name, nature, taxonomyTag, isControl: false, isCashLike: false, requiredDims: [], ...opts });

const INDIVIDUAL: Account[] = [
  a("CASH", "Cash in hand", "asset", "BS.cash", { isCashLike: true }),
  a("BANK", "Bank account", "asset", "BS.cash", { isCashLike: true }),
  a("INVEST", "Investments", "asset", "BS.investments"),
  a("LOANS", "Loans", "liability", "BS.borrowings"),
  a("CARD", "Credit card", "liability", "BS.borrowings", { isCashLike: true }),
  a("OPENING", "Opening balance equity", "equity", "BS.capital"),
  a("SALARY", "Salary income", "income", "ITR.salary"),
  a("OTHINC", "Other income", "income", "ITR.other_sources"),
  a("LIVING", "Living expenses", "expense", "PL.personal"),
  a("SUSPENSE", "Unclassified (suspense)", "asset", "BS.suspense"),
];

const FREELANCER_EXTRA: Account[] = [
  a("DEBTORS", "Trade receivables", "asset", "BS.trade_receivables", { isControl: true }),
  a("CREDITORS", "Trade payables", "liability", "BS.trade_payables", { isControl: true }),
  a("FEES", "Professional fees", "income", "ITR.business"),
  a("BIZEXP", "Business expenses", "expense", "PL.other_expenses"),
  a("GSTOUT", "GST output", "liability", "BS.statutory_dues"),
  a("GSTIN", "GST input credit", "asset", "BS.statutory_receivables"),
  a("TDSREC", "TDS receivable", "asset", "BS.statutory_receivables", { isControl: true }),
  a("DRAWINGS", "Drawings", "equity", "BS.capital"),
];

export const SEEDS: Record<string, Account[]> = {
  individual: INDIVIDUAL,
  household: INDIVIDUAL,
  freelancer: [...INDIVIDUAL, ...FREELANCER_EXTRA],
  company: [...INDIVIDUAL.filter((x) => !["SALARY", "LIVING"].includes(x.accountId)), ...FREELANCER_EXTRA.filter((x) => x.accountId !== "DRAWINGS"),
    a("CAPITAL", "Share capital", "equity", "BS.share_capital")],
};
