import { fail, redirect } from "@sveltejs/kit";
import { api, ApiError } from "$lib/server/api";
import { COOKIE, cookieOptions, encode } from "$lib/server/session";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.session?.book) throw redirect(303, "/");
  return {};
};

const TYPES = ["individual", "household", "freelancer", "company"];

export const actions: Actions = {
  default: async ({ request, locals, cookies }) => {
    const s = locals.session!;
    const f = await request.formData();
    const entityType = String(f.get("type") ?? "");
    if (!TYPES.includes(entityType)) return fail(400, { message: "Choose who these books are for." });
    const asOf = String(f.get("asOf") || new Date().toISOString().slice(0, 10));
    const a = api(s);
    const book = "main";
    try {
      await a.openBook(book, s.tenant, entityType);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "book_exists")) return fail(502, { message: e instanceof Error ? e.message : "Could not open the books." });
    }
    // opening balances are optional; blank fields are skipped
    const openings: [string, string][] = [["BANK", "bank"], ["CASH", "cash"], ["LOANS", "loans"]];
    for (const [acc, field] of openings) {
      const v = String(f.get(field) ?? "").trim();
      if (!v || v === "0") continue;
      try { await a.openingBalance(book, acc, v, asOf); }
      catch (e) { return fail(422, { message: `Opening balance for ${field}: ${e instanceof Error ? e.message : "not accepted"}` }); }
    }
    cookies.set(COOKIE, encode({ ...s, book, issuedAt: Date.now() }), cookieOptions);
    throw redirect(303, "/");
  },
};
