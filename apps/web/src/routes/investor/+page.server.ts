/**
 * Investor and guest reports (role model v2): investors see certified snapshots published to
 * them; guests see the items shared with them until each share expires. The core does the filtering.
 */
import { error } from "@sveltejs/kit";
import { ApiError, portal } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!;
  try {
    if (s.role === "investor") return { kind: "investor" as const, snapshots: await portal(s).snapshots(), shares: [] };
    if (s.role === "guest") return { kind: "guest" as const, snapshots: [], shares: await portal(s).shares() };
  } catch (e) { throw error(e instanceof ApiError ? e.status : 502, e instanceof ApiError ? e.message : "Kuber's ledger service isn't reachable."); }
  throw error(403, "This page is for investors and guests.");
};
