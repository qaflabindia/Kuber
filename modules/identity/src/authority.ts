/**
 * FIN-MDM-04: the authority matrix. Who may approve what is decided by
 *
 *   action      plan.approve (policy-gated plans) or plan.approve.period (period operations)
 *   book        the member's book scope, and a band may be set per book ('*' = every book)
 *   amount band the largest amount the plan moves (planAmount) against the role's band
 *   delegation  a time-boxed (valid from/to), amount-capped grant of the action from a member who
 *               holds it, never beyond the grantor's own authority (checked at grant AND at use)
 *
 * plus conflict rules (a member flagged as related to a party may not approve plans that pay it),
 * separation of duties (identity.separation, with the explicit single-owner exception) and the
 * rule that authority is checked again when an approved plan is executed.
 *
 * Bands: the policy registry cannot express POL-002's bands (its front matter has one
 * amount_limit_inr, null for POL-002; the bands are prose), so they live in a settings table
 * (identity.authority_bands) with DOA_DEFAULTS drawn from POL-002. The matrix is enforced per
 * tenant once switched on (identity.authority_settings.enabled). Off by default, deliberately: an
 * authority matrix binds only once the entity has approved it (the owner switching it on, recorded as
 * AuthorityMatrixChanged, is that approval), so POL-002's illustrative bands never bind by accident.
 * Delegations, conflict rules and the re-check at execution always apply.
 *
 * Every change is an identity event (same transaction), and every change that can alter someone's
 * authority notifies the authority-change hooks (the ops module invalidates approvals that relied on it).
 */
import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { Principal } from "@kuber/contracts";
import type { EventStore, GuardScope, NewEvent } from "@kuber/eventstore";
import { can, isRole, mayNot, prefixOf, type Action, type Role } from "./roles.ts";
import { relatedPartyNoteCtx } from "./fin-migrations.ts";

/** What the authority service needs from the identity service (kept narrow to avoid an import cycle). */
export interface IdentityHost {
  member(tenant: string, principal: string, tx?: TransactionSql): Promise<HostMember | null>;
  authorize(tenant: string, principal: string, action: Action, scope?: GuardScope, tx?: TransactionSql): Promise<HostMember>;
  now(): number;
  denied(message: string): Error;
  error(code: string, message: string, status?: number): Error;
  changed(tx: TransactionSql, tenant: string, change: AuthorityChange): Promise<void>;
}
interface HostMember { principal: string; role: string; books: string[] | null }

/**
 * An authority change, as the ops module needs it: approvals recorded by `approvers` ("all": by
 * anyone) in `books` (null: every book) no longer stand; plans prepared by `stalePreparedBy` are stale.
 */
export interface AuthorityChange { approvers: string[] | "all"; books: string[] | null; stalePreparedBy?: string[]; reason: string }
export type AuthorityChangeHook = (tenant: string, change: AuthorityChange, tx: TransactionSql) => Promise<void>;

/** Actions with amount bands and delegation. */
export const DELEGABLE: readonly Action[] = ["plan.approve", "plan.approve.period"];

/**
 * Defaults from POL-002 v1 (paise; null = no limit). The policy's bands: up to ₹25,000 the
 * preparer's manager (Kuber's approver role), ₹25,001 to ₹2,00,000 a controller, ₹2,00,001 to
 * ₹10,00,000 a CFO, above that the owner/board. Kuber has no CFO role, so the CFO band falls to
 * the owner. Period operations (close, carry forward, allocate, rebalance) have no default band.
 * Each tenant sets its own with setBand.
 */
export const DOA_DEFAULTS: Readonly<Record<string, Partial<Record<BandRole, bigint | null>>>> = {
  "plan.approve": { superuser: null, controller: 20_000_000n, treasurer: 20_000_000n, approver: 2_500_000n },
};
/**
 * Band keys: the roles, plus the legacy `approver` band. Role model v2 migrated approver principals
 * to Superuser, still bounded by the approver band of POL-002 while the matrix is enabled.
 */
export type BandRole = Role | "approver";
/** The band a member's approvals are measured against: `approver:*` principals keep the approver band. */
export const bandRole = (m: { principal: string; role: string }): string => (prefixOf(m.principal) === "approver" ? "approver" : m.role);
/** Roles that can never receive approval authority by delegation. */
const NO_AUTHORITY = new Set(["agent", "agent_checker", "auditor", "admin", "system_owner", "customer", "supplier", "investor", "guest"]);
export const DOA_SOURCE = "POL-002 v1 (delegation of authority matrix) example bands";

const rupees = (p: bigint) => `₹${(p / 100n).toLocaleString("en-IN")}${p % 100n ? `.${(p % 100n).toString().padStart(2, "0")}` : ""}`;
const actorOf = (by: string) => (Principal.safeParse(by).success ? by : `system:${by.replace(/[^\w.@-]+/g, ".").replace(/^\.+|\.+$/g, "") || "unknown"}`);
const minLimit = (a: bigint | null, b: bigint | null) => (a === null ? b : b === null ? a : a < b ? a : b);

export interface Delegation {
  delegationId: string; grantor: string; grantee: string; action: string; books: string[] | null; maxPaise: string;
  validFrom: string; validTo: string; status: "active" | "revoked"; current: boolean;
}
export interface AuthorityBasis { via: "role" | "delegation"; delegationId?: string; limitPaise: string | null }
type DRow = { delegation_id: string; grantor: string; grantee: string; action: string; books: string[] | null; max_paise: string;
  valid_from: Date; valid_to: Date; status: "active" | "revoked" };

export class Authority {
  constructor(private store: EventStore, private host: IdentityHost) {}

  private tx<T>(tenant: string, tx: TransactionSql | undefined, f: (t: TransactionSql) => Promise<T>): Promise<T> {
    return tx ? f(tx) : this.store.tenantTx(tenant, f);
  }
  private async lock(tx: TransactionSql, tenant: string) { await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"identity:" + tenant}, 0))`; }
  private async audit(tx: TransactionSql, tenant: string, by: string, events: NewEvent[]) {
    await this.store.append("identity", tenant, { streamId: `${tenant}/identity`, expected: "any", events }, { principal: actorOf(by) }, tx);
  }

  // ------------------------------------------------------------------ bands
  async enabled(tenant: string, tx?: TransactionSql): Promise<boolean> {
    const [r] = await this.tx(tenant, tx, (t) => t<{ enabled: boolean }[]>`SELECT enabled FROM identity.authority_settings WHERE tenant_id = ${tenant}`);
    return r?.enabled ?? false;
  }

  /** Switch the tenant's authority matrix on or off (authority.manage). Every recorded approval is re-examined. */
  async setMatrix(tenant: string, by: string, enabled: boolean) {
    await this.store.tenantTx(tenant, async (tx) => {
      await this.host.authorize(tenant, by, "authority.manage", { allBooks: true }, tx);
      await this.lock(tx, tenant);
      const [prev] = await tx<{ enabled: boolean }[]>`SELECT enabled FROM identity.authority_settings WHERE tenant_id = ${tenant}`;
      await tx`INSERT INTO identity.authority_settings (tenant_id, enabled, updated_by) VALUES (${tenant}, ${enabled}, ${by})
        ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await this.audit(tx, tenant, by, [{ type: "AuthorityMatrixChanged", data: { enabled, previous: prev?.enabled ?? null } }]);
      if ((prev?.enabled ?? false) !== enabled) await this.host.changed(tx, tenant, { approvers: "all", books: null, reason: `authority matrix ${enabled ? "enabled" : "disabled"} by ${by}` });
    });
    return this.matrix(tenant);
  }

  /** Set one band (authority.manage): `maxPaise` null = no limit; `book` null = every book. */
  async setBand(tenant: string, by: string, b: { action: string; book: string | null; role: string; maxPaise: string | null }) {
    if (!DELEGABLE.includes(b.action as Action)) throw this.host.error("bad_action", `bands apply to ${DELEGABLE.join(", ")}`);
    if (!isRole(b.role) && b.role !== "approver") throw this.host.error("bad_role", `unknown role ${b.role}`);
    if (b.maxPaise !== null && !/^\d{1,18}$/.test(b.maxPaise)) throw this.host.error("bad_limit", "a band is whole paise");
    const book = b.book ?? "*";
    await this.store.tenantTx(tenant, async (tx) => {
      await this.host.authorize(tenant, by, "authority.manage", { allBooks: true }, tx);
      await this.lock(tx, tenant);
      const [prev] = await tx<{ max_paise: string | null }[]>`SELECT max_paise::text FROM identity.authority_bands
        WHERE tenant_id = ${tenant} AND action = ${b.action} AND book_id = ${book} AND role = ${b.role}`;
      await tx`INSERT INTO identity.authority_bands (tenant_id, action, book_id, role, max_paise, updated_by)
        VALUES (${tenant}, ${b.action}, ${book}, ${b.role}, ${b.maxPaise}, ${by})
        ON CONFLICT (tenant_id, action, book_id, role) DO UPDATE SET max_paise = EXCLUDED.max_paise, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await this.audit(tx, tenant, by, [{ type: "AuthorityBandSet", data: { action: b.action, bookId: b.book, role: b.role, maxPaise: b.maxPaise,
        previousMaxPaise: prev ? prev.max_paise : null, removed: false } }]);
      await this.host.changed(tx, tenant, { approvers: "all", books: b.book === null ? null : [b.book],
        reason: `${b.role} band for ${b.action}${b.book ? ` in ${b.book}` : ""} changed by ${by}` });
    });
    return this.matrix(tenant);
  }

  /** The matrix as enforced: on/off, POL-002 defaults and this tenant's overrides. */
  async matrix(tenant: string) {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ action: string; book_id: string; role: string; max_paise: string | null }[]>`
      SELECT action, book_id, role, max_paise::text FROM identity.authority_bands WHERE tenant_id = ${tenant} ORDER BY action, book_id, role`);
    return {
      enabled: await this.enabled(tenant), source: DOA_SOURCE,
      defaults: Object.fromEntries(Object.entries(DOA_DEFAULTS).map(([a, r]) => [a, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : v!.toString()]))])),
      bands: rows.map((r) => ({ action: r.action, book: r.book_id === "*" ? null : r.book_id, role: r.role, maxPaise: r.max_paise })),
    };
  }

  /**
   * The role's limit for `action` in `book`: null = no limit. A book's own band wins over the
   * tenant-wide one, which wins over the POL-002 default. With the matrix off: no limit.
   */
  async limitOf(tx: TransactionSql, tenant: string, action: string, book: string, role: string, enabled?: boolean): Promise<bigint | null> {
    if (!(enabled ?? (await this.enabled(tenant, tx)))) return null;
    const rows = await tx<{ book_id: string; max_paise: string | null }[]>`SELECT book_id, max_paise::text FROM identity.authority_bands
      WHERE tenant_id = ${tenant} AND action = ${action} AND role = ${role} AND book_id IN (${book}, '*')`;
    const r = rows.find((x) => x.book_id === book && book !== "*") ?? rows.find((x) => x.book_id === "*");
    if (r) return r.max_paise === null ? null : BigInt(r.max_paise);
    const d = DOA_DEFAULTS[action];
    if (!d) return null;
    const v = d[role as BandRole];
    return v === undefined ? 0n : v;
  }

  /** The smallest limit the role has in any of `books` (null: every book, so the tenant-wide band and every book-specific one). */
  private async limitAcross(tx: TransactionSql, tenant: string, action: string, role: string, books: string[] | null): Promise<bigint | null> {
    const enabled = await this.enabled(tenant, tx);
    const list = books ?? ["*", ...(await tx<{ book_id: string }[]>`SELECT DISTINCT book_id FROM identity.authority_bands
      WHERE tenant_id = ${tenant} AND action = ${action} AND role = ${role} AND book_id <> '*'`).map((r) => r.book_id)];
    let lim: bigint | null = null;                   // null = no limit, the identity for minLimit
    for (const b of list) lim = minLimit(lim, await this.limitOf(tx, tenant, action, b, role, enabled));
    return lim;
  }

  /**
   * May `principal` approve `amount` paise of `action` in `book`, now? By their role (within its
   * band and their book scope) or by a current delegation whose grantor still holds that authority.
   * Throws 403 with the reason otherwise.
   */
  async approvalAuthority(tenant: string, principal: string, action: Action, book: string, amount: bigint, tx?: TransactionSql): Promise<{ member: HostMember } & AuthorityBasis> {
    return this.tx(tenant, tx, async (t) => {
      const m = await this.host.member(tenant, principal, t);
      if (!m || m.role === "agent") throw this.host.denied(`${principal} is not a member of workspace ${tenant}`);
      const enabled = await this.enabled(tenant, t);
      const roleOk = can(m.role, action), bookOk = m.books === null || m.books.includes(book);
      let limit: bigint | null = 0n;
      if (roleOk && bookOk) {
        limit = await this.limitOf(t, tenant, action, book, bandRole(m), enabled);
        if (limit === null || amount <= limit) return { member: m, via: "role" as const, limitPaise: limit === null ? null : limit.toString() };
      }
      const d = await this.usableDelegation(t, tenant, principal, action, book, amount, enabled);
      if (d) return { member: m, via: "delegation" as const, delegationId: d.id, limitPaise: d.max };
      if (!roleOk) throw this.host.denied(mayNot(m.principal, m.role, action));
      if (!bookOk) throw this.host.denied(`${principal} has no access to book ${book}`);
      throw this.host.denied(`${rupees(amount)} is above ${principal}'s authority of ${rupees(limit ?? 0n)} for ${action} in book ${book} (authority matrix, POL-002)`);
    });
  }

  /** A delegation to `grantee` covering this action, book and amount, current now, whose grantor still has the authority. */
  private async usableDelegation(tx: TransactionSql, tenant: string, grantee: string, action: string, book: string, amount: bigint, enabled: boolean) {
    const now = new Date(this.host.now());
    const rows = await tx<{ delegation_id: string; grantor: string; max_paise: string }[]>`
      SELECT delegation_id, grantor, max_paise::text FROM identity.delegations
      WHERE tenant_id = ${tenant} AND grantee = ${grantee} AND action = ${action} AND status = 'active'
        AND valid_from <= ${now} AND valid_to > ${now} AND max_paise >= ${amount.toString()}::bigint
        AND (books IS NULL OR ${book} = ANY(books))
      ORDER BY valid_to, delegation_id`;
    for (const r of rows) {
      const g = await this.host.member(tenant, r.grantor, tx);
      if (!g || g.role === "agent" || !can(g.role, action as Action) || !(g.books === null || g.books.includes(book))) continue;
      const gl = await this.limitOf(tx, tenant, action, book, bandRole(g), enabled);
      if (gl === null || amount <= gl) return { id: r.delegation_id, max: r.max_paise };
    }
    return null;
  }

  // ------------------------------------------------------------------ delegations
  /**
   * Delegate `action` from `by` (who must hold it, in those books, up to at least `maxPaise`) to
   * another person for a period. Auditors and agents cannot receive authority.
   */
  async delegate(tenant: string, by: string, d: { grantee: string; action: string; books?: string[] | null; maxPaise: string; validFrom?: string; validTo: string }): Promise<Delegation> {
    if (!DELEGABLE.includes(d.action as Action)) throw this.host.error("bad_action", `only ${DELEGABLE.join(", ")} can be delegated`);
    if (!/^\d{1,18}$/.test(d.maxPaise)) throw this.host.error("bad_limit", "the delegated limit is whole paise");
    const from = d.validFrom ? new Date(d.validFrom) : new Date(this.host.now()), to = new Date(d.validTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw this.host.error("bad_period", "validFrom and validTo are dates");
    if (to <= from) throw this.host.error("bad_period", "a delegation ends after it starts");
    if (to.getTime() <= this.host.now()) throw this.host.error("bad_period", "a delegation must end in the future");
    const books = d.books ?? null, max = BigInt(d.maxPaise), id = `dlg-${randomUUID()}`;
    return this.store.tenantTx(tenant, async (tx) => {
      await this.lock(tx, tenant);
      const grantor = await this.host.member(tenant, by, tx);
      if (!grantor || grantor.role === "agent") throw this.host.denied(`${by} is not a member of workspace ${tenant}`);
      if (!can(grantor.role, d.action as Action)) throw this.host.denied(`${mayNot(by, grantor.role, d.action)}, so cannot delegate it`);
      if (grantor.books !== null && (books === null || !books.every((b) => grantor.books!.includes(b))))
        throw this.host.denied(`${by} can delegate only within books ${grantor.books.join(", ")}`);
      const own = await this.limitAcross(tx, tenant, d.action, bandRole(grantor), books);
      if (own !== null && max > own) throw this.host.denied(`a delegation of ${rupees(max)} exceeds the grantor's own authority of ${rupees(own)} for ${d.action}`);
      if (d.grantee === by) throw this.host.error("bad_grantee", "a delegation is to someone else");
      const grantee = await this.host.member(tenant, d.grantee, tx);
      if (!grantee) throw this.host.error("bad_grantee", `${d.grantee} is not an active member`, 404);
      if (NO_AUTHORITY.has(grantee.role)) throw this.host.denied(`${grantee.role}s cannot receive approval authority`);
      await tx`INSERT INTO identity.delegations (tenant_id, delegation_id, grantor, grantee, action, books, max_paise, valid_from, valid_to, created_by)
        VALUES (${tenant}, ${id}, ${by}, ${d.grantee}, ${d.action}, ${books}, ${d.maxPaise}, ${from}, ${to}, ${by})`;
      await this.audit(tx, tenant, by, [{ type: "DelegationGranted", data: { delegationId: id, grantor: by, grantee: d.grantee, action: d.action, books,
        maxPaise: d.maxPaise, validFrom: from.toISOString(), validTo: to.toISOString() } }]);
      return { delegationId: id, grantor: by, grantee: d.grantee, action: d.action, books, maxPaise: d.maxPaise, validFrom: from.toISOString(),
        validTo: to.toISOString(), status: "active" as const, current: from.getTime() <= this.host.now() };
    });
  }

  /** Revoke a delegation: its grantor, or a superuser (authority.manage). Approvals the grantee recorded no longer stand. */
  async revokeDelegation(tenant: string, by: string, delegationId: string, reason: string) {
    await this.store.tenantTx(tenant, async (tx) => {
      await this.lock(tx, tenant);
      const [r] = await tx<DRow[]>`SELECT * FROM identity.delegations WHERE tenant_id = ${tenant} AND delegation_id = ${delegationId} FOR UPDATE`;
      if (!r) throw this.host.error("not_found", `no delegation ${delegationId}`, 404);
      if (r.grantor !== by) await this.host.authorize(tenant, by, "authority.manage", { allBooks: true }, tx);
      else if (!(await this.host.member(tenant, by, tx))) throw this.host.denied(`${by} is not a member of workspace ${tenant}`);
      if (r.status === "revoked") return;
      await tx`UPDATE identity.delegations SET status = 'revoked', revoked_by = ${by}, revoked_at = now() WHERE tenant_id = ${tenant} AND delegation_id = ${delegationId}`;
      await this.audit(tx, tenant, by, [{ type: "DelegationRevoked", data: { delegationId, grantor: r.grantor, grantee: r.grantee, reason } }]);
      await this.host.changed(tx, tenant, { approvers: [r.grantee], books: r.books, reason: `delegation ${delegationId} revoked by ${by}: ${reason}` });
    });
  }

  async delegations(tenant: string, f: { principal?: string } = {}): Promise<Delegation[]> {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<DRow[]>`
      SELECT delegation_id, grantor, grantee, action, books, max_paise::text, valid_from, valid_to, status FROM identity.delegations
      WHERE tenant_id = ${tenant} ${f.principal ? tx`AND (grantor = ${f.principal} OR grantee = ${f.principal})` : tx``} ORDER BY created_at`);
    const now = this.host.now();
    return rows.map((r) => ({ delegationId: r.delegation_id, grantor: r.grantor, grantee: r.grantee, action: r.action, books: r.books, maxPaise: r.max_paise,
      validFrom: r.valid_from.toISOString(), validTo: r.valid_to.toISOString(), status: r.status,
      current: r.status === "active" && r.valid_from.getTime() <= now && r.valid_to.getTime() > now }));
  }

  /** Active grantees of `grantor` (their authority derives from it). */
  async delegatesOf(tx: TransactionSql, tenant: string, grantor: string): Promise<string[]> {
    return (await tx<{ grantee: string }[]>`SELECT DISTINCT grantee FROM identity.delegations
      WHERE tenant_id = ${tenant} AND grantor = ${grantor} AND status = 'active'`).map((r) => r.grantee);
  }

  // ------------------------------------------------------------------ conflict rules
  /** Flag `principal` as related to `partyId` (conflicts.manage): they may not approve plans that pay that party. */
  async flagRelatedParty(tenant: string, by: string, f: { principal: string; partyId: string; note: string }) {
    const keys = await this.store.keys(tenant);
    await this.store.tenantTx(tenant, async (tx) => {
      await this.host.authorize(tenant, by, "conflicts.manage", { allBooks: true }, tx);
      await this.lock(tx, tenant);
      if (!Principal.safeParse(f.principal).success) throw this.host.error("bad_principal", `${f.principal} is not a principal`);
      await tx`INSERT INTO identity.related_parties (tenant_id, principal, party_id, note, flagged_by)
        VALUES (${tenant}, ${f.principal}, ${f.partyId}, ${keys.seal(f.note, relatedPartyNoteCtx(f.principal, f.partyId))}, ${by})
        ON CONFLICT (tenant_id, principal, party_id) DO UPDATE SET note = EXCLUDED.note, flagged_by = EXCLUDED.flagged_by, flagged_at = now(),
          cleared_by = NULL, cleared_at = NULL`;
      await this.audit(tx, tenant, by, [{ type: "RelatedPartyFlagged", data: { principal: f.principal, partyId: f.partyId, note: f.note } }]);
      await this.host.changed(tx, tenant, { approvers: [f.principal], books: null, reason: `${f.principal} flagged as related to party ${f.partyId}` });
    });
  }

  async clearRelatedParty(tenant: string, by: string, f: { principal: string; partyId: string; note: string }) {
    await this.store.tenantTx(tenant, async (tx) => {
      await this.host.authorize(tenant, by, "conflicts.manage", { allBooks: true }, tx);
      const n = await tx`UPDATE identity.related_parties SET cleared_by = ${by}, cleared_at = now()
        WHERE tenant_id = ${tenant} AND principal = ${f.principal} AND party_id = ${f.partyId} AND cleared_at IS NULL RETURNING 1`;
      if (!n.length) throw this.host.error("not_found", `${f.principal} is not flagged for ${f.partyId}`, 404);
      await this.audit(tx, tenant, by, [{ type: "RelatedPartyCleared", data: { principal: f.principal, partyId: f.partyId, note: f.note } }]);
    });
  }

  async relatedParties(tenant: string) {
    const keys = await this.store.keys(tenant);
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ principal: string; party_id: string; note: string; flagged_by: string; flagged_at: Date }[]>`
      SELECT principal, party_id, note, flagged_by, flagged_at FROM identity.related_parties WHERE tenant_id = ${tenant} AND cleared_at IS NULL ORDER BY 1, 2`);
    return rows.map((r) => ({ principal: r.principal, partyId: r.party_id, note: keys.openText(r.note, relatedPartyNoteCtx(r.principal, r.party_id)),
      flaggedBy: r.flagged_by, flaggedAt: r.flagged_at.toISOString() }));
  }

  /** Throws when `principal` is flagged as related to any of `parties`. */
  async checkConflicts(tenant: string, principal: string, parties: string[], tx?: TransactionSql) {
    if (!parties.length) return;
    const hit = await this.tx(tenant, tx, (t) => t<{ party_id: string }[]>`SELECT party_id FROM identity.related_parties
      WHERE tenant_id = ${tenant} AND principal = ${principal} AND cleared_at IS NULL AND party_id IN ${t(parties)} ORDER BY 1`);
    if (hit.length) throw this.host.denied(`conflict of interest: ${principal} is flagged as related to party ${hit.map((h) => h.party_id).join(", ")}, which this plan pays`);
  }
}

