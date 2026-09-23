/**
 * Signed session cookie (HMAC-SHA256). The browser holds the session but cannot alter it:
 * any change to the payload breaks the signature and the session is discarded.
 *
 * Phase 0 uses a development sign-in. Phase 1 replaces it with passkeys (WebAuthn) and
 * device-bound sessions; the cookie format and signature check stay.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "$env/dynamic/private";

export interface Session {
  tenant: string;        // workspace id, e.g. "laksh"
  principal: string;     // "owner:laksh"
  name: string;          // display name
  book: string | null;   // selected book
  issuedAt: number;
}

export const COOKIE = "kuber_session";
export const MAX_AGE = 60 * 60 * 12; // 12 hours

// A missing secret means sessions do not survive a restart: acceptable for local development only.
const SECRET = env.SESSION_SECRET && env.SESSION_SECRET.length >= 32 ? env.SESSION_SECRET : randomBytes(32).toString("hex");
if (!env.SESSION_SECRET) console.warn("SESSION_SECRET not set: using a random per-process secret (development only)");

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("base64url");

export function encode(s: Session): string {
  const payload = b64(JSON.stringify(s));
  return `${payload}.${sign(payload)}`;
}

export function decode(cookie: string | undefined): Session | null {
  if (!cookie) return null;
  const [payload, mac] = cookie.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    if (Date.now() - s.issuedAt > MAX_AGE * 1000) return null;
    return s;
  } catch { return null; }
}

export const cookieOptions = {
  path: "/", httpOnly: true, sameSite: "strict" as const, secure: env.COOKIE_SECURE === "true", maxAge: MAX_AGE,
};

export const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
