import { createHash, randomUUID } from "node:crypto";

/** Canonical JSON: sorted keys, no whitespace, bigint as decimal string. Used for hashes and signatures. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const GENESIS_HASH = "0".repeat(64);
export const uuid = () => randomUUID();

/** Deterministic UUID (v5-style layout) from a name, so retried work produces the same IDs. */
export function stableId(namespace: string, name: string): string {
  const h = createHash("sha1").update(namespace + "\u0000" + name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export const todayIso = (d = new Date()) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return todayIso(d);
};

/** The GL journal ID for a posting request: deterministic so retries and other modules agree on it. */
export const journalIdForRequest = (tenantId: string, requestId: string) => stableId("journal", `${tenantId}/${requestId}`);
export const reversalIdForRequest = (tenantId: string, requestId: string) => stableId("reversal", `${tenantId}/${requestId}`);
