/**
 * Another passkey for the signed-in person, step 1 (design 16.4: owners and controllers keep two
 * authenticators). The core issues registration options that exclude their current passkeys.
 */
import { error, json } from "@sveltejs/kit";
import { ApiError, members } from "$lib/server/api";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals }) => {
  const s = locals.session;
  if (!s) throw error(401, "Sign in first.");
  try { return json({ options: await members(s).addPasskeyOptions() }); }
  catch (e) {
    if (e instanceof ApiError) throw error(e.status >= 500 ? 502 : e.status, e.message);
    throw error(502, "Kuber's ledger service isn't reachable.");
  }
};
