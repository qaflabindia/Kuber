import { error } from "@sveltejs/kit";
import { api } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

const KINDS = {
  "profit-and-loss": { title: "Income and expenses", short: "Income & expenses", period: "range" },
  "balance-sheet": { title: "What you own and owe", short: "Balance sheet", period: "asOf" },
  "trial-balance": { title: "Trial balance", short: "Trial balance", period: "asOf" },
  "statement-of-affairs": { title: "Statement of affairs", short: "Statement of affairs", period: "range" },
} as const;
type Kind = keyof typeof KINDS;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function fy(today = new Date()) {
  const y = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

export const load: PageServerLoad = async ({ params, url, locals }) => {
  const kind = params.kind as Kind;
  if (!(kind in KINDS)) error(404, "No such report");
  const meta = KINDS[kind];
  const d = fy();
  const pick = (k: string, dflt: string) => { const v = url.searchParams.get(k); return v && ISO.test(v) ? v : dflt; };
  const from = pick("from", d.from), to = pick("to", d.to);
  const q: Record<string, string> = meta.period === "range" ? { from, to } : { asOf: to };
  const s = locals.session!;
  const statement = await api(s).report(s.book!, kind, q);
  return { kind, meta, from, to, statement, kinds: Object.entries(KINDS).map(([k, v]) => ({ kind: k, label: v.short })) };
};
