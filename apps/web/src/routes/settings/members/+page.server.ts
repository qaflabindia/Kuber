/**
 * Members and access: who is in this workspace, with which role, over which books, with how many
 * passkeys; invitations; and the separation-of-duties settings. Every change goes to the core,
 * which authorizes it against the signed-in member's role (members.manage, settings.manage); the
 * page only hides controls the core would refuse.
 */
import { error, fail } from "@sveltejs/kit";
import { api, ApiError, members, type Invitation } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

const ROLES = ["owner", "controller", "preparer", "approver", "auditor", "member"] as const;

export const load: PageServerLoad = async ({ locals }) => {
  const s = locals.session!;
  const m = members(s);
  const me = await m.me().catch((e) => { throw e instanceof ApiError ? error(e.status, e.message) : error(502, "Kuber's ledger service isn't reachable."); });
  if (!me.permissions.includes("members.read")) throw error(403, "Your role does not include seeing the workspace's members.");
  const [list, credentials, separation, books] = await Promise.all([m.list(), m.credentials(), m.separation(), api(s).books().catch(() => [])]);
  return {
    me: { principal: me.principal, role: me.role },
    canManage: me.permissions.includes("members.manage"),
    canSettings: me.permissions.includes("settings.manage"),
    roles: [...ROLES],
    books: books.map((b) => b.book_id),
    separation,
    members: list.map((x) => ({ ...x, credentials: credentials.filter((c) => c.principal === x.principal) })),
  };
};

const problem = (action: string, e: unknown, extra: Record<string, unknown> = {}) =>
  fail(e instanceof ApiError ? (e.status >= 500 ? 502 : e.status) : 502, { action, ...extra,
    message: e instanceof ApiError ? e.message : "Kuber's ledger service isn't reachable." });

/** Book scope from the form: "all" (null) or the ticked books. */
function scopeOf(f: FormData): string[] | null | "empty" {
  if (String(f.get("scope") ?? "all") === "all") return null;
  const books = f.getAll("books").map(String).filter(Boolean);
  return books.length ? books : "empty";
}

/** "50,000" or "50000.50" rupees → paise; "" → null (the policies' own limits apply). */
function paiseOf(v: string): string | null | undefined {
  const t = v.replace(/[,₹\s]/g, "");
  if (!t) return null;
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(t);
  return m ? (BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0")).toString() : undefined;
}

export const actions: Actions = {
  invite: async ({ request, locals }) => {
    const f = await request.formData();
    const displayName = String(f.get("displayName") ?? "").trim(), role = String(f.get("role") ?? "");
    const ttlHours = Number(f.get("ttlHours") ?? 72);
    const books = scopeOf(f);
    if (displayName.length < 2) return fail(400, { action: "invite", message: "Enter the person's name." });
    if (!(ROLES as readonly string[]).includes(role)) return fail(400, { action: "invite", message: "Choose a role." });
    if (books === "empty") return fail(400, { action: "invite", message: "Tick at least one book, or choose every book." });
    try {
      const invitation: Invitation = await members(locals.session!).invite({ role, displayName, books, ttlHours: Number.isFinite(ttlHours) ? ttlHours : 72 });
      return { ok: true, action: "invite", invitation, displayName };
    } catch (e) { return problem("invite", e); }
  },

  change: async ({ request, locals }) => {
    const s = locals.session!;
    const f = await request.formData();
    const principal = String(f.get("principal") ?? ""), role = String(f.get("role") ?? "");
    const books = scopeOf(f);
    if (books === "empty") return fail(400, { action: "change", principal, message: "Tick at least one book, or choose every book." });
    if (!(ROLES as readonly string[]).includes(role)) return fail(400, { action: "change", principal, message: "Choose a role." });
    try {
      const m = await members(s).change(principal, { role, books });
      const self = principal === s.principal && m.principal !== principal;
      return { ok: true, action: "change", principal: m.principal, message: self
        ? `Your role is now ${m.role}. Sign out and sign in again with your passkey to continue.`
        : m.principal !== principal ? `Now ${m.principal}. They sign in again with the same passkey.` : "Access updated." };
    } catch (e) { return problem("change", e, { principal }); }
  },

  revoke: async ({ request, locals }) => {
    const principal = String((await request.formData()).get("principal") ?? "");
    try { await members(locals.session!).revoke(principal); return { ok: true, action: "revoke", principal, message: "Access revoked." }; }
    catch (e) { return problem("revoke", e, { principal }); }
  },

  revokeCredential: async ({ request, locals }) => {
    const f = await request.formData();
    const id = String(f.get("credentialId") ?? ""), principal = String(f.get("principal") ?? "");
    try { await members(locals.session!).revokeCredential(id); return { ok: true, action: "revokeCredential", principal, message: "Passkey revoked." }; }
    catch (e) { return problem("revokeCredential", e, { principal }); }
  },

  separation: async ({ request, locals }) => {
    const f = await request.formData();
    const soloOwner = f.get("soloOwner") === "on";
    const sodLimitPaise = paiseOf(String(f.get("sodLimit") ?? ""));
    if (sodLimitPaise === undefined) return fail(400, { action: "separation", message: "Enter the limit in rupees, e.g. 50,000, or leave it empty." });
    try {
      await members(locals.session!).setSeparation({ soloOwner, sodLimitPaise });
      return { ok: true, action: "separation", message: "Separation settings saved." };
    } catch (e) { return problem("separation", e); }
  },
};
