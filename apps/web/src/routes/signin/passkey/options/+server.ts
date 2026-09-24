/**
 * Step 1 of a passkey ceremony: ask the core for WebAuthn options (it issues the challenge),
 * remember the ceremony in a short-lived encrypted cookie, and hand the options to the browser.
 */
import { error, json } from "@sveltejs/kit";
import { ApiError, identity } from "$lib/server/api";
import { CEREMONY_COOKIE, ceremonyCookieOptions, encodeCeremony, slug } from "$lib/server/session";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies }) => {
  const b = (await request.json().catch(() => ({}))) as { mode?: string; workspace?: string; name?: string; code?: string };
  const mode = b.mode === "register" ? "register" : "signin";
  const tenant = slug(String(b.workspace ?? ""));
  if (!tenant) throw error(400, "Enter your workspace.");
  const name = String(b.name ?? "").trim(), code = String(b.code ?? "").trim() || undefined;
  if (mode === "register" && name.length < 2) throw error(400, "Enter your name.");
  try {
    const id = identity(tenant);
    const options = mode === "register" ? await id.registrationOptions(name, code) : await id.authenticationOptions();
    cookies.set(CEREMONY_COOKIE, encodeCeremony({ mode, tenant, challenge: options.challenge, name, code, issuedAt: Date.now() }), ceremonyCookieOptions);
    return json({ mode, options });
  } catch (e) {
    if (e instanceof ApiError) throw error(e.status >= 500 ? 502 : e.status, e.message);
    throw error(502, "Kuber's ledger service isn't reachable.");
  }
};
