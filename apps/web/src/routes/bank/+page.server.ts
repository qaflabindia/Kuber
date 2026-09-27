import { fail } from "@sveltejs/kit";
import { bankApi, ApiError } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** FIN-CASH-01..03: the book's bank accounts, statement coverage, the reconciliation statement and its certification. */
export const load: PageServerLoad = async ({ locals, url }) => {
  const s = locals.session!;
  const a = bankApi(s, s.book!);
  const accounts = await a.accounts().catch(() => null);
  const account = url.searchParams.get("account") ?? accounts?.[0]?.bankAccountId ?? null;
  if (!accounts || !account) return { accounts, account: null, coverage: null, rec: null, certifications: [], exceptions: [], periodEnd: null };
  const coverage = await a.coverage(account).catch(() => null);
  const q = url.searchParams.get("end");
  const periodEnd = q && ISO.test(q) ? q : coverage?.to ?? new Date().toISOString().slice(0, 10);
  const [rec, certifications, exceptions] = await Promise.all([a.reconciliation(account, periodEnd).catch(() => null), a.certifications(account).catch(() => []), a.exceptions().catch(() => [])]);
  return { accounts, account, coverage, rec, certifications, exceptions, periodEnd };
};

export const actions: Actions = {
  prepare: async ({ request, locals }) => {
    const f = await request.formData();
    const s = locals.session!;
    try { return { prepared: await bankApi(s, s.book!).prepare(String(f.get("account") ?? ""), String(f.get("end") ?? "")) }; }
    catch (e) { return fail(409, { message: e instanceof Error ? e.message : "Could not prepare the certification." }); }
  },
  certify: async ({ request, locals }) => {
    const f = await request.formData();
    const s = locals.session!;
    // Certifying is always a signed command: the certifier's passkey signs this exact plan.
    let assertion: unknown;
    try { assertion = f.get("assertion") ? JSON.parse(String(f.get("assertion"))) : undefined; }
    catch { return fail(400, { code: "bad_signature", message: "That passkey signature could not be read. Try again." }); }
    try { await bankApi(s, s.book!).certify(String(f.get("planId") ?? ""), String(f.get("hash") ?? ""), assertion); return { certified: true }; }
    catch (e) { return fail(e instanceof ApiError && e.code === "step_up_required" ? 403 : 409, { code: e instanceof ApiError ? e.code : "error", message: e instanceof Error ? e.message : "Could not certify." }); }
  },
};
