import { api, ApiError, type KpiReport } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** FIN-RPT-01/02: mapped statements with comparatives, and the KPI panel. A failed KPI call shows as unavailable, never as zeros. */
export const load: PageServerLoad = async ({ url, locals }) => {
  const s = locals.session!;
  const q: Record<string, string> = {};
  for (const k of ["from", "to"]) { const v = url.searchParams.get(k); if (v && ISO.test(v)) q[k] = v; }
  const a = api(s);
  const [bundle, kpis] = await Promise.all([
    a.finStatements(s.book!, q),
    a.kpis(s.book!, q).catch((e: unknown) => ({ error: e instanceof ApiError ? e.message : "KPIs could not be loaded" })),
  ]);
  const tab = url.searchParams.get("tab") ?? "balanceSheet";
  return { bundle, kpis: kpis as KpiReport | { error: string }, tab, q };
};
