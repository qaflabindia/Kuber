import { fail } from "@sveltejs/kit";
import { api, ApiError } from "$lib/server/api";
import { reasonFrom } from "$lib/reasons";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!;
  const a = api(s);
  const [drafts, accounts] = await Promise.all([a.drafts(s.books ? s.book ?? undefined : undefined), a.accounts(s.book!)]);
  return { drafts, accounts: accounts.map(({ account_id, name, nature }) => ({ account_id, name, nature })) };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    const f = await request.formData();
    const id = String(f.get("id") ?? ""), accountId = String(f.get("accountId") ?? "") || undefined;
    if (accountId === "SUSPENSE") return fail(400, { id, message: "Choose where this belongs before approving." });
    // Above the approval limit the approval is a signed command: the passkey signature travels with it.
    let assertion: unknown;
    try { assertion = f.get("assertion") ? JSON.parse(String(f.get("assertion"))) : undefined; }
    catch { return fail(400, { id, code: "bad_signature", message: "That passkey signature could not be read. Try again." }); }
    try { await api(locals.session!).approve(id, accountId, assertion, reasonFrom(f)); return { id, done: "approved" }; }
    catch (e) { return fail(e instanceof ApiError && e.code === "step_up_required" ? 403 : 409, { id, code: e instanceof ApiError ? e.code : "error", message: e instanceof Error ? e.message : "Could not approve." }); }
  },
  reject: async ({ request, locals }) => {
    const f = await request.formData();
    const id = String(f.get("id") ?? ""), reason = String(f.get("reason") ?? "").trim() || "Not a real transaction";
    try { await api(locals.session!).reject(id, reason, reasonFrom(f)?.codes); return { id, done: "rejected" }; }
    catch (e) { return fail(409, { id, message: e instanceof Error ? e.message : "Could not reject." }); }
  },
};
