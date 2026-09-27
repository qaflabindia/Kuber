/** FIN-RPT-01/02 export: the core's CSV / JSON bytes for statements or KPIs, passed through with their SHA-256. */
import { error } from "@sveltejs/kit";
import { coreFile } from "$lib/server/api";
import type { RequestHandler } from "./$types";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const GET: RequestHandler = async ({ locals, url }) => {
  const s = locals.session;
  if (!s?.book) throw error(401, "Sign in first.");
  const q = new URLSearchParams();
  for (const k of ["from", "to"]) { const v = url.searchParams.get(k); if (v && ISO.test(v)) q.set(k, v); }
  q.set("format", url.searchParams.get("format") === "json" ? "json" : "csv");
  const what = url.searchParams.get("what") === "kpis" ? "metrics" : "statements";
  const f = await coreFile(s, `/books/${encodeURIComponent(s.book)}/${what}/export?${q}`);
  return new Response(f.body, { headers: { "content-type": f.contentType, "x-content-sha256": f.sha256, "content-disposition": f.disposition } });
};
