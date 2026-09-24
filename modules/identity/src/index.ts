/**
 * Identity: who may act in a workspace (tenant), and how they prove it (findings F01, F02).
 *
 *   members      one row per principal in a tenant: role, book scope (null = every book), status
 *   credentials  passkeys (WebAuthn public keys) of members; verified here, in the core
 *   enrolments   one-time codes that let a new person register a passkey for an assigned role
 *   settings     separation-of-duties policy per tenant (explicit single-owner exception, limit)
 *
 * Every table is tenant-scoped with row-level security, like the rest of the core.
 *
 * Sign-in ceremonies are stateless on the server: a challenge is random bytes plus an expiry,
 * authenticated with a per-process key, bound to the ceremony kind and tenant, and accepted once.
 *
 * The same service is the operations guard: role, book scope and maker-checker for every plan,
 * commit and discard, whichever surface (web, copilot, MCP) the request came through.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TransactionSql } from "postgres";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { tenantRlsFor, type EventStore, type Migration } from "@kuber/eventstore";
import type { OpsGuard, OpsGuardQuery, Plan } from "@kuber/ops";
import type { PolicyEngine } from "@kuber/policy";
import { ReplayCache } from "@kuber/auth";
import { can, isRole, roleOf, type Action, type Role } from "./roles.ts";

export * from "./roles.ts";

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
  // Member management: a role change re-keys the principal (its prefix is its role) and records the
  // successor, so maker-checker still recognizes the person; passkeys are revoked, not deleted.
  id: "identity-002",
  sql: `
ALTER TABLE identity.members ADD COLUMN succeeded_by TEXT;
ALTER TABLE identity.credentials ADD COLUMN revoked_at TIMESTAMPTZ, ADD COLUMN revoked_by TEXT;
`,
}];

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
/** A member's passkey, as listed for management (never the key material). */
export interface Credential { credentialId: string; principal: string; transports: string[]; createdAt: string; lastUsedAt: string | null }
export interface MemberChange { role?: Role; books?: string[] | null }
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
type Ceremony = "reg" | "auth" | "stepup";

type Row = { tenant_id: string; principal: string; role: string; books: string[] | null; display_name: string; status: string; source: string };
const toMember = (r: Row): Member => ({ tenant: r.tenant_id, principal: r.principal, role: r.role as Member["role"], books: r.books,
  displayName: r.display_name, status: r.status as Member["status"], source: r.source });
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

export class Identity implements OpsGuard {
  private readonly challengeKey = randomBytes(32);
  private readonly used = new ReplayCache(50_000);
  private readonly now: () => number;
  constructor(private store: EventStore, private policies: PolicyEngine, private o: IdentityOptions) {
    this.now = o.now ?? Date.now;
  }

  get devSignInEnabled() { return !!this.o.devSignIn; }

  // ------------------------------------------------------------------ membership
  async member(tenant: string, principal: string): Promise<Member | null> {
    const [r] = await this.store.tenantTx(tenant, (tx) => tx<Row[]>`
      SELECT tenant_id, principal, role, books, display_name, status, source FROM identity.members
      WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`);
    return r ? toMember(r) : null;
  }

  async members(tenant: string): Promise<Member[]> {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<Row[]>`
      SELECT tenant_id, principal, role, books, display_name, status, source FROM identity.members
      WHERE tenant_id = ${tenant} ORDER BY created_at`);
    return rows.map(toMember);
  }

  /**
   * The one authorization check for people: an active membership whose role allows `action`
   * and whose book scope covers `book`. `allBooks` marks tenant-wide resources (drafts,
   * evidence, members), which a book-scoped member may not touch.
   */
  async authorize(tenant: string, principal: string, action: Action, scope: { book?: string; allBooks?: boolean } = {}): Promise<Member> {
    const m = await this.member(tenant, principal);
    if (!m || m.role === "agent") throw denied(`${principal} is not a member of workspace ${tenant}`);
    if (!can(m.role, action)) throw denied(`${m.role} may not ${action}`);
    if (scope.book !== undefined && !inScope(m, scope.book)) throw denied(`${principal} has no access to book ${scope.book}`);
    if (scope.allBooks && m.books !== null) throw denied(`${principal} is limited to books ${m.books.join(", ")}`);
    return m;
  }

  /** Add a member directly: operator tooling, MCP grants and tests. People normally arrive by enrolment. */
  async addMember(tenant: string, by: string, m: { principal: string; books?: string[] | null; displayName?: string; source?: Member["source"] }): Promise<Member> {
    const role = roleOf(m.principal);
    if (!isRole(role) && role !== "agent") throw new IdentityError("bad_role", `unknown role in ${m.principal}`);
    return this.store.tenantTx(tenant, async (tx) => {
      const [r] = await tx<Row[]>`
        INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
        VALUES (${tenant}, ${m.principal}, ${role}, ${m.books ?? null}, ${m.displayName ?? m.principal.slice(role.length + 1)}, ${m.source ?? "operator"}, ${by})
        ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', books = EXCLUDED.books, revoked_by = NULL, revoked_at = NULL
        RETURNING tenant_id, principal, role, books, display_name, status, source`;
      return toMember(r!);
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
    await this.store.tenantTx(tenant, async (tx) => {
      const [exists] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
      if (exists) throw new IdentityError("member_exists", `${principal} is already a member`, 409);
      await tx`INSERT INTO identity.enrolments (tenant_id, token_hash, principal, role, books, display_name, created_by, expires_at)
        VALUES (${tenant}, ${sha(token)}, ${principal}, ${i.role}, ${i.books ?? null}, ${i.displayName}, ${by}, ${expiresAt})`;
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
    await this.store.tenantTx(tenant, (tx) => tx`
      INSERT INTO identity.settings (tenant_id, solo_owner, sod_limit_paise, updated_by) VALUES (${tenant}, ${s.soloOwner}, ${s.sodLimitPaise}, ${by})
      ON CONFLICT (tenant_id) DO UPDATE SET solo_owner = EXCLUDED.solo_owner, sod_limit_paise = EXCLUDED.sod_limit_paise, updated_by = EXCLUDED.updated_by, updated_at = now()`);
    return this.settings(tenant);
  }

  /** Active passkeys of the tenant's active members. */
  async credentials(tenant: string): Promise<Credential[]> {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ credential_id: string; principal: string; transports: string[]; created_at: Date; last_used_at: Date | null }[]>`
      SELECT c.credential_id, c.principal, c.transports, c.created_at, c.last_used_at FROM identity.credentials c
      JOIN identity.members m ON m.tenant_id = c.tenant_id AND m.principal = c.principal AND m.status = 'active'
      WHERE c.tenant_id = ${tenant} AND c.revoked_at IS NULL ORDER BY c.created_at`);
    return rows.map((r) => ({ credentialId: r.credential_id, principal: r.principal, transports: r.transports,
      createdAt: new Date(r.created_at).toISOString(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null }));
  }

  /**
   * Revoke one passkey. The workspace's last owner keeps at least one passkey, or nobody could
   * manage it again without operator tooling.
   */
  async revokeCredential(tenant: string, by: string, credentialId: string) {
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [c] = await tx<{ principal: string; role: string }[]>`
        SELECT c.principal, m.role FROM identity.credentials c
        JOIN identity.members m ON m.tenant_id = c.tenant_id AND m.principal = c.principal AND m.status = 'active'
        WHERE c.tenant_id = ${tenant} AND c.credential_id = ${credentialId} AND c.revoked_at IS NULL`;
      if (!c) throw new IdentityError("not_found", "no such active passkey", 404);
      if (c.role === "owner") {
        const [n] = await tx<{ owners: number; mine: number }[]>`
          SELECT (SELECT count(*)::int FROM identity.members WHERE tenant_id = ${tenant} AND role = 'owner' AND status = 'active') AS owners,
                 (SELECT count(*)::int FROM identity.credentials WHERE tenant_id = ${tenant} AND principal = ${c.principal} AND revoked_at IS NULL) AS mine`;
        if (n!.owners <= 1 && n!.mine <= 1) throw new IdentityError("last_owner_passkey", "the workspace's only owner keeps at least one passkey", 409);
      }
      await tx`UPDATE identity.credentials SET revoked_at = now(), revoked_by = ${by} WHERE tenant_id = ${tenant} AND credential_id = ${credentialId}`;
    });
  }

  /**
   * Change a person's role and/or book scope. A principal's prefix is its role, so a role change
   * creates the successor principal (`approver:asha` → `controller:asha`), moves the passkeys to
   * it and revokes the old one, recording the succession: the person signs in again with the same
   * passkey, and maker-checker still treats both principals as one person.
   */
  async changeMember(tenant: string, by: string, principal: string, change: MemberChange): Promise<Member> {
    if (change.role !== undefined && !isRole(change.role)) throw new IdentityError("bad_role", `unknown role ${String(change.role)}`);
    if (change.books !== undefined && change.books !== null && (!Array.isArray(change.books) || !change.books.length || change.books.some((b) => typeof b !== "string" || !b)))
      throw new IdentityError("bad_books", "books is a non-empty list of book ids, or null for every book");
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [r] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source FROM identity.members
        WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
      if (!r) throw new IdentityError("not_found", `no active member ${principal}`, 404);
      if (r.role === "agent") throw new IdentityError("agent_grant", "agent grants come from configuration", 400);
      const role = change.role ?? (r.role as Role);
      const books = change.books !== undefined ? change.books : r.books;
      if (r.role === "owner" && role !== "owner") {
        const [o] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM identity.members WHERE tenant_id = ${tenant} AND role = 'owner' AND status = 'active'`;
        if (o!.n <= 1) throw new IdentityError("last_owner", "a workspace keeps at least one owner", 409);
      }
      if (role === r.role) {
        const [u] = await tx<Row[]>`UPDATE identity.members SET books = ${books} WHERE tenant_id = ${tenant} AND principal = ${principal}
          RETURNING tenant_id, principal, role, books, display_name, status, source`;
        return toMember(u!);
      }
      const next = `${role}:${principal.slice(principal.indexOf(":") + 1)}`;
      const [taken] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND principal = ${next} AND status = 'active'`;
      if (taken) throw new IdentityError("member_exists", `${next} is already a member`, 409);
      const [n] = await tx<Row[]>`
        INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
        VALUES (${tenant}, ${next}, ${role}, ${books}, ${r.display_name}, ${r.source}, ${by})
        ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', books = EXCLUDED.books, display_name = EXCLUDED.display_name,
          revoked_by = NULL, revoked_at = NULL, succeeded_by = NULL
        RETURNING tenant_id, principal, role, books, display_name, status, source`;
      await tx`UPDATE identity.credentials SET principal = ${next} WHERE tenant_id = ${tenant} AND principal = ${principal}`;
      await tx`UPDATE identity.members SET status = 'revoked', revoked_by = ${by}, revoked_at = now(), succeeded_by = ${next}
        WHERE tenant_id = ${tenant} AND principal = ${principal}`;
      return toMember(n!);
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
    const m = await this.authorize(tenant, principal, op.gate === "human" ? "plan.approve.period" : "plan.approve", { book });
    await this.separation(tenant, m, plan);
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

  /** A workspace can be claimed by a first owner only while it has no members and no data. */
  private async claimable(tx: TransactionSql, tenant: string): Promise<boolean> {
    const [m] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND role <> 'agent' LIMIT 1`;
    if (m) return false;
    const [e] = await tx`SELECT 1 FROM es.events WHERE tenant_id = ${tenant} LIMIT 1`;
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
  async register(tenant: string, i: { displayName: string; enrolment?: string; response: RegistrationResponseJSON }): Promise<Member> {
    this.validTenant(tenant);
    const displayName = i.displayName.trim().slice(0, 80);
    let v;
    try {
      v = await verifyRegistrationResponse({ response: i.response, expectedChallenge: this.checkChallenge("reg", tenant),
        expectedOrigin: this.o.origins, expectedRPID: this.o.rpId, requireUserVerification: true });
    } catch (e) { throw new IdentityError("passkey_rejected", `passkey registration failed: ${e instanceof Error ? e.message : String(e)}`, 401); }
    if (!v.verified) throw new IdentityError("passkey_rejected", "passkey registration could not be verified", 401);
    const cred = v.registrationInfo.credential;
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      let member: Member;
      if (i.enrolment) {
        const e = await this.enrolment(tx, tenant, i.enrolment, true);
        await tx`UPDATE identity.enrolments SET used_at = now() WHERE tenant_id = ${tenant} AND token_hash = ${sha(i.enrolment)}`;
        const [r] = await tx<Row[]>`
          INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
          VALUES (${tenant}, ${e.principal}, ${e.role}, ${e.books}, ${displayName || e.display_name}, 'enrolment', ${e.principal})
          ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', role = EXCLUDED.role, books = EXCLUDED.books,
            display_name = EXCLUDED.display_name, revoked_by = NULL, revoked_at = NULL
          RETURNING tenant_id, principal, role, books, display_name, status, source`;
        member = toMember(r!);
      } else {
        if (!(await this.claimable(tx, tenant))) throw new IdentityError("workspace_taken", "that workspace already exists", 409);
        const principal = `owner:${slug(displayName) || "owner"}`;
        const [r] = await tx<Row[]>`
          INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
          VALUES (${tenant}, ${principal}, 'owner', NULL, ${displayName}, 'passkey', ${principal})
          RETURNING tenant_id, principal, role, books, display_name, status, source`;
        member = toMember(r!);
      }
      await tx`INSERT INTO identity.credentials (tenant_id, credential_id, principal, public_key, counter, transports)
        VALUES (${tenant}, ${cred.id}, ${member.principal}, ${Buffer.from(cred.publicKey)}, ${cred.counter}, ${cred.transports ?? []})`;
      return member;
    });
  }

  /** Options for `navigator.credentials.get`: any discoverable passkey of this workspace. */
  async authenticationOptions(tenant: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    this.validTenant(tenant);
    return generateAuthenticationOptions({ rpID: this.o.rpId, challenge: this.challenge("auth", tenant), userVerification: "required" });
  }

  /** Verify a passkey assertion; returns the active member it belongs to. */
  async authenticate(tenant: string, i: { response: AuthenticationResponseJSON }): Promise<Member> {
    this.validTenant(tenant);
    return this.assertion(tenant, i.response, "auth", tenant, null);
  }

  /** A passkey assertion (user verification required) for `kind`, optionally by one principal only. */
  private async assertion(tenant: string, response: AuthenticationResponseJSON, kind: Ceremony, binding: string, principal: string | null): Promise<Member> {
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
    await this.store.tenantTx(tenant, (tx) => tx`UPDATE identity.credentials SET counter = ${v.authenticationInfo.newCounter}, last_used_at = now()
      WHERE tenant_id = ${tenant} AND credential_id = ${c.credential_id}`);
    const m = await this.member(tenant, c.principal);
    if (!m) throw fail();
    return m;
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
   * Development sign-in (KUBER_DEV_SIGNIN=true only): an owner by name, for a workspace that has
   * no people yet or where that owner already exists. No proof of identity: never in production.
   */
  async devSignIn(tenant: string, name: string): Promise<Member> {
    if (!this.o.devSignIn) throw denied("development sign-in is disabled");
    this.validTenant(tenant);
    const principal = `owner:${slug(name) || "owner"}`;
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lockTenant(tx, tenant);
      const [r] = await tx<Row[]>`SELECT tenant_id, principal, role, books, display_name, status, source FROM identity.members
        WHERE tenant_id = ${tenant} AND principal = ${principal} AND status = 'active'`;
      if (r) return toMember(r);
      const [people] = await tx`SELECT 1 FROM identity.members WHERE tenant_id = ${tenant} AND role <> 'agent' AND status = 'active' LIMIT 1`;
      if (people) throw denied("this workspace has members: sign in with a passkey");
      const [n] = await tx<Row[]>`
        INSERT INTO identity.members (tenant_id, principal, role, books, display_name, source, created_by)
        VALUES (${tenant}, ${principal}, 'owner', NULL, ${name.trim().slice(0, 80)}, 'dev', ${principal})
        ON CONFLICT (tenant_id, principal) DO UPDATE SET status = 'active', revoked_by = NULL, revoked_at = NULL
        RETURNING tenant_id, principal, role, books, display_name, status, source`;
      return toMember(n!);
    });
  }
}
