import { api } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!;
  const a = api(s);
  const [accounts, verify] = await Promise.all([a.accounts(s.book!), a.verify(s.book!)]);
  return { accounts, verify, book: s.book! };
};
