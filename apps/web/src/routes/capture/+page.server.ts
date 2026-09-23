import { fail, redirect } from "@sveltejs/kit";
import { api, ApiError } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => { throw redirect(303, "/"); };

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const s = locals.session!;
    const text = String((await request.formData()).get("text") ?? "").trim();
    if (!text) return fail(400, { message: "Write what happened, for example “Paid 450 to the plumber in cash”." });
    try {
      const r = await api(s).chat(s.book!, text);
      if (r.duplicate) return { message: "Kuber already has this entry, so nothing was added." };
      return { message: "Recorded. It will appear in your books in a moment." };
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_understood")
        return fail(422, { message: "Kuber couldn't find an amount and whether money came in or went out. Try “Paid 450 to … in cash”." });
      return fail(502, { message: e instanceof Error ? e.message : "The ledger service did not respond." });
    }
  },
};
