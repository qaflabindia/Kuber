import { fail } from "@sveltejs/kit";
import { api } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

const fyStart = (d = new Date()) => {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
};

export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!;
  const a = api(s);
  const book = s.book!;
  const [bs, pl, accounts, drafts, ratifications, journals] = await Promise.all([
    a.report(book, "balance-sheet"), a.report(book, "profit-and-loss", { from: fyStart() }),
    a.accounts(book), a.drafts(), a.ratifications(), a.journals(book, 8),
  ]);
  const cash = accounts.filter((x) => x.nature === "asset" && ["BANK", "CASH"].includes(x.account_id))
    .reduce((t, x) => t + BigInt(x.balance), 0n);
  const assets = BigInt(bs.totals["Total assets"] ?? "0"), liabilities = BigInt(bs.totals["Total liabilities"] ?? "0");
  return {
    figures: {
      cash: cash.toString(),
      netWorth: (assets - liabilities).toString(),
      surplus: pl.totals["Surplus / (deficit)"] ?? "0",
      income: pl.totals["Total income"] ?? "0",
      expenses: pl.totals["Total expenses"] ?? "0",
      fyStart: fyStart(),
    },
    drafts: drafts.slice(0, 4),
    draftTotal: drafts.length,
    ratifications: ratifications.length,
    journals,
    accountNames: Object.fromEntries(accounts.map((x) => [x.account_id, x.name])),
  };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    const id = String((await request.formData()).get("id") ?? "");
    try { await api(locals.session!).approve(id); return { ok: true }; }
    catch (e) { return fail(409, { message: e instanceof Error ? e.message : "Could not approve." }); }
  },
};
