import { fail, redirect } from "@sveltejs/kit";
import { api } from "$lib/server/api";
import { COOKIE, cookieOptions, encode, slug } from "$lib/server/session";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.session) throw redirect(303, "/");
  return {};
};

export const actions: Actions = {
  /** Development sign-in. Phase 1 replaces this with passkeys (WebAuthn). */
  signin: async ({ request, cookies, url }) => {
    const f = await request.formData();
    const name = String(f.get("name") ?? "").trim();
    const workspace = slug(String(f.get("workspace") ?? "") || name);
    if (name.length < 2) return fail(400, { message: "Enter your name.", name, workspace });
    if (!workspace) return fail(400, { message: "Choose a workspace name.", name, workspace });
    const principal = `owner:${slug(name) || "owner"}`;
    let book: string | null = null;
    try {
      const books = await api({ tenant: workspace, principal }).books();
      book = books[0]?.book_id ?? null;
    } catch {
      return fail(502, { message: "Kuber's ledger service isn't reachable. Is the core running on port 8080?", name, workspace });
    }
    cookies.set(COOKIE, encode({ tenant: workspace, principal, name, book, issuedAt: Date.now() }), cookieOptions);
    const next = url.searchParams.get("next");
    throw redirect(303, book ? (next && next.startsWith("/") && !next.startsWith("//") ? next : "/") : "/setup");
  },
  signout: async ({ cookies }) => {
    cookies.delete(COOKIE, { path: "/" });
    throw redirect(303, "/signin");
  },
};
