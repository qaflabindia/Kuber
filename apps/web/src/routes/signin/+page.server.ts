import { fail, redirect } from "@sveltejs/kit";
import { ApiError, identity } from "$lib/server/api";
import { COOKIE, devSignInEnabled, slug } from "$lib/server/session";
import { startSession } from "$lib/server/signin";
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
      to = await startSession(cookies, await identity(workspace).devSignIn(name), url.searchParams.get("next"));
    } catch (e) {
      if (e instanceof ApiError) return fail(e.status, { message: e.message, name, workspace });
      return fail(502, { message: "Kuber's ledger service isn't reachable. Is the core running on port 8080?", name, workspace });
    }
    throw redirect(303, to);
  },
  signout: async ({ cookies }) => {
    cookies.delete(COOKIE, { path: "/" });
    throw redirect(303, "/signin");
  },
};
