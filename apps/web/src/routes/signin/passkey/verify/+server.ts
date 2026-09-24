/**
 * Step 2: the browser's passkey response goes to the core, which verifies it against the
 * challenge it issued and the credential it holds. Only then is a session issued.
 */
import { error, json } from "@sveltejs/kit";
import { ApiError, identity } from "$lib/server/api";
import { CEREMONY_COOKIE, decodeCeremony } from "$lib/server/session";
import { startSession } from "$lib/server/signin";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies, url }) => {
  const c = decodeCeremony(cookies.get(CEREMONY_COOKIE));
  cookies.delete(CEREMONY_COOKIE, { path: "/signin" });                 // one attempt per ceremony
  if (!c) throw error(400, "That sign-in took too long. Try again.");
  const b = (await request.json().catch(() => ({}))) as { response?: { response?: { clientDataJSON?: string } } };
  if (!b.response) throw error(400, "No passkey response.");
  // The response must answer this browser's ceremony, not one started elsewhere.
  try {
    const cd = JSON.parse(Buffer.from(String(b.response.response?.clientDataJSON ?? ""), "base64url").toString("utf8")) as { challenge?: string };
    if (cd.challenge !== c.challenge) throw new Error("challenge");
  } catch { throw error(400, "That passkey response does not belong to this sign-in."); }
  try {
    const id = identity(c.tenant);
    const member = c.mode === "register" ? await id.register(c.name ?? "", b.response, c.code) : await id.authenticate(b.response);
    return json({ redirect: await startSession(cookies, member, url.searchParams.get("next")) });
  } catch (e) {
    if (e instanceof ApiError) throw error(e.status >= 500 ? 502 : e.status === 401 ? 401 : e.status, e.message);
    throw error(502, "Kuber's ledger service isn't reachable.");
  }
};
