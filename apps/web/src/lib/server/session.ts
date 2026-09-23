/**
 * Encrypted session cookie (AES-256-GCM). The browser holds the session but can neither read
 * nor alter it: any change breaks authentication and the session is discarded. The key is derived
 * from SESSION_SECRET with HKDF, so rotating the secret signs everyone out.
 *
 * Phase 0 uses a development sign-in. Phase 1 replaces it with passkeys (WebAuthn) and
 * device-bound sessions; the cookie format and signature check stay.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
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

const KEY = Buffer.from(hkdfSync("sha256", SECRET, "kuber-web", "session-cookie/v1", 32));
const AAD = Buffer.from("kuber_session|v1");

export function encode(s: Session): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, nonce);
  c.setAAD(AAD);
  const body = Buffer.concat([c.update(JSON.stringify(s), "utf8"), c.final()]);
  return `v1.${Buffer.concat([nonce, body, c.getAuthTag()]).toString("base64url")}`;
}

export function decode(cookie: string | undefined): Session | null {
  if (!cookie?.startsWith("v1.")) return null;
  try {
    const b = Buffer.from(cookie.slice(3), "base64url");
    if (b.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
    d.setAAD(AAD);
    d.setAuthTag(b.subarray(b.length - 16));
    const s = JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("utf8")) as Session;
    if (typeof s.issuedAt !== "number" || Date.now() - s.issuedAt > MAX_AGE * 1000) return null;
    return s;
  } catch { return null; }
}

export const cookieOptions = {
  path: "/", httpOnly: true, sameSite: "strict" as const, secure: env.COOKIE_SECURE === "true", maxAge: MAX_AGE,
};

export const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
