/**
 * Roles and permissions (finding F02; role model v2, implementation design 6.3, decided 25 September
 * 2026). Deny by default: an action is allowed only when the member's role lists it.
 *
 * Principals are identifiers recorded in sealed history, so they are never renamed. A principal's
 * prefix is its role or a legacy alias of that role (`owner:laksh` is a Superuser), and the
 * membership row must agree, so a principal cannot claim a role it was not given. New principals
 * use the new prefixes (`superuser:asha`, `staff:pia`).
 *
 *   Internal  superuser (Checker, top authority), admin, system_owner, controller, treasurer,
 *             staff (Maker), auditor
 *   Agent     agent (Maker, `agent:*`), agent_checker (the deterministic policy engine, `agent:policy`)
 *   External  customer, supplier (each bound to one party), investor, guest
 */
import { POLICY_CHECKER, ROLE_ALIASES } from "@kuber/contracts";

export { POLICY_CHECKER };
export const PERSON_ROLES = [
  "superuser", "admin", "system_owner", "controller", "treasurer", "staff", "auditor",
  "customer", "supplier", "investor", "guest",
] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];
export const AGENT_ROLES = ["agent", "agent_checker"] as const;
/** Every role of the model: the people's roles and the two agent roles. */
export const ROLES = [...PERSON_ROLES, ...AGENT_ROLES] as const;
export type Role = (typeof ROLES)[number];

/** External roles see their own records only (party-bound, published or shared items). */
export const EXTERNAL_ROLES: ReadonlySet<Role> = new Set<Role>(["customer", "supplier", "investor", "guest"]);
/** Customer and Supplier memberships are bound to one party of the party master. */
export const PARTY_BOUND_ROLES: ReadonlySet<Role> = new Set<Role>(["customer", "supplier"]);

/**
 * Legacy principal prefixes and the role their memberships were migrated to (role model v2).
 * `approver` principals stay bounded by the POL-002 `approver` band while the matrix is enabled.
 * controller and auditor are unchanged.
 */
export const LEGACY_ALIASES = ROLE_ALIASES as Readonly<Record<string, PersonRole>>;
/** A legacy role name, accepted where a role is given (it stands for the role it maps to). */
export type LegacyRole = "owner" | "approver" | "preparer" | "member";
/** The reason recorded on MemberRoleChanged events written by the role model migration. */
export const ROLE_MODEL_V2_REASON = "role model v2";


export const ACTIONS = [
  "self",                 // own membership, passkeys and sessions (every person)
  "read",                 // reports, ledgers, plans, drafts, evidence
  "book.open", "account.add", "journal.post", "period.lock", "rules.manage",
  "capture",              // statements and chat lines (become drafts; policy decides posting)
  "draft.decide",         // approve or reject a drafted entry
  "journal.ratify",       // ratify or correct an auto-posted entry
  "plan.prepare",         // simulate a write operation (stored as a proposal)
  "plan.approve",         // commit a policy-gated plan
  "plan.approve.period",  // commit a period operation (close, carry forward, allocate, rebalance)
  "plan.discard",         // withdraw someone else's proposal (anyone may withdraw their own)
  "policy.commit",        // commit a plan or posting an active policy clears for L3/L4 (agent:policy only)
  "copilot",
  "members.read", "members.manage",
  "settings.manage",      // non-financial workspace settings
  "authority.manage",     // separation-of-duties settings, POL-002 amount bands (authority changes)
  // Finance controls:
  "access.review",        // FIN-MDM-05: record dispositions on the periodic access and master-change review
  "conflicts.manage",     // FIN-MDM-04: flag or clear related-party conflicts between members and parties
  "autonomy.manage",      // FIN-OPS-03: halt or resume autonomous posting (kill switch)
  "incident.manage",      // FIN-OPS-02: open, update and close financial incidents
  "account.close",        // close an account, change its statement mapping or mandatory dimensions (FIN-MDM-02)
  "party.manage",         // create a party, change its details, request a bank-detail change (maker, FIN-MDM-03)
  "party.bank.verify",    // record the out-of-band verification of a bank-detail change, or reject it (checker)
  "party.bank.release",   // release a verified bank-detail change: lifts the payment hold (fresh approval)
  // Reporting to outsiders:
  "snapshot.publish",     // mark a certified snapshot published (or not) to investors
  "share.grant",          // share a certified snapshot or a report with a guest until an expiry
  // AI system accountability (TAGOF):
  "agent.system",         // tool register, prompt and artifact approvals, copilot halt, model-processing approval
  "agent.turns.read",     // agent turn records and evaluation reports
  // External roles (party-bound or item-bound; filtered at the module boundary):
  "portal.customer.read", "portal.customer.query",
  "portal.supplier.read", "portal.supplier.bank_request",
  "investor.read",        // certified snapshots published to investors
  "share.read",           // items explicitly shared with this guest, until expiry
] as const;
export type Action = (typeof ACTIONS)[number];

const EXTERNAL_ACTIONS = new Set<Action>(["portal.customer.read", "portal.customer.query", "portal.supplier.read", "portal.supplier.bank_request",
  "investor.read", "share.read"]);
/** Actions only the policy engine performs. */
const POLICY_ONLY = new Set<Action>(["policy.commit"]);
/** Controller as before role model v2: everything internal except member and settings management and authority changes. */
const CONTROLLER_EXCLUDED = new Set<Action>(["members.manage", "settings.manage", "authority.manage", "agent.system"]);

const set = (xs: Action[]) => new Set<Action>(xs);
const PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  // Everything within its band, including authority changes and agent.system as the ultimate authority.
  superuser: set(ACTIONS.filter((a) => !EXTERNAL_ACTIONS.has(a) && !POLICY_ONLY.has(a))),
  // Members, passkey recovery, non-financial settings. No financial action and no ledger reads.
  admin: set(["self", "members.read", "members.manage", "settings.manage"]),
  system_owner: set(["self", "agent.system", "agent.turns.read"]),
  controller: set(ACTIONS.filter((a) => !EXTERNAL_ACTIONS.has(a) && !POLICY_ONLY.has(a) && !CONTROLLER_EXCLUDED.has(a))),
  // Cash and treasury: prepare and approve treasury plans prepared by others; verify bank changes out of band.
  treasurer: set(["self", "read", "capture", "plan.prepare", "plan.approve", "copilot", "party.bank.verify"]),
  staff: set(["self", "read", "capture", "plan.prepare", "party.manage", "copilot"]),
  auditor: set(["self", "read", "members.read", "agent.turns.read"]),
  agent: set(["capture", "plan.prepare"]),
  agent_checker: set(["policy.commit"]),
  customer: set(["self", "portal.customer.read", "portal.customer.query"]),
  supplier: set(["self", "portal.supplier.read", "portal.supplier.bank_request"]),
  investor: set(["self", "investor.read"]),
  guest: set(["self", "share.read"]),
};

/** Operations a treasurer may prepare and approve (payments, reconciliation, rebalance, cash allocation). */
export const TREASURY_OPS: ReadonlySet<string> = new Set(["record", "post", "reconcile", "rebalance", "allocate"]);

/** A role of the model (people and agents). */
export const isRole = (r: string): r is Role => (ROLES as readonly string[]).includes(r);
/** A role a person can be invited to or changed to. */
export const isPersonRole = (r: string): r is PersonRole => (PERSON_ROLES as readonly string[]).includes(r);
export const isLegacyAlias = (prefix: string) => Object.prototype.hasOwnProperty.call(LEGACY_ALIASES, prefix);
/** The role a role name or legacy alias stands for (`owner` → `superuser`); unknown names unchanged. */
export const canonicalRole = (r: string): string => (isLegacyAlias(r) ? LEGACY_ALIASES[r]! : r);
/** May `role` (or a legacy alias of it) perform `action`? Deny by default. */
export const can = (role: string, action: Action): boolean => { const r = canonicalRole(role); return isRole(r) && PERMISSIONS[r].has(action); };
/** The principal's prefix exactly as written (`owner` for `owner:laksh`). */
export const prefixOf = (principal: string) => principal.slice(0, Math.max(principal.indexOf(":"), 0));
/**
 * The role a principal stands for: its prefix, or the role a legacy prefix maps to. `agent:policy`
 * is the Agent (Checker); every other `agent:*` is an Agent (Maker).
 */
export const roleOf = (principal: string): string => {
  if (principal === POLICY_CHECKER) return "agent_checker";
  return canonicalRole(prefixOf(principal));
};
/** The invariant on memberships: the principal's prefix is the role or a legacy alias of it. */
export const prefixMatchesRole = (principal: string, role: string) => {
  const p = prefixOf(principal);
  return p === role || (isLegacyAlias(p) && LEGACY_ALIASES[p] === role);
};
/**
 * The denial message: "<prefix> may not <action>". A legacy prefix is named as written (a
 * preparer:* principal is Staff, and "preparer may not plan.approve" says which principal was refused).
 */
export const mayNot = (principal: string, role: string, _action: string) => `${prefixOf(principal) || role} may not ${_action}`;
/** The permission table, for display and table-driven tests. */
export const permissionTable = () => Object.fromEntries(ROLES.map((r) => [r, [...PERMISSIONS[r]]])) as Record<Role, Action[]>;
