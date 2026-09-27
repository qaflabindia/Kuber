/**
 * Signed commands, step 1 (design 14.4/16.4): the browser names the command it wants to carry out;
 * the core checks the person may do it, renders what it would do from the command itself, and
 * returns WebAuthn options whose challenge is the digest of exactly that command. The browser
 * shows the summary, then asks the passkey to sign; the signature travels with the command itself.
 *
 * With development sign-in enabled on both tiers, a member who has no passkey is told to use the
 * development step-up instead (`dev: true`): not a signature, and recorded as such by the core.
 */
import { error, json } from "@sveltejs/kit";
import { ApiError, members, type SigningRequest } from "$lib/server/api";
import { devSignInEnabled } from "$lib/server/session";
import type { RequestHandler } from "./$types";

const ACTIONS = new Set(["plan.commit", "plan.approve", "draft.approve", "journal.ratify", "period.lock", "migration.golive"]);

export const POST: RequestHandler = async ({ locals, request }) => {
  const s = locals.session;
  if (!s) throw error(401, "Sign in first.");
  const b = (await request.json().catch(() => null)) as SigningRequest | null;
  if (!b || typeof b !== "object" || !ACTIONS.has(String((b as { action?: unknown }).action))) throw error(400, "Which command should be signed?");
  try {
    return json(await members(s).signingOptions(b));
  } catch (e) {
    if (e instanceof ApiError && e.code === "no_passkey" && devSignInEnabled()) return json({ dev: true });
    if (e instanceof ApiError) return json({ error: e.code, message: e.message }, { status: e.status >= 500 ? 502 : e.status });
    throw error(502, "Kuber's ledger service isn't reachable.");
  }
};
