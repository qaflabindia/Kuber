import { redirect } from "@sveltejs/kit";
import { api, members } from "$lib/server/api";
import { shellState } from "$lib/shell";
import type { LayoutServerLoad } from "./$types";

/** Where each external role lands (role model v2): customers and suppliers their portal, investors and guests their reports. */
const EXTERNAL_HOME: Record<string, string> = { customer: "/portal", supplier: "/portal", investor: "/investor", guest: "/investor" };

/**
 * The shell's data. There is no menu: the rail shows only what is waiting for the person
 * (plans to approve, drafts to review, postings to confirm); everything else is reached from the canvas.
 */
export const load: LayoutServerLoad = async ({ locals, url }) => {
  const s = locals.session;
  if (!s) return { session: null, shell: null };
  // Role model v2: external roles have their own small pages and never see the books.
  const home = EXTERNAL_HOME[s.role];
  if (home) {
    if (!url.pathname.startsWith(home) && !url.pathname.startsWith("/signin")) throw redirect(303, home);
    return { session: s, shell: null };
  }
  // An admin reads no books (role model v2): it manages members.
  if (s.role === "admin" && !s.book) {
    if (!url.pathname.startsWith("/settings/members")) throw redirect(303, "/settings/members");
    return { session: s, shell: null };
  }
  if (!s.book && url.pathname !== "/setup") throw redirect(303, "/setup");
  if (!s.book) return { session: s, shell: null };

  const a = api(s);
  // Counts, not lists: the shell's cost does not grow with the queue (F11). A call that fails is
  // "unavailable" (null), never zero: an unanswered control must not read as "nothing waiting" (F15).
  const [attention, journals, verify, me] = await Promise.all([
    a.attention(s.book).catch(() => null),
    a.journals(s.book, 1).catch(() => null), a.verify(s.book).catch(() => null),
    members(s).me().catch(() => null),
  ]);
  return { session: s, shell: shellState({ attention, journals, verify, me }, s.role) };
};
