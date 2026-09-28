import { fail } from "@sveltejs/kit";
import { api, ApiError, members } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

/** Record a transaction: the book's accounts (with control and money-account flags), its parties, and the latest entries. */
export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!, a = api(s);
  const [accounts, parties, journals, me] = await Promise.all([
    a.accounts(s.book!), a.parties().catch(() => null), a.journals(s.book!, 200).catch(() => null), members(s).me().catch(() => null),
  ]);
  const recent = journals ? journals.slice(0, 6) : null;
  // Originals a return can be recorded against: the latest 200 journals' sales and purchase vouchers, not reversed.
  const originals = (journals ?? []).filter((j) => (j.voucher_type === "sales" || j.voucher_type === "purchase") && !j.reverses)
    .map((j) => ({ journalId: j.journal_id, type: j.voucher_type as "sales" | "purchase", date: j.txn_date, narration: j.narration, lines: j.lines,
      total: j.lines.reduce((t, l) => (BigInt(l.amount) > 0n ? t + BigInt(l.amount) : t), 0n).toString() }));
  const perms = new Set(me?.permissions ?? []);
  return {
    accounts: accounts.filter((x) => x.account_id !== "SUSPENSE"),
    parties, recent, originals,
    today: new Date().toISOString().slice(0, 10),
    canPrepare: perms.has("plan.prepare"),
    // FIN-GL-01: only a superuser or controller may flag a controlled adjustment to a control account.
    canAdjust: ["superuser", "controller", "owner"].includes(me?.role ?? s.role),
  };
};

export const actions: Actions = {
  /** Ask the core to check the voucher and show exactly what it would post (nothing is written). */
  preview: async ({ request, locals }) => {
    const s = locals.session!;
    let input: unknown;
    try { input = JSON.parse(String((await request.formData()).get("voucher") ?? "")); }
    catch { return fail(400, { message: "The voucher could not be read. Reload and try again." }); }
    try { return { plan: await api(s).plan(s.book!, "journal", input) }; }
    catch (e) {
      const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Kuber could not check this voucher.";
      return fail(e instanceof ApiError && e.status === 403 ? 403 : 422, { message });
    }
  },
};
