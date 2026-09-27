/**
 * Migration wizard (FIN-MIG-01..03): upload → mapping approval → rehearsal → comparison → go-live,
 * for the session's book. Every action is a signed call to the core, which authorizes it
 * (migration.manage; the go-live authority.manage with the superuser's passkey signature).
 */
import { fail } from "@sveltejs/kit";
import { ApiError, migration, type Comparison, type GoLiveIntent, type MappingRowView, type Reconciliation } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

const MAX_BYTES = 4 * 1024 * 1024;
const err = (e: unknown, fallback: string) => ({ code: e instanceof ApiError ? e.code : "error", message: e instanceof Error ? e.message : fallback });

export const load: PageServerLoad = async ({ locals, url }) => {
  const s = locals.session!;
  const m = migration(s);
  let projects;
  try { projects = await m.list(); } catch (e) { return { available: false as const, message: err(e, "Migrations are not available.").message }; }
  const mine = projects.filter((p) => p.bookId === s.book);
  const current = mine.find((p) => p.status === "open") ?? mine.at(-1) ?? null;
  if (!current) return { available: true as const, book: s.book!, project: null };
  const view = await m.view(current.projectId);
  const mapping: { rows: MappingRowView[] } = await m.mapping(current.projectId);
  const active = view.loads.filter((l) => l.status === "active");
  const recLoad = active.find((l) => l.kind === "target") ?? active.at(-1) ?? null;
  const reconciliation: Reconciliation | null = recLoad ? await m.reconciliation(current.projectId, recLoad.loadId).catch(() => null) : null;
  const last = view.comparisons.at(-1) ?? null;
  const comparison: Comparison | null = last ? await m.comparison(current.projectId, last.comparisonId).catch(() => null) : null;
  const intent: GoLiveIntent | null = last ? await m.goLiveIntent(current.projectId, last.comparisonId).catch(() => null) : null;
  const step = url.searchParams.get("step");
  const auto = view.status !== "open" || intent?.ready ? "golive" : comparison ? "compare" : active.length ? (active.some((l) => l.kind === "target") ? "compare" : "rehearse")
    : view.mapping.unmapped === 0 && view.files.length ? "rehearse" : view.files.length ? "mapping" : "upload";
  return { available: true as const, book: s.book!, project: view, mapping: mapping.rows, reconciliation, comparison, intent,
    step: step && ["upload", "mapping", "rehearse", "compare", "golive"].includes(step) ? step : auto };
};

const projectOf = (f: FormData) => String(f.get("projectId") ?? "");

export const actions: Actions = {
  create: async ({ request, locals }) => {
    const s = locals.session!;
    const f = await request.formData();
    const cutoff = String(f.get("cutoff") ?? ""), sourceSystem = String(f.get("sourceSystem") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) return fail(400, { message: "Choose the cut-off date." });
    try { await migration(s).create({ bookId: s.book!, sourceSystem, cutoff }); return { done: "created" }; }
    catch (e) { return fail(409, err(e, "Could not start the migration.")); }
  },
  upload: async ({ request, locals }) => {
    const f = await request.formData();
    const file = f.get("file"), purpose = String(f.get("purpose") ?? "source"), asOf = String(f.get("asOf") ?? "");
    if (!(file instanceof File) || file.size === 0) return fail(400, { message: "Choose an export file." });
    if (file.size > MAX_BYTES) return fail(413, { message: "That file is larger than 4 MB. Export one company or one period at a time." });
    try {
      const content = Buffer.from(await file.arrayBuffer()).toString("base64");
      const r = await migration(locals.session!).upload(projectOf(f), { name: file.name, content, encoding: "base64", purpose, ...(asOf ? { asOf } : {}) });
      return { done: "uploaded", name: file.name, ...r };
    } catch (e) { return fail(422, err(e, "Could not read that file.")); }
  },
  approve: async ({ request, locals }) => {
    const f = await request.formData();
    const sourceKey = String(f.get("sourceKey") ?? ""), accountId = String(f.get("accountId") ?? "");
    try {
      await migration(locals.session!).approve(projectOf(f), sourceKey && accountId ? { rows: [{ sourceKey, accountId }] } : sourceKey ? { acceptSuggested: [sourceKey] } : { acceptSuggested: true });
      return { done: "approved" };
    } catch (e) { return fail(422, err(e, "Could not approve that mapping.")); }
  },
  rehearse: async ({ request, locals }) => {
    const f = await request.formData();
    try { const r = await migration(locals.session!).rehearse(projectOf(f)); return { done: "rehearsed", book: r.bookId }; }
    catch (e) { return fail(409, err(e, "The rehearsal could not load.")); }
  },
  load: async ({ request, locals }) => {
    const f = await request.formData();
    try { await migration(locals.session!).load(projectOf(f)); return { done: "loaded" }; }
    catch (e) { return fail(409, err(e, "The load was refused.")); }
  },
  delta: async ({ request, locals }) => {
    const f = await request.formData();
    try { const r = await migration(locals.session!).delta(projectOf(f), String(f.get("asOf") ?? "") || undefined); return { done: "delta", ...r }; }
    catch (e) { return fail(409, err(e, "The delta import failed.")); }
  },
  rollback: async ({ request, locals }) => {
    const f = await request.formData();
    try { await migration(locals.session!).rollback(projectOf(f), String(f.get("loadId") ?? ""), String(f.get("reason") ?? "")); return { done: "rolled_back" }; }
    catch (e) { return fail(409, err(e, "Could not roll back.")); }
  },
  compare: async ({ request, locals }) => {
    const f = await request.formData();
    try { await migration(locals.session!).compare(projectOf(f), String(f.get("from") ?? ""), String(f.get("to") ?? "")); return { done: "compared" }; }
    catch (e) { return fail(409, err(e, "Could not compare.")); }
  },
  explain: async ({ request, locals }) => {
    const f = await request.formData();
    try {
      await migration(locals.session!).explain(projectOf(f), String(f.get("comparisonId") ?? ""), { key: String(f.get("key") ?? ""), category: String(f.get("category") ?? ""), note: String(f.get("note") ?? "") });
      return { done: "explained" };
    } catch (e) { return fail(422, err(e, "Could not record that explanation.")); }
  },
  golive: async ({ request, locals }) => {
    const f = await request.formData();
    let assertion: unknown;
    try { assertion = f.get("assertion") ? JSON.parse(String(f.get("assertion"))) : undefined; }
    catch { return fail(400, { code: "bad_signature", message: "That passkey signature could not be read. Try again." }); }
    try { await migration(locals.session!).goLive(projectOf(f), String(f.get("comparisonId") ?? ""), assertion); return { done: "live" }; }
    catch (e) { return fail(e instanceof ApiError && e.code === "step_up_required" ? 403 : 409, err(e, "Could not go live.")); }
  },
};
