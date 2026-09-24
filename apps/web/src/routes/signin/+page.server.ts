import { fail, redirect } from "@sveltejs/kit";
import { ApiError, api, identity } from "$lib/server/api";
import { COOKIE, devSignInEnabled, newSessionId, slug } from "$lib/server/session";
import { startSession } from "$lib/server/signin";
import { forgetStepUp } from "$lib/server/stepup";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.session) throw redirect(303, "/");
  return { devSignIn: devSignInEnabled() };
};

export const actions: Actions = {
  /**
   * DEVELOPMENT ONLY (KUBER_DEV_SIGNIN=true here and in the core): an owner by name, no passkey.
   * The core refuses it for a workspace that already has people.
   */
  dev: async ({ request, cookies, url }) => {
    if (!devSignInEnabled()) return fail(403, { message: "Development sign-in is disabled. Use a passkey.", name: "", workspace: "" });
    const f = await request.formData();
    const name = String(f.get("name") ?? "").trim();
    const workspace = slug(String(f.get("workspace") ?? "") || name);
    if (name.length < 2) return fail(400, { message: "Enter your name.", name, workspace });
    if (!workspace) return fail(400, { message: "Choose a workspace name.", name, workspace });
    let to: string;
    try {
      const sid = newSessionId();
      to = await startSession(cookies, await identity(workspace, sid).devSignIn(name), url.searchParams.get("next"), sid);
    } catch (e) {
      if (e instanceof ApiError) return fail(e.status, { message: e.message, name, workspace });
      return fail(502, { message: "Kuber's ledger service isn't reachable. Is the core running on port 8080?", name, workspace });
    }
    throw redirect(303, to);
  },
  signout: async ({ cookies, locals }) => {
    // Revoke the session in the core first, so the cookie is worthless even if it was copied.
    // Sign-out still completes locally when the core cannot be reached.
    if (locals.session) await api(locals.session).signOut().catch(() => undefined);
    cookies.delete(COOKIE, { path: "/" });
    forgetStepUp(cookies);
    throw redirect(303, "/signin");
  },
};
