/**
 * Passkey step-up for sensitive approvals (period operations, amounts above the approval limit).
 *
 * After the core has verified a fresh, user-verified assertion by the signed-in person's own
 * passkey, the BFF remembers the time in a short-lived encrypted cookie bound to that tenant and
 * principal and web session (sid), and carries it in its signed assertions to the core (claim `su`). The core decides
 * which commits need it and refuses them when the step-up is missing or older than five minutes.
 *
 * A second cookie holds the step-up ceremony in progress (its challenge), like sign-in does.
 * Kept apart from session.ts: its own key (HKDF info) and cookie names.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import { STEP_UP_MAX_AGE_MS } from "@kuber/auth";
import { env } from "$env/dynamic/private";
import type { Session } from "./session";

export const STEP_UP_COOKIE = "kuber_stepup";
export const STEP_UP_CEREMONY_COOKIE = "kuber_stepup_ceremony";
const MAX_AGE_S = STEP_UP_MAX_AGE_MS / 1000;

// session.ts refuses to start in production without SESSION_SECRET; development falls back to a per-process key.
const SECRET = env.SESSION_SECRET && env.SESSION_SECRET.length >= 32 ? env.SESSION_SECRET : randomBytes(32).toString("hex");
const KEY = Buffer.from(hkdfSync("sha256", SECRET, "kuber-web", "stepup-cookie/v1", 32));

interface Sealed { tenant: string; principal: string; sid: string; issuedAt: number }
interface StepUp extends Sealed { at: number }
interface StepUpCeremony extends Sealed { challenge: string }

function seal(v: unknown, aad: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, nonce);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(JSON.stringify(v), "utf8"), c.final()]);
  return `v1.${Buffer.concat([nonce, body, c.getAuthTag()]).toString("base64url")}`;
}

function unseal<T extends Sealed>(cookie: string | undefined, aad: string, s: Pick<Session, "tenant" | "principal" | "sid">): T | null {
  if (!cookie?.startsWith("v1.")) return null;
  try {
    const b = Buffer.from(cookie.slice(3), "base64url");
    if (b.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(b.subarray(b.length - 16));
    const v = JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("utf8")) as T;
    if (typeof v.issuedAt !== "number" || Date.now() - v.issuedAt > STEP_UP_MAX_AGE_MS) return null;
    return v.tenant === s.tenant && v.principal === s.principal && v.sid === s.sid ? v : null;
  } catch { return null; }
}

const options = (path: string) => ({ path, httpOnly: true, sameSite: "strict" as const, secure: env.COOKIE_SECURE === "true", maxAge: MAX_AGE_S });

/** The time of this person's last step-up, if it is still within its window. */
export function stepUpAt(cookies: Cookies, s: Pick<Session, "tenant" | "principal" | "sid">): number | undefined {
  const v = unseal<StepUp>(cookies.get(STEP_UP_COOKIE), "kuber_stepup|v1", s);
  return v && typeof v.at === "number" && Date.now() - v.at <= STEP_UP_MAX_AGE_MS ? v.at : undefined;
}

export function rememberStepUp(cookies: Cookies, s: Pick<Session, "tenant" | "principal" | "sid">, at: number) {
  cookies.set(STEP_UP_COOKIE, seal({ tenant: s.tenant, principal: s.principal, sid: s.sid, at, issuedAt: Date.now() } satisfies StepUp, "kuber_stepup|v1"), options("/"));
}

export function startStepUpCeremony(cookies: Cookies, s: Pick<Session, "tenant" | "principal" | "sid">, challenge: string) {
  cookies.set(STEP_UP_CEREMONY_COOKIE, seal({ tenant: s.tenant, principal: s.principal, sid: s.sid, challenge, issuedAt: Date.now() } satisfies StepUpCeremony, "kuber_stepup_ceremony|v1"), options("/signin/stepup"));
}

/** The ceremony in progress for this person, consumed: one attempt per ceremony. */
export function takeStepUpCeremony(cookies: Cookies, s: Pick<Session, "tenant" | "principal" | "sid">): StepUpCeremony | null {
  const c = unseal<StepUpCeremony>(cookies.get(STEP_UP_CEREMONY_COOKIE), "kuber_stepup_ceremony|v1", s);
  cookies.delete(STEP_UP_CEREMONY_COOKIE, { path: "/signin/stepup" });
  return c;
}

/** Sign-out: forget any step-up and ceremony in progress. */
export function forgetStepUp(cookies: Cookies) {
  cookies.delete(STEP_UP_COOKIE, { path: "/" });
  cookies.delete(STEP_UP_CEREMONY_COOKIE, { path: "/signin/stepup" });
}
