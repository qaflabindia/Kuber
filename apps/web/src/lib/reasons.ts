/**
 * Structured reasons for rejecting or correcting what the agent proposed and for discarding a plan
 * (context integrity: a decision above the approval limit, or on an item policy let the agent do on
 * its own, is recorded with a reason code the next decision can learn from). The core requires one
 * in those cases and accepts one always.
 */
export const REASONS: [code: string, label: string][] = [
  ["wrong_account", "Wrong account"], ["wrong_amount", "Wrong amount"], ["wrong_party", "Wrong party"], ["wrong_period", "Wrong date or period"],
  ["duplicate", "Duplicate"], ["not_business", "Not this book's"], ["missing_evidence", "No evidence"], ["policy_breach", "Against policy"],
  ["suspected_fraud", "Looks irregular"], ["superseded", "Superseded"], ["stale", "Books changed"], ["not_needed", "Not needed"], ["other", "Other (explain)"],
];
export const REASON_CODES = new Set(REASONS.map(([c]) => c));
/** The structured reason from a form's `code` and optional `text` fields, or undefined when no code was chosen. */
export function reasonFrom(f: FormData): { codes: string[]; text?: string } | undefined {
  const code = String(f.get("code") ?? "");
  if (!REASON_CODES.has(code)) return undefined;
  const text = String(f.get("reason") ?? f.get("note") ?? "").trim();
  return { codes: [code], ...(text ? { text } : {}) };
}
