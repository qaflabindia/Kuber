/**
 * Field and payload encryption: AES-256-GCM with a fresh 96-bit nonce per value.
 *
 * Token format (text, safe in TEXT and JSON columns):
 *   kb1.<keyVersion>.<base64url(nonce ‖ ciphertext ‖ tag)>
 *
 * Every token is bound to a context string through GCM's additional authenticated data: tenant,
 * purpose and the exact row it belongs to. A token copied to another row or tenant fails to open.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "kb1.";
const NONCE = 12, TAG = 16;

export class CryptoError extends Error {
  constructor(public code: "bad_token" | "auth_failed" | "no_key" | "shredded" | "plaintext" | "key_file", message: string) { super(message); }
}

export const isToken = (v: unknown): v is string => typeof v === "string" && v.startsWith(TOKEN_PREFIX);

export function sealWith(key: Buffer, version: number, plaintext: string | Buffer, aad: string): string {
  if (key.length !== 32) throw new CryptoError("no_key", "data keys are 256-bit");
  const nonce = randomBytes(NONCE);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(`${aad}|v${version}`, "utf8"));
  const body = Buffer.concat([c.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), c.final()]);
  return `${TOKEN_PREFIX}${version}.${Buffer.concat([nonce, body, c.getAuthTag()]).toString("base64url")}`;
}

export function parseToken(token: string): { version: number; blob: Buffer } {
  const m = /^kb1\.(\d{1,6})\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) throw new CryptoError("bad_token", "not a Kuber ciphertext token");
  const blob = Buffer.from(m[2]!, "base64url");
  if (blob.length < NONCE + TAG) throw new CryptoError("bad_token", "ciphertext too short");
  return { version: Number(m[1]), blob };
}

export function openWith(key: Buffer, token: string, aad: string): Buffer {
  const { version, blob } = parseToken(token);
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, NONCE));
  d.setAAD(Buffer.from(`${aad}|v${version}`, "utf8"));
  d.setAuthTag(blob.subarray(blob.length - TAG));
  try { return Buffer.concat([d.update(blob.subarray(NONCE, blob.length - TAG)), d.final()]); }
  catch { throw new CryptoError("auth_failed", "ciphertext failed authentication (wrong key, wrong row, or tampered)"); }
}

/** Keyed blind index for equality lookups on encrypted values (HMAC-SHA256, truncated to 128 bits). */
export const blindIndex = (key: Buffer, purpose: string, value: string) =>
  createHmac("sha256", key).update(`${purpose}\u0000${value}`, "utf8").digest("base64url").slice(0, 22);
