/**
 * Step-up, step 1: the signed-in person asks the core for a challenge that only their own
 * passkeys can answer (user verification required). With development sign-in enabled on both
 * tiers, a member who has no passkey is told to confirm without one (`dev: true`).
 */
import { error, json } from "@sveltejs/kit";
import { ApiError, members } from "$lib/server/api";
import { devSignInEnabled } from "$lib/server/session";
import { startStepUpCeremony } from "$lib/server/stepup";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, cookies }) => {
  const s = locals.session;
  if (!s) throw error(401, "Sign in first.");
  try {
    const options = await members(s).stepUpOptions();
    startStepUpCeremony(cookies, s, options.challenge);
    return json({ options });
  } catch (e) {
    if (e instanceof ApiError && e.code === "no_passkey" && devSignInEnabled()) return json({ dev: true });
    if (e instanceof ApiError) throw error(e.status >= 500 ? 502 : e.status, e.message);
    throw error(502, "Kuber's ledger service isn't reachable.");
  }
};
