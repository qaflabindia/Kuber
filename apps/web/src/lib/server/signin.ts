/** Turning a verified member (from the core) into a web session. */
import type { Cookies } from "@sveltejs/kit";
import { api, type Member } from "./api";
import { COOKIE, cookieOptions, encode } from "./session";

/** Issue the session and return where to go next: the first book in scope, or setup. */
export async function startSession(cookies: Cookies, m: Member, next: string | null): Promise<string> {
  const books = await api({ tenant: m.tenant, principal: m.principal }).books().catch(() => []);
  const book = books[0]?.book_id ?? null;
  cookies.set(COOKIE, encode({ tenant: m.tenant, principal: m.principal, role: m.role, books: m.books, name: m.displayName, book, issuedAt: Date.now() }), cookieOptions);
  if (!book) return "/setup";
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
