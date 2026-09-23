import { fail } from "@sveltejs/kit";
import { api } from "$lib/server/api";
import type { Actions } from "./$types";

const INSTRUMENTS = new Set(["BANK", "CARD", "CASH"]);
const MAX_BYTES = 2 * 1024 * 1024;

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const s = locals.session!;
    const f = await request.formData();
    const file = f.get("file");
    const instrument = String(f.get("instrument") ?? "BANK");
    if (!INSTRUMENTS.has(instrument)) return fail(400, { message: "Choose which account this statement is for." });
    if (!(file instanceof File) || file.size === 0) return fail(400, { message: "Choose a CSV statement to import." });
    if (file.size > MAX_BYTES) return fail(413, { message: "That file is larger than 2 MB. Split it by month and import each part." });
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") return fail(415, { message: "Kuber reads CSV statements for now. Export the statement as CSV from your bank." });
    try {
      const r = await api(s).statement(s.book!, await file.text(), instrument);
      return { ok: true, name: file.name, ...r };
    } catch (e) {
      return fail(422, { message: e instanceof Error ? e.message : "Could not read that statement." });
    }
  },
};
