/**
 * Identity: who may act in a workspace (tenant), and how they prove it (findings F01, F02).
 *
 *   members      one row per principal in a tenant: role, book scope (null = every book), status
 *   credentials  passkeys (WebAuthn public keys) of members; verified here, in the core
 *   enrolments   one-time codes that let a new person register a passkey for an assigned role
 *   settings     separation-of-duties policy per tenant (explicit single-owner exception, limit)
 *   sessions     web sessions bound at sign-in (hash of the session id, principal, passkey) and
 *                revoked at sign-out; a signed request's session id is checked here
 *
 * Every table is tenant-scoped with row-level security, like the rest of the core. Display names
 * (members, invitations) are sealed with the tenant's data key; principals stay readable because
 * they are the identifiers every other record uses.
 *
 * Every change (member added, removed or re-scoped, invitation issued or redeemed, passkey
 * registered or revoked, session revoked, settings changed) is appended as a sealed event to the
 * tenant's identity stream (`<tenant>/identity`) in the same transaction as the change.
 *
 * Sign-in ceremonies are stateless on the server: a challenge is random bytes plus an expiry,
 * authenticated with a per-process key, bound to the ceremony kind and tenant, and accepted once.
 *
 * The same service is the operations guard: role, book scope and maker-checker for every plan,
 * commit and discard, whichever surface (web, copilot, MCP) the request came through; and the
 * module guard the agent and channels modules check their commands against (permit).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TransactionSql } from "postgres";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Principal } from "@kuber/contracts";
import { isToken, type TenantKeys } from "@kuber/crypto";
import { tenantRlsFor, type EventStore, type GuardScope, type Migration, type ModuleGuard, type NewEvent } from "@kuber/eventstore";
import type { OpsGuard, OpsGuardQuery, Plan } from "@kuber/ops";
import type { PolicyEngine } from "@kuber/policy";
import { ReplayCache } from "@kuber/auth";
import { ACTIONS, can, isRole, roleOf, type Action, type Role } from "./roles.ts";
import { Authority, type AuthorityChange, type AuthorityChangeHook, type IdentityHost } from "./authority.ts";
import { AutonomySwitch } from "./autonomy.ts";
import { AccessReview } from "./access-review.ts";
import { IDENTITY_FIN_MIGRATIONS } from "./fin-migrations.ts";

export * from "./roles.ts";
export { Authority, DELEGABLE, DOA_DEFAULTS, DOA_SOURCE, type AuthorityBasis, type AuthorityChange, type AuthorityChangeHook, type Delegation } from "./authority.ts";
export { AutonomySwitch, type AutonomySwitchState } from "./autonomy.ts";
export { AccessReview, REVIEW_DECISIONS, type AccessReviewReport, type ReviewDecision, type ReviewItem } from "./access-review.ts";
export { IDENTITY_FIN_MIGRATIONS, accessReviewNoteCtx, autonomyReasonCtx, relatedPartyNoteCtx, rlsForTables } from "./fin-migrations.ts";

export const IDENTITY_MIGRATIONS: Migration[] = [{
  id: "identity-001",
  sql: `
CREATE SCHEMA IF NOT EXISTS identity;
CREATE TABLE identity.members (
  tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','controller','preparer','approver','auditor','member','agent')),
  books TEXT[],
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  source TEXT NOT NULL CHECK (source IN ('passkey','enrolment','operator','config','dev')),
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by TEXT, revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, principal),
  CHECK (split_part(principal, ':', 1) = role));
CREATE TABLE identity.credentials (
  tenant_id TEXT NOT NULL, credential_id TEXT NOT NULL, principal TEXT NOT NULL,
  public_key BYTEA NOT NULL, counter BIGINT NOT NULL DEFAULT 0, transports TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, credential_id),
  FOREIGN KEY (tenant_id, principal) REFERENCES identity.members (tenant_id, principal));
CREATE TABLE identity.enrolments (
  tenant_id TEXT NOT NULL, token_hash TEXT NOT NULL, principal TEXT NOT NULL, role TEXT NOT NULL, books TEXT[],
  display_name TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, token_hash));
CREATE TABLE identity.settings (
  tenant_id TEXT PRIMARY KEY, solo_owner BOOLEAN NOT NULL DEFAULT false, sod_limit_paise BIGINT,
  updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
` + tenantRlsFor("identity"),
}, {
  id: "identity-002-sessions-credential-revocation",
  // Passkeys can be revoked; web sessions are bound at sign-in and revoked at sign-out (by the
  // hash of their id: the id itself is a bearer secret of the web tier and is never stored).
  sql: `
ALTER TABLE identity.credentials ADD COLUMN revoked_at TIMESTAMPTZ, ADD COLUMN revoked_by TEXT;
CREATE TABLE identity.sessions (
  tenant_id TEXT NOT NULL, session_hash TEXT NOT NULL, principal TEXT, credential_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ, revoked_by TEXT,
  PRIMARY KEY (tenant_id, session_hash));
ALTER TABLE identity.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.sessions USING (tenant_id = current_setting('kuber.tenant', true)) WITH CHECK (tenant_id = current_setting('kuber.tenant', true));
CREATE POLICY system_scope ON identity.sessions TO kuber_system_scope USING (true) WITH CHECK (true);`,
}, ...IDENTITY_FIN_MIGRATIONS];

/**
 * Data migration (run once by the cell after the SQL migrations, recorded in schema_migrations):
 * seal display names stored before they were encrypted. See SEALED_COLUMNS in the core.
 */
export const IDENTITY_SEAL_MIGRATION = "identity-003-seal-display-names";
/** Contexts the sealed display names are bound to. */
export const memberNameCtx = (principal: string) => `identity.members.display_name|${principal}`;
export const enrolmentNameCtx = (tokenHash: string) => `identity.enrolments.display_name|${tokenHash}`;
/** The tenant's identity audit stream. */
export const identityStream = (tenant: string) => `${tenant}/identity`;

/** 403: authenticated, but not allowed to do this. */
export class AccessDenied extends Error {
  readonly statusCode = 403;
  readonly code = "forbidden";
}
/** 4xx problems with an identity request (bad code, workspace taken, ...). */
export class IdentityError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}

export interface Member {
  tenant: string; principal: string; role: Role | "agent"; books: string[] | null;
  displayName: string; status: "active" | "revoked"; source: string;
}
export interface Separation { soloOwner: boolean; sodLimitPaise: string | null }
export interface IdentityOptions {
  /** WebAuthn relying party: the web origin's registrable domain, e.g. "kuber.example.com". */
  rpId: string;
  rpName?: string;
  /** Exact origins the browser ceremonies run on, e.g. ["https://kuber.example.com"]. */
  origins: string[];
  /** Development sign-in without a passkey. Never enable in production. */
  devSignIn?: boolean;
  now?: () => number;
}

/** The copilot proposes on a person's behalf; it never commits. */
export const COPILOT = "agent:copilot";
const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const CHALLENGE_TTL_MS = 5 * 60_000;
const ENROLMENT_TTL_HOURS = 72;
export const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const denied = (m: string) => new AccessDenied(m);

type Row = { tenant_id: string; principal: string; role: string; books: string[] | null; display_name: string; status: string; source: string };
/** Rows written before names were sealed are plaintext until the sealing migration has run. */
const openName = (keys: TenantKeys, v: string, ctx: string) => (isToken(v) ? keys.openText(v, ctx) : v);
const toMember = (r: Row, keys: TenantKeys): Member => ({ tenant: r.tenant_id, principal: r.principal, role: r.role as Member["role"], books: r.books,
  displayName: openName(keys, r.display_name, memberNameCtx(r.principal)), status: r.status as Member["status"], source: r.source });
const sameBooks = (a: string[] | null, b: string[] | null) => (a === null || b === null ? a === b : a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000"));
/** Event metadata needs a principal: operator and configuration actors ("operator:cli", "config") are recorded as system:<actor>. */
const actor = (by: string) => (Principal.safeParse(by).success ? by : `system:${by.replace(/[^\w.@-]+/g, ".").replace(/^\.+|\.+$/g, "") || "unknown"}`);
const sessionHash = (sid: string) => sha(`session|${sid}`);

/** What a system principal may do at a module boundary: channel adapters capture statements and messages. */
const SYSTEM_ACTIONS = new Set<Action>(["capture"]);
/** What an agent with a book grant may do directly at a module boundary (anything else goes through an ops plan). */
const AGENT_ACTIONS = new Set<Action>(["capture"]);
const isAction = (a: string): a is Action => (ACTIONS as readonly string[]).includes(a);
export const inScope = (m: Pick<Member, "books">, book: string) => m.books === null || m.books.includes(book);

/** Largest amount a plan moves: the biggest journal's total debits (paise). */
export function planAmount(p: Pick<Plan, "journals">): bigint {
  let max = 0n;
  for (const j of p.journals) {
    const d = j.lines.reduce((a, l) => (BigInt(l.amount) > 0n ? a + BigInt(l.amount) : a), 0n);
    if (d > max) max = d;
  }
  return max;
}

export class Identity implements OpsGuard, ModuleGuard {
  private readonly challengeKey = randomBytes(32);
  private readonly used = new ReplayCache(50_000);
  private readonly now: () => number;
  /** FIN-MDM-04: amount bands, delegations and conflict rules. */
  readonly authority: Authority;
  /** FIN-OPS-03: the autonomy kill switch. */
  readonly autonomy: AutonomySwitch;
  /** FIN-MDM-05: periodic access and master-change review. */
  readonly accessReview: AccessReview;
  private readonly authorityHooks: AuthorityChangeHook[] = [];
  constructor(private store: EventStore, private policies: PolicyEngine, private o: IdentityOptions) {
    this.now = o.now ?? Date.now;
    const host: IdentityHost = {
      member: (t, p, tx) => this.member(t, p, tx), authorize: (t, p, a, sc, tx) => this.authorize(t, p, a, sc, tx),
      now: () => this.now(), denied: (m) => denied(m), error: (c, m, st) => new IdentityError(c, m, st),
      changed: (tx, t, c) => this.authorityChanged(tx, t, c),
    };
    this.authority = new Authority(store, host);
    this.autonomy = new AutonomySwitch(store, host);
    this.accessReview = new AccessReview(store, host);
  }

  /**
   * FIN-MDM-04: run `hook` in the transaction of every change that can alter someone's approval
   * authority (bands, delegations, conflicts, removal, role or scope). The cell registers the ops
   * module here, which invalidates approvals that relied on it.
   */
  onAuthorityChange(hook: AuthorityChangeHook) { this.authorityHooks.push(hook); }
  private async authorityChanged(tx: TransactionSql, tenant: string, change: AuthorityChange) {
    for (const h of this.authorityHooks) await h(tenant, change, tx);
  }

  /** FIN-OPS-03: is autonomous action halted (kill switch) for this book? (OpsGuard, ModuleGuard and the GL's gate.) */
  autonomyHalted(tenant: string, book: string, tx?: TransactionSql): Promise<boolean> { return this.autonomy.halted(tenant, book, tx); }

  get devSignInEnabled() { return !!this.o.devSignIn; }

  // ------------------------------------------------------------------ membership
  /** The active membership of `principal`; in `tx` when given (the caller's tenant transaction). */
  async member(tenant: string, principal: string, tx?: TransactionSql): Promise<Member | null> {
    const q = (t: TransactionSql) => t<Row[]>`
      SELECT tenant_id, principal, role, books, display_name, status, source FROM identity.members
      WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
    const [r] = tx ? await q(tx) : await this.store.tenantTx(tenant, q);
    return r ? toMember(r, await this.store.keys(tenant)) : null;
  }

  async members(tenant: string): Promise<Member[]> {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<Row[]>`
      SELECT tenant_id, principal, role, books, display_name, status, source FROM identity.members
      WHERE tenant_id = ${tenant} ORDER BY created_at`);
    const keys = await this.store.keys(tenant);
    return rows.map((r) => toMember(r, keys));
  }

  /** Append identity events to the tenant's identity stream, in the transaction of the change they record. */
  private async audit(tx: TransactionSql, tenant: string, by: string, events: NewEvent[]) {
    if (!events.length) return;
    await this.store.append("identity", tenant, { streamId: identityStream(tenant), expected: "any", events }, { principal: actor(by) }, tx);
  }

  /**
   * The one authorization check for people: an active membership whose role allows `action`
   * and whose book scope covers `book`. `allBooks` marks tenant-wide resources (drafts,
   * evidence, members), which a book-scoped member may not touch.
   */
  async authorize(tenant: string, principal: string, action: Action, scope: GuardScope = {}, tx?: TransactionSql): Promise<Member> {
    const m = await this.member(tenant, principal, tx);
    if (!m || m.role === "agent") throw denied(`${principal} is not a member of workspace ${tenant}`);
    if (!can(m.role, action)) throw denied(`${m.role} may not ${action}`);
    if (scope.book !== undefined && !inScope(m, scope.book)) throw denied(`${principal} has no access to book ${scope.book}`);
    if (scope.allBooks && m.books !== null) throw denied(`${principal} is limited to books ${m.books.join(", ")}`);
    return m;
  }

  /**
   * The module guard (F02, in depth): the same check at a module boundary, for callers that did not
   * come through HTTP. People: authorize(). Agents: an active grant covering the book, and only the
   * few actions an agent may take directly (AGENT_ACTIONS); everything else is an ops plan.
   * System principals: only SYSTEM_ACTIONS (channel adapters). Throws AccessDenied (403).
   */
  async permit(tenant: string, principal: string, action: string, scope: GuardScope = {}, tx?: TransactionSql): Promise<void> {
    if (!isAction(action)) throw denied(`unknown action ${action}`);
    if (principal.startsWith("system:")) {
      if (!SYSTEM_ACTIONS.has(action) || !/^system:[\w.@-]+$/.test(principal)) throw denied(`${principal} may not ${action}`);
      return;
    }
    if (principal.startsWith("agent:")) {
      const m = await this.member(tenant, principal, tx);
      if (!m || m.role !== "agent") throw denied(`${principal} has no grant in workspace ${tenant}`);
      if (!AGENT_ACTIONS.has(action)) throw denied(`an agent may not ${action} directly; it proposes a plan for a person`);
      if (scope.book !== undefined && !inScope(m, scope.book)) throw denied(`${principal} is not granted book ${scope.book}`);
      if (scope.allBooks && m.books !== null) throw denied(`${principal} is limited to books ${m.books.join(", ")}`);
      return;
    }
    await this.authorize(tenant, principal, action, scope, tx);
  }

  /** Add a member directly: operator tooling, MCP grants and tests. People normally arrive by enrolment. */
  async addMember(tenant: string, by: string, m: { principal: string; books?: string[] | null; displayName?: string; source?: Member["source"] }): Promise<Member> {
    const role = roleOf(m.principal);
    if (!isRole(role) && role !== "agent") throw new IdentityError("bad_role", `unknown role in ${m.principal}`);
    const keys = await this.store.keys(tenant);
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [prev] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source FROM identity.members
        WHERE tenant_id = ${tenant} AND principal = ${m.principal}`;
      const name = m.displayName ?? m.principal.slice(role.length + 1);
      const [r] = await tx<Row[]>`
        INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
        VALUES (${tenant}, ${m.principal}, ${role}, ${m.books ?? null}, ${keys.seal(name, memberNameCtx(m.principal))}, ${m.source ?? "operator"}, ${by})
        ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', books = EXCLUDED.books, revoked_by = NULL, revoked_at = NULL
        RETURNING tenant_id, principal, role, books, display_name, status, source`;
      const member = toMember(r!, keys);
      if (!prev || prev.status !== "active") {
        await this.audit(tx, tenant, by, [{ type: "MemberAdded", data: { principal: member.principal, role: member.role, books: member.books,
          source: member.source, displayName: member.displayName, reactivated: !!prev } }]);
      } else if (!sameBooks(prev.books, member.books) || prev.role !== member.role) {
        await this.audit(tx, tenant, by, [{ type: "MemberRoleChanged", data: { principal: member.principal, role: member.role, books: member.books,
          previousRole: prev.role, previousBooks: prev.books } }]);
        // FIN-MDM-04: approvals this member (or anyone holding a delegation from them) recorded no longer stand.
        await this.authorityChanged(tx, tenant, { approvers: [member.principal, ...(await this.authority.delegatesOf(tx, tenant, member.principal))],
          books: null, reason: `${member.principal} changed role or book scope` });
      }
      return member;
    });
  }

  /** MCP grants from configuration become agent members limited to their book (A12). */
  async syncAgentGrants(grants: { tenant: string; book: string; principal: string }[]) {
    const byKey = new Map<string, { tenant: string; principal: string; books: Set<string> }>();
    for (const g of grants) {
      const k = `${g.tenant}\u0000${g.principal}`;
      const e = byKey.get(k) ?? { tenant: g.tenant, principal: g.principal, books: new Set<string>() };
      e.books.add(g.book); byKey.set(k, e);
    }
    for (const g of byKey.values()) await this.addMember(g.tenant, "config", { principal: g.principal, books: [...g.books], source: "config" });
  }

  async revoke(tenant: string, by: string, principal: string) {
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [m] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source FROM identity.members
        WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
      if (!m) throw new IdentityError("not_found", `no active member ${principal}`, 404);
      if (m.role === "owner") {
        const [o] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM identity.members WHERE tenant_id = ${tenant} AND role = 'owner' AND status = 'active'`;
        if (o!.n <= 1) throw new IdentityError("last_owner", "a workspace keeps at least one owner", 409);
      }
      await tx`UPDATE identity.members SET status = 'revoked', revoked_by = ${by}, revoked_at = now() WHERE tenant_id = ${tenant} AND principal = ${principal}`;
      await this.audit(tx, tenant, by, [{ type: "MemberRemoved", data: { principal } }]);
      // FIN-MDM-04/05: their approvals (and their delegates') no longer stand, and plans they saved are stale.
      await this.authorityChanged(tx, tenant, { approvers: [principal, ...(await this.authority.delegatesOf(tx, tenant, principal))],
        books: null, stalePreparedBy: [principal], reason: `${principal} was removed from the workspace` });
    });
  }

  /**
   * A one-time enrolment code for a new member (or, from operator tooling, for the owner of an
   * existing workspace that predates passkeys). Only the hash is stored.
   */
  async invite(tenant: string, by: string, i: { role: Role; displayName: string; books?: string[] | null; principal?: string; ttlHours?: number }) {
    if (!isRole(i.role)) throw new IdentityError("bad_role", `unknown role ${i.role}`);
    const principal = i.principal ?? `${i.role}:${slug(i.displayName) || i.role}`;
    if (roleOf(principal) !== i.role || !/^[a-z]+:[\w.@-]+$/.test(principal)) throw new IdentityError("bad_principal", `principal ${principal} must be ${i.role}:<name>`);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(this.now() + (i.ttlHours ?? ENROLMENT_TTL_HOURS) * 3600_000);
    const keys = await this.store.keys(tenant), hash = sha(token);
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [exists] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
      if (exists) throw new IdentityError("member_exists", `${principal} is already a member`, 409);
      await tx`INSERT INTO identity.enrolments (tenant_id, token_hash, principal, role, books, display_name, created_by, expires_at)
        VALUES (${tenant}, ${hash}, ${principal}, ${i.role}, ${i.books ?? null}, ${keys.seal(i.displayName, enrolmentNameCtx(hash))}, ${by}, ${expiresAt})`;
      await this.audit(tx, tenant, by, [{ type: "InvitationIssued", data: { invitation: hash, principal, role: i.role, books: i.books ?? null, expiresAt: expiresAt.toISOString() } }]);
    });
    return { token, principal, role: i.role, books: i.books ?? null, expiresAt: expiresAt.toISOString() };
  }

  async settings(tenant: string): Promise<Separation> {
    const [r] = await this.store.tenantTx(tenant, (tx) => tx<{ solo_owner: boolean; sod_limit_paise: string | null }[]>`
      SELECT solo_owner, sod_limit_paise::text FROM identity.settings WHERE tenant_id = ${tenant}`);
    return { soloOwner: r?.solo_owner ?? false, sodLimitPaise: r?.sod_limit_paise ?? null };
  }

  async setSettings(tenant: string, by: string, s: Separation) {
    if (s.sodLimitPaise !== null && !/^\d+$/.test(s.sodLimitPaise)) throw new IdentityError("bad_limit", "limit must be whole paise");
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [prev] = await tx<{ solo_owner: boolean; sod_limit_paise: string | null }[]>`
        SELECT solo_owner, sod_limit_paise::text FROM identity.settings WHERE tenant_id = ${tenant}`;
      await tx`
        INSERT INTO identity.settings (tenant_id, solo_owner, sod_limit_paise, updated_by) VALUES (${tenant}, ${s.soloOwner}, ${s.sodLimitPaise}, ${by})
        ON CONFLICT (tenant_id) DO UPDATE SET solo_owner = EXCLUDED.solo_owner, sod_limit_paise = EXCLUDED.sod_limit_paise, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await this.audit(tx, tenant, by, [{ type: "SettingsChanged", data: { soloOwner: s.soloOwner, sodLimitPaise: s.sodLimitPaise,
        previous: prev ? { soloOwner: prev.solo_owner, sodLimitPaise: prev.sod_limit_paise } : null } }]);
    });
    return this.settings(tenant);
  }

  // ------------------------------------------------------------------ operations guard (F02)
  async check(q: OpsGuardQuery): Promise<void> {
    const { step, tenant, book, principal, op, plan } = q;
    if (principal === COPILOT) {
      // The copilot prepares plans for the person who asked; the person's role decides.
      if (step !== "plan" || !q.onBehalfOf || q.onBehalfOf.startsWith("agent:")) throw denied("the copilot proposes; a person commits");
      await this.authorize(tenant, q.onBehalfOf, op.kind === "write" ? "plan.prepare" : "read", { book });
      return;
    }
    if (principal.startsWith("agent:")) {
      const m = await this.member(tenant, principal);
      if (!m || m.role !== "agent") throw denied(`${principal} has no grant in workspace ${tenant}`);
      if (!inScope(m, book)) throw denied(`${principal} is not granted book ${book}`);
      if (step === "discard" && plan?.createdBy !== principal) throw denied("an agent may withdraw only its own plans");
      if (step === "approve" || step === "execute") throw denied("approvals are recorded and carried out by people");
      return;                                        // commit authority is then limited by policy (needsPerson)
    }
    if (!/^[a-z]+:/.test(principal) || principal.startsWith("system:")) throw denied(`${principal} may not use operations`);
    if (step === "plan") { await this.authorize(tenant, principal, op.kind === "write" ? "plan.prepare" : "read", { book }); return; }
    if (!plan) throw denied("no plan to check");
    if (step === "discard") {
      const own = plan.createdBy === principal || plan.requestedBy === principal;
      await this.authorize(tenant, principal, own ? "plan.prepare" : "plan.discard", { book });
      return;
    }
    if (step === "execute") {
      // FIN-MDM-04: carrying out someone else's recorded approval. The executor must be a person who
      // may prepare plans in this book; the approver's authority is checked again, in full, now.
      await this.authorize(tenant, principal, "plan.prepare", { book });
      if (!q.approvedBy) throw denied("no recorded approval to execute");
      await this.approverAuthority({ ...q, principal: q.approvedBy });
      return;
    }
    await this.approverAuthority(q);                 // commit (approve and execute at once) or approve
  }

  /**
   * FIN-MDM-04: may `q.principal` approve this plan now? Role and book scope, or a current
   * delegation, within the authority matrix's amount band; no related-party conflict with a party
   * the plan pays; separation of duties from its preparer (explicit single-owner exception kept).
   */
  private async approverAuthority(q: OpsGuardQuery) {
    const { tenant, book, principal, op, plan } = q;
    if (!plan) throw denied("no plan to check");
    const action: Action = op.gate === "human" ? "plan.approve.period" : "plan.approve";
    const { member: m } = await this.authority.approvalAuthority(tenant, principal, action, book, planAmount(plan));
    await this.authority.checkConflicts(tenant, principal, q.parties ?? []);
    await this.separation(tenant, m as Member, plan);
  }

  /** Why a plan needs someone other than its preparer to approve it, or null. */
  async separationReason(tenant: string, plan: Plan): Promise<string | null> {
    if (plan.gate === "human") return "this is a period operation";
    const s = await this.settings(tenant);
    const limits = (plan.policy?.ids ?? []).map((id) => this.policies.policies.find((p) => p.policyId === id)?.amountLimitInr)
      .filter((x): x is number => typeof x === "number").map((x) => BigInt(x) * 100n);
    const limit = s.sodLimitPaise !== null ? BigInt(s.sodLimitPaise) : limits.length ? limits.reduce((a, b) => (a < b ? a : b)) : null;
    if (limit !== null && planAmount(plan) > limit) return `the amount is above the approval limit of ₹${(limit / 100n).toLocaleString("en-IN")}`;
    return null;
  }

  private async separation(tenant: string, approver: Member, plan: Plan) {
    const preparer = plan.requestedBy ?? plan.createdBy;
    if (preparer !== approver.principal) return;
    const reason = await this.separationReason(tenant, plan);
    if (!reason) return;
    // Explicit single-owner exception: set by the owner, and only while they are the only person.
    if (approver.role === "owner" && (await this.settings(tenant)).soloOwner && (await this.people(tenant)) === 1) return;
    throw denied(`${reason}: it needs approval by someone other than its preparer (${preparer})`);
  }

  private async people(tenant: string): Promise<number> {
    const [r] = await this.store.tenantTx(tenant, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM identity.members WHERE tenant_id = ${tenant} AND status = 'active' AND role <> 'agent'`);
    return r!.n;
  }

  // ------------------------------------------------------------------ passkeys (WebAuthn)
  private challenge(kind: "reg" | "auth", tenant: string): Uint8Array<ArrayBuffer> {
    const rand = randomBytes(16), exp = Buffer.alloc(8);
    exp.writeBigUInt64BE(BigInt(this.now() + CHALLENGE_TTL_MS));
    const tag = createHmac("sha256", this.challengeKey).update(`${kind}|${tenant}|`).update(rand).update(exp).digest().subarray(0, 16);
    const out = new Uint8Array(40);
    out.set(rand, 0); out.set(exp, 16); out.set(tag, 24);
    return out;
  }

  /** Accept a challenge we issued, for this ceremony and tenant, unexpired, once. */
  private checkChallenge(kind: "reg" | "auth", tenant: string) {
    return (c: string) => {
      const b = Buffer.from(c, "base64url");
      if (b.length !== 40) return false;
      const rand = b.subarray(0, 16), exp = b.subarray(16, 24), tag = b.subarray(24);
      const want = createHmac("sha256", this.challengeKey).update(`${kind}|${tenant}|`).update(rand).update(exp).digest().subarray(0, 16);
      if (!timingSafeEqual(tag, want)) return false;
      const expires = Number(exp.readBigUInt64BE());
      return expires > this.now() && this.used.claim(rand.toString("hex"), expires, this.now());
    };
  }

  private validTenant(tenant: string) {
    if (!TENANT_RE.test(tenant)) throw new IdentityError("bad_workspace", "workspace names are lowercase letters, digits and dashes");
  }

  /** Serialize membership changes per tenant (first-owner races, last-owner checks). */
  private async lockTenant(tx: TransactionSql, tenant: string) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"identity:" + tenant}, 0))`;
  }

  /**
   * A workspace can be claimed by a first owner only while it has no members and no data (identity
   * events alone, such as an agent grant from configuration, are not data).
   */
  private async claimable(tx: TransactionSql, tenant: string): Promise<boolean> {
    const [m] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND role <> 'agent' LIMIT 1`;
    if (m) return false;
    const [e] = await tx`SELECT 1 FROM es.events WHERE tenant_id = ${tenant} AND module <> 'identity' LIMIT 1`;
    return !e;
  }

  private async enrolment(tx: TransactionSql, tenant: string, code: string, lock = false) {
    const [r] = lock
      ? await tx<{ principal: string; role: string; books: string[] | null; display_name: string }[]>`
          SELECT principal, role, books, display_name FROM identity.enrolments
          WHERE tenant_id = ${tenant} AND token_hash = ${sha(code)} AND used_at IS NULL AND expires_at > now() FOR UPDATE`
      : await tx<{ principal: string; role: string; books: string[] | null; display_name: string }[]>`
          SELECT principal, role, books, display_name FROM identity.enrolments
          WHERE tenant_id = ${tenant} AND token_hash = ${sha(code)} AND used_at IS NULL AND expires_at > now()`;
    if (!r) throw new IdentityError("bad_code", "that invitation code is not valid (used, expired or for another workspace)", 403);
    return r;
  }

  /** Options for `navigator.credentials.create`: a first owner for a new workspace, or an invited member. */
  async registrationOptions(tenant: string, i: { displayName: string; enrolment?: string }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    this.validTenant(tenant);
    const displayName = i.displayName.trim().slice(0, 80);
    if (displayName.length < 2) throw new IdentityError("bad_name", "enter your name");
    const principal = await this.store.tenantTx(tenant, async (tx) => {
      if (i.enrolment) return (await this.enrolment(tx, tenant, i.enrolment)).principal;
      if (!(await this.claimable(tx, tenant))) throw new IdentityError("workspace_taken", "that workspace already exists: sign in with your passkey, or ask its owner for an invitation", 409);
      return `owner:${slug(displayName) || "owner"}`;
    });
    return generateRegistrationOptions({
      rpName: this.o.rpName ?? "Kuber", rpID: this.o.rpId, userName: `${principal.split(":")[1]}@${tenant}`, userDisplayName: displayName,
      userID: new Uint8Array(randomBytes(32)), challenge: this.challenge("reg", tenant), attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
  }

  /** Verify the new passkey and create the membership it belongs to, atomically. */
  async register(tenant: string, i: { displayName: string; enrolment?: string; response: RegistrationResponseJSON; session?: string | null }): Promise<Member> {
    this.validTenant(tenant);
    const displayName = i.displayName.trim().slice(0, 80);
    let v;
    try {
      v = await verifyRegistrationResponse({ response: i.response, expectedChallenge: this.checkChallenge("reg", tenant),
        expectedOrigin: this.o.origins, expectedRPID: this.o.rpId, requireUserVerification: true });
    } catch (e) { throw new IdentityError("passkey_rejected", `passkey registration failed: ${e instanceof Error ? e.message : String(e)}`, 401); }
    if (!v.verified) throw new IdentityError("passkey_rejected", "passkey registration could not be verified", 401);
    const cred = v.registrationInfo.credential;
    const keys = await this.store.keys(tenant);
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      let member: Member;
      const events: NewEvent[] = [];
      if (i.enrolment) {
        const e = await this.enrolment(tx, tenant, i.enrolment, true);
        const hash = sha(i.enrolment);
        await tx`UPDATE identity.enrolments SET used_at = now() WHERE tenant_id = ${tenant} AND token_hash = ${hash}`;
        const [prev] = await tx<{ status: string }[]>`SELECT status FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${e.principal}`;
        const name = displayName || openName(keys, e.display_name, enrolmentNameCtx(hash));
        const [r] = await tx<Row[]>`
          INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
          VALUES (${tenant}, ${e.principal}, ${e.role}, ${e.books}, ${keys.seal(name, memberNameCtx(e.principal))}, 'enrolment', ${e.principal})
          ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', role = EXCLUDED.role, books = EXCLUDED.books,
            display_name = EXCLUDED.display_name, revoked_by = NULL, revoked_at = NULL
          RETURNING tenant_id, principal, role, books, display_name, status, source`;
        member = toMember(r!, keys);
        events.push({ type: "InvitationRedeemed", data: { invitation: hash, principal: member.principal, credentialId: cred.id } },
          { type: "MemberAdded", data: { principal: member.principal, role: member.role, books: member.books, source: member.source,
            displayName: member.displayName, reactivated: !!prev } });
      } else {
        if (!(await this.claimable(tx, tenant))) throw new IdentityError("workspace_taken", "that workspace already exists", 409);
        const principal = `owner:${slug(displayName) || "owner"}`;
        const [r] = await tx<Row[]>`
          INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
          VALUES (${tenant}, ${principal}, 'owner', NULL, ${keys.seal(displayName, memberNameCtx(principal))}, 'passkey', ${principal})
          RETURNING tenant_id, principal, role, books, display_name, status, source`;
        member = toMember(r!, keys);
        events.push({ type: "MemberAdded", data: { principal, role: "owner", books: null, source: "passkey", displayName: member.displayName, reactivated: false } });
      }
      await tx`INSERT INTO identity.credentials (tenant_id, credential_id, principal, public_key, counter, transports)
        VALUES (${tenant}, ${cred.id}, ${member.principal}, ${Buffer.from(cred.publicKey)}, ${cred.counter}, ${cred.transports ?? []})`;
      events.push({ type: "CredentialRegistered", data: { principal: member.principal, credentialId: cred.id } });
      await this.audit(tx, tenant, member.principal, events);
      if (i.session) await this.bindSession(tx, tenant, i.session, member.principal, cred.id);
      return member;
    });
  }

  /** Options for `navigator.credentials.get`: any discoverable passkey of this workspace. */
  async authenticationOptions(tenant: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    this.validTenant(tenant);
    return generateAuthenticationOptions({ rpID: this.o.rpId, challenge: this.challenge("auth", tenant), userVerification: "required" });
  }

  /** Verify a passkey assertion; returns the active member it belongs to. */
  async authenticate(tenant: string, i: { response: AuthenticationResponseJSON; session?: string | null }): Promise<Member> {
    this.validTenant(tenant);
    const fail = () => new IdentityError("passkey_rejected", "that passkey is not registered for this workspace", 401);
    const [c] = await this.store.tenantTx(tenant, (tx) => tx<{ credential_id: string; principal: string; public_key: Buffer; counter: string; transports: string[] }[]>`
      SELECT c.credential_id, c.principal, c.public_key, c.counter::text, c.transports FROM identity.credentials c
      JOIN identity.members m ON m.tenant_id = c.tenant_id AND m.principal = c.principal AND m.status = 'active'
      WHERE c.tenant_id = ${tenant} AND c.credential_id = ${String(i.response?.id ?? "")} AND c.revoked_at IS NULL`);
    if (!c) throw fail();
    let v;
    try {
      v = await verifyAuthenticationResponse({ response: i.response, expectedChallenge: this.checkChallenge("auth", tenant),
        expectedOrigin: this.o.origins, expectedRPID: this.o.rpId, requireUserVerification: true,
        credential: { id: c.credential_id, publicKey: new Uint8Array(c.public_key), counter: Number(c.counter), transports: c.transports } });
    } catch (e) { throw new IdentityError("passkey_rejected", `passkey sign-in failed: ${e instanceof Error ? e.message : String(e)}`, 401); }
    if (!v.verified) throw fail();
    await this.store.tenantTx(tenant, async (tx) => {
      await tx`UPDATE identity.credentials SET counter = ${v.authenticationInfo.newCounter}, last_used_at = now()
        WHERE tenant_id = ${tenant} AND credential_id = ${c.credential_id}`;
      if (i.session) await this.bindSession(tx, tenant, i.session, c.principal, c.credential_id);
    });
    const m = await this.member(tenant, c.principal);
    if (!m) throw fail();
    return m;
  }

  /**
   * Development sign-in (KUBER_DEV_SIGNIN=true only): an owner by name, for a workspace that has
   * no people yet or where that owner already exists. No proof of identity: never in production.
   */
  async devSignIn(tenant: string, name: string, session?: string | null): Promise<Member> {
    if (!this.o.devSignIn) throw denied("development sign-in is disabled");
    this.validTenant(tenant);
    const principal = `owner:${slug(name) || "owner"}`;
    const keys = await this.store.keys(tenant);
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [r] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source FROM identity.members
        WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
      if (r) {
        if (session) await this.bindSession(tx, tenant, session, principal, null);
        return toMember(r, keys);
      }
      const [people] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND role <> 'agent' AND status = 'active' LIMIT 1`;
      if (people) throw denied("this workspace has members: sign in with a passkey");
      const [prev] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${principal}`;
      const [n] = await tx<Row[]>`
        INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
        VALUES (${tenant}, ${principal}, 'owner', NULL, ${keys.seal(name.trim().slice(0, 80), memberNameCtx(principal))}, 'dev', ${principal})
        ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', revoked_by = NULL, revoked_at = NULL
        RETURNING tenant_id, principal, role, books, display_name, status, source`;
      const member = toMember(n!, keys);
      await this.audit(tx, tenant, principal, [{ type: "MemberAdded", data: { principal, role: "owner", books: null, source: "dev",
        displayName: member.displayName, reactivated: !!prev } }]);
      if (session) await this.bindSession(tx, tenant, session, principal, null);
      return member;
    });
  }

  // ------------------------------------------------------------------ passkey and session revocation
  /** A member's passkeys (never the key material). */
  async credentials(tenant: string, principal: string) {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ credential_id: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }[]>`
      SELECT credential_id, created_at, last_used_at, revoked_at FROM identity.credentials
      WHERE tenant_id = ${tenant} AND principal = ${principal} ORDER BY created_at`);
    return rows.map((r) => ({ credentialId: r.credential_id, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null,
      revokedAt: r.revoked_at?.toISOString() ?? null }));
  }

  /**
   * Revoke a passkey: it can no longer sign in, and sessions bound to it at sign-in stop working.
   * `by` may revoke its own passkeys; `anyMember` (members.manage, checked by the caller) any in the workspace.
   */
  async revokeCredential(tenant: string, by: string, credentialId: string, opts: { anyMember?: boolean } = {}) {
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [c] = await tx<{ principal: string; revoked_at: Date | null }[]>`
        SELECT principal, revoked_at FROM identity.credentials WHERE tenant_id = ${tenant} AND credential_id = ${credentialId} FOR UPDATE`;
      if (!c || (!opts.anyMember && c.principal !== by)) throw new IdentityError("not_found", "no such passkey", 404);
      if (c.revoked_at) return;
      await tx`UPDATE identity.credentials SET revoked_at = now(), revoked_by = ${by} WHERE tenant_id = ${tenant} AND credential_id = ${credentialId}`;
      await this.audit(tx, tenant, by, [{ type: "CredentialRevoked", data: { principal: c.principal, credentialId } }]);
    });
  }

  /** Record which principal and passkey a web session was issued for (first binding wins). */
  private async bindSession(tx: TransactionSql, tenant: string, session: string, principal: string, credentialId: string | null) {
    await tx`INSERT INTO identity.sessions (tenant_id, session_hash, principal, credential_id)
      VALUES (${tenant}, ${sessionHash(session)}, ${principal}, ${credentialId}) ON CONFLICT (tenant_id, session_hash) DO NOTHING`;
  }

  /**
   * Sign-out: revoke a session id. Works for sessions the core never saw bound (revocation list),
   * and is idempotent. `by` is the signed-in principal the session belongs to.
   */
  async revokeSession(tenant: string, session: string, by: string) {
    const h = sessionHash(session);
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [prev] = await tx<{ revoked_at: Date | null; principal: string | null }[]>`
        SELECT revoked_at, principal FROM identity.sessions WHERE tenant_id = ${tenant} AND session_hash = ${h} FOR UPDATE`;
      if (prev?.revoked_at) return;
      if (prev) await tx`UPDATE identity.sessions SET revoked_at = now(), revoked_by = ${by} WHERE tenant_id = ${tenant} AND session_hash = ${h}`;
      else await tx`INSERT INTO identity.sessions (tenant_id, session_hash, principal, revoked_at, revoked_by) VALUES (${tenant}, ${h}, ${by}, now(), ${by})`;
      await this.audit(tx, tenant, by, [{ type: "SessionRevoked", data: { session: h, principal: prev?.principal ?? by } }]);
    });
  }

  /**
   * Is this session still good for `principal`? No when it was revoked, when it was bound to
   * another principal, or when the passkey it was issued for has been revoked. A session the core
   * has no record of (issued before binding existed, or by development tooling) is good until revoked.
   */
  async sessionActive(tenant: string, session: string, principal: string): Promise<boolean> {
    const [r] = await this.store.tenantTx(tenant, (tx) => tx<{ revoked: boolean; principal: string | null; credential_revoked: boolean }[]>`
      SELECT s.revoked_at IS NOT NULL AS revoked, s.principal, c.revoked_at IS NOT NULL AS credential_revoked
      FROM identity.sessions s LEFT JOIN identity.credentials c ON c.tenant_id = s.tenant_id AND c.credential_id = s.credential_id
      WHERE s.tenant_id = ${tenant} AND s.session_hash = ${sessionHash(session)}`);
    if (!r) return true;
    return !r.revoked && !r.credential_revoked && (r.principal === null || r.principal === principal);
  }
}
