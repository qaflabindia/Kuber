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
  // Counts, not lists: the shell's cost does not grow with the queue (F11).
  const [attention, journals, verify] = await Promise.all([
    a.attention(s.book).catch(() => ({ drafts: 0, awaitingApproval: 0, ratifications: 0, plans: 0 })),
    a.journals(s.book, 1).catch(() => []), a.verify(s.book).catch(() => ({ intact: false, firstBrokenJournal: null })),
  ]);
  return {
    session: s,
    shell: {
      reviewCount: attention.drafts,
      awaitingApproval: attention.awaitingApproval,
      confirmCount: attention.ratifications,
      hasJournals: journals.length > 0,
      intact: verify.intact,
      pendingPlans: attention.plans,
    },
  };
};
