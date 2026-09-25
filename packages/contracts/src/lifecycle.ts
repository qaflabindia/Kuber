/**
 * Journal lifecycle vocabulary (FIN-GL-01). Whatever path an entry takes (a drafted statement line,
 * an ops plan, a manual journal, a scheduled occurrence), a person sees one of these states:
 *
 *   draft      prepared, not yet put forward (an agent draft in the review queue, a plan preview)
 *   submitted  put forward for a decision (awaiting approval, a proposed plan)
 *   approved   a person or policy approved it; nothing has been sent to the ledger yet
 *   posting    sent to the ledger, which has not answered yet
 *   posted     the ledger accepted it (JournalPosted)
 *   failed     refused (by the ledger, a reviewer, a stale basis) with the reason; nothing was posted
 *
 * Stored states are not renamed: agent drafts and ops plans keep their own columns, and these
 * functions map them for the API and reports.
 */
export const JOURNAL_STATES = ["draft", "submitted", "approved", "posting", "posted", "failed"] as const;
export type JournalState = (typeof JOURNAL_STATES)[number];

/** Agent draft status (agent.drafts.status) to the lifecycle. */
export function draftLifecycle(status: string): JournalState {
  switch (status) {
    case "queued": return "draft";
    case "awaiting_approval": return "submitted";
    case "approved": return "posting";              // PostingRequested sent; the GL has not answered
    case "posted": return "posted";
    case "rejected_by_gl": case "rejected": return "failed";
    default: return "draft";
  }
}

/**
 * Ops plan status (ops.plans.status) to the lifecycle. `error`: a commit attempt failed and nothing
 * was applied. `viaDrafts`: the plan's journals post through the agent (post op), so a committed plan
 * has only requested them. `approvalOnly`: the plan approves later postings (a schedule approval).
 */
export function planLifecycle(status: string, o: { error?: string | null; viaDrafts?: boolean; approvalOnly?: boolean } = {}): JournalState {
  switch (status) {
    case "preview": return "draft";
    case "proposed": return o.error ? "failed" : "submitted";
    // approvalOnly: the plan approves future postings (a schedule) and posts nothing itself
    case "committed": return o.approvalOnly ? "approved" : o.viaDrafts ? "posting" : "posted";
    case "discarded": case "stale": return "failed";
    default: return "draft";
  }
}
