/**
 * Model-processing gate (TAGOF Domain 12 CBJ-01/02 cross-border data flow; GEN-04 dependency map;
 * agent design 7.1: the gate sits in the Python agent middleware AND in the TypeScript core).
 *
 * Book data may reach a language model only after the operator records a processing decision:
 *
 *   KUBER_LLM_PROCESSING_APPROVED=<approver>:<YYYY-MM-DD>:<data-location>
 *     e.g. system_owner:laksh:2026-09-25:us     (the approver may itself contain ':'; the last two
 *                                                fields are the date and the data location)
 *
 * Validated at start-up (main.ts refuses to start on a malformed value). Without a valid record the
 * core builds no model path (providerFromEnv returns null and logs why) and must not call the agent
 * middleware (requireProcessingApproval throws); every middleware request carries the record in
 * PROCESSING_HEADER and the middleware checks it against its own configuration, so neither tier
 * alone can switch model processing on. See agent/dependencies.md.
 */
import { isIsoDate } from "@kuber/contracts";

export const PROCESSING_ENV = "KUBER_LLM_PROCESSING_APPROVED";
export const PROCESSING_HEADER = "x-kuber-processing-approval";

export interface ProcessingApproval { approver: string; date: string; location: string; record: string }
export type ProcessingCheck = { ok: true; approval: ProcessingApproval } | { ok: false; reason: string; configured: boolean };

export class ProcessingNotApproved extends Error {
  readonly code = "processing_not_approved";
  constructor(reason: string) { super(`model processing is not approved: ${reason}`); }
}

const APPROVER = /^[a-z][\w.@-]*(:[\w.@-]+)?$/i;
/** ISO 3166 alpha-2 country, optionally a provider region: in, us, eu, in-mumbai, us-east-1, ap-south-1. */
const LOCATION = /^[a-z]{2}(-[a-z0-9]+){0,3}$/i;

export function parseProcessingApproval(value: string | undefined, today = new Date().toISOString().slice(0, 10)): ProcessingCheck {
  const v = value?.trim();
  if (!v) return { ok: false, configured: false, reason: `${PROCESSING_ENV} is not set: no processing decision has been recorded for sending book data to a model` };
  const parts = v.split(":");
  if (parts.length < 3) return { ok: false, configured: true, reason: `${PROCESSING_ENV} must be <approver>:<YYYY-MM-DD>:<data-location>` };
  const location = parts.pop()!, date = parts.pop()!, approver = parts.join(":");
  if (!APPROVER.test(approver)) return { ok: false, configured: true, reason: `${PROCESSING_ENV}: approver "${approver}" is not a principal or name` };
  if (!isIsoDate(date)) return { ok: false, configured: true, reason: `${PROCESSING_ENV}: "${date}" is not a real YYYY-MM-DD date` };
  if (date > today) return { ok: false, configured: true, reason: `${PROCESSING_ENV}: the decision date ${date} is in the future` };
  if (!LOCATION.test(location)) return { ok: false, configured: true, reason: `${PROCESSING_ENV}: data location "${location}" must be a country code, optionally with a region (in, us, eu-west-1)` };
  return { ok: true, approval: { approver, date, location: location.toLowerCase(), record: `${approver}:${date}:${location.toLowerCase()}` } };
}

export const processingFromEnv = (env: NodeJS.ProcessEnv = process.env, today?: string) => parseProcessingApproval(env[PROCESSING_ENV], today);

/** The core's gate before any model call (direct provider or agent middleware). Throws ProcessingNotApproved. */
export function requireProcessingApproval(env: NodeJS.ProcessEnv = process.env, today?: string): ProcessingApproval {
  const c = processingFromEnv(env, today);
  if (!c.ok) throw new ProcessingNotApproved(c.reason);
  return c.approval;
}

/** Headers for a request to the agent middleware: the record the middleware re-checks. */
export const middlewareHeaders = (a: ProcessingApproval): Record<string, string> => ({ [PROCESSING_HEADER]: a.record });
