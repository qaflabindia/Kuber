/**
 * Event payload sealing.
 *
 * Stored payload: {"$c": token} where token seals {s: salt, d: data} under the tenant's data key,
 * bound to (event id, type, stream). The same sealed payload goes to the outbox and the broker,
 * so no plaintext copy of an event exists at rest anywhere.
 *
 * digest = sha256(salt ‖ canonical(data)); link_n = sha256(link_{n-1} ‖ digest_n ‖ stream ‖ n).
 * The salt is inside the ciphertext, so digests reveal nothing about the data, yet the link chain
 * can be checked without keys (after re-encryption, and after crypto-shredding).
 */
import { createHash, randomBytes } from "node:crypto";
import { canonical, type Envelope } from "@kuber/contracts";
import { CryptoError, isToken, type Keyring, type TenantKeys } from "@kuber/crypto";

export const GENESIS_LINK = "0".repeat(64);
export interface Sealed { $c: string }
export const isSealed = (d: unknown): d is Sealed => !!d && typeof d === "object" && isToken((d as Sealed).$c);

export const eventContext = (eventId: string, type: string, streamId: string) => `event|${eventId}|${type}|${streamId}`;
export const digestOf = (salt: Buffer, data: unknown) => createHash("sha256").update(salt).update(canonical(data)).digest("hex");
export const linkOf = (prev: string, digest: string, streamId: string, version: number) =>
  createHash("sha256").update(`${prev}|${digest}|${streamId}|${version}`).digest("hex");

export function sealEvent(keys: TenantKeys, eventId: string, type: string, streamId: string, data: unknown) {
  const salt = randomBytes(16);
  return { sealed: { $c: keys.sealJson({ s: salt.toString("base64"), d: data }, eventContext(eventId, type, streamId)) } as Sealed, digest: digestOf(salt, data) };
}

export function openEventData(keys: TenantKeys, eventId: string, type: string, streamId: string, stored: Sealed) {
  const p = keys.openJson<{ s: string; d: unknown }>(stored.$c, eventContext(eventId, type, streamId));
  return { data: p.d, digest: digestOf(Buffer.from(p.s, "base64"), p.d) };
}

/** Policy for rows written before encryption existed. */
export type LegacyPolicy = "reject" | "allow";

/** Decrypt an envelope's payload (from the broker or the outbox) before a handler sees it. */
export async function openEnvelope(keyring: Keyring, env: Envelope, legacy: LegacyPolicy = "reject"): Promise<Envelope> {
  if (!isSealed(env.data)) {
    if (legacy === "allow") return env;
    throw new CryptoError("plaintext", `event ${env.eventId} is not encrypted; run the legacy encryption migration`);
  }
  const keys = await keyring.forTenant(env.meta.tenantId);
  return { ...env, data: openEventData(keys, env.eventId, env.type, env.streamId, env.data).data as never };
}
