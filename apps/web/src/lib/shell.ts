/**
 * The shell's state from the core's answers (plain TypeScript, no SvelteKit imports, so the root
 * test suite exercises it: tests/web-shell.test.ts). A call that failed arrives as null and stays
 * "unavailable": an unanswered control must never read as zero or as "nothing waiting" (F15).
 */
export interface Attention { drafts: number; awaitingApproval: number; ratifications: number; plans: number }

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
  hasJournals: boolean;
  /** true: chain verified; false: verification found a break; null: the check could not run. */
  intact: boolean | null;
  role: string;
  canSeeMembers: boolean;
}

export function shellState(r: ShellInputs, sessionRole: string): Shell {
  const a = r.attention;
  return {
    attentionAvailable: a !== null,
    reviewCount: a?.drafts ?? null,
    awaitingApproval: a?.awaitingApproval ?? null,
    confirmCount: a?.ratifications ?? null,
    pendingPlans: a?.plans ?? null,
    hasJournals: (r.journals?.length ?? 0) > 0,
    intact: r.verify ? r.verify.intact : null,
    // From the core's answer for this member (role changes show at once), not the session.
    role: r.me?.role ?? sessionRole,
    canSeeMembers: !!r.me?.permissions.includes("members.read"),
  };
}

export interface WaitingItem { href: string; label: string; icon: string; count: number; tone: string }

/** The rail: what is waiting, or "unavailable" when the counts could not be loaded. */
export function waitingRail(sh: Shell): { state: "unavailable" } | { state: "items"; items: WaitingItem[] } {
  if (!sh.attentionAvailable) return { state: "unavailable" };
  const items: WaitingItem[] = [];
  if (sh.pendingPlans) items.push({ href: "/", label: sh.pendingPlans === 1 ? "Plan to approve" : "Plans to approve", icon: "confirm", count: sh.pendingPlans, tone: "brass" });
  if (sh.reviewCount) items.push({ href: "/review", label: "Entries to review", icon: "review", count: sh.reviewCount, tone: sh.awaitingApproval ? "clay" : "brass" });
  if (sh.confirmCount) items.push({ href: "/confirm", label: "Postings to confirm", icon: "confirm", count: sh.confirmCount, tone: "brass" });
  return { state: "items", items };
}

/** The integrity line at the foot of the rail. */
export const integrityLabel = (intact: boolean | null) =>
  intact === null ? "Ledger check unavailable" : intact ? "Ledger verified" : "Ledger check failed";
