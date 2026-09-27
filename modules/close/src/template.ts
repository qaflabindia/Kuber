/**
 * FIN-CLS-01 close checklist template. Every area of the CFO list is in the template; a task is
 * included only when its feature is active in the book, and is otherwise recorded as "not
 * applicable — feature not enabled" with the reason, so an unsupported module is never presented
 * as reconciled. Dependencies on a not-applicable task are satisfied by it.
 */
import type { Account } from "@kuber/contracts";
import { isSuspense, type BookState } from "@kuber/gl";
import type { EvidenceKind } from "./evidence.ts";

export const TEMPLATE_VERSION = "close-template-1";

export interface TemplateTask {
  taskId: string; area: string; title: string;
  /** Evidence kinds that can complete the task (at least one reference of one of them). */
  evidence: EvidenceKind[];
  dependsOn: string[];
  /** Default deadline: days after the period end. */
  offsetDays: number;
}

export const TEMPLATE: TemplateTask[] = [
  { taskId: "bank", area: "bank", title: "Bank and card accounts reconciled to their statements (a certified bank reconciliation per account)", evidence: ["bank_reconciliation"], dependsOn: [], offsetDays: 3 },
  { taskId: "ar", area: "AR", title: "Receivables: customer balances agreed to the control account, aged and reviewed", evidence: ["document"], dependsOn: ["bank"], offsetDays: 4 },
  { taskId: "ap", area: "AP", title: "Payables: supplier balances agreed to the control account, aged and reviewed", evidence: ["document"], dependsOn: ["bank"], offsetDays: 4 },
  { taskId: "grni", area: "GRNI", title: "Goods and services received not invoiced accrued and reviewed", evidence: ["document"], dependsOn: ["ap"], offsetDays: 5 },
  { taskId: "inventory", area: "inventory", title: "Inventory counted, valued and agreed to the ledger", evidence: ["document"], dependsOn: [], offsetDays: 5 },
  { taskId: "assets", area: "assets", title: "Fixed asset register agreed to the ledger; depreciation posted", evidence: ["document"], dependsOn: [], offsetDays: 5 },
  { taskId: "payroll", area: "payroll", title: "Payroll and statutory deductions agreed to the ledger", evidence: ["document"], dependsOn: ["bank"], offsetDays: 4 },
  { taskId: "accruals", area: "accruals", title: "Accruals and prepayments: recognition schedules reconciled to the ledger", evidence: ["schedule_reconciliation", "document"], dependsOn: ["ap"], offsetDays: 5 },
  { taskId: "tax", area: "tax", title: "Tax balances (GST, TDS) agreed to returns and computations", evidence: ["document"], dependsOn: ["ap", "ar", "payroll"], offsetDays: 6 },
  { taskId: "fx", area: "FX", title: "Foreign currency balances revalued at the closing rate", evidence: ["document"], dependsOn: ["bank"], offsetDays: 5 },
  { taskId: "intercompany", area: "intercompany", title: "Intercompany balances agreed with the counterparty entities", evidence: ["document"], dependsOn: ["ap", "ar"], offsetDays: 6 },
  { taskId: "suspense", area: "suspense", title: "Suspense items cleared or explained (balanced roll-forward)", evidence: ["suspense_roll_forward"], dependsOn: ["bank"], offsetDays: 5 },
];

/** Facts from outside the book that decide which features are active. */
export interface FeatureFacts {
  /** Approved recurring or recognition schedules in the book (FIN-GL-02/03). */
  schedules: number;
  /** The book's entity is in a consolidation group with intercompany links (FIN-GRP-01). */
  intercompany: boolean;
}

const tagged = (s: BookState, re: RegExp) => [...s.accounts.values()].filter((a) => !s.closed.has(a.accountId) && (re.test(a.taxonomyTag ?? "") || re.test(a.accountId)));

/** Accounts with a bank or card statement: cash-like accounts other than cash in hand (and its children). */
export function statementAccounts(s: BookState): Account[] {
  const underCash = (a: Account): boolean => a.accountId === "CASH" || (!!a.parentId && underCash(s.accounts.get(a.parentId) ?? ({ accountId: "" } as Account)));
  return [...s.accounts.values()].filter((a) => a.isCashLike && !underCash(a) && !s.closed.has(a.accountId)).sort((a, b) => a.accountId.localeCompare(b.accountId));
}

/** For each template task: null when its feature is active, else why it is not applicable. */
export function inactiveReasons(s: BookState, f: FeatureFacts): Record<string, string | null> {
  const none = (xs: unknown[], why: string) => (xs.length ? null : why);
  return {
    bank: none(statementAccounts(s), "the book has no bank or card account"),
    ar: none(tagged(s, /trade_receivables|^DEBTORS$/), "the book has no receivables control account"),
    ap: none(tagged(s, /trade_payables|^CREDITORS$/), "the book has no payables control account"),
    grni: none(tagged(s, /grni/i), "receipt-to-accrual (GRNI, FIN-PRC-03) is not enabled: the book has no GRNI account"),
    inventory: none(tagged(s, /inventor/i), "inventory (FIN-INV) is not enabled: the book has no inventory account"),
    assets: none(tagged(s, /fixed_asset|ppe|property_plant/i), "fixed assets (FIN-FA) are not enabled: the book has no fixed asset account"),
    payroll: none(tagged(s, /payroll|salar(y|ies)_payable|employee_benefit/i), "payroll (FIN-PAY) is not enabled: the book has no payroll account"),
    accruals: f.schedules ? null : "no approved recurring or recognition schedule (FIN-GL-02/03) in the book",
    tax: none(tagged(s, /statutory_dues|statutory_receivables|^GST|^TDS/), "the book has no tax account"),
    fx: "foreign currency is not enabled (FIN-GL-04 deferred): the book is INR only",
    intercompany: f.intercompany ? null : "the book's entity is not in a consolidation group with intercompany links (FIN-GRP-01)",
    suspense: [...s.accounts.values()].some((a) => isSuspense(a)) ? null : "the book has no suspense account",
  };
}

export const notApplicable = (reason: string) => `not applicable — feature not enabled: ${reason}`;

/** The day `days` after an ISO date. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
/** Whole days from `from` to `to` (0 when `to` is not later). */
export const daysBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
/** First day of the month of an ISO date. */
export const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
