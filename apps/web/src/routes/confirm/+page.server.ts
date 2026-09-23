import { fail } from "@sveltejs/kit";
import { api } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!;
  const a = api(s);
  const [items, accounts, journals] = await Promise.all([a.ratifications(), a.accounts(s.book!), a.journals(s.book!, 200)]);
  const byId = new Map(journals.map((j) => [j.journal_id, j]));
  return {
    accounts: accounts.map(({ account_id, name, nature }) => ({ account_id, name, nature })),
    items: items.map((r) => {
      const j = byId.get(r.journal_id);
      const cash = j?.lines.find((l) => ["BANK", "CASH", "CARD"].includes(l.accountId));
      const other = j?.lines.find((l) => l !== cash);
      const amt = BigInt(cash?.amount ?? other?.amount ?? "0");
      return { ...r, txnDate: j?.txn_date ?? null, accountId: other?.accountId ?? null,
        direction: amt >= 0n ? ("in" as const) : ("out" as const), amount: (amt < 0n ? -amt : amt).toString() };
    }),
  };
};

export const actions: Actions = {
  ratify: async ({ request, locals }) => {
    const id = String((await request.formData()).get("journalId") ?? "");
    try { await api(locals.session!).ratify(id); return { id, done: "ratified" }; }
    catch (e) { return fail(409, { id, message: e instanceof Error ? e.message : "Could not confirm." }); }
  },
  correct: async ({ request, locals }) => {
    const f = await request.formData();
    const id = String(f.get("journalId") ?? ""), to = String(f.get("accountId") ?? ""), learn = f.get("learn") === "on";
    if (!to || to === "SUSPENSE") return fail(400, { id, message: "Choose the account it should have gone to." });
    try { await api(locals.session!).correct(id, to, learn); return { id, done: "corrected" }; }
    catch (e) { return fail(409, { id, message: e instanceof Error ? e.message : "Could not correct." }); }
  },
};
