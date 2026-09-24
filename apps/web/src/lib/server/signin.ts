/** Turning a verified member (from the core) into a web session. */
import type { Cookies } from "@sveltejs/kit";
import { api, type Member } from "./api";
import { COOKIE, cookieOptions, encode } from "./session";

/**
 * Issue the session and return where to go next: the first book in scope, or setup. `sid` is the
 * session id the sign-in ceremony was signed with (the core bound it to the passkey).
 */
export async function startSession(cookies: Cookies, m: Member, next: string | null, sid: string): Promise<string> {
  const books = await api({ tenant: m.tenant, principal: m.principal, sid }).books().catch(() => []);
  const book = books[0]?.book_id ?? null;
  cookies.set(COOKIE, encode({ tenant: m.tenant, principal: m.principal, role: m.role, books: m.books, name: m.displayName, book, sid, issuedAt: Date.now() }), cookieOptions);
  if (!book) return "/setup";
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
