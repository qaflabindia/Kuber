/**
 * The shell's state from the core's answers (plain TypeScript, no SvelteKit imports, so the root
 * test suite exercises it: tests/web-shell.test.ts). A call that failed arrives as null and stays
 * "unavailable": an unanswered control must never read as zero or as "nothing waiting" (F15).
 */
export interface Attention { drafts: number; awaitingApproval: number; ratifications: number; plans: number;
  /** FIN-CLS-01: open close checklist tasks past their deadline (absent from cores before the close module). */
  closeTasksOverdue?: number }

export interface ShellInputs {
  attention: Attention | null;
  journals: unknown[] | null;
  verify: { intact: boolean } | null;
  me: { role: string; permissions: string[] } | null;
}

export interface Shell {
  /** False when the core did not answer: the rail shows "Counts unavailable", not an empty queue. */
  attentionAvailable: boolean;
  reviewCount: number | null;
  awaitingApproval: number | null;
  confirmCount: number | null;
  pendingPlans: number | null;
  closeOverdue: number | null;
  hasJournals: boolean;
  /** true: chain verified; false: verification found a break; null: the check could not run. */
  intact: boolean | null;
  role: string;
  canSeeMembers: boolean;
  /** FIN-MIG: the member may run legacy migrations (Controller, Superuser). */
  canMigrate: boolean;
  /** The member's permissions from the core, or null when the member call failed (navigation then falls back to reading). */
  permissions: string[] | null;
}

export function shellState(r: ShellInputs, sessionRole: string): Shell {
  const a = r.attention;
  return {
    attentionAvailable: a !== null,
    reviewCount: a?.drafts ?? null,
    awaitingApproval: a?.awaitingApproval ?? null,
    confirmCount: a?.ratifications ?? null,
    pendingPlans: a?.plans ?? null,
    closeOverdue: a?.closeTasksOverdue ?? null,
    hasJournals: (r.journals?.length ?? 0) > 0,
    intact: r.verify ? r.verify.intact : null,
    // From the core's answer for this member (role changes show at once), not the session.
    role: r.me?.role ?? sessionRole,
    canSeeMembers: !!r.me?.permissions.includes("members.read"),
    canMigrate: !!r.me?.permissions.includes("migration.manage"),
    permissions: r.me ? [...r.me.permissions] : null,
  };
}

export interface WaitingItem { href: string; label: string; icon: string; count: number; tone: string }

/** The rail: what is waiting, or "unavailable" when the counts could not be loaded. */
export function waitingRail(sh: Shell): { state: "unavailable" } | { state: "items"; items: WaitingItem[] } {
  if (!sh.attentionAvailable) return { state: "unavailable" };
  const items: WaitingItem[] = [];
  if (sh.pendingPlans) items.push({ href: "/", label: sh.pendingPlans === 1 ? "Plan to approve" : "Plans to approve", icon: "confirm", count: sh.pendingPlans, tone: "brass" });
  if (sh.reviewCount) items.push({ href: "/review", label: "Entries to review", icon: "review", count: sh.reviewCount, tone: sh.awaitingApproval ? "clay" : "brass" });
  if (sh.closeOverdue) items.push({ href: "/close", label: sh.closeOverdue === 1 ? "Close task overdue" : "Close tasks overdue", icon: "alert", count: sh.closeOverdue, tone: "clay" });
  if (sh.confirmCount) items.push({ href: "/confirm", label: "Postings to confirm", icon: "confirm", count: sh.confirmCount, tone: "brass" });
  return { state: "items", items };
}

/** The integrity line at the foot of the rail. */
export const integrityLabel = (intact: boolean | null) =>
  intact === null ? "Ledger check unavailable" : intact ? "Ledger verified" : "Ledger check failed";

/* ---------------------------------------------------------------------------------------------
 * Navigation (role-aware). The menu is a convenience, not a control: the core refuses anything the
 * member may not do, whatever the web shows. It hides what the member cannot use, so a Treasurer is
 * not shown member management and a System owner is not shown the books. When the member call
 * failed, permissions are unknown: the menu offers the reading pages only (never administration),
 * and each page still asks the core.
 * ------------------------------------------------------------------------------------------- */
export interface NavBadge { count: number; tone: "brass" | "clay" }
export interface NavItem {
  href: string; label: string; icon: string;
  /** Path prefixes that make this item current (defaults to href). */
  match?: string[];
  /** Extra words for the command palette. */
  keywords?: string;
  badge?: NavBadge;
}
export interface NavSection { id: string; label: string; items: NavItem[] }

/** When the member's permissions are unknown, the menu assumes reading only. */
const FALLBACK = ["read"];

const badge = (n: number | null, tone: NavBadge["tone"]): NavBadge | undefined => (n ? { count: n, tone } : undefined);

export function navSections(sh: Shell): NavSection[] {
  const perms = new Set(sh.permissions ?? FALLBACK);
  const has = (p: string) => perms.has(p);
  const reads = has("read");
  const sections: NavSection[] = [
    { id: "workspace", label: "Workspace", items: [
      { href: "/", label: "Canvas", icon: "home", match: [], keywords: "home ask kuber copilot plans approve",
        badge: badge(sh.pendingPlans, "brass") },
    ] },
  ];
  if (reads) {
    sections.push({ id: "books", label: "Books", items: [
      { href: "/review", label: "Review", icon: "review", keywords: "drafts entries approve reject",
        badge: badge(sh.reviewCount, sh.awaitingApproval ? "clay" : "brass") },
      { href: "/confirm", label: "Confirm", icon: "confirm", keywords: "ratify automatic postings", badge: badge(sh.confirmCount, "brass") },
      { href: "/ledger", label: "Ledger", icon: "ledger", keywords: "accounts chart journals balances" },
      ...(has("capture") ? [{ href: "/import", label: "Import", icon: "import", keywords: "statement upload csv bank file" }] : []),
    ] });
    sections.push({ id: "cash", label: "Cash & close", items: [
      { href: "/bank", label: "Bank", icon: "bank", keywords: "reconciliation cash exceptions" },
      { href: "/close", label: "Period close", icon: "calendar", keywords: "checklist month end certify lock",
        badge: badge(sh.closeOverdue, "clay") },
    ] });
    sections.push({ id: "reports", label: "Reports", items: [
      { href: "/statements", label: "Statements", icon: "book", keywords: "financial statements kpi metrics" },
      { href: "/reports/profit-and-loss", label: "Income & expenses", icon: "reports", keywords: "profit loss p&l income" },
      { href: "/reports/balance-sheet", label: "Balance sheet", icon: "scale", keywords: "assets liabilities equity own owe" },
      { href: "/reports/trial-balance", label: "Trial balance", icon: "list", keywords: "tb debits credits" },
      { href: "/reports/statement-of-affairs", label: "Statement of affairs", icon: "doc", keywords: "affairs" },
    ] });
  }
  const admin: NavItem[] = [];
  if (sh.canSeeMembers) admin.push({ href: "/settings/members", label: "Members & access", icon: "members", match: ["/settings"], keywords: "users roles invite passkeys recovery" });
  if (sh.canMigrate) admin.push({ href: "/migration", label: "Migration", icon: "upload", keywords: "tally zoho legacy load" });
  if (admin.length) sections.push({ id: "admin", label: "Administration", items: admin });
  return sections;
}

/** Is `item` the current page for `path`? The Canvas is current only at "/". */
export function isCurrent(item: NavItem, path: string): boolean {
  if (item.href === "/") return path === "/";
  const prefixes = item.match && item.match.length ? item.match : [item.href];
  return prefixes.some((p) => path === p || path.startsWith(p + "/"));
}

/**
 * Command palette ranking: every query word must appear (as a prefix of a word, or a substring) in the
 * label, section or keywords; label matches rank first. Empty query: all items in menu order.
 */
export function searchNav(sections: NavSection[], query: string): (NavItem & { section: string })[] {
  const all = sections.flatMap((s) => s.items.map((i) => ({ ...i, section: s.label })));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return all;
  const scored = all.map((i) => {
    const label = i.label.toLowerCase(), hay = `${label} ${i.section.toLowerCase()} ${i.keywords ?? ""}`;
    let score = 0;
    for (const w of words) {
      if (!hay.includes(w)) return null;
      score += label.startsWith(w) ? 4 : new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label) ? 3 : label.includes(w) ? 2 : 1;
    }
    return { i, score };
  }).filter((x): x is { i: NavItem & { section: string }; score: number } => x !== null);
  return scored.sort((a, b) => b.score - a.score).map((x) => x.i);
}
