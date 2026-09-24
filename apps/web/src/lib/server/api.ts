/**
 * Server-side client for the Kuber core API. The browser never talks to the core directly:
 * this backend-for-frontend adds the tenant and principal from the signed session.
 */
import { env } from "$env/dynamic/private";
import type { Session } from "./session";

const CORE = env.CORE_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function call<T>(s: Pick<Session, "tenant" | "principal">, method: string, path: string, body?: unknown, contentType = "application/json"): Promise<T> {
  const res = await fetch(`${CORE}/v1/tenants/${encodeURIComponent(s.tenant)}${path}`, {
    method,
    headers: {
      "x-kuber-tenant": s.tenant, "x-kuber-principal": s.principal,
      ...(body !== undefined ? { "content-type": contentType } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, json?.error ?? "error", json?.message ?? `Request failed (${res.status})`);
  return json as T;
}

// ---------------------------------------------------------------- types returned by the core
export interface Statement { title: string; rows: { label: string; amount: string; accountId?: string; section?: string }[]; totals: Record<string, string>; unit: "paise" }
export interface Account { account_id: string; name: string; nature: "asset" | "liability" | "equity" | "income" | "expense"; parent_id: string | null; balance: string }
export interface Line { accountId: string; amount: string; partyId?: string | null }
export interface Journal { journal_id: string; seq: number; txn_date: string; narration: string; provisional: boolean; reverses: string | null; principal: string; lines: Line[] }
export interface Draft {
  draft_id: string; txn_id: string; book_id: string; status: "queued" | "awaiting_approval" | "rejected_by_gl"; created_at: string;
  /** Why the ledger refused the posting, when status is rejected_by_gl. */
  gl_rejection: string | null;
  proposal: { txnDate: string; narration: string; accountId: string; confidence: number; classifiedBy: string; partyName?: string | null;
    amount: string; direction: "in" | "out"; lines: Line[]; provisional: boolean };
  decision: { level: string; action: string; reasons: string[]; policyIds: string[]; approver: string };
}
export interface Ratification { request_id: string; journal_id: string; txn_id: string; due_by: string; narration: string }
export interface DrillLine { journal_id: string; seq: number; txn_date: string; amount: string; party_id: string | null; narration: string; provisional: boolean; reverses: string | null; principal: string }

export interface PlanCheck { label: string; ok: boolean; blocking: boolean; detail?: string }
export interface PlanSection { title: string; kind: "kv" | "table"; columns?: string[]; rows: (string | number | null)[][]; money?: number[] }
export interface Plan {
  planId: string; op: string; bookId: string; kind: "read" | "write"; gate: "policy" | "human"; title: string; summary: string;
  policy: { ids: string[]; level: string; approver: string; reasons: string[] } | null;
  checks: PlanCheck[]; journals: { journalId: string; txnDate: string; narration: string; voucherType: string; lines: { accountId: string; name: string; amount: string; dimensions?: Record<string, string> }[] }[];
  effects: { accountId: string; name: string; nature: string; before: string; after: string }[];
  sections: PlanSection[]; data?: unknown; notes: string[]; links: [string, string][];
  basisSeq: number; createdAt: string; createdBy: string; hash: string; status: "preview" | "proposed" | "committed" | "discarded" | "stale"; blocked: boolean; needsPerson: boolean;
}
export interface CopilotReply { reply: string; cards: Plan[]; suggestions?: string[]; engine: string; trace: { tool: string; ok: boolean }[] }

export const api = (s: Pick<Session, "tenant" | "principal">) => ({
  books: () => call<{ book_id: string; accounts: number }[]>(s, "GET", "/books"),
  openBook: (bookId: string, entityId: string, entityType: string) => call(s, "POST", "/books", { bookId, entityId, entityType }),
  accounts: (book: string) => call<Account[]>(s, "GET", `/books/${book}/accounts`),
  journals: (book: string, limit = 20) => call<Journal[]>(s, "GET", `/books/${book}/journals?limit=${limit}`),
  drafts: () => call<Draft[]>(s, "GET", "/drafts"),
  approve: (id: string, accountId?: string) => call(s, "POST", `/drafts/${id}/approve`, accountId ? { accountId } : {}),
  reject: (id: string, reason: string) => call(s, "POST", `/drafts/${id}/reject`, { reason }),
  ratifications: () => call<Ratification[]>(s, "GET", "/ratifications"),
  ratify: (journalId: string) => call(s, "POST", `/journals/${journalId}/ratify`, {}),
  correct: (journalId: string, toAccount: string, learn: boolean) => call(s, "POST", `/journals/${journalId}/correct`, { toAccount, learn }),
  chat: (book: string, text: string) => call<{ accepted: number; duplicate: boolean }>(s, "POST", `/books/${book}/chat`, { text }),
  statement: (book: string, csv: string, instrument: string) =>
    call<{ accepted: number; skipped: number; duplicate: boolean }>(s, "POST", `/books/${book}/statements?instrument=${encodeURIComponent(instrument)}`, csv, "text/csv"),
  openingBalance: (book: string, accountId: string, amount: string, asOf: string) => call(s, "POST", `/books/${book}/opening-balances`, { accountId, amount, asOf }),
  report: (book: string, kind: string, q: Record<string, string> = {}) =>
    call<Statement>(s, "GET", `/books/${book}/reports/${kind}${Object.keys(q).length ? "?" + new URLSearchParams(q) : ""}`),
  drill: (book: string, account: string, q: Record<string, string> = {}) =>
    call<DrillLine[]>(s, "GET", `/books/${book}/accounts/${encodeURIComponent(account)}/lines${Object.keys(q).length ? "?" + new URLSearchParams(q) : ""}`),
  copilotInfo: () => call<{ engine: string; suggestions: string[] }>(s, "GET", "/copilot"),
  ask: (book: string, text: string, history: { role: "user" | "assistant"; text: string }[]) => call<CopilotReply>(s, "POST", `/books/${book}/copilot`, { text, history }),
  plan: (book: string, op: string, input: unknown = {}) => call<Plan>(s, "POST", `/books/${book}/ops/${op}`, input),
  plans: (book: string) => call<Plan[]>(s, "GET", `/books/${book}/plans`),
  commit: (id: string, hash: string) => call<{ planId: string; status: string; steps?: string[]; message?: string }>(s, "POST", `/plans/${id}/commit`, { hash }),
  discard: (id: string) => call(s, "POST", `/plans/${id}/discard`, {}),
  verify: (book: string) => call<{ intact: boolean; firstBrokenJournal: string | null }>(s, "GET", `/books/${book}/verify`),
});
