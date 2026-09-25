/**
 * Another passkey, step 2: the core verifies the new passkey. A person who already has one must
 * have confirmed with it moments ago (the step-up the BFF carries as claim `su`), so a stolen
 * session alone cannot add someone else's key.
 */
import { error, json } from "@sveltejs/kit";
import { ApiError, members } from "$lib/server/api";
import { stepUpAt } from "$lib/server/stepup";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, cookies, request }) => {
  const s = locals.session;
  if (!s) throw error(401, "Sign in first.");
  const b = (await request.json().catch(() => ({}))) as { response?: unknown };
  if (!b.response) throw error(400, "No passkey response.");
  try { return json(await members({ ...s, stepUpAt: stepUpAt(cookies, s) }).addPasskey(b.response), { status: 201 }); }
  catch (e) {
    if (e instanceof ApiError) throw error(e.status >= 500 ? 502 : e.status, e.message);
    throw error(502, "Kuber's ledger service isn't reachable.");
  }
};
