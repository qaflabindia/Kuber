/**
 * Signed commands (design 14.4 and 16.4): high-risk commands are signed on the person's device.
 *
 *   1. options   The server renders a summary of the command from the command itself (amount,
 *                payee, accounts, book), builds the canonical digest inputs (tenant, book, action,
 *                subject, subject hash, principal, a random single-use nonce, its expiry and the
 *                summary's hash), stores them under the digest, and returns WebAuthn options whose
 *                challenge IS the digest, limited to the principal's own active passkeys.
 *   2. verify    Inside the transaction that carries out the command: the stored request is locked,
 *                must be unused, unexpired, for this principal and for exactly this command (action,
 *                book, subject, subject hash, summary); the assertion must be by one of the
 *                principal's own active passkeys, with user verification. The request is marked
 *                used and the full assertion (credential id, authenticatorData, clientDataJSON,
 *                signature, digest and its inputs, the summary) is returned for the command's event.
 *                If the command fails, the transaction rolls back and nothing is consumed or stored.
 *   3. offline   verifyCommandSignature re-checks a stored assertion against the stored public key
 *                and the event it is stored in, without the database's say-so: `ops verify-signatures`.
 *
 * Replay: a request is used once (a row lock serializes concurrent attempts), and a signature for
 * plan A cannot be used for plan B (the stored request names its subject and subject hash, and the
 * digest covers them). Only development sign-in may fall back to the `su` freshness claim, and the
 * event then records `kind: "dev-step-up"`, which is not a signature.
 */
import { createHash, randomBytes } from "node:crypto";
import type { TransactionSql } from "postgres";
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { canonical, sha256, type CommandDigestInputs, type CommandSignature, type CommandSummary, type Envelope, type SignedAction } from "@kuber/contracts";
import type { EventStore, Migration } from "@kuber/eventstore";
import { rlsForTables } from "./fin-migrations.ts";

/** How long a signing request may be answered. */
export const SIGNING_TTL_MS = 5 * 60_000;
/** Roles that must keep two authenticators (warning always; refusal when the tenant requires it). */
/** Superusers and controllers keep two authenticators (design 16.4); legacy owners are superusers. */
export const TWO_AUTHENTICATOR_ROLES = new Set(["superuser", "controller"]);
/** Labelled in the stored record: the development fallback proves no possession of a key. */
export const DEV_STEP_UP_NOTE = "DEVELOPMENT SIGN-IN ONLY: confirmed by a fresh step-up claim (su) from a member without a passkey; this is not a signature and proves nothing about the command";

export const SIGNING_MIGRATIONS: Migration[] = [{
  id: "identity-005-signed-commands",
  sql: `
CREATE TABLE identity.signing_requests (
  tenant_id TEXT NOT NULL, digest TEXT NOT NULL, principal TEXT NOT NULL, action TEXT NOT NULL, book_id TEXT NOT NULL,
  subject TEXT NOT NULL, subject_hash TEXT NOT NULL, inputs JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), used_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, digest));
CREATE INDEX signing_requests_expiry ON identity.signing_requests (tenant_id, expires_at);
ALTER TABLE identity.settings ADD COLUMN require_two_authenticators BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE identity.enrolments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'enrol' CHECK (purpose IN ('enrol','recovery')),
  ADD COLUMN revoke_existing BOOLEAN NOT NULL DEFAULT false;
` + rlsForTables("identity", ["signing_requests"]),
}];

/** The command a signature must be for: what the server derives from the command itself. */
export interface SigningIntent { action: SignedAction; book: string; subject: string; subjectHash: string; summary: CommandSummary }

export const commandDigest = (inputs: CommandDigestInputs) => sha256(canonical(inputs));
export const summaryHash = (summary: CommandSummary) => sha256(canonical(summary));
/** The subject hash of a directly requested period lock. */
export const lockSubjectHash = (book: string, periodEnd: string, level: string) => sha256(canonical({ kind: "period.lock", book, periodEnd, level }));
const b64u = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

/** Refusals of a signed command: the caller maps `code` and `status` to its error type. */
export class SigningError extends Error {
  constructor(public code: string, message: string, public statusCode = 403) { super(message); }
}

interface Host {
  store: EventStore; rpId: string; origins: string[]; now: () => number;
  /** Refuse (throw) when the tenant requires two authenticators and this principal has fewer. */
  requireSecondPasskey(tenant: string, principal: string, tx?: TransactionSql): Promise<void>;
}

export class SignedCommands {
  constructor(private h: Host) {}

  /**
   * Step 1: WebAuthn options whose challenge is the digest of exactly this command, for the
   * principal's own active passkeys, plus the digest inputs and the summary to show first.
   */
  async options(tenant: string, principal: string, intent: SigningIntent): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; digest: string; inputs: CommandDigestInputs; summary: CommandSummary; expiresAt: string }> {
    const creds = await this.h.store.tenantTx(tenant, (tx) => tx<{ credential_id: string; transports: string[] }[]>`
      SELECT c.credential_id, c.transports FROM identity.credentials c
      JOIN identity.members m ON m.tenant_id = c.tenant_id AND m.principal = c.principal AND m.status = 'active'
      WHERE c.tenant_id = ${tenant} AND c.principal = ${principal} AND c.revoked_at IS NULL`);
    if (!creds.length) throw new SigningError("no_passkey", "you have no passkey in this workspace to sign with: ask an owner for an invitation to register one", 409);
    await this.h.requireSecondPasskey(tenant, principal);
    const expiresAt = new Date(this.h.now() + SIGNING_TTL_MS).toISOString();
    const inputs: CommandDigestInputs = { v: 1, tenant, book: intent.book, action: intent.action, subject: intent.subject, subjectHash: intent.subjectHash,
      principal, nonce: randomBytes(18).toString("base64url"), expiresAt, summaryHash: summaryHash(intent.summary) };
    const digest = commandDigest(inputs);
    // Requests are kept (ids and hashes only): which commands were offered for signing, and which were used.
    await this.h.store.tenantTx(tenant, async (tx) => {
      await tx`INSERT INTO identity.signing_requests (tenant_id, digest, principal, action, book_id, subject, subject_hash, inputs, expires_at)
        VALUES (${tenant}, ${digest}, ${principal}, ${intent.action}, ${intent.book}, ${intent.subject}, ${intent.subjectHash}, ${tx.json(inputs as never)}, ${expiresAt})`;
    });
    const options = await generateAuthenticationOptions({ rpID: this.h.rpId, challenge: new Uint8Array(Buffer.from(digest, "hex")), userVerification: "required",
      timeout: SIGNING_TTL_MS, allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports as never })) });
    return { options, digest, inputs, summary: intent.summary, expiresAt };
  }

  /**
   * Step 2, inside the command's own transaction `tx`: verify `response` as `principal`'s signature
   * over `intent`, consume its request, and return the record to store with the command's event.
   */
  async verify(tx: TransactionSql, tenant: string, principal: string, intent: SigningIntent, response: AuthenticationResponseJSON): Promise<CommandSignature> {
    const reject = (m: string, code = "signature_rejected") => new SigningError(code, m);
    let challenge: string;
    try {
      const cd = JSON.parse(Buffer.from(String(response?.response?.clientDataJSON ?? ""), "base64url").toString("utf8")) as { challenge?: unknown };
      challenge = typeof cd.challenge === "string" ? cd.challenge : "";
    } catch { throw reject("that is not a passkey signature"); }
    const digest = Buffer.from(challenge, "base64url").toString("hex");
    if (!/^[0-9a-f]{64}$/.test(digest)) throw reject("that passkey response does not sign a command");
    const [req] = await tx<{ principal: string; action: string; book_id: string; subject: string; subject_hash: string; inputs: CommandDigestInputs; expired: boolean; used: boolean }[]>`
      SELECT principal, action, book_id, subject, subject_hash, inputs, expires_at <= ${new Date(this.h.now()).toISOString()} AS expired, used_at IS NOT NULL AS used
      FROM identity.signing_requests WHERE tenant_id = ${tenant} AND digest = ${digest} FOR UPDATE`;
    if (!req) throw reject("this signature was not requested in this workspace: ask for the command's signing options again");
    if (req.used) throw reject("this signature has already been used: sign the command again", "signature_replayed");
    if (req.expired) throw reject("this signing request has expired: sign the command again", "signature_expired");
    if (req.principal !== principal) throw reject("this signature was requested for someone else");
    if (req.action !== intent.action || req.book_id !== intent.book || req.subject !== intent.subject || req.subject_hash !== intent.subjectHash)
      throw reject(`this signature is for another command (${req.action} ${req.subject}), not ${intent.action} ${intent.subject}`, "signature_mismatch");
    const inputs = req.inputs;
    if (commandDigest(inputs) !== digest || inputs.principal !== principal || inputs.tenant !== tenant) throw reject("the stored signing request does not match its digest");
    const sh = summaryHash(intent.summary);
    if (inputs.summaryHash !== sh) throw reject("what this command would do changed after it was shown for signing: review it and sign again", "signature_mismatch");
    await this.h.requireSecondPasskey(tenant, principal, tx);
    const [c] = await tx<{ credential_id: string; public_key: Buffer; counter: string; transports: string[] }[]>`
      SELECT c.credential_id, c.public_key, c.counter::text, c.transports FROM identity.credentials c
      JOIN identity.members m ON m.tenant_id = c.tenant_id AND m.principal = c.principal AND m.status = 'active'
      WHERE c.tenant_id = ${tenant} AND c.credential_id = ${String(response?.id ?? "")} AND c.principal = ${principal} AND c.revoked_at IS NULL
      FOR UPDATE OF c`;
    if (!c) throw reject("that passkey is not one of your active passkeys in this workspace");
    let v;
    try {
      v = await verifyAuthenticationResponse({ response, expectedChallenge: b64u(digest), expectedOrigin: this.h.origins, expectedRPID: this.h.rpId,
        requireUserVerification: true, credential: { id: c.credential_id, publicKey: new Uint8Array(c.public_key), counter: Number(c.counter), transports: c.transports as never } });
    } catch (e) { throw reject(`the passkey signature is not valid: ${e instanceof Error ? e.message : String(e)}`); }
    if (!v.verified || !v.authenticationInfo.userVerified) throw reject("the passkey signature could not be verified with user verification");
    await tx`UPDATE identity.credentials SET counter = ${v.authenticationInfo.newCounter}, last_used_at = now() WHERE tenant_id = ${tenant} AND credential_id = ${c.credential_id}`;
    await tx`UPDATE identity.signing_requests SET used_at = now() WHERE tenant_id = ${tenant} AND digest = ${digest}`;
    return { kind: "webauthn", digest, inputs, summary: intent.summary, credentialId: c.credential_id,
      authenticatorData: response.response.authenticatorData, clientDataJSON: response.response.clientDataJSON, signature: response.response.signature,
      ...(response.response.userHandle ? { userHandle: response.response.userHandle } : {}),
      rpId: this.h.rpId, origin: v.authenticationInfo.origin, verifiedAt: new Date(this.h.now()).toISOString() };
  }
}

// ------------------------------------------------------------------ offline verification
/** Event types that can carry a command signature, and what each must be bound to. */
export const SIGNED_EVENT_TYPES = ["PlanApproved", "PlanApprovalRecorded", "DraftApproved", "Ratified", "PeriodLocked", "MigrationWentLive"] as const;

/**
 * What a stored signature must say, given the event it is stored in: the event is the command the
 * signature authorized, so its tenant, signer, action, subject (and, where the event carries it,
 * the subject hash and book) must be the ones in the digest inputs.
 */
export function expectedBinding(env: Pick<Envelope, "type" | "data" | "meta">): Partial<CommandDigestInputs> | null {
  const d = env.data as Record<string, unknown>;
  const base = { tenant: env.meta.tenantId, principal: env.meta.principal };
  switch (env.type) {
    case "PlanApproved": return { ...base, action: "plan.commit", subject: d.planId as string, subjectHash: d.hash as string, book: d.bookId as string };
    case "PlanApprovalRecorded": return { ...base, action: "plan.approve", subject: d.planId as string, subjectHash: d.hash as string, book: d.bookId as string };
    case "DraftApproved": return { ...base, action: "draft.approve", subject: d.draftId as string };
    case "Ratified": return { ...base, action: "journal.ratify", subject: d.journalId as string };
    case "PeriodLocked": return { ...base, action: "period.lock", subject: `${d.periodEnd}:${d.level}`, book: d.bookId as string,
      subjectHash: lockSubjectHash(d.bookId as string, d.periodEnd as string, d.level as string) };
    // FIN-MIG-02: the go-live signs the project's comparison (subject) and the checklist hash over it.
    case "MigrationWentLive": return { ...base, action: "migration.golive", subject: `${d.projectId}:${d.comparisonId}`, subjectHash: d.subjectHash as string, book: d.bookId as string };
    default: return null;
  }
}

/**
 * Re-check a stored webauthn signature offline: the digest recomputes from its inputs, the summary
 * from its hash, the inputs are bound to `binding` (the event), clientDataJSON is a webauthn.get over
 * exactly this digest, and the signature verifies against `publicKey` (COSE, as registered) with
 * the user-verified flag set. Returns the problems found (empty: valid).
 */
export async function verifyCommandSignature(sig: Extract<CommandSignature, { kind: "webauthn" }>, binding: Partial<CommandDigestInputs>, publicKey: Uint8Array | null): Promise<string[]> {
  const problems: string[] = [];
  if (commandDigest(sig.inputs) !== sig.digest) problems.push("digest does not match its inputs");
  if (summaryHash(sig.summary) !== sig.inputs.summaryHash) problems.push("summary does not match the signed summary hash");
  for (const [k, v] of Object.entries(binding)) {
    if (v !== undefined && (sig.inputs as Record<string, unknown>)[k] !== v) problems.push(`signed ${k} ${JSON.stringify((sig.inputs as Record<string, unknown>)[k])} is not the event's ${JSON.stringify(v)}`);
  }
  if (sig.summary.action !== sig.inputs.action) problems.push("summary is for another action");
  let cd: { type?: string; challenge?: string } = {};
  try { cd = JSON.parse(Buffer.from(sig.clientDataJSON, "base64url").toString("utf8")); } catch { problems.push("clientDataJSON is not JSON"); }
  if (cd.type !== "webauthn.get") problems.push("clientDataJSON is not an assertion");
  if (cd.challenge !== b64u(sig.digest)) problems.push("the signed challenge is not the command digest");
  const auth = Buffer.from(sig.authenticatorData, "base64url");
  if (auth.length < 37) problems.push("authenticatorData is too short");
  else {
    if (!auth.subarray(0, 32).equals(createHash("sha256").update(sig.rpId).digest())) problems.push("authenticatorData is for another relying party");
    if ((auth[32]! & 0x05) !== 0x05) problems.push("user presence and verification flags are not both set");
  }
  if (!publicKey) { problems.push(`no stored public key for credential ${sig.credentialId}`); return problems; }
  try {
    const v = await verifyAuthenticationResponse({
      response: { id: sig.credentialId, rawId: sig.credentialId, type: "public-key", clientExtensionResults: {},
        response: { authenticatorData: sig.authenticatorData, clientDataJSON: sig.clientDataJSON, signature: sig.signature, ...(sig.userHandle ? { userHandle: sig.userHandle } : {}) } },
      expectedChallenge: b64u(sig.digest), expectedOrigin: sig.origin, expectedRPID: sig.rpId, requireUserVerification: true,
      credential: { id: sig.credentialId, publicKey: new Uint8Array(publicKey), counter: 0 },
    });
    if (!v.verified) problems.push("signature does not verify against the stored public key");
  } catch (e) { problems.push(`signature does not verify: ${e instanceof Error ? e.message : String(e)}`); }
  return problems;
}

export interface SignatureReport {
  tenant: string; checked: number; valid: number;
  failures: { eventId: string; type: string; streamId: string; problems: string[] }[];
  /** Development fallback confirmations (no signature): acceptable only in development. */
  devStepUps: { eventId: string; type: string; principal: string }[];
  /** Period operations committed by a person without any signature (legacy, or not through HTTP). */
  unsignedPeriodOps: { eventId: string; planId: string; principal: string }[];
}
