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

/**
 * One signed call. `principal` is null only for sign-in ceremonies, before anyone is signed in.
 * `sid` is the web session the call is made for (a ceremony: the session it is about to start).
 * `stepUpAt`: the person's last passkey step-up (see stepup.ts), for sensitive approvals.
 */
async function call<T>(s: { tenant: string; principal: string | null; sid?: string | null; stepUpAt?: number }, method: string, path: string, body?: unknown, contentType = "application/json"): Promise<T> {
  const target = `/v1/tenants/${encodeURIComponent(s.tenant)}${path}`;
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`${CORE}${target}`, {
    method,
    headers: {
      [AUTH_HEADER]: signRequest(coreKey(), { method, path: target, body: payload, tenant: s.tenant, principal: s.principal, session: s.sid ?? null, stepUpAt: s.stepUpAt }),
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
export const api = (s: Pick<Session, "tenant" | "principal" | "sid"> & { stepUpAt?: number }) => ({
  /** Sign-out: the core revokes this session id, so a copied cookie stops working too. */
  signOut: () => call<void>(s, "POST", "/sessions/revoke", {}),
  books: () => call<{ book_id: string; accounts: number }[]>(s, "GET", "/books"),
  openBook: (bookId: string, entityId: string, entityType: string) => call(s, "POST", "/books", { bookId, entityId, entityType }),
  accounts: (book: string) => call<Account[]>(s, "GET", `/books/${book}/accounts`),
  journals: (book: string, limit = 20) => call<Journal[]>(s, "GET", `/books/${book}/journals?limit=${limit}`),
  // A book-scoped member lists the drafts of one book (the core refuses a tenant-wide list for them).
  drafts: (book?: string) => call<Draft[]>(s, "GET", book ? `/drafts?book=${encodeURIComponent(book)}` : "/drafts"),
  /** `assertion`: the passkey signature over this approval, when it is above the approval limit (signed commands). */
  approve: (id: string, accountId?: string, assertion?: unknown) => call(s, "POST", `/drafts/${id}/approve`, { ...(accountId ? { accountId } : {}), ...(assertion ? { assertion } : {}) }),
  reject: (id: string, reason: string) => call(s, "POST", `/drafts/${id}/reject`, { reason }),
  ratifications: () => call<Ratification[]>(s, "GET", "/ratifications"),
  ratify: (journalId: string, assertion?: unknown) => call(s, "POST", `/journals/${journalId}/ratify`, assertion ? { assertion } : {}),
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
  attention: (book: string) => call<{ drafts: number; awaitingApproval: number; ratifications: number; plans: number; closeTasksOverdue?: number }>(s, "GET", `/books/${book}/attention`),
  /** `assertion`: the passkey signature over this plan (step-up-class plans; see signing options). */
  commit: (id: string, hash: string, assertion?: unknown) =>
    call<{ planId: string; status: string; steps?: string[]; message?: string }>(s, "POST", `/plans/${id}/commit`, { hash, ...(assertion ? { assertion } : {}) }),
  discard: (id: string) => call(s, "POST", `/plans/${id}/discard`, {}),
  verify: (book: string) => call<{ intact: boolean; firstBrokenJournal: string | null }>(s, "GET", `/books/${book}/verify`),
  // Period close (FIN-CLS-01..04): plans returned here are committed through commit() like any other.
  closeOverview: (book: string) => call<CloseOverview>(s, "GET", `/books/${book}/close`),
  closeStatus: (book: string, periodEnd: string) => call<CloseStatus>(s, "GET", `/books/${book}/close/${periodEnd}`),
  closeCertify: (book: string, periodEnd: string) => call<Plan>(s, "POST", `/books/${book}/close/${periodEnd}/certify`, {}),
  closeReopen: (book: string, periodEnd: string, reason: string) => call<Plan>(s, "POST", `/books/${book}/close/${periodEnd}/reopen`, { reason }),
  closeComplete: (book: string, periodEnd: string, taskId: string, evidence: EvidenceRef[]) => call<Plan>(s, "POST", `/books/${book}/close/${periodEnd}/tasks/${encodeURIComponent(taskId)}/complete`, { evidence }),
  closeSubstantiate: (book: string, periodEnd: string, accountId: string, body: { sourceBalance?: string; evidence?: EvidenceRef[]; note?: string }) =>
    call<Plan>(s, "POST", `/books/${book}/close/${periodEnd}/substantiations/${encodeURIComponent(accountId)}`, body),
});

// ---------------------------------------------------------------- period close (FIN-CLS-01..04)
export interface EvidenceRef { kind: "bank_reconciliation" | "schedule_reconciliation" | "suspense_roll_forward" | "document"; id: string; hash: string }
export interface CloseTask { taskId: string; area: string; title: string; owner: string | null; deadline: string; dependsOn: string[]; evidenceKinds: EvidenceRef["kind"][];
  applicable: boolean; reason: string | null; status: "open" | "done" | "not_applicable"; state: "open" | "awaiting_review" | "done" | "not_applicable"; overdue: boolean;
  evidence: EvidenceRef[]; completedBy: string | null; reviewedBy: string | null; withdrawnReason: string | null }
export interface CloseRecord { closeId: string; periodEnd: string; version: number; status: "certified" | "withdrawn"; closeSeq: number; contentHash: string;
  certifiedBy: string; certifiedAt: string; withdrawnReason: string | null }
export interface CloseStatus {
  bookId: string; periodEnd: string; periodStart: string;
  checklist: { tasks: CloseTask[] } | null;
  substantiations: { accountId: string; name: string; glBalance: string; status: "missing" | "stale" | "approved"; preparedBy: string | null; approvedBy: string | null; source: string | null }[];
  findings: { code: string; label: string; detail: string; blocking: boolean }[];
  certified: CloseRecord | null; closes: CloseRecord[]; blockers: string[]; hardLocked: boolean;
}
export interface CloseOverview { checklists: { periodEnd: string; periodStart: string }[]; closes: CloseRecord[]; overdue: { periodEnd: string; taskId: string; owner: string | null; deadline: string }[];
  bankReconciliationService: boolean }

// ---------------------------------------------------------------- identity (passkeys, members)
export interface Member { tenant: string; principal: string; role: string; books: string[] | null; displayName: string; status: string; source: string }
/** WebAuthn options as JSON, passed through to the browser unchanged. */
export type CeremonyOptions = Record<string, unknown> & { challenge: string };

/**
 * Sign-in ceremonies: signed by the BFF without a principal; the core verifies the passkey.
 * `sid`: the session the ceremony will start, which the core binds to the verified passkey.
 */
export const identity = (tenant: string, sid: string | null = null) => {
  const c = { tenant, principal: null, sid };
  return {
    registrationOptions: (displayName: string, enrolment?: string) => call<CeremonyOptions>(c, "POST", "/identity/registration/options", { displayName, ...(enrolment ? { enrolment } : {}) }),
    register: (displayName: string, response: unknown, enrolment?: string) => call<Member>(c, "POST", "/identity/registration/verify", { displayName, response, ...(enrolment ? { enrolment } : {}) }),
    authenticationOptions: () => call<CeremonyOptions>(c, "POST", "/identity/authentication/options", {}),
    authenticate: (response: unknown) => call<Member>(c, "POST", "/identity/authentication/verify", { response }),
    devSignIn: (name: string) => call<Member>(c, "POST", "/identity/dev-signin", { name }),
  };
};

// ---------------------------------------------------------------- member management and step-up
export interface Me extends Member {
  permissions: string[];
  /** Active passkeys, and warnings such as an owner or controller with only one (design 16.4). */
  passkeys: number; requireTwoAuthenticators: boolean; warnings: { code: string; message: string }[];
}
export interface Credential { credentialId: string; principal: string; transports: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
export interface Invitation { token: string; principal: string; role: string; books: string[] | null; expiresAt: string }
/** `soloSuperuser`: the single-superuser exception (role model v2); `soloOwner` is its earlier name, still returned. */
export interface Separation { soloSuperuser?: boolean; soloOwner?: boolean; sodLimitPaise: string | null; requireTwoAuthenticators?: boolean }

// ---------------------------------------------------------------- signed commands (design 14.4, 16.4)
export type SignedAction = "plan.commit" | "plan.approve" | "draft.approve" | "journal.ratify" | "period.lock";
/** The command to sign, as the browser names it; the core derives everything else from the command itself. */
export type SigningRequest =
  | { action: "plan.commit" | "plan.approve"; planId: string; hash: string }
  | { action: "draft.approve"; draftId: string; accountId?: string }
  | { action: "journal.ratify"; journalId: string }
  | { action: "period.lock"; book: string; periodEnd: string; level: "soft" | "hard" };
/** What the person is shown before their passkey signs: rendered by the core from the command. Amounts are paise. */
export interface CommandSummary {
  action: SignedAction; title: string; book: string; amountPaise: string | null;
  payees: { partyId: string; name: string | null }[];
  accounts: { accountId: string; name: string; debitPaise: string; creditPaise: string }[];
  periods: { periodEnd: string; level: string }[];
  lines: string[];
}
export type SigningOptions = { required: false; reason: string | null }
  | { required: true; reason: string | null; digest: string; expiresAt: string; summary: CommandSummary; options: CeremonyOptions };

/** Signed-in calls for the members page and passkey step-up; the core authorizes each one. `stepUpAt`: see stepup.ts. */
export const members = (s: Pick<Session, "tenant" | "principal" | "sid"> & { stepUpAt?: number }) => {
  const m = (p: string) => `/members/${encodeURIComponent(p)}`;
  return {
    me: () => call<Me>(s, "GET", "/me"),
    list: () => call<Member[]>(s, "GET", "/members"),
    credentials: () => call<Credential[]>(s, "GET", "/credentials"),
    invite: (i: { role: string; displayName: string; books: string[] | null; ttlHours?: number; partyId?: string }) => call<Invitation>(s, "POST", "/members/invitations", i),
    change: (principal: string, c: { role?: string; books?: string[] | null }) => call<Member>(s, "PATCH", m(principal), c),
    revoke: (principal: string) => call<void>(s, "POST", `${m(principal)}/revoke`, {}),
    revokeCredential: (id: string) => call<void>(s, "POST", `/credentials/${encodeURIComponent(id)}/revoke`, {}),
    separation: () => call<Separation>(s, "GET", "/settings/separation"),
    setSeparation: (v: Separation) => call<Separation>(s, "PUT", "/settings/separation", v),
    stepUpOptions: () => call<CeremonyOptions>(s, "POST", "/identity/stepup/options", {}),
    stepUp: (body: { response: unknown } | { dev: true }) => call<{ principal: string; at: number }>(s, "POST", "/identity/stepup/verify", body),
    /** Signed commands, step 1: WebAuthn options whose challenge is the command digest, and the summary to show. */
    signingOptions: (body: SigningRequest) => call<SigningOptions>(s, "POST", "/signing/options", body),
    /** Another passkey for the signed-in member (needs a fresh step-up when they already have one). */
    addPasskeyOptions: () => call<CeremonyOptions>(s, "POST", "/identity/passkeys/options", {}),
    addPasskey: (response: unknown) => call<Credential>(s, "POST", "/identity/passkeys/verify", { response }),
  };
};

// ---------------------------------------------------------------- external roles (role model v2)
export interface PortalLine { bookId: string; journalId: string; date: string; voucherType: string; accountId: string; amount: string }
export interface PortalItem extends PortalLine { open: string; status: "open" | "partly_paid" | "paid" }
export interface PortalStatement { partyId: string; name: string | null; balance: string; lines: (PortalLine & { balance: string })[] }
export interface CustomerView { statement: PortalStatement; openItems: PortalItem[]; paymentsReceived: PortalLine[] }
export interface SupplierView { statement: PortalStatement; bills: PortalItem[]; payments: PortalLine[];
  bankChange: { changeId: string; status: string; effectiveFrom: string } | null; paymentsHeld: boolean }
export interface PortalQuery { queryId: string; subject: string; message: string; reference: string | null; openedAt: string }
export interface InvestorSnapshot { snapshotId: string; bookId: string; kind: string; seq: number; contentHash: string; takenAt: string }
export interface GuestShare { shareId: string; itemType: "snapshot" | "report"; itemId: string; expiresAt: string; grantedBy: string }

/** Customers, suppliers, investors and guests: the core filters every call to the member's own party, published snapshots or shares. */
export const portal = (s: Pick<Session, "tenant" | "principal" | "sid">) => ({
  customer: () => call<CustomerView>(s, "GET", "/portal/customer"),
  queries: () => call<PortalQuery[]>(s, "GET", "/portal/customer/queries"),
  query: (q: { subject: string; message: string; reference?: string }) => call<{ queryId: string }>(s, "POST", "/portal/customer/queries", q),
  supplier: () => call<SupplierView>(s, "GET", "/portal/supplier"),
  bankChange: (b: { bank: { accountNumber: string; ifsc: string; holderName: string }; effectiveFrom?: string }) =>
    call<{ changeId: string; status: string; hold: boolean }>(s, "POST", "/portal/supplier/bank-change", b),
  snapshots: () => call<InvestorSnapshot[]>(s, "GET", "/portal/investor/snapshots"),
  shares: () => call<GuestShare[]>(s, "GET", "/shares/mine"),
});
