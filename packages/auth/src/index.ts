/**
 * Service authentication between the backend-for-frontend (web) and the core (finding F01).
 *
 * The core does not trust identity headers. Every request carries a short-lived assertion,
 * HMAC-SHA256 under a key derived from CORE_AUTH_SECRET, over:
 *   issuer, audience, method, path (with query), SHA-256 of the exact body bytes,
 *   tenant, principal (or null for sign-in ceremonies), issued-at, expiry and a random nonce.
 * The core recomputes the body hash, rejects stale, future-dated, replayed or altered requests,
 * and then resolves the principal against the tenant's memberships: a valid signature proves the
 * request came from the BFF, the membership decides what the person may do.
 *
 * Header:  x-kuber-auth: KH1 <base64url(claims JSON)>.<base64url(mac)>
 *
 * No dependencies beyond node:crypto, so the web tier, the core and tests share this file.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const AUTH_HEADER = "x-kuber-auth";
export const AUDIENCE = "kuber-core";
export const ISSUER = "kuber-web";
const SCHEME = "KH1";
const CONTEXT = "kuber-core-auth/v1";
/** Lifetime of one assertion. Short: it authenticates one request, not a session. */
export const MAX_TTL_MS = 60_000;
/** Tolerated clock difference between the BFF and the core. */
export const SKEW_MS = 30_000;

export interface Claims {
  v: 1; iss: string; aud: string;
  tenant: string | null; principal: string | null;
  method: string; path: string; bh: string;
  iat: number; exp: number; nonce: string;
  /**
   * Step-up (optional): when the BFF last saw this principal pass a fresh, user-verified passkey
   * assertion (epoch ms). Only the core decides whether a request needs it; see `stepUpFresh`.
   */
  su?: number;
}

export class AuthError extends Error {
  readonly statusCode = 401;
  constructor(public code: string, message: string) { super(message); }
}

/** Key material: at least 32 characters of secret, stretched with HKDF to a dedicated MAC key. */
export function authKey(secret: string | Buffer): Buffer {
  const s = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  if (s.length < 32) throw new Error("CORE_AUTH_SECRET must be at least 32 characters");
  return Buffer.from(hkdfSync("sha256", s, "kuber", CONTEXT, 32));
}

export const bodyHash = (body: string | Uint8Array | undefined | null) =>
  createHash("sha256").update(body === undefined || body === null ? "" : typeof body === "string" ? Buffer.from(body, "utf8") : body).digest("hex");

const mac = (key: Buffer, payload: string) => createHmac("sha256", key).update(`${CONTEXT}\n${payload}`).digest();

export interface SignInput {
  method: string; path: string; body?: string | Uint8Array | null;
  tenant: string | null; principal: string | null;
  issuer?: string; now?: number; ttlMs?: number;
  /** Time of the principal's last verified passkey step-up (epoch ms), if any. */
  stepUpAt?: number;
}

/** The header value for one request. `path` is the request target exactly as sent: "/v1/...?...". */
export function signRequest(key: Buffer, i: SignInput): string {
  const now = i.now ?? Date.now();
  const claims: Claims = {
    v: 1, iss: i.issuer ?? ISSUER, aud: AUDIENCE, tenant: i.tenant, principal: i.principal,
    method: i.method.toUpperCase(), path: i.path, bh: bodyHash(i.body), iat: now,
    exp: now + Math.min(i.ttlMs ?? MAX_TTL_MS, MAX_TTL_MS), nonce: randomBytes(16).toString("base64url"),
    ...(typeof i.stepUpAt === "number" && i.principal ? { su: i.stepUpAt } : {}),
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${SCHEME} ${payload}.${mac(key, payload).toString("base64url")}`;
}

/** Remembers nonces until their assertion expires, so each assertion is accepted once. */
export class ReplayCache {
  private seen = new Map<string, number>();
  constructor(private readonly max = 200_000) {}
  /** True the first time a nonce is seen before `expiresAt`; false for a replay. */
  claim(nonce: string, expiresAt: number, now = Date.now()): boolean {
    if (this.seen.size >= this.max) this.prune(now);
    if (this.seen.size >= this.max) return false;           // fail closed under a flood
    const prev = this.seen.get(nonce);
    if (prev !== undefined && prev >= now) return false;
    this.seen.set(nonce, expiresAt);
    return true;
  }
  prune(now = Date.now()) { for (const [n, e] of this.seen) if (e < now) this.seen.delete(n); }
  get size() { return this.seen.size; }
}

export interface VerifyInput {
  header: string | string[] | undefined;
  method: string; path: string; body: string | Uint8Array | null | undefined;
  issuers?: string[]; now?: number;
}

/** Verify one request's assertion. Throws AuthError; returns the claims when every check passes. */
export function verifyRequest(key: Buffer, replay: ReplayCache, i: VerifyInput): Claims {
  const h = Array.isArray(i.header) ? i.header[0] : i.header;
  const m = /^KH1 ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(h ?? "");
  if (!m) throw new AuthError("unauthenticated", "missing or malformed service assertion");
  const expected = mac(key, m[1]!), given = Buffer.from(m[2]!, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AuthError("bad_signature", "service assertion signature is invalid");
  let c: Claims;
  try { c = JSON.parse(Buffer.from(m[1]!, "base64url").toString("utf8")) as Claims; }
  catch { throw new AuthError("unauthenticated", "service assertion is not readable"); }
  const now = i.now ?? Date.now();
  if (c.v !== 1 || c.aud !== AUDIENCE) throw new AuthError("wrong_audience", "service assertion is not for the core");
  if (!(i.issuers ?? [ISSUER]).includes(c.iss)) throw new AuthError("wrong_issuer", "service assertion issuer is not trusted");
  if (typeof c.iat !== "number" || typeof c.exp !== "number" || c.exp - c.iat > MAX_TTL_MS || c.exp <= c.iat) throw new AuthError("bad_lifetime", "service assertion lifetime is invalid");
  if (c.iat > now + SKEW_MS) throw new AuthError("not_yet_valid", "service assertion is dated in the future");
  if (c.exp + SKEW_MS < now) throw new AuthError("expired", "service assertion has expired");
  if (c.method !== i.method.toUpperCase() || c.path !== i.path) throw new AuthError("wrong_request", "service assertion was issued for another request");
  const bh = Buffer.from(bodyHash(i.body), "hex"), cbh = Buffer.from(String(c.bh), "hex");
  if (cbh.length !== bh.length || !timingSafeEqual(cbh, bh)) throw new AuthError("wrong_body", "request body does not match the service assertion");
  if (typeof c.nonce !== "string" || c.nonce.length < 16 || !replay.claim(c.nonce, c.exp + SKEW_MS, now)) throw new AuthError("replayed", "service assertion was already used");
  return c;
}

/** How long a passkey step-up authorizes sensitive approvals. */
export const STEP_UP_MAX_AGE_MS = 5 * 60_000;

/**
 * True when verified claims carry a step-up no older than `maxAgeMs` (and not dated in the
 * future beyond the tolerated skew), for a signed-in principal.
 */
export function stepUpFresh(c: Pick<Claims, "su" | "principal">, now = Date.now(), maxAgeMs = STEP_UP_MAX_AGE_MS): boolean {
  if (!c.principal || typeof c.su !== "number" || !Number.isFinite(c.su)) return false;
  return c.su <= now + SKEW_MS && now - c.su <= maxAgeMs;
}
