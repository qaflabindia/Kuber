/**
 * Browser side of signed commands (design 14.4/16.4). A high-risk command (approving a period
 * operation or an amount above the approval limit, approving a large draft, confirming a large
 * automatic posting, locking a period) is signed on this device:
 *
 *   1. ask the BFF for the command's signing options: the core renders a summary of exactly what
 *      the command does (amount, payees, accounts, book) and a WebAuthn challenge that is the
 *      digest of the command;
 *   2. show that summary (SignPrompt) and wait for the person to confirm or cancel;
 *   3. only then ask the passkey to sign (user verification required); the signature is sent with
 *      the command, and the core verifies and stores it with the resulting event.
 *
 * Development sign-in only: a member without a passkey confirms with the development step-up.
 */
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { confirmWithPasskey } from "$lib/stepup";
import type { SigningOptions, SigningRequest } from "$lib/server/api";

type Prompt = Extract<SigningOptions, { required: true }>;
/** What `Signer.sign` resolves to: the assertion (JSON) to send, "none" (nothing to sign, or dev step-up done), or null (cancelled, or failed: see `message`). */
export type SignOutcome = { assertion: string } | "none" | null;

export class Signer {
  /** The summary being shown, while the person decides. */
  prompt = $state<Prompt | null>(null);
  busy = $state(false);
  message = $state<string | null>(null);
  private decide: ((ok: boolean) => void) | null = null;

  async sign(req: SigningRequest): Promise<SignOutcome> {
    this.message = null; this.busy = true;
    let o: (SigningOptions & { dev?: undefined; error?: undefined }) | { dev: true } | { error: string; message: string };
    try {
      const r = await fetch("/sign/options", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
      o = await r.json().catch(() => ({ error: "error", message: "Could not start signing." }));
      if (!r.ok && !("error" in o)) o = { error: "error", message: (o as { message?: string }).message ?? "Could not start signing." };
    } catch { o = { error: "error", message: "Kuber isn't reachable." }; }
    this.busy = false;
    if ("error" in o && o.error) { this.message = o.message; return null; }
    if ("dev" in o && o.dev) {
      const problem = await confirmWithPasskey();
      this.message = problem;
      return problem ? null : "none";
    }
    const opts = o as SigningOptions;
    if (!opts.required) return "none";
    if (!browserSupportsWebAuthn()) { this.message = "This browser does not support passkeys, so it cannot sign this."; return null; }
    this.prompt = opts;
    const ok = await new Promise<boolean>((resolve) => { this.decide = resolve; });
    const prompt = this.prompt;
    this.prompt = null; this.decide = null;
    if (!ok || !prompt) { this.message = "Not signed: nothing was changed."; return null; }
    try {
      this.busy = true;
      const assertion = await startAuthentication({ optionsJSON: prompt.options as never });
      return { assertion: JSON.stringify(assertion) };
    } catch (e) {
      this.message = e instanceof Error && e.name === "NotAllowedError" ? "Signing was cancelled: nothing was changed." : e instanceof Error ? e.message : "Signing failed.";
      return null;
    } finally { this.busy = false; }
  }

  /** The person read the summary and wants their passkey to sign it. */
  confirm() { this.decide?.(true); }
  cancel() { this.decide?.(false); }
}

type Result = { type: string; data?: Record<string, unknown> };
/**
 * A form's enhance function for a command that may need signing: submit as usual; when the core
 * answers `step_up_required`, sign the command (`request`, from the submitted form) and submit
 * again with the signature in an `assertion` field. `start` runs when a submission starts, `after`
 * with the final result.
 */
export function signedSubmit(signer: Signer, request: (f: FormData) => SigningRequest, start: () => void,
                             after: (o: { result: Result; update: (o?: { reset?: boolean }) => Promise<void> }) => Promise<void>) {
  let assertion = "", retried = false;
  return ({ formData, formElement }: { formData: FormData; formElement: HTMLFormElement }) => {
    start();
    if (assertion) { formData.set("assertion", assertion); assertion = ""; }
    const req = request(formData);
    return async (o: { result: Result; update: (o?: { reset?: boolean }) => Promise<void> }) => {
      const code = o.result.type === "failure" ? o.result.data?.code : undefined;
      if (code === "step_up_required" && !retried) {
        retried = true;
        const r = await signer.sign(req);
        if (r !== null) { if (r !== "none") assertion = r.assertion; formElement.requestSubmit(); return; }
      }
      retried = false;
      await after(o);
    };
  };
}
