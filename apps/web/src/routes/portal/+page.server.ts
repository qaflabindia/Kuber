/**
 * Customer and supplier portal (role model v2): the member's own party only. The core filters
 * every call to the party the membership is bound to; this page only shows what it returns.
 */
import { error, fail } from "@sveltejs/kit";
import { ApiError, portal } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

const problem = (e: unknown) => (e instanceof ApiError ? e.message : "Kuber's ledger service isn't reachable.");

export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!;
  const p = portal(s);
  try {
    if (s.role === "customer") {
      const [view, queries] = await Promise.all([p.customer(), p.queries()]);
      return { kind: "customer" as const, customer: view, queries, supplier: null };
    }
    if (s.role === "supplier") return { kind: "supplier" as const, supplier: await p.supplier(), customer: null, queries: [] };
  } catch (e) { throw error(e instanceof ApiError ? e.status : 502, problem(e)); }
  throw error(403, "This page is for customers and suppliers.");
};

export const actions: Actions = {
  query: async ({ request, locals }) => {
    const f = await request.formData();
    const subject = String(f.get("subject") ?? "").trim(), message = String(f.get("message") ?? "").trim();
    if (subject.length < 2 || message.length < 2) return fail(400, { action: "query", message: "Add a subject and a message." });
    try { await portal(locals.session!).query({ subject, message }); return { ok: true, action: "query", message: "Query sent. We will reply to you." }; }
    catch (e) { return fail(e instanceof ApiError ? e.status : 502, { action: "query", message: problem(e) }); }
  },
  bank: async ({ request, locals }) => {
    const f = await request.formData();
    const bank = { accountNumber: String(f.get("accountNumber") ?? "").trim(), ifsc: String(f.get("ifsc") ?? "").trim().toUpperCase(),
      holderName: String(f.get("holderName") ?? "").trim() };
    if (!bank.accountNumber || !bank.ifsc || !bank.holderName) return fail(400, { action: "bank", message: "Enter the account number, IFSC and account holder." });
    try {
      await portal(locals.session!).bankChange({ bank });
      return { ok: true, action: "bank", message: "Request received. Payments to you are held until we verify the new details with you by phone." };
    } catch (e) { return fail(e instanceof ApiError ? e.status : 502, { action: "bank", message: problem(e) }); }
  },
};
