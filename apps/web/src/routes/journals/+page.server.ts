import { api } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

/** The day book: journals newest first, 50 at a time (older pages by ledger position). */
export const load: PageServerLoad = async ({ locals, url }) => {
  const s = locals.session!, a = api(s);
  const before = Number(url.searchParams.get("before") ?? "");
  const [journals, accounts, parties] = await Promise.all([
    a.journals(s.book!, 50, Number.isInteger(before) && before > 0 ? before : undefined).catch(() => null),
    a.accounts(s.book!).catch(() => []), a.parties().catch(() => []),
  ]);
  return {
    journals, before: Number.isInteger(before) && before > 0 ? before : null, focus: url.searchParams.get("focus"),
    names: Object.fromEntries(accounts.map((x) => [x.account_id, x.name])),
    partyNames: Object.fromEntries((parties ?? []).map((p) => [p.partyId, p.name])),
  };
};
