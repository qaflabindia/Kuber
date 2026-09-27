import { fail } from "@sveltejs/kit";
import { api, ApiError, type EvidenceRef } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

/** The previous month end: the period people close next. */
const lastMonthEnd = (today: string) => { const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Period close (FIN-CLS-01..04): checklist, substantiation, completeness, certified closes. Unanswered calls stay "unavailable". */
export const load: PageServerLoad = async ({ locals, url }) => {
  const s = locals.session!;
  const a = api(s);
  const overview = await a.closeOverview(s.book!).catch(() => null);
  const asked = url.searchParams.get("period");
  const period = asked && ISO.test(asked) ? asked : overview?.checklists.at(-1)?.periodEnd ?? lastMonthEnd(new Date().toISOString().slice(0, 10));
  const status = await a.closeStatus(s.book!, period).catch(() => null);
  return { period, overview, status, me: s.principal };
};

const problem = (e: unknown, fallback: string) => ({ code: e instanceof ApiError ? e.code : "error", message: e instanceof Error ? e.message : fallback });

export const actions: Actions = {
  certify: async ({ request, locals }) => {
    const s = locals.session!, period = String((await request.formData()).get("period") ?? "");
    try { return { plan: await api(s).closeCertify(s.book!, period) }; } catch (e) { return fail(409, problem(e, "Could not prepare the certification.")); }
  },
  reopen: async ({ request, locals }) => {
    const s = locals.session!, f = await request.formData();
    const reason = String(f.get("reason") ?? "").trim();
    if (reason.length < 10) return fail(400, { code: "reason_required", message: "Say why the period is reopened (at least 10 characters)." });
    try { return { plan: await api(s).closeReopen(s.book!, String(f.get("period")), reason) }; } catch (e) { return fail(409, problem(e, "Could not prepare the reopen.")); }
  },
  complete: async ({ request, locals }) => {
    const s = locals.session!, f = await request.formData();
    const evidence: EvidenceRef[] = [{ kind: String(f.get("kind")) as EvidenceRef["kind"], id: String(f.get("ref") ?? "").trim(), hash: String(f.get("hash") ?? "").trim() }];
    try { return { plan: await api(s).closeComplete(s.book!, String(f.get("period")), String(f.get("taskId")), evidence) }; }
    catch (e) { return fail(409, problem(e, "Could not prepare the task completion.")); }
  },
  substantiate: async ({ request, locals }) => {
    const s = locals.session!, f = await request.formData();
    const sourceBalance = String(f.get("sourceBalance") ?? "").trim(), ref = String(f.get("ref") ?? "").trim(), hash = String(f.get("hash") ?? "").trim();
    const kind = String(f.get("kind") ?? "document") as EvidenceRef["kind"];
    try {
      return { plan: await api(s).closeSubstantiate(s.book!, String(f.get("period")), String(f.get("accountId")),
        { ...(sourceBalance ? { sourceBalance } : {}), ...(ref && hash ? { evidence: [{ kind, id: ref, hash }] } : {}) }) };
    } catch (e) { return fail(409, problem(e, "Could not prepare the substantiation.")); }
  },
};
