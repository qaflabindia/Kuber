import { redirect } from "@sveltejs/kit";
import { api } from "$lib/server/api";
import type { LayoutServerLoad } from "./$types";

/**
 * The shell's data. There is no menu: the rail shows only what is waiting for the person
 * (plans to approve, drafts to review, postings to confirm); everything else is reached from the canvas.
 */
export const load: LayoutServerLoad = async ({ locals, url }) => {
  const s = locals.session;
  if (!s) return { session: null, shell: null };
  if (!s.book && url.pathname !== "/setup") throw redirect(303, "/setup");
  if (!s.book) return { session: s, shell: null };

  const a = api(s);
  const [drafts, ratifications, journals, verify, plans] = await Promise.all([
    a.drafts().catch(() => []), a.ratifications().catch(() => []),
    a.journals(s.book, 1).catch(() => []), a.verify(s.book).catch(() => ({ intact: false, firstBrokenJournal: null })),
    a.plans(s.book).catch(() => []),
  ]);
  return {
    session: s,
    shell: {
      reviewCount: drafts.length,
      awaitingApproval: drafts.filter((d) => d.status === "awaiting_approval").length,
      confirmCount: ratifications.length,
      hasJournals: journals.length > 0,
      intact: verify.intact,
      pendingPlans: plans.length,
    },
  };
};
