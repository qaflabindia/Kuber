import { error } from "@sveltejs/kit";
import { api } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const load: PageServerLoad = async ({ params, url, locals }) => {
  const s = locals.session!;
  const a = api(s);
  const q: Record<string, string> = {};
  for (const k of ["from", "to"]) { const v = url.searchParams.get(k); if (v && ISO.test(v)) q[k] = v; }
  const [accounts, lines] = await Promise.all([a.accounts(s.book!), a.drill(s.book!, params.account, q)]);
  const account = accounts.find((x) => x.account_id === params.account);
  if (!account) error(404, "No such account");
  return { account, lines, from: q.from ?? null, to: q.to ?? null };
};
