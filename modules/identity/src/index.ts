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
import type { CommandSignature, Envelope } from "@kuber/contracts";
import type { OpsGuard, OpsGuardQuery, Plan } from "@kuber/ops";
import type { PolicyEngine } from "@kuber/policy";
import { ReplayCache } from "@kuber/auth";
import { ACTIONS, EXTERNAL_ROLES, LEGACY_ALIASES, PARTY_BOUND_ROLES, POLICY_CHECKER, ROLE_MODEL_V2_REASON, TREASURY_OPS, can, isPersonRole, isRole, mayNot,
  prefixMatchesRole, prefixOf, roleOf, type Action, type LegacyRole, type PersonRole, type Role } from "./roles.ts";
import { Authority, type AuthorityChange, type AuthorityChangeHook, type IdentityHost } from "./authority.ts";
import { AutonomySwitch } from "./autonomy.ts";
import { AccessReview } from "./access-review.ts";
import { IDENTITY_FIN_MIGRATIONS } from "./fin-migrations.ts";
import { IDENTITY_V2_MIGRATIONS } from "./v2-migrations.ts";
import { DEV_STEP_UP_NOTE, SIGNED_EVENT_TYPES, SIGNING_MIGRATIONS, SignedCommands, SigningError, TWO_AUTHENTICATOR_ROLES, expectedBinding,
  verifyCommandSignature, type SignatureReport, type SigningIntent } from "./signing.ts";
import { STEP_UP_MAX_AGE_MS, stepUpFresh } from "@kuber/auth";

export * from "./roles.ts";
export { IDENTITY_V2_MIGRATIONS } from "./v2-migrations.ts";
export { Authority, DELEGABLE, DOA_DEFAULTS, DOA_SOURCE, type AuthorityBasis, type AuthorityChange, type AuthorityChangeHook, type Delegation } from "./authority.ts";
export { AutonomySwitch, SWITCH_SCOPES, type AutonomySwitchState, type SwitchScope } from "./autonomy.ts";
export { AGENT_ACTION_FALLBACKS, AGENT_GOVERNANCE_ACTIONS, actionsFor, authorizeNamed, type AgentGovernanceAction } from "./agent-actions.ts";
export { AccessReview, REVIEW_DECISIONS, type AccessReviewReport, type ReviewDecision, type ReviewItem } from "./access-review.ts";
export { IDENTITY_FIN_MIGRATIONS, accessReviewNoteCtx, autonomyReasonCtx, relatedPartyNoteCtx, rlsForTables } from "./fin-migrations.ts";
export { DEV_STEP_UP_NOTE, SIGNED_EVENT_TYPES, SIGNING_TTL_MS, SigningError, TWO_AUTHENTICATOR_ROLES, commandDigest, expectedBinding, lockSubjectHash,
  summaryHash, verifyCommandSignature, type SignatureReport, type SigningIntent } from "./signing.ts";

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
}, {
  // Member management: a role change re-keys the principal (its prefix is its role) and records the
  // successor, so maker-checker still recognizes the person. (Passkey revocation columns: identity-002.)
  id: "identity-004-member-succession",
  sql: `ALTER TABLE identity.members ADD COLUMN succeeded_by TEXT;`,
}, ...IDENTITY_FIN_MIGRATIONS, ...SIGNING_MIGRATIONS, ...IDENTITY_V2_MIGRATIONS, {
  // Design 7.3 data use: the owner's opt-in to offline policy optimisation (Dream-RSI) of this
  // tenant's history. Off by default; extraction of a replay pool refuses without it.
  id: "identity-dream-001-optimisation-opt-in",
  sql: `ALTER TABLE identity.settings ADD COLUMN optimisation_opt_in BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN optimisation_opt_in_by TEXT, ADD COLUMN optimisation_opt_in_at TIMESTAMPTZ;`,
}];

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
/** A party's portal stream (role model v2): queries its customer raised. */
export const portalStream = (tenant: string, partyId: string) => `${tenant}/portal/${partyId}`;
/** A time-limited share of one item with a guest (role model v2). */
export interface Share { shareId: string; grantee: string; itemType: "snapshot" | "report"; itemId: string; expiresAt: string; grantedBy: string }

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
  tenant: string; principal: string; role: Role; books: string[] | null;
  displayName: string; status: "active" | "revoked"; source: string;
  /** The party a Customer or Supplier membership is bound to (role model v2); null for every other role. */
  partyId: string | null;
}
/**
 * Separation-of-duties settings. `requireTwoAuthenticators` (off by default, design 16.4): owners
 * and controllers with fewer than two active passkeys may not sign step-up-class approvals.
 */
export interface Separation {
  /**
   * The explicit single-superuser exception (role model v2 name; stored as solo_owner). `soloOwner`
   * is the earlier name, still accepted on input and returned alongside.
   */
  soloSuperuser?: boolean; soloOwner?: boolean;
  sodLimitPaise: string | null; requireTwoAuthenticators?: boolean;
}
/** Settings as read: both names of the single-superuser exception. */
export interface SeparationSettings { soloSuperuser: boolean; soloOwner: boolean; sodLimitPaise: string | null; requireTwoAuthenticators: boolean }
/** A member's passkey, as listed for management (never the key material). */
export interface Credential { credentialId: string; principal: string; transports: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
/** `role` may be a legacy name (preparer), which stands for its role (staff). */
export interface MemberChange { role?: PersonRole | LegacyRole; books?: string[] | null }
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
/** Ceremony kinds bound into a challenge; step-up challenges are also bound to the principal. */
type Ceremony = "reg" | "auth" | "stepup" | "addkey";

type Row = { tenant_id: string; principal: string; role: string; books: string[] | null; display_name: string; status: string; source: string; party_id?: string | null };
/** Rows written before names were sealed are plaintext until the sealing migration has run. */
const openName = (keys: TenantKeys, v: string, ctx: string) => (isToken(v) ? keys.openText(v, ctx) : v);
const toMember = (r: Row, keys: TenantKeys): Member => ({ tenant: r.tenant_id, principal: r.principal, role: r.role as Member["role"], books: r.books,
  displayName: openName(keys, r.display_name, memberNameCtx(r.principal)), status: r.status as Member["status"], source: r.source, partyId: r.party_id ?? null });
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
  /** Design 14.4/16.4: device-signed high-risk commands. */
  private readonly signing: SignedCommands;
  constructor(private store: EventStore, private policies: PolicyEngine, private o: IdentityOptions) {
    this.now = o.now ?? Date.now;
    this.signing = new SignedCommands({ store, rpId: o.rpId, origins: o.origins, now: () => this.now(),
      requireSecondPasskey: (t, p, tx) => this.requireSecondPasskey(t, p, tx) });
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
  /** AGT-09: is the model-driven copilot halted for this book (scope 'copilot', independent of autonomy)? */
  copilotHalted(tenant: string, book: string, tx?: TransactionSql): Promise<boolean> { return this.autonomy.halted(tenant, book, tx, "copilot"); }

  get devSignInEnabled() { return !!this.o.devSignIn; }

  // ------------------------------------------------------------------ membership
  /** The active membership of `principal`; in `tx` when given (the caller's tenant transaction). */
  async member(tenant: string, principal: string, tx?: TransactionSql): Promise<Member | null> {
    const q = (t: TransactionSql) => t<Row[]>`
      SELECT tenant_id, principal, role, books, display_name, status, source, party_id FROM identity.members
      WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
    const [r] = tx ? await q(tx) : await this.store.tenantTx(tenant, q);
    return r ? toMember(r, await this.store.keys(tenant)) : null;
  }

  async members(tenant: string): Promise<Member[]> {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<Row[]>`
      SELECT tenant_id, principal, role, books, display_name, status, source, party_id FROM identity.members
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
    if (!can(m.role, action)) throw denied(mayNot(principal, m.role, action));
    if (scope.book !== undefined && !inScope(m, scope.book)) throw denied(`${principal} has no access to book ${scope.book}`);
    if (scope.allBooks && m.books !== null) throw denied(`${principal} is limited to books ${m.books.join(", ")}`);
    // Party-bound roles (role model v2): every portal action concerns the party the membership is bound to, and only it.
    if (PARTY_BOUND_ROLES.has(m.role) && action.startsWith("portal.")) {
      if (!m.partyId) throw denied(`${principal} is not bound to a party`);
      if (scope.party !== undefined && scope.party !== m.partyId) throw denied(`${principal} may act only for party ${m.partyId}`);
    }
    return m;
  }

  /**
   * The party a Customer or Supplier member may act for with `action` (role model v2): the party
   * its membership is bound to, never one taken from the request. Every portal query is filtered to
   * this party at the module boundary.
   */
  async boundParty(tenant: string, principal: string, action: Action, tx?: TransactionSql): Promise<string> {
    const m = await this.authorize(tenant, principal, action, {}, tx);
    if (!PARTY_BOUND_ROLES.has(m.role) || !m.partyId) throw denied(`${principal} is not bound to a party`);
    return m.partyId;
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
      if (principal === POLICY_CHECKER) throw denied(`${POLICY_CHECKER} is the policy engine's checker identity: it is recorded as checker, it never acts`);
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
  async addMember(tenant: string, by: string, m: { principal: string; books?: string[] | null; displayName?: string; source?: Member["source"]; partyId?: string | null }): Promise<Member> {
    // The prefix is the role or a legacy alias of it (owner:laksh is a superuser); agent:policy is never a member.
    const role = m.principal === POLICY_CHECKER ? "agent_checker" : roleOf(m.principal);
    if (!isPersonRole(role) && role !== "agent") throw new IdentityError("bad_role", `unknown role in ${m.principal}`);
    const partyId = this.partyFor(role, m.partyId);
    const keys = await this.store.keys(tenant);
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [prev] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source, party_id FROM identity.members
        WHERE tenant_id = ${tenant} AND principal = ${m.principal}`;
      const name = m.displayName ?? m.principal.slice(m.principal.indexOf(":") + 1);
      const [r] = await tx<Row[]>`
        INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by, party_id)
        VALUES (${tenant}, ${m.principal}, ${role}, ${m.books ?? null}, ${keys.seal(name, memberNameCtx(m.principal))}, ${m.source ?? "operator"}, ${by}, ${partyId})
        ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', books = EXCLUDED.books, role = EXCLUDED.role, party_id = EXCLUDED.party_id,
          revoked_by = NULL, revoked_at = NULL
        RETURNING tenant_id, principal, role, books, display_name, status, source, party_id`;
      const member = toMember(r!, keys);
      if (!prev || prev.status !== "active") {
        await this.audit(tx, tenant, by, [{ type: "MemberAdded", data: { principal: member.principal, role: member.role, books: member.books,
          source: member.source, displayName: member.displayName, reactivated: !!prev, ...(member.partyId ? { partyId: member.partyId } : {}) } }]);
      } else if (!sameBooks(prev.books, member.books) || prev.role !== member.role || (prev.party_id ?? null) !== member.partyId) {
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
      const [m] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source, party_id FROM identity.members
        WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
      if (!m) throw new IdentityError("not_found", `no active member ${principal}`, 404);
      if (m.role === "superuser") await this.keepOneSuperuser(tx, tenant);
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
  async invite(tenant: string, by: string, input: { role: PersonRole | LegacyRole; displayName: string; books?: string[] | null; principal?: string; ttlHours?: number; partyId?: string | null }) {
    const i = { ...input, role: (LEGACY_ALIASES[input.role] ?? input.role) as PersonRole };
    if (!isPersonRole(i.role)) throw new IdentityError("bad_role", `unknown role ${i.role}`);
    // New principals use the new prefixes; an explicit legacy principal (operator tooling re-inviting
    // someone whose history is under owner:<name>) is accepted when its prefix is an alias of the role.
    const principal = i.principal ?? `${i.role}:${slug(i.displayName) || i.role}`;
    if (!prefixMatchesRole(principal, i.role) || !Principal.safeParse(principal).success) throw new IdentityError("bad_principal", `principal ${principal} must be ${i.role}:<name>`);
    const partyId = this.partyFor(i.role, i.partyId);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(this.now() + (i.ttlHours ?? ENROLMENT_TTL_HOURS) * 3600_000);
    const keys = await this.store.keys(tenant), hash = sha(token);
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [exists] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
      if (exists) throw new IdentityError("member_exists", `${principal} is already a member (to restore access for someone who lost their passkeys, an operator runs identity-cli recover)`, 409);
      await tx`INSERT INTO identity.enrolments (tenant_id, token_hash, principal, role, books, display_name, created_by, expires_at, party_id)
        VALUES (${tenant}, ${hash}, ${principal}, ${i.role}, ${i.books ?? null}, ${keys.seal(i.displayName, enrolmentNameCtx(hash))}, ${by}, ${expiresAt}, ${partyId})`;
      await this.audit(tx, tenant, by, [{ type: "InvitationIssued", data: { invitation: hash, principal, role: i.role, books: i.books ?? null, expiresAt: expiresAt.toISOString(),
        ...(partyId ? { partyId } : {}) } }]);
    });
    return { token, principal, role: i.role, books: i.books ?? null, partyId, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Account recovery (design 16.4), operator tooling only: a one-time code with which an EXISTING
   * active member who lost access registers a new passkey for the same principal (same role, books
   * and maker-checker history). Audited: RecoveryIssued now, RecoveryCompleted when redeemed. With
   * `revokeExisting` (the default) redeeming it revokes the member's other passkeys, and so the
   * sessions bound to them. Only the code's hash is stored.
   */
  async recover(tenant: string, by: string, principal: string, i: { reason: string; ttlHours?: number; revokeExisting?: boolean }) {
    const reason = i.reason.trim();
    if (reason.length < 3) throw new IdentityError("bad_reason", "say why access is being recovered");
    const token = randomBytes(24).toString("base64url"), hash = sha(token);
    const expiresAt = new Date(this.now() + (i.ttlHours ?? 24) * 3600_000);
    const revokeExisting = i.revokeExisting ?? true;
    const keys = await this.store.keys(tenant);
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [m] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source, party_id FROM identity.members
        WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
      if (!m || m.role === "agent") throw new IdentityError("not_found", `no active member ${principal} to recover (invite new people instead)`, 404);
      const name = openName(keys, m.display_name, memberNameCtx(principal));
      // Outstanding recovery codes for this principal stop working: only the newest one counts.
      await tx`UPDATE identity.enrolments SET used_at = now() WHERE tenant_id = ${tenant} AND principal = ${principal} AND purpose = 'recovery' AND used_at IS NULL`;
      await tx`INSERT INTO identity.enrolments (tenant_id, token_hash, principal, role, books, display_name, created_by, expires_at, purpose, revoke_existing)
        VALUES (${tenant}, ${hash}, ${principal}, ${m.role}, ${m.books}, ${keys.seal(name, enrolmentNameCtx(hash))}, ${by}, ${expiresAt}, 'recovery', ${revokeExisting})`;
      await this.audit(tx, tenant, by, [{ type: "RecoveryIssued", data: { invitation: hash, principal, reason, revokeExisting, expiresAt: expiresAt.toISOString() } }]);
    });
    return { token, principal, revokeExisting, expiresAt: expiresAt.toISOString() };
  }

  async settings(tenant: string, tx?: TransactionSql): Promise<SeparationSettings> {
    const q = (t: TransactionSql) => t<{ solo_owner: boolean; sod_limit_paise: string | null; require_two_authenticators: boolean }[]>`
      SELECT solo_owner, sod_limit_paise::text, require_two_authenticators FROM identity.settings WHERE tenant_id = ${tenant}`;
    const [r] = tx ? await q(tx) : await this.store.tenantTx(tenant, q);
    const solo = r?.solo_owner ?? false;
    return { soloSuperuser: solo, soloOwner: solo, sodLimitPaise: r?.sod_limit_paise ?? null, requireTwoAuthenticators: r?.require_two_authenticators ?? false };
  }

  /** Design 7.3: has the owner allowed this tenant's history to be used for offline policy optimisation? */
  async optimisationOptIn(tenant: string, tx?: TransactionSql): Promise<boolean> {
    const q = (t: TransactionSql) => t<{ optimisation_opt_in: boolean }[]>`
      SELECT optimisation_opt_in FROM identity.settings WHERE tenant_id = ${tenant}`;
    const [r] = tx ? await q(tx) : await this.store.tenantTx(tenant, q);
    return r?.optimisation_opt_in ?? false;
  }

  /** Opt the tenant in to (or out of) offline policy optimisation. Superusers only (authority.manage: a data-use decision, not an admin setting); recorded in the identity stream. */
  async setOptimisationOptIn(tenant: string, by: string, optIn: boolean): Promise<boolean> {
    await this.store.tenantTx(tenant, async (tx) => {
      await this.authorize(tenant, by, "authority.manage", { allBooks: true }, tx);
      await this.lockTenant(tx, tenant);
      const [prev] = await tx<{ optimisation_opt_in: boolean }[]>`SELECT optimisation_opt_in FROM identity.settings WHERE tenant_id = ${tenant}`;
      await tx`INSERT INTO identity.settings (tenant_id, updated_by, optimisation_opt_in, optimisation_opt_in_by, optimisation_opt_in_at)
        VALUES (${tenant}, ${by}, ${optIn}, ${by}, now())
        ON CONFLICT (tenant_id) DO UPDATE SET optimisation_opt_in = EXCLUDED.optimisation_opt_in, optimisation_opt_in_by = EXCLUDED.optimisation_opt_in_by,
          optimisation_opt_in_at = now(), updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await this.audit(tx, tenant, by, [{ type: "OptimisationOptInChanged", data: { optIn, previous: prev ? prev.optimisation_opt_in : null } }]);
    });
    return this.optimisationOptIn(tenant);
  }

  /**
   * `requireTwoAuthenticators` left out keeps its current value. The single-superuser exception is
   * `soloSuperuser`; the earlier name `soloOwner` is accepted too (the event keeps `soloOwner`,
   * as recorded in sealed history).
   */
  async setSettings(tenant: string, by: string, input: Separation) {
    if (input.soloSuperuser !== undefined && input.soloOwner !== undefined && input.soloSuperuser !== input.soloOwner)
      throw new IdentityError("bad_settings", "soloSuperuser and its earlier name soloOwner disagree");
    const s = { soloOwner: input.soloSuperuser ?? input.soloOwner ?? false, sodLimitPaise: input.sodLimitPaise, requireTwoAuthenticators: input.requireTwoAuthenticators };
    if (s.sodLimitPaise !== null && !/^\d+$/.test(s.sodLimitPaise)) throw new IdentityError("bad_limit", "limit must be whole paise");
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [prev] = await tx<{ solo_owner: boolean; sod_limit_paise: string | null; require_two_authenticators: boolean }[]>`
        SELECT solo_owner, sod_limit_paise::text, require_two_authenticators FROM identity.settings WHERE tenant_id = ${tenant}`;
      const two = s.requireTwoAuthenticators ?? prev?.require_two_authenticators ?? false;
      await tx`
        INSERT INTO identity.settings (tenant_id, solo_owner, sod_limit_paise, require_two_authenticators, updated_by) VALUES (${tenant}, ${s.soloOwner}, ${s.sodLimitPaise}, ${two}, ${by})
        ON CONFLICT (tenant_id) DO UPDATE SET solo_owner = EXCLUDED.solo_owner, sod_limit_paise = EXCLUDED.sod_limit_paise,
          require_two_authenticators = EXCLUDED.require_two_authenticators, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await this.audit(tx, tenant, by, [{ type: "SettingsChanged", data: { soloOwner: s.soloOwner, sodLimitPaise: s.sodLimitPaise, requireTwoAuthenticators: two,
        previous: prev ? { soloOwner: prev.solo_owner, sodLimitPaise: prev.sod_limit_paise, requireTwoAuthenticators: prev.require_two_authenticators } : null } }]);
    });
    return this.settings(tenant);
  }

  /**
   * Change a person's role and/or book scope. A principal's prefix is its role, so a role change
   * creates the successor principal (`approver:asha` → `controller:asha`), moves the passkeys to
   * it and revokes the old one, recording the succession: the person signs in again with the same
   * passkey, and maker-checker still treats both principals as one person.
   */
  async changeMember(tenant: string, by: string, principal: string, change: MemberChange): Promise<Member> {
    if (change.role !== undefined) change = { ...change, role: LEGACY_ALIASES[change.role] ?? change.role };
    if (change.role !== undefined && !isPersonRole(change.role)) throw new IdentityError("bad_role", `unknown role ${String(change.role)}`);
    if (change.books !== undefined && change.books !== null && (!Array.isArray(change.books) || !change.books.length || change.books.some((b) => typeof b !== "string" || !b)))
      throw new IdentityError("bad_books", "books is a non-empty list of book ids, or null for every book");
    const keys = await this.store.keys(tenant);
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [r] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source, party_id FROM identity.members
        WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
      if (!r) throw new IdentityError("not_found", `no active member ${principal}`, 404);
      if (r.role === "agent") throw new IdentityError("agent_grant", "agent grants come from configuration", 400);
      const role = change.role ?? (r.role as Role);
      const books = change.books !== undefined ? change.books : r.books;
      // Party-bound memberships are created by invitation with their party; a role change never moves into or out of one.
      if (role !== r.role && (PARTY_BOUND_ROLES.has(role as Role) || PARTY_BOUND_ROLES.has(r.role as Role)))
        throw new IdentityError("party_bound", "customer and supplier memberships are bound to a party: invite a new member instead of changing the role", 400);
      if (r.role === "superuser" && role !== "superuser") await this.keepOneSuperuser(tx, tenant);
      if (role === r.role) {
        const [u] = await tx<Row[]>`UPDATE identity.members SET books = ${books} WHERE tenant_id = ${tenant} AND principal = ${principal}
          RETURNING tenant_id, principal, role, books, display_name, status, source, party_id`;
        if (!sameBooks(r.books, books)) await this.audit(tx, tenant, by, [{ type: "MemberRoleChanged", data: { principal, role, books,
          previousRole: r.role, previousBooks: r.books } }]);
        return toMember(u!, keys);
      }
      const next = `${role}:${principal.slice(principal.indexOf(":") + 1)}`;
      const [taken] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${next} AND status = 'active'`;
      if (taken) throw new IdentityError("member_exists", `${next} is already a member`, 409);
      // The sealed name is bound to its principal: open it under the old one, seal it under the new.
      const name = openName(keys, r.display_name, memberNameCtx(principal));
      const [n] = await tx<Row[]>`
        INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
        VALUES (${tenant}, ${next}, ${role}, ${books}, ${keys.seal(name, memberNameCtx(next))}, ${r.source}, ${by})
        ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', books = EXCLUDED.books, display_name = EXCLUDED.display_name,
          revoked_by = NULL, revoked_at = NULL, succeeded_by = NULL
        RETURNING tenant_id, principal, role, books, display_name, status, source, party_id`;
      await tx`UPDATE identity.credentials SET principal = ${next} WHERE tenant_id = ${tenant} AND principal = ${principal}`;
      await tx`UPDATE identity.members SET status = 'revoked', revoked_by = ${by}, revoked_at = now(), succeeded_by = ${next}
        WHERE tenant_id = ${tenant} AND principal = ${principal}`;
      await this.audit(tx, tenant, by, [{ type: "MemberRoleChanged", data: { principal: next, role, books, previousRole: r.role,
        previousBooks: r.books, previousPrincipal: principal } }]);
      return toMember(n!, keys);
    });
  }

  /** True when `later` is `earlier` or one of its successors after role changes. */
  private async samePerson(tenant: string, earlier: string, later: string): Promise<boolean> {
    if (earlier === later) return true;
    return this.store.tenantTx(tenant, async (tx) => {
      let p: string | null = earlier;
      for (let hops = 0; p && hops < 32; hops++) {
        const [r]: { succeeded_by: string | null }[] = await tx<{ succeeded_by: string | null }[]>`
          SELECT succeeded_by FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${p}`;
        p = r?.succeeded_by ?? null;
        if (p === later) return true;
      }
      return false;
    });
  }

  // ------------------------------------------------------------------ operations guard (F02)
  async check(q: OpsGuardQuery): Promise<void> {
    const { step, tenant, book, principal, op, plan } = q;
    // Role model v2: the policy engine's checker identity is recorded on commits, it never acts itself.
    if (principal === POLICY_CHECKER) throw denied(`${POLICY_CHECKER} is the policy engine's checker identity: it is recorded as checker, it never acts`);
    if (q.approvedBy === COPILOT || q.approvedBy === POLICY_CHECKER) throw denied(`${q.approvedBy} can never be the recorded approver of a plan`);
    if (principal === COPILOT) {
      // The copilot prepares plans for the person who asked; the person's role decides. A language
      // model is never a checker: it cannot commit, approve or execute anything.
      if (step !== "plan" || !q.onBehalfOf || q.onBehalfOf.startsWith("agent:")) throw denied("the copilot proposes; a person commits (a language model is never a checker)");
      await this.authorize(tenant, q.onBehalfOf, op.kind === "write" ? "plan.prepare" : "read", { book });
      return;
    }
    if (principal.startsWith("agent:")) {
      const m = await this.member(tenant, principal);
      if (!m || m.role !== "agent") throw denied(`${principal} has no grant in workspace ${tenant}`);
      if (!inScope(m, book)) throw denied(`${principal} is not granted book ${book}`);
      if (step === "discard" && plan?.createdBy !== principal) throw denied("an agent may withdraw only its own plans");
      if (step === "approve" || step === "execute") throw denied("approvals are recorded and carried out by people");
      // Commit: allowed only as far as policy clears it (needsPerson, agentCheckerExclusion); the
      // checker recorded is then agent:policy, never this agent.
      return;
    }
    if (!/^[a-z_]+:/.test(principal) || principal.startsWith("system:")) throw denied(`${principal} may not use operations`);
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
    // A schedule approval moves no journal itself; its band amount is the per-occurrence amount it approves.
    const approved = (plan.data as { approvedAmount?: string } | undefined)?.approvedAmount;
    const amount = approved && /^\d+$/.test(approved) && BigInt(approved) > planAmount(plan) ? BigInt(approved) : planAmount(plan);
    const { member: m } = await this.authority.approvalAuthority(tenant, principal, action, book, amount);
    // A treasurer approves treasury plans only (payments, reconciliation, rebalance, cash allocation).
    if (m.role === "treasurer" && !TREASURY_OPS.has(op.name)) throw denied(`a treasurer approves treasury plans only (${[...TREASURY_OPS].join(", ")}), not ${op.name}`);
    await this.authority.checkConflicts(tenant, principal, q.parties ?? []);
    // Conflict matrix: whoever verified a party's bank details does not also approve a payment to it (POL-501).
    for (const v of q.bankVerifiers ?? []) {
      if (await this.samePerson(tenant, v.principal, principal))
        throw denied(`${principal} verified the bank details of ${v.partyId}, so may not approve a payment to it: another person approves (conflict matrix, POL-501)`);
    }
    await this.separation(tenant, m as Member, plan);
  }

  /**
   * Role model v2 (Agent Checker, OpsGuard): why policy clearance alone may not commit this plan,
   * so a person must check it. Amounts above the approval limit always need a human checker.
   */
  async agentCheckerExclusion(tenant: string, plan: Plan): Promise<string | null> {
    if (plan.gate === "human") return "period operations always need a person as checker";
    const s = await this.separationReason(tenant, plan);
    return s ? `${s}, which always needs a person as checker` : null;
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

  /**
   * Why committing this plan needs a fresh passkey step-up, or null: the same plans that need
   * separation of duties (period operations, amounts above the approval limit).
   */
  stepUpReason(tenant: string, plan: Plan): Promise<string | null> { return this.separationReason(tenant, plan); }

  private async separation(tenant: string, approver: Member, plan: Plan) {
    const preparer = plan.requestedBy ?? plan.createdBy;
    if (!(await this.samePerson(tenant, preparer, approver.principal))) return;
    const reason = await this.separationReason(tenant, plan);
    if (!reason) return;
    // Explicit single-superuser exception: set by the superuser, and only while they are the only person.
    if (approver.role === "superuser" && (await this.settings(tenant)).soloSuperuser && (await this.people(tenant)) === 1) return;
    throw denied(`${reason}: it needs approval by someone other than its preparer (${preparer})`);
  }

  private async people(tenant: string): Promise<number> {
    const [r] = await this.store.tenantTx(tenant, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM identity.members WHERE tenant_id = ${tenant} AND status = 'active'
        AND role NOT IN ('agent', 'customer', 'supplier', 'investor', 'guest')`);
    return r!.n;
  }

  /** The party a membership of `role` is bound to: required for Customer and Supplier, refused for every other role. */
  private partyFor(role: string, partyId: string | null | undefined): string | null {
    if (PARTY_BOUND_ROLES.has(role as Role)) {
      if (!partyId || !/^[A-Za-z0-9_.:@+-]{1,200}$/.test(partyId)) throw new IdentityError("party_required", `a ${role} membership is bound to one party: give its party id`);
      return partyId;
    }
    if (partyId) throw new IdentityError("not_party_bound", `a ${role} membership is not bound to a party`);
    return null;
  }

  /** A workspace keeps at least one superuser (legacy owners count: their memberships are superusers). */
  private async keepOneSuperuser(tx: TransactionSql, tenant: string) {
    const [o] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM identity.members WHERE tenant_id = ${tenant} AND role IN ('superuser', 'owner') AND status = 'active'`;
    if (o!.n <= 1) throw new IdentityError("last_owner", "a workspace keeps at least one owner (superuser)", 409);
  }

  // ------------------------------------------------------------------ role model v2: data migration
  /**
   * Rewrite legacy role values (owner, approver → superuser; preparer, member → staff) in every
   * tenant's memberships, pending invitations and authority bands. Principals keep their names
   * (they are identifiers in sealed history). Each member changed gets a MemberRoleChanged event
   * with the reason "role model v2", in the same transaction. Idempotent: a second run finds
   * nothing to change and writes nothing. Returns the members changed per tenant.
   */
  async migrateRoleModel(): Promise<Record<string, number>> {
    const legacy = Object.keys(LEGACY_ALIASES);
    const tenants = (await this.store.systemTx((tx) => tx<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id FROM identity.members WHERE role IN ${tx(legacy)}
      UNION SELECT DISTINCT tenant_id FROM identity.enrolments WHERE role IN ${tx(legacy)} AND used_at IS NULL
      ORDER BY 1`)).map((r) => r.tenant_id);
    const out: Record<string, number> = {};
    for (const tenant of tenants) out[tenant] = await this.migrateTenantRoles(tenant);
    return out;
  }

  /** The role model v2 migration of one tenant (see migrateRoleModel). */
  async migrateTenantRoles(tenant: string): Promise<number> {
    const legacy = Object.keys(LEGACY_ALIASES);
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const rows = await tx<{ principal: string; role: string; books: string[] | null }[]>`
        SELECT principal, role, books FROM identity.members WHERE tenant_id = ${tenant} AND role IN ${tx(legacy)} ORDER BY created_at, principal FOR UPDATE`;
      const events: NewEvent[] = [];
      for (const r of rows) {
        const role = LEGACY_ALIASES[r.role]!;
        await tx`UPDATE identity.members SET role = ${role} WHERE tenant_id = ${tenant} AND principal = ${r.principal}`;
        events.push({ type: "MemberRoleChanged", data: { principal: r.principal, role, books: r.books, previousRole: r.role, previousBooks: r.books,
          reason: ROLE_MODEL_V2_REASON } });
      }
      for (const [from, to] of Object.entries(LEGACY_ALIASES)) {
        await tx`UPDATE identity.enrolments SET role = ${to} WHERE tenant_id = ${tenant} AND role = ${from}`;
        // Owner bands become superuser bands; approver bands stay (approver principals keep that band).
        if (from !== "approver") {
          await tx`UPDATE identity.authority_bands b SET role = ${to} WHERE tenant_id = ${tenant} AND role = ${from}
            AND NOT EXISTS (SELECT 1 FROM identity.authority_bands x WHERE x.tenant_id = b.tenant_id AND x.action = b.action AND x.book_id = b.book_id AND x.role = ${to})`;
        }
      }
      await this.audit(tx, tenant, "system:migration", events);
      return rows.length;
    });
  }

  // ------------------------------------------------------------------ role model v2: guest shares and portal queries
  /**
   * Share a certified snapshot or a report with a guest until `expiresAt` (share.grant). The guest
   * reads it, and nothing else, until then (share.read). `itemId`: a snapshot id, or
   * `<book>/<report kind>` for a report.
   */
  async grantShare(tenant: string, by: string, s: { grantee: string; itemType: "snapshot" | "report"; itemId: string; expiresAt: string }): Promise<Share> {
    const expires = new Date(s.expiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= this.now()) throw new IdentityError("bad_expiry", "a share expires in the future");
    if (!/^[A-Za-z0-9_.:@+/-]{1,200}$/.test(s.itemId)) throw new IdentityError("bad_item", "item ids are identifiers");
    const shareId = `shr-${randomBytes(12).toString("hex")}`;
    return this.store.tenantTx(tenant, async (tx) => {
      await this.authorize(tenant, by, "share.grant", { allBooks: true }, tx);
      const g = await this.member(tenant, s.grantee, tx);
      if (!g || g.role !== "guest") throw new IdentityError("bad_grantee", `${s.grantee} is not an active guest of this workspace`, 404);
      await tx`INSERT INTO identity.shares (tenant_id, share_id, grantee, item_type, item_id, expires_at, granted_by)
        VALUES (${tenant}, ${shareId}, ${s.grantee}, ${s.itemType}, ${s.itemId}, ${expires}, ${by})`;
      await this.audit(tx, tenant, by, [{ type: "ShareGranted", data: { shareId, grantee: s.grantee, itemType: s.itemType, itemId: s.itemId, expiresAt: expires.toISOString() } }]);
      return { shareId, grantee: s.grantee, itemType: s.itemType, itemId: s.itemId, expiresAt: expires.toISOString(), grantedBy: by };
    });
  }

  async revokeShare(tenant: string, by: string, shareId: string) {
    await this.store.tenantTx(tenant, async (tx) => {
      await this.authorize(tenant, by, "share.grant", { allBooks: true }, tx);
      const [r] = await tx<{ grantee: string }[]>`UPDATE identity.shares SET revoked_at = now(), revoked_by = ${by}
        WHERE tenant_id = ${tenant} AND share_id = ${shareId} AND revoked_at IS NULL RETURNING grantee`;
      if (!r) throw new IdentityError("not_found", `no active share ${shareId}`, 404);
      await this.audit(tx, tenant, by, [{ type: "ShareRevoked", data: { shareId, grantee: r.grantee } }]);
    });
  }

  /** The unexpired, unrevoked shares granted to this guest (share.read). Expired shares are never returned. */
  async sharesFor(tenant: string, principal: string): Promise<Share[]> {
    await this.authorize(tenant, principal, "share.read");
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ share_id: string; grantee: string; item_type: "snapshot" | "report"; item_id: string; expires_at: Date; granted_by: string }[]>`
      SELECT share_id, grantee, item_type, item_id, expires_at, granted_by FROM identity.shares
      WHERE tenant_id = ${tenant} AND grantee = ${principal} AND revoked_at IS NULL AND expires_at > ${new Date(this.now())} ORDER BY granted_at, share_id`);
    return rows.map((r) => ({ shareId: r.share_id, grantee: r.grantee, itemType: r.item_type, itemId: r.item_id, expiresAt: r.expires_at.toISOString(), grantedBy: r.granted_by }));
  }

  /** One share of this guest, if it is unexpired and unrevoked; otherwise 404 (an expired share is as if it never existed). */
  async shareFor(tenant: string, principal: string, shareId: string): Promise<Share> {
    const s = (await this.sharesFor(tenant, principal)).find((x) => x.shareId === shareId);
    if (!s) throw new IdentityError("not_found", `no current share ${shareId}`, 404);
    return s;
  }

  /** Shares granted in the workspace (share.grant): for the people who manage them. */
  async shares(tenant: string, by: string): Promise<(Share & { revoked: boolean; expired: boolean })[]> {
    await this.authorize(tenant, by, "share.grant", { allBooks: true });
    const now = this.now();
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ share_id: string; grantee: string; item_type: "snapshot" | "report"; item_id: string; expires_at: Date; granted_by: string; revoked_at: Date | null }[]>`
      SELECT share_id, grantee, item_type, item_id, expires_at, granted_by, revoked_at FROM identity.shares WHERE tenant_id = ${tenant} ORDER BY granted_at, share_id`);
    return rows.map((r) => ({ shareId: r.share_id, grantee: r.grantee, itemType: r.item_type, itemId: r.item_id, expiresAt: r.expires_at.toISOString(), grantedBy: r.granted_by,
      revoked: r.revoked_at !== null, expired: r.expires_at.getTime() <= now }));
  }

  /** Role model v2: may `by` publish snapshots of this book to investors (snapshot.publish)? Records the change in the audit stream, in `tx`. */
  async recordSnapshotPublication(tx: TransactionSql, tenant: string, by: string, p: { snapshotId: string; bookId: string; published: boolean }) {
    await this.authorize(tenant, by, "snapshot.publish", { book: p.bookId }, tx);
    await this.audit(tx, tenant, by, [{ type: "SnapshotPublished", data: p }]);
  }

  /**
   * A customer raises a query about its own records (portal.customer.query): recorded as a
   * PortalQueryOpened event on the party's portal stream, for a person to answer. The party is
   * the one the membership is bound to, never one named in the request.
   */
  async openPortalQuery(tenant: string, principal: string, q: { subject: string; message: string; reference?: string }) {
    const subject = q.subject.trim().slice(0, 200), message = q.message.trim().slice(0, 4000);
    if (subject.length < 2 || message.length < 2) throw new IdentityError("bad_query", "a query has a subject and a message");
    const queryId = `qry-${randomBytes(12).toString("hex")}`;
    return this.store.tenantTx(tenant, async (tx) => {
      const partyId = await this.boundParty(tenant, principal, "portal.customer.query", tx);
      await this.store.append("identity", tenant, { streamId: portalStream(tenant, partyId), expected: "any", events: [{ type: "PortalQueryOpened",
        data: { queryId, partyId, subject, message, ...(q.reference ? { reference: q.reference.slice(0, 200) } : {}) } }] }, { principal }, tx);
      return { queryId, partyId, subject, status: "open" as const };
    });
  }

  /** The queries this customer raised (its own party's portal stream only). */
  async portalQueries(tenant: string, principal: string) {
    const partyId = await this.boundParty(tenant, principal, "portal.customer.read");
    const events = await this.store.readStream(tenant, portalStream(tenant, partyId));
    return events.filter((e) => e.type === "PortalQueryOpened").map((e) => {
      const d = e.data as { queryId: string; subject: string; message: string; reference?: string };
      return { queryId: d.queryId, subject: d.subject, message: d.message, reference: d.reference ?? null, openedAt: e.recordedAt, openedBy: e.meta.principal };
    });
  }

  // ------------------------------------------------------------------ passkeys (WebAuthn)
  private challenge(kind: Ceremony, tenant: string): Uint8Array<ArrayBuffer> {
    const rand = randomBytes(16), exp = Buffer.alloc(8);
    exp.writeBigUInt64BE(BigInt(this.now() + CHALLENGE_TTL_MS));
    const tag = createHmac("sha256", this.challengeKey).update(`${kind}|${tenant}|`).update(rand).update(exp).digest().subarray(0, 16);
    const out = new Uint8Array(40);
    out.set(rand, 0); out.set(exp, 16); out.set(tag, 24);
    return out;
  }

  /** Accept a challenge we issued, for this ceremony and tenant, unexpired, once. */
  private checkChallenge(kind: Ceremony, tenant: string) {
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
    type E = { principal: string; role: string; books: string[] | null; display_name: string; purpose: "enrol" | "recovery"; revoke_existing: boolean; party_id: string | null };
    const [r] = lock
      ? await tx<E[]>`
          SELECT principal, role, books, display_name, purpose, revoke_existing, party_id FROM identity.enrolments
          WHERE tenant_id = ${tenant} AND token_hash = ${sha(code)} AND used_at IS NULL AND expires_at > now() FOR UPDATE`
      : await tx<E[]>`
          SELECT principal, role, books, display_name, purpose, revoke_existing, party_id FROM identity.enrolments
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
      return `superuser:${slug(displayName) || "superuser"}`;
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
      let revokedOnRecovery: string[] = [];
      if (i.enrolment && (await this.enrolment(tx, tenant, i.enrolment, true)).purpose === "recovery") {
        // Recovery: the same member keeps role, books and history; only the passkeys change.
        const e = await this.enrolment(tx, tenant, i.enrolment, true);
        const hash = sha(i.enrolment);
        const [r] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source, party_id FROM identity.members
          WHERE tenant_id = ${tenant} AND principal = ${e.principal} AND status = 'active'`;
        if (!r) throw new IdentityError("bad_code", "that recovery code is for someone who is no longer an active member", 403);
        await tx`UPDATE identity.enrolments SET used_at = now() WHERE tenant_id = ${tenant} AND token_hash = ${hash}`;
        member = toMember(r, keys);
        if (e.revoke_existing) {
          revokedOnRecovery = (await tx<{ credential_id: string }[]>`
            UPDATE identity.credentials SET revoked_at = now(), revoked_by = ${"system:recovery"}
            WHERE tenant_id = ${tenant} AND principal = ${member.principal} AND revoked_at IS NULL RETURNING credential_id`).map((c) => c.credential_id);
        }
        events.push({ type: "InvitationRedeemed", data: { invitation: hash, principal: member.principal, credentialId: cred.id } },
          ...revokedOnRecovery.map((id) => ({ type: "CredentialRevoked" as const, data: { principal: member.principal, credentialId: id } })),
          { type: "RecoveryCompleted", data: { invitation: hash, principal: member.principal, credentialId: cred.id, revokedCredentials: revokedOnRecovery } });
      } else if (i.enrolment) {
        const e = await this.enrolment(tx, tenant, i.enrolment, true);
        const hash = sha(i.enrolment);
        await tx`UPDATE identity.enrolments SET used_at = now() WHERE tenant_id = ${tenant} AND token_hash = ${hash}`;
        const [prev] = await tx<{ status: string }[]>`SELECT status FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${e.principal}`;
        const name = displayName || openName(keys, e.display_name, enrolmentNameCtx(hash));
        // An invitation issued before role model v2 names a legacy role: the membership takes the role it maps to.
        const role = LEGACY_ALIASES[e.role] ?? e.role;
        const [r] = await tx<Row[]>`
          INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by, party_id)
          VALUES (${tenant}, ${e.principal}, ${role}, ${e.books}, ${keys.seal(name, memberNameCtx(e.principal))}, 'enrolment', ${e.principal}, ${e.party_id})
          ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', role = EXCLUDED.role, books = EXCLUDED.books, party_id = EXCLUDED.party_id,
            display_name = EXCLUDED.display_name, revoked_by = NULL, revoked_at = NULL
          RETURNING tenant_id, principal, role, books, display_name, status, source, party_id`;
        member = toMember(r!, keys);
        events.push({ type: "InvitationRedeemed", data: { invitation: hash, principal: member.principal, credentialId: cred.id } },
          { type: "MemberAdded", data: { principal: member.principal, role: member.role, books: member.books, source: member.source,
            displayName: member.displayName, reactivated: !!prev, ...(member.partyId ? { partyId: member.partyId } : {}) } });
      } else {
        if (!(await this.claimable(tx, tenant))) throw new IdentityError("workspace_taken", "that workspace already exists", 409);
        const principal = `superuser:${slug(displayName) || "superuser"}`;
        const [r] = await tx<Row[]>`
          INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
          VALUES (${tenant}, ${principal}, 'superuser', NULL, ${keys.seal(displayName, memberNameCtx(principal))}, 'passkey', ${principal})
          RETURNING tenant_id, principal, role, books, display_name, status, source, party_id`;
        member = toMember(r!, keys);
        events.push({ type: "MemberAdded", data: { principal, role: "superuser", books: null, source: "passkey", displayName: member.displayName, reactivated: false } });
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
    return this.assertion(tenant, i.response, "auth", tenant, null, i.session ?? null);
  }

  /** A passkey assertion (user verification required) for `kind`, optionally by one principal only. */
  private async assertion(tenant: string, response: AuthenticationResponseJSON, kind: Ceremony, binding: string, principal: string | null, session: string | null = null): Promise<Member> {
    const fail = () => new IdentityError("passkey_rejected", "that passkey is not registered for this workspace", 401);
    const [c] = await this.store.tenantTx(tenant, (tx) => tx<{ credential_id: string; principal: string; public_key: Buffer; counter: string; transports: string[] }[]>`
      SELECT c.credential_id, c.principal, c.public_key, c.counter::text, c.transports FROM identity.credentials c
      JOIN identity.members m ON m.tenant_id = c.tenant_id AND m.principal = c.principal AND m.status = 'active'
      WHERE c.tenant_id = ${tenant} AND c.credential_id = ${String(response?.id ?? "")} AND c.revoked_at IS NULL`);
    if (!c) throw fail();
    if (principal !== null && c.principal !== principal) throw new IdentityError("passkey_rejected", "that passkey belongs to someone else", 401);
    let v;
    try {
      v = await verifyAuthenticationResponse({ response, expectedChallenge: this.checkChallenge(kind, binding),
        expectedOrigin: this.o.origins, expectedRPID: this.o.rpId, requireUserVerification: true,
        credential: { id: c.credential_id, publicKey: new Uint8Array(c.public_key), counter: Number(c.counter), transports: c.transports } });
    } catch (e) { throw new IdentityError("passkey_rejected", `passkey ${kind === "stepup" ? "confirmation" : "sign-in"} failed: ${e instanceof Error ? e.message : String(e)}`, 401); }
    if (!v.verified) throw fail();
    await this.store.tenantTx(tenant, async (tx) => {
      await tx`UPDATE identity.credentials SET counter = ${v.authenticationInfo.newCounter}, last_used_at = now()
        WHERE tenant_id = ${tenant} AND credential_id = ${c.credential_id}`;
      if (session) await this.bindSession(tx, tenant, session, c.principal, c.credential_id);
    });
    const m = await this.member(tenant, c.principal);
    if (!m) throw fail();
    return m;
  }

  // ------------------------------------------------------------------ another passkey for a signed-in member
  /**
   * Options for a signed-in member to register another passkey (design 16.4: owners and controllers
   * keep two authenticators). Their existing passkeys are excluded, so the same authenticator is not
   * registered twice.
   */
  async addPasskeyOptions(tenant: string, principal: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    this.validTenant(tenant);
    const m = await this.member(tenant, principal);
    if (!m || m.role === "agent") throw denied(`${principal} is not a member of workspace ${tenant}`);
    const creds = await this.credentials(tenant, principal);
    return generateRegistrationOptions({
      rpName: this.o.rpName ?? "Kuber", rpID: this.o.rpId, userName: `${principal.split(":")[1]}@${tenant}`, userDisplayName: m.displayName,
      userID: new Uint8Array(randomBytes(32)), challenge: this.challenge("addkey", `${tenant}|${principal}`), attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: creds.filter((c) => !c.revokedAt).map((c) => ({ id: c.credentialId, transports: c.transports as never })),
    });
  }

  /**
   * Register another passkey for a signed-in member. Adding a key to an account is itself sensitive:
   * a member who already has a passkey must have confirmed with it within the step-up window
   * (`stepUpAt`, the `su` claim), so a stolen session alone cannot add an attacker's key.
   */
  async addPasskey(tenant: string, principal: string, i: { response: RegistrationResponseJSON; stepUpAt?: number }): Promise<Credential> {
    this.validTenant(tenant);
    if ((await this.passkeyCount(tenant, principal)) > 0 && !stepUpFresh({ principal, su: i.stepUpAt }, this.now(), STEP_UP_MAX_AGE_MS))
      throw new IdentityError("step_up_required", "confirm with one of your existing passkeys first, then register the new one", 403);
    let v;
    try {
      v = await verifyRegistrationResponse({ response: i.response, expectedChallenge: this.checkChallenge("addkey", `${tenant}|${principal}`),
        expectedOrigin: this.o.origins, expectedRPID: this.o.rpId, requireUserVerification: true });
    } catch (e) { throw new IdentityError("passkey_rejected", `passkey registration failed: ${e instanceof Error ? e.message : String(e)}`, 401); }
    if (!v.verified) throw new IdentityError("passkey_rejected", "passkey registration could not be verified", 401);
    const cred = v.registrationInfo.credential;
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [m] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active' AND role <> 'agent'`;
      if (!m) throw denied(`${principal} is not a member of workspace ${tenant}`);
      const [dup] = await tx`SELECT 1 FROM identity.credentials WHERE tenant_id = ${tenant} AND credential_id = ${cred.id}`;
      if (dup) throw new IdentityError("passkey_exists", "that passkey is already registered", 409);
      await tx`INSERT INTO identity.credentials (tenant_id, credential_id, principal, public_key, counter, transports)
        VALUES (${tenant}, ${cred.id}, ${principal}, ${Buffer.from(cred.publicKey)}, ${cred.counter}, ${cred.transports ?? []})`;
      await this.audit(tx, tenant, principal, [{ type: "CredentialRegistered", data: { principal, credentialId: cred.id } }]);
    });
    return (await this.credentials(tenant, principal)).find((c) => c.credentialId === cred.id)!;
  }

  // ------------------------------------------------------------------ step-up (sensitive approvals)
  /** Options for re-confirming a signed-in person with one of their own passkeys. */
  async stepUpOptions(tenant: string, principal: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    this.validTenant(tenant);
    const creds = await this.store.tenantTx(tenant, (tx) => tx<{ credential_id: string; transports: string[] }[]>`
      SELECT c.credential_id, c.transports FROM identity.credentials c
      JOIN identity.members m ON m.tenant_id = c.tenant_id AND m.principal = c.principal AND m.status = 'active'
      WHERE c.tenant_id = ${tenant} AND c.principal = ${principal} AND c.revoked_at IS NULL`);
    if (!creds.length) throw new IdentityError("no_passkey", "you have no passkey in this workspace: ask an owner for an invitation to register one", 409);
    return generateAuthenticationOptions({ rpID: this.o.rpId, challenge: this.challenge("stepup", `${tenant}|${principal}`), userVerification: "required",
      allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports as never })) });
  }

  /** Verify a step-up: a fresh, user-verified assertion by this principal's own passkey. */
  async stepUp(tenant: string, principal: string, i: { response: AuthenticationResponseJSON }): Promise<{ principal: string; at: number }> {
    this.validTenant(tenant);
    const m = await this.assertion(tenant, i.response, "stepup", `${tenant}|${principal}`, principal);
    return { principal: m.principal, at: this.now() };
  }

  /** Development only (devSignIn): a member without any passkey confirms without one. */
  async devStepUp(tenant: string, principal: string): Promise<{ principal: string; at: number }> {
    if (!this.o.devSignIn) throw denied("development sign-in is disabled");
    const [c] = await this.store.tenantTx(tenant, (tx) => tx`
      SELECT 1 FROM identity.credentials WHERE tenant_id = ${tenant} AND principal = ${principal} AND revoked_at IS NULL LIMIT 1`);
    if (c) throw denied("you have a passkey: confirm with it");
    if (!(await this.member(tenant, principal))) throw denied(`${principal} is not a member of workspace ${tenant}`);
    return { principal, at: this.now() };
  }

  /**
   * Development sign-in (KUBER_DEV_SIGNIN=true only): a superuser by name, for a workspace that has
   * no people yet or where that superuser (or a legacy owner of that name) already exists. No proof
   * of identity: never in production.
   */
  async devSignIn(tenant: string, name: string, session?: string | null): Promise<Member> {
    if (!this.o.devSignIn) throw denied("development sign-in is disabled");
    this.validTenant(tenant);
    const who = slug(name) || "superuser";
    const principal = `superuser:${who}`;
    const keys = await this.store.keys(tenant);
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [r] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source, party_id FROM identity.members
        WHERE tenant_id = ${tenant} AND principal IN (${principal}, ${`owner:${who}`}) AND status = 'active' ORDER BY principal = ${principal} DESC LIMIT 1`;
      if (r) {
        if (session) await this.bindSession(tx, tenant, session, r.principal, null);
        return toMember(r, keys);
      }
      const [people] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND role <> 'agent' AND status = 'active' LIMIT 1`;
      if (people) throw denied("this workspace has members: sign in with a passkey");
      const [prev] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${principal}`;
      const [n] = await tx<Row[]>`
        INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
        VALUES (${tenant}, ${principal}, 'superuser', NULL, ${keys.seal(name.trim().slice(0, 80), memberNameCtx(principal))}, 'dev', ${principal})
        ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', revoked_by = NULL, revoked_at = NULL
        RETURNING tenant_id, principal, role, books, display_name, status, source, party_id`;
      const member = toMember(n!, keys);
      await this.audit(tx, tenant, principal, [{ type: "MemberAdded", data: { principal, role: "superuser", books: null, source: "dev",
        displayName: member.displayName, reactivated: !!prev } }]);
      if (session) await this.bindSession(tx, tenant, session, principal, null);
      return member;
    });
  }

  // ------------------------------------------------------------------ passkey and session revocation
  /**
   * Passkeys (never the key material). With `principal`: that member's, revoked ones included.
   * Without: the active passkeys of every active member (member management).
   */
  async credentials(tenant: string, principal?: string): Promise<Credential[]> {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ credential_id: string; principal: string; transports: string[]; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }[]>`
      SELECT c.credential_id, c.principal, c.transports, c.created_at, c.last_used_at, c.revoked_at FROM identity.credentials c
      ${principal !== undefined
        ? tx`WHERE c.tenant_id = ${tenant} AND c.principal = ${principal}`
        : tx`JOIN identity.members m ON m.tenant_id = c.tenant_id AND m.principal = c.principal AND m.status = 'active'
             WHERE c.tenant_id = ${tenant} AND c.revoked_at IS NULL`}
      ORDER BY c.created_at`);
    return rows.map((r) => ({ credentialId: r.credential_id, principal: r.principal, transports: r.transports, createdAt: r.created_at.toISOString(),
      lastUsedAt: r.last_used_at?.toISOString() ?? null, revokedAt: r.revoked_at?.toISOString() ?? null }));
  }

  /**
   * Revoke a passkey: it can no longer sign in, and sessions bound to it at sign-in stop working.
   * `by` may revoke its own passkeys; `anyMember` (members.manage, checked by the caller) any in the
   * workspace. The workspace's only superuser keeps at least one passkey, or nobody could manage it
   * again without operator tooling.
   */
  async revokeCredential(tenant: string, by: string, credentialId: string, opts: { anyMember?: boolean } = {}) {
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [c] = await tx<{ principal: string; revoked_at: Date | null }[]>`
        SELECT principal, revoked_at FROM identity.credentials WHERE tenant_id = ${tenant} AND credential_id = ${credentialId} FOR UPDATE`;
      if (!c || (!opts.anyMember && c.principal !== by)) throw new IdentityError("not_found", "no such passkey", 404);
      if (c.revoked_at) return;
      const [n] = await tx<{ owner: boolean; owners: number; mine: number }[]>`
        SELECT EXISTS (SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${c.principal} AND role IN ('superuser', 'owner') AND status = 'active') AS owner,
               (SELECT count(*)::int FROM identity.members WHERE tenant_id = ${tenant} AND role IN ('superuser', 'owner') AND status = 'active') AS owners,
               (SELECT count(*)::int FROM identity.credentials WHERE tenant_id = ${tenant} AND principal = ${c.principal} AND revoked_at IS NULL) AS mine`;
      if (n!.owner && n!.owners <= 1 && n!.mine <= 1) throw new IdentityError("last_owner_passkey", "the workspace's only owner keeps at least one passkey", 409);
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

  // ------------------------------------------------------------------ signed commands (design 14.4, 16.4)
  /** Active passkeys of a member. */
  async passkeyCount(tenant: string, principal: string, tx?: TransactionSql): Promise<number> {
    const q = (t: TransactionSql) => t<{ n: number }[]>`
      SELECT count(*)::int AS n FROM identity.credentials WHERE tenant_id = ${tenant} AND principal = ${principal} AND revoked_at IS NULL`;
    const [r] = tx ? await q(tx) : await this.store.tenantTx(tenant, q);
    return r!.n;
  }

  /**
   * Owners and controllers with exactly one active passkey (design 16.4: they must register two).
   * Members with none (operator-added, development sign-in) have nothing to sign with yet and are
   * not listed; with `requireTwoAuthenticators` on they cannot sign either.
   */
  async singlePasskeyPeople(tenant: string): Promise<string[]> {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ principal: string }[]>`
      SELECT m.principal FROM identity.members m
      JOIN identity.credentials c ON c.tenant_id = m.tenant_id AND c.principal = m.principal AND c.revoked_at IS NULL
      WHERE m.tenant_id = ${tenant} AND m.status = 'active' AND m.role IN ${tx([...TWO_AUTHENTICATOR_ROLES])}
      GROUP BY m.principal HAVING count(*) = 1 ORDER BY m.principal`);
    return rows.map((r) => r.principal);
  }

  /** For /me: how many passkeys the member has and, for an owner or controller with one, the warning. */
  async passkeyStatus(tenant: string, principal: string): Promise<{ passkeys: number; requireTwoAuthenticators: boolean; warnings: { code: string; message: string }[] }> {
    const [n, s] = await Promise.all([this.passkeyCount(tenant, principal), this.settings(tenant)]);
    const warnings: { code: string; message: string }[] = [];
    if (TWO_AUTHENTICATOR_ROLES.has(roleOf(principal)) && n === 1) {
      warnings.push({ code: "single_passkey", message: s.requireTwoAuthenticators
        ? "You have one passkey. This workspace requires owners and controllers to register a second one before approving high-risk commands."
        : "You have only one passkey. Register a second one (another device or security key) so losing it does not lock you out of approving." });
    }
    return { passkeys: n, requireTwoAuthenticators: s.requireTwoAuthenticators, warnings };
  }

  /** Refuse when the tenant requires two authenticators and this owner or controller has fewer. */
  async requireSecondPasskey(tenant: string, principal: string, tx?: TransactionSql): Promise<void> {
    if (!TWO_AUTHENTICATOR_ROLES.has(roleOf(principal))) return;
    if (!(await this.settings(tenant, tx)).requireTwoAuthenticators) return;
    const n = await this.passkeyCount(tenant, principal, tx);
    if (n < 2) throw new IdentityError("second_passkey_required",
      `this workspace requires owners and controllers to register a second passkey before approving high-risk commands (you have ${n})`, 403);
  }

  /**
   * Step 1 of a signed command: WebAuthn options whose challenge is the digest of exactly `intent`
   * (built by the caller from the command itself), for the principal's own active passkeys.
   */
  async signingOptions(tenant: string, principal: string, intent: SigningIntent) {
    this.validTenant(tenant);
    try { return await this.signing.options(tenant, principal, intent); } catch (e) { throw asIdentityError(e); }
  }

  /**
   * Step 2: a verifier for the command's transaction. Pass the returned function as the command's
   * `attest`: it checks `response` is `principal`'s user-verified passkey signature over exactly
   * `intent`, consumes the single-use request and returns what the command's event stores.
   */
  signedCommand(tenant: string, principal: string, intent: SigningIntent, response: AuthenticationResponseJSON): (tx: TransactionSql) => Promise<CommandSignature> {
    return async (tx) => {
      try { return await this.signing.verify(tx, tenant, principal, intent, response); } catch (e) { throw asIdentityError(e); }
    };
  }

  /**
   * DEVELOPMENT SIGN-IN ONLY: the legacy `su` freshness path, as a fallback for a member who has no
   * passkey while development sign-in is enabled. Returns a record labelled "dev-step-up" (not a
   * signature), or null when the fallback does not apply (production, a member with a passkey, no
   * or stale step-up claim). Two-authenticator enforcement still applies.
   */
  async devAttestation(tenant: string, principal: string, stepUpAt: number | undefined): Promise<CommandSignature | null> {
    if (!this.o.devSignIn) return null;
    if (!stepUpFresh({ principal, su: stepUpAt }, this.now(), STEP_UP_MAX_AGE_MS)) return null;
    if ((await this.passkeyCount(tenant, principal)) > 0) return null;
    await this.requireSecondPasskey(tenant, principal);
    return { kind: "dev-step-up", note: DEV_STEP_UP_NOTE, stepUpAt: stepUpAt!, principal };
  }

  /**
   * Offline verification of every stored command signature in a tenant (`ops verify-signatures`,
   * evidence): each webauthn record is re-checked against the event it is stored in and the stored
   * public key of its credential (revoked keys still verify what they signed). Also lists
   * development confirmations and period operations committed without a signature.
   */
  async verifySignatures(tenant: string): Promise<SignatureReport> {
    const report: SignatureReport = { tenant, checked: 0, valid: 0, failures: [], devStepUps: [], unsignedPeriodOps: [] };
    const keys = new Map<string, { publicKey: Uint8Array; principal: string } | null>();
    let after = "0";
    for (;;) {
      const events = await this.store.tenantTx(tenant, (tx) => this.store.readEvents({ tenantId: tenant, types: [...SIGNED_EVENT_TYPES], after, limit: 500 }, tx));
      if (!events.length) break;
      after = events.at(-1)!.globalPosition;
      for (const env of events) {
        const sig = (env.data as { signature?: CommandSignature }).signature;
        if (!sig) {
          const d = env.data as { gate?: string; planId?: string; approvedBy?: string };
          if (env.type === "PlanApproved" && d.gate === "human" && !d.approvedBy && !/^(agent|system):/.test(env.meta.principal))
            report.unsignedPeriodOps.push({ eventId: env.eventId, planId: d.planId!, principal: env.meta.principal });
          continue;
        }
        if (sig.kind === "dev-step-up") { report.devStepUps.push({ eventId: env.eventId, type: env.type, principal: env.meta.principal }); continue; }
        report.checked++;
        const problems = await this.verifyStoredSignature(tenant, env, sig, keys);
        if (problems.length) report.failures.push({ eventId: env.eventId, type: env.type, streamId: env.streamId, problems });
        else report.valid++;
      }
    }
    return report;
  }

  /** Re-check one stored signature against its event (evidence records call this too). */
  async verifyStoredSignature(tenant: string, env: Pick<Envelope, "type" | "data" | "meta">, sig: CommandSignature,
                              cache = new Map<string, { publicKey: Uint8Array; principal: string } | null>()): Promise<string[]> {
    if (sig.kind !== "webauthn") return ["not a signature: development step-up"];
    const binding = expectedBinding(env);
    if (!binding) return [`${env.type} does not carry command signatures`];
    let key = cache.get(sig.credentialId);
    if (key === undefined) {
      const [c] = await this.store.tenantTx(tenant, (tx) => tx<{ public_key: Buffer; principal: string }[]>`
        SELECT public_key, principal FROM identity.credentials WHERE tenant_id = ${tenant} AND credential_id = ${sig.credentialId}`);
      key = c ? { publicKey: new Uint8Array(c.public_key), principal: c.principal } : null;
      cache.set(sig.credentialId, key);
    }
    const problems = await verifyCommandSignature(sig, binding, key?.publicKey ?? null);
    // The passkey belonged to the signer (or moved to their successor on a role change).
    if (key && !(await this.samePerson(tenant, sig.inputs.principal, key.principal))) problems.push(`credential ${sig.credentialId} belongs to ${key.principal}, not the signer ${sig.inputs.principal}`);
    return problems;
  }
}

const asIdentityError = (e: unknown) => (e instanceof SigningError ? new IdentityError(e.code, e.message, e.statusCode) : e);
