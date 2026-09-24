/**
 * Roles and permissions (finding F02). Deny by default: an action is allowed only when the
 * member's role lists it. The principal's prefix is its role (`controller:asha`), and the
 * membership row must say the same, so a principal cannot claim a role it was not given.
 */
export const ROLES = ["owner", "controller", "preparer", "approver", "auditor", "member"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "read",                 // reports, ledgers, plans, drafts, evidence
  "book.open", "account.add", "journal.post", "period.lock", "rules.manage",
  "capture",              // statements and chat lines (become drafts; policy decides posting)
  "draft.decide",         // approve or reject a drafted entry
  "journal.ratify",       // ratify or correct an auto-posted entry
  "plan.prepare",         // simulate a write operation (stored as a proposal)
  "plan.approve",         // commit a policy-gated plan
  "plan.approve.period",  // commit a period operation (close, carry forward, allocate, rebalance)
  "plan.discard",         // withdraw someone else's proposal (anyone may withdraw their own)
  "copilot",
  "members.read", "members.manage", "settings.manage",
] as const;
export type Action = (typeof ACTIONS)[number];

const ALL = new Set<Action>(ACTIONS);
const PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  owner: ALL,
  controller: new Set<Action>(ACTIONS.filter((a) => a !== "members.manage" && a !== "settings.manage")),
  preparer: new Set<Action>(["read", "capture", "plan.prepare", "copilot"]),
  approver: new Set<Action>(["read", "draft.decide", "journal.ratify", "plan.prepare", "plan.approve", "plan.discard", "copilot"]),
  auditor: new Set<Action>(["read", "members.read"]),
  member: new Set<Action>(["read", "capture", "plan.prepare", "copilot"]),
};

export const isRole = (r: string): r is Role => (ROLES as readonly string[]).includes(r);
export const can = (role: string, action: Action): boolean => isRole(role) && PERMISSIONS[role].has(action);
export const roleOf = (principal: string) => principal.slice(0, principal.indexOf(":"));
/** The permission table, for display and table-driven tests. */
export const permissionTable = () => Object.fromEntries(ROLES.map((r) => [r, [...PERMISSIONS[r]]])) as Record<Role, Action[]>;
