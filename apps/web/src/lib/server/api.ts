/**
 * Server-side client for the Kuber core API. The browser never talks to the core directly:
 * this backend-for-frontend signs each request (tenant and principal from the encrypted session,
 * method, path, body hash, time, nonce) with CORE_AUTH_SECRET, which the core verifies (F01).
 */
import { readFileSync } from "node:fs";
import { env } from "$env/dynamic/private";
import { AUTH_HEADER, authKey, signRequest } from "@kuber/auth";
import type { Session } from "./session";

const CORE = env.CORE_URL ?? "http://localhost:8080";

// Read lazily: the build imports this module without runtime secrets.
let key: Buffer | null = null;
function coreKey(): Buffer {
  if (key) return key;
  const secret = env.CORE_AUTH_SECRET_FILE ? readFileSync(env.CORE_AUTH_SECRET_FILE, "utf8").trim() : env.CORE_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("CORE_AUTH_SECRET is not set: the web tier cannot authenticate to the core (run ./scripts/secure-setup.sh)");
  return (key = authKey(secret));
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** One signed call. `principal` is null only for sign-in ceremonies, before anyone is signed in. */
async function call<T>(s: { tenant: string; principal: string | null; stepUpAt?: number }, method: string, path: string, body?: unknown, contentType = "application/json"): Promise<T> {
  const target = `/v1/tenants/${encodeURIComponent(s.tenant)}${path}`;
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`${CORE}${target}`, {
    method,
    headers: {
      [AUTH_HEADER]: signRequest(coreKey(), { method, path: target, body: payload, tenant: s.tenant, principal: s.principal, stepUpAt: s.stepUpAt }),
      ...(payload !== undefined ? { "content-type": contentType } : {}),
    },
    body: payload,
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

/** `stepUpAt`: the person's last passkey step-up (see stepup.ts), for sensitive approvals. */
export const api = (s: Pick<Session, "tenant" | "principal"> & { stepUpAt?: number }) => ({
  books: () => call<{ book_id: string; accounts: number }[]>(s, "GET", "/books"),
  openBook: (bookId: string, entityId: string, entityType: string) => call(s, "POST", "/books", { bookId, entityId, entityType }),
  accounts: (book: string) => call<Account[]>(s, "GET", `/books/${book}/accounts`),
  journals: (book: string, limit = 20) => call<Journal[]>(s, "GET", `/books/${book}/journals?limit=${limit}`),
  // A book-scoped member lists the drafts of one book (the core refuses a tenant-wide list for them).
  drafts: (book?: string) => call<Draft[]>(s, "GET", book ? `/drafts?book=${encodeURIComponent(book)}` : "/drafts"),
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
  attention: (book: string) => call<{ drafts: number; awaitingApproval: number; ratifications: number; plans: number }>(s, "GET", `/books/${book}/attention`),
  commit: (id: string, hash: string) => call<{ planId: string; status: string; steps?: string[]; message?: string }>(s, "POST", `/plans/${id}/commit`, { hash }),
  discard: (id: string) => call(s, "POST", `/plans/${id}/discard`, {}),
  verify: (book: string) => call<{ intact: boolean; firstBrokenJournal: string | null }>(s, "GET", `/books/${book}/verify`),
});

// ---------------------------------------------------------------- identity (passkeys, members)
export interface Member { tenant: string; principal: string; role: string; books: string[] | null; displayName: string; status: string; source: string }
/** WebAuthn options as JSON, passed through to the browser unchanged. */
export type CeremonyOptions = Record<string, unknown> & { challenge: string };

/** Sign-in ceremonies: signed by the BFF without a principal; the core verifies the passkey. */
export const identity = (tenant: string) => {
  const c = { tenant, principal: null };
  return {
    registrationOptions: (displayName: string, enrolment?: string) => call<CeremonyOptions>(c, "POST", "/identity/registration/options", { displayName, ...(enrolment ? { enrolment } : {}) }),
    register: (displayName: string, response: unknown, enrolment?: string) => call<Member>(c, "POST", "/identity/registration/verify", { displayName, response, ...(enrolment ? { enrolment } : {}) }),
    authenticationOptions: () => call<CeremonyOptions>(c, "POST", "/identity/authentication/options", {}),
    authenticate: (response: unknown) => call<Member>(c, "POST", "/identity/authentication/verify", { response }),
    devSignIn: (name: string) => call<Member>(c, "POST", "/identity/dev-signin", { name }),
  };
};

// ---------------------------------------------------------------- member management and step-up
export interface Me extends Member { permissions: string[] }
export interface Credential { credentialId: string; principal: string; transports: string[]; createdAt: string; lastUsedAt: string | null }
export interface Invitation { token: string; principal: string; role: string; books: string[] | null; expiresAt: string }
export interface Separation { soloOwner: boolean; sodLimitPaise: string | null }

/** Signed-in calls for the members page and passkey step-up; the core authorizes each one. */
export const members = (s: Pick<Session, "tenant" | "principal">) => {
  const m = (p: string) => `/members/${encodeURIComponent(p)}`;
  return {
    me: () => call<Me>(s, "GET", "/me"),
    list: () => call<Member[]>(s, "GET", "/members"),
    credentials: () => call<Credential[]>(s, "GET", "/credentials"),
    invite: (i: { role: string; displayName: string; books: string[] | null; ttlHours?: number }) => call<Invitation>(s, "POST", "/members/invitations", i),
    change: (principal: string, c: { role?: string; books?: string[] | null }) => call<Member>(s, "PATCH", m(principal), c),
    revoke: (principal: string) => call<void>(s, "POST", `${m(principal)}/revoke`, {}),
    revokeCredential: (id: string) => call<void>(s, "POST", `/credentials/${encodeURIComponent(id)}/revoke`, {}),
    separation: () => call<Separation>(s, "GET", "/settings/separation"),
    setSeparation: (v: Separation) => call<Separation>(s, "PUT", "/settings/separation", v),
    stepUpOptions: () => call<CeremonyOptions>(s, "POST", "/identity/stepup/options", {}),
    stepUp: (body: { response: unknown } | { dev: true }) => call<{ principal: string; at: number }>(s, "POST", "/identity/stepup/verify", body),
  };
};
