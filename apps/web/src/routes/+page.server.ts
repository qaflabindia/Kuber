import { fail } from "@sveltejs/kit";
import { api, ApiError } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

/** The canvas: live position, plans waiting for approval, and the agent. */
export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!;
  const a = api(s);
  const [position, pending, copilot] = await Promise.all([
    a.plan(s.book!, "dashboard", {}).catch(() => null),
    a.plans(s.book!).catch(() => []),
    a.copilotInfo().catch(() => ({ engine: "rules", suggestions: [] as string[] })),
  ]);
  return { position, pending, copilot };
};

const problem = (e: unknown, fallback: string) =>
  e instanceof ApiError ? { code: e.code, message: e.message } : { code: "error", message: e instanceof Error ? e.message : fallback };

export const actions: Actions = {
  ask: async ({ request, locals }) => {
    const s = locals.session!;
    const f = await request.formData();
    const text = String(f.get("text") ?? "").trim().slice(0, 2000);
    if (!text) return fail(400, { message: "Tell Kuber what to do." });
    let history: { role: "user" | "assistant"; text: string }[] = [];
    try { history = JSON.parse(String(f.get("history") ?? "[]")).slice(-8); } catch { /* ignore malformed history */ }
    try { return { asked: text, answer: await api(s).ask(s.book!, text, history) }; }
    catch (e) { return fail(502, { asked: text, ...problem(e, "Kuber could not answer.") }); }
  },
  commit: async ({ request, locals }) => {
    const f = await request.formData();
    const id = String(f.get("planId") ?? ""), hash = String(f.get("hash") ?? "");
    try {
      const r = await api(locals.session!).commit(id, hash);
      return { planId: id, status: r.status === "committed" ? "committed" : "proposed", message: r.message ?? null };
    } catch (e) { return fail(409, { planId: id, ...problem(e, "Could not post.") }); }
  },
  discard: async ({ request, locals }) => {
    const id = String((await request.formData()).get("planId") ?? "");
    try { await api(locals.session!).discard(id); return { planId: id, status: "discarded" }; }
    catch (e) { return fail(409, { planId: id, ...problem(e, "Could not discard.") }); }
  },
};
