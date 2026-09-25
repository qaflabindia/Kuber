/**
 * Step-up, step 2: the core verifies the passkey response against the challenge it issued for
 * this person. Only then does the BFF remember the step-up (five minutes), which it carries to
 * the core in its signed assertions for sensitive approvals.
 */
import { error, json } from "@sveltejs/kit";
import { STEP_UP_MAX_AGE_MS } from "@kuber/auth";
import { ApiError, members } from "$lib/server/api";
import { devSignInEnabled } from "$lib/server/session";
import { rememberStepUp, takeStepUpCeremony } from "$lib/server/stepup";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, cookies, request }) => {
  const s = locals.session;
  if (!s) throw error(401, "Sign in first.");
  const b = (await request.json().catch(() => ({}))) as { dev?: boolean; response?: { response?: { clientDataJSON?: string } } };
  const c = takeStepUpCeremony(cookies, s);
  let body: { response: unknown } | { dev: true };
  if (b.dev === true) {
    if (!devSignInEnabled()) throw error(403, "Development sign-in is disabled. Use your passkey.");
    body = { dev: true };
  } else {
    if (!c) throw error(400, "That confirmation took too long. Try again.");
    if (!b.response) throw error(400, "No passkey response.");
    // The response must answer this browser's ceremony, not one started elsewhere.
    try {
      const cd = JSON.parse(Buffer.from(String(b.response.response?.clientDataJSON ?? ""), "base64url").toString("utf8")) as { challenge?: string };
      if (cd.challenge !== c.challenge) throw new Error("challenge");
    } catch { throw error(400, "That passkey response does not belong to this confirmation."); }
    body = { response: b.response };
  }
  try {
    await members(s).stepUp(body);
    const at = Date.now();
    rememberStepUp(cookies, s, at);
    return json({ ok: true, until: at + STEP_UP_MAX_AGE_MS });
  } catch (e) {
    if (e instanceof ApiError) throw error(e.status >= 500 ? 502 : e.status, e.message);
    throw error(502, "Kuber's ledger service isn't reachable.");
  }
};
