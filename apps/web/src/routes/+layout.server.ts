import { redirect } from "@sveltejs/kit";
import { api } from "$lib/server/api";
import type { LayoutServerLoad } from "./$types";

/**
 * The shell's data. Navigation is emergent: an item appears only when it has something for the
 * person (drafts to review, postings to confirm, journals to report on).
 */
export const load: LayoutServerLoad = async ({ locals, url }) => {
  const s = locals.session;
  if (!s) return { session: null, shell: null };
  if (!s.book && url.pathname !== "/setup") throw redirect(303, "/setup");
  if (!s.book) return { session: s, shell: null };

  const a = api(s);
  const [drafts, ratifications, journals, verify] = await Promise.all([
    a.drafts().catch(() => []), a.ratifications().catch(() => []),
    a.journals(s.book, 1).catch(() => []), a.verify(s.book).catch(() => ({ intact: false, firstBrokenJournal: null })),
  ]);
  return {
    session: s,
    shell: {
      reviewCount: drafts.length,
      awaitingApproval: drafts.filter((d) => d.status === "awaiting_approval").length,
      confirmCount: ratifications.length,
      hasJournals: journals.length > 0,
      intact: verify.intact,
    },
  };
};
