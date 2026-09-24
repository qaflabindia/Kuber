/**
 * Browser side of the passkey step-up: ask the BFF for a challenge, let the authenticator
 * answer it (user verification required), and have the core verify it. Resolves to null when
 * confirmed, or to a message for the person.
 */
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reason = async (r: Response, fallback: string) => ((await r.json().catch(() => null)) as { message?: string } | null)?.message ?? fallback;

export async function confirmWithPasskey(): Promise<string | null> {
  try {
    const o = await post("/signin/stepup/options", {});
    if (!o.ok) return reason(o, "Could not start the passkey confirmation.");
    const start = (await o.json()) as { options?: Parameters<typeof startAuthentication>[0]["optionsJSON"]; dev?: boolean };
    let body: unknown;
    if (start.dev) body = { dev: true };
    else {
      if (!browserSupportsWebAuthn()) return "This browser does not support passkeys.";
      body = { response: await startAuthentication({ optionsJSON: start.options! }) };
    }
    const v = await post("/signin/stepup/verify", body);
    return v.ok ? null : reason(v, "That passkey was not accepted.");
  } catch (e) {
    return e instanceof Error && e.name === "NotAllowedError" ? "Passkey confirmation was cancelled." : e instanceof Error ? e.message : "Passkey confirmation failed.";
  }
}
