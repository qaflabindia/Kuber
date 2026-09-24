/**
 * Encrypted session cookie (AES-256-GCM). The browser holds the session but can neither read
 * nor alter it: any change breaks authentication and the session is discarded. The key is derived
 * from SESSION_SECRET with HKDF, so rotating the secret signs everyone out.
 *
 * A session is issued only after the core has verified a passkey (or, with KUBER_DEV_SIGNIN=true
 * on both tiers, a development sign-in). The core re-checks the membership on every request, so
 * revoking a member takes effect immediately, whatever sessions they hold.
 *
 * Each session has a random id (sid), chosen here before sign-in and signed into every request to
 * the core. The core binds it to the passkey at sign-in and refuses it once it is revoked: at
 * sign-out, or when that passkey is revoked. Cookies from before session ids are no longer valid.
 *
 * A second cookie of the same construction carries a sign-in ceremony in progress (workspace,
 * mode, challenge) for five minutes.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { building, dev } from "$app/environment";
import { env } from "$env/dynamic/private";

export interface Session {
  tenant: string;        // workspace id, e.g. "laksh"
  principal: string;     // "owner:laksh", from the membership the core returned
  role: string;          // owner | controller | preparer | approver | auditor | member
  books: string[] | null; // book scope; null = every book
  name: string;          // display name
  book: string | null;   // selected book
  sid: string;           // session id, revocable in the core
  issuedAt: number;
}

export interface Ceremony {
  mode: "signin" | "register";
  tenant: string;
  challenge: string;
  name?: string;
  code?: string;
  issuedAt: number;
}

export const COOKIE = "kuber_session";
export const CEREMONY_COOKIE = "kuber_passkey";
export const MAX_AGE = 60 * 60 * 12; // 12 hours
export const CEREMONY_MAX_AGE = 5 * 60;

/** Development sign-in (no passkey): only with KUBER_DEV_SIGNIN=true, never in a production build. */
export const devSignInEnabled = () => env.KUBER_DEV_SIGNIN === "true" && (dev || env.NODE_ENV !== "production");

// Production refuses to run without a real secret; development falls back to a per-process one.
const secretOk = !!env.SESSION_SECRET && env.SESSION_SECRET.length >= 32;
if (!secretOk && !building) {
  if (!dev && env.NODE_ENV === "production") throw new Error("SESSION_SECRET (at least 32 characters) is required in production; run ./scripts/secure-setup.sh");
  console.warn("SESSION_SECRET not set: using a random per-process secret (development only)");
}
if (env.KUBER_DEV_SIGNIN === "true" && !dev && env.NODE_ENV === "production" && !building) {
  throw new Error("KUBER_DEV_SIGNIN=true is not allowed in production");
}
const SECRET = secretOk ? env.SESSION_SECRET! : randomBytes(32).toString("hex");

const KEY = Buffer.from(hkdfSync("sha256", SECRET, "kuber-web", "session-cookie/v1", 32));

function seal(v: unknown, aad: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, nonce);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(JSON.stringify(v), "utf8"), c.final()]);
  return `v1.${Buffer.concat([nonce, body, c.getAuthTag()]).toString("base64url")}`;
}

function unseal<T extends { issuedAt: number }>(cookie: string | undefined, aad: string, maxAge: number): T | null {
  if (!cookie?.startsWith("v1.")) return null;
  try {
    const b = Buffer.from(cookie.slice(3), "base64url");
    if (b.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(b.subarray(b.length - 16));
    const s = JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("utf8")) as T;
    if (typeof s.issuedAt !== "number" || Date.now() - s.issuedAt > maxAge * 1000) return null;
    return s;
  } catch { return null; }
}

export const encode = (s: Session) => seal(s, "kuber_session|v2");
export function decode(cookie: string | undefined): Session | null {
  const s = unseal<Session>(cookie, "kuber_session|v2", MAX_AGE);
  return s && typeof s.principal === "string" && typeof s.role === "string" && typeof s.sid === "string" ? s : null;
}
/** A new session id: 256 random bits, URL-safe. */
export const newSessionId = () => randomBytes(32).toString("base64url");
export const encodeCeremony = (c: Ceremony) => seal(c, "kuber_passkey|v1");
export const decodeCeremony = (cookie: string | undefined) => unseal<Ceremony>(cookie, "kuber_passkey|v1", CEREMONY_MAX_AGE);

export const cookieOptions = {
  path: "/", httpOnly: true, sameSite: "strict" as const, secure: env.COOKIE_SECURE === "true", maxAge: MAX_AGE,
};
export const ceremonyCookieOptions = { ...cookieOptions, path: "/signin", maxAge: CEREMONY_MAX_AGE };

export const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
