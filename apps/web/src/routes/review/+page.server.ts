import { fail } from "@sveltejs/kit";
import { api } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!;
  const a = api(s);
  const [drafts, accounts] = await Promise.all([a.drafts(), a.accounts(s.book!)]);
  return { drafts, accounts: accounts.map(({ account_id, name, nature }) => ({ account_id, name, nature })) };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    const f = await request.formData();
    const id = String(f.get("id") ?? ""), accountId = String(f.get("accountId") ?? "") || undefined;
    if (accountId === "SUSPENSE") return fail(400, { id, message: "Choose where this belongs before approving." });
    try { await api(locals.session!).approve(id, accountId); return { id, done: "approved" }; }
    catch (e) { return fail(409, { id, message: e instanceof Error ? e.message : "Could not approve." }); }
  },
  reject: async ({ request, locals }) => {
    const f = await request.formData();
    const id = String(f.get("id") ?? ""), reason = String(f.get("reason") ?? "").trim() || "Not a real transaction";
    try { await api(locals.session!).reject(id, reason); return { id, done: "rejected" }; }
    catch (e) { return fail(409, { id, message: e instanceof Error ? e.message : "Could not reject." }); }
  },
};
