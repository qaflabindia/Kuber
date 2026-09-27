import { fail, redirect } from "@sveltejs/kit";
import { api, ApiError } from "$lib/server/api";
import { COOKIE, cookieOptions, encode } from "$lib/server/session";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!, a = api(s);
  const [books, position, items, groups] = await Promise.all([
    a.books().catch(() => null), a.plan(s.book!, "dashboard").catch(() => null),
    a.suspense(s.book!).catch(() => null), a.groups().catch(() => null),
  ]);
  return { books, position, items, groups: groups?.filter(g => books?.some(b => b.book_id === g.bookId)) ?? null,
    refreshedAt: new Date().toISOString() };
};
const problem = (e: unknown) => e instanceof ApiError ? e.message : "The request could not be completed. Try again.";
export const actions: Actions = {
  select: async ({ locals, request, cookies }) => {
    const s = locals.session!, book = String((await request.formData()).get("book") ?? "");
    try {
      if (!(await api(s).books()).some(b => b.book_id === book)) return fail(403, { message: "Choose a book you can access." });
    } catch (e) { return fail(502, { message: problem(e) }); }
    cookies.set(COOKIE, encode({ ...s, book }), cookieOptions);
    throw redirect(303, "/cfo");
  },
  assign: async ({ locals, request }) => {
    const s = locals.session!, f = await request.formData();
    const id = String(f.get("item") ?? ""), owner = String(f.get("owner") ?? "").trim();
    if (!owner || owner.length > 200) return fail(400, { message: "Enter an accountable owner (up to 200 characters)." });
    try {
      if (!(await api(s).suspense(s.book!)).some(i => i.itemId === id)) return fail(404, { message: "This open item is no longer in the selected book. Refresh the briefing." });
      await api(s).assignSuspense(id, owner);
      return { message: "Owner saved. The assignment is recorded in the audit history." };
    } catch (e) { return fail(422, { message: problem(e) }); }
  },
  inspect: async ({ locals, request }) => {
    const s = locals.session!, f = await request.formData(), op = String(f.get("op") ?? "");
    if (!["balance", "suspense", "simulate", "ic_mismatches", "group_pnl", "group_balance_sheet", "group_perimeter"].includes(op)) return fail(400, { message: "Choose one of the briefing checks." });
    const input: Record<string, unknown> = {};
    if (op === "simulate") {
      const income = String(f.get("income") ?? "0"), expenses = String(f.get("expenses") ?? "0");
      if (![income, expenses].every(v => /^-?\d{1,12}(\.\d{1,2})?$/.test(v))) return fail(400, { message: "Enter monthly changes in rupees, with at most two decimal places." });
      input.monthlyChange = { income, expenses }; input.months = 12;
    }
    try { return { plan: await api(s).plan(s.book!, op, input) }; }
    catch (e) { return fail(422, { message: problem(e) }); }
  },
};
