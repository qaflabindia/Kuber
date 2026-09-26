/**
 * Deterministic helpers of the Dream-RSI core: canonical JSON, SHA-256, a seeded RNG and
 * percentile statistics. No domain knowledge and no dependencies beyond node:crypto.
 */
import { createHash } from "node:crypto";

/** Canonical JSON: sorted keys, no whitespace, non-finite numbers as strings, bigint as decimal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
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

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const hashOf = (v: unknown) => sha256Hex(canonicalJson(v));

/**
 * Seeded pseudo-random generator (sfc32, seeded from SHA-256 of the seed text). The same seed text
 * gives the same sequence on every platform, which is what makes a dream run reproducible
 * (open-dream-rsi seeds `random.Random(DREAM_SEED)` and `f"{DREAM_SEED}:{ep}"` the same way).
 */
export class SeededRng {
  private a: number; private b: number; private c: number; private d: number;
  constructor(seed: string | number) {
    const h = createHash("sha256").update(String(seed)).digest();
    this.a = h.readUInt32LE(0); this.b = h.readUInt32LE(4); this.c = h.readUInt32LE(8); this.d = h.readUInt32LE(12);
    for (let i = 0; i < 12; i++) this.next();
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const r = (t + this.d) | 0;
    this.c = (this.c + r) | 0;
    return (r >>> 0) / 4294967296;
  }
  /** Integer in [0, n). */
  int(n: number): number { return Math.floor(this.next() * n); }
  uniform(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
}

/** Quantile with linear interpolation between order statistics (R type 7) of an ascending array. */
export function quantile(sortedAsc: ArrayLike<number>, q: number): number {
  const n = sortedAsc.length;
  if (!n) return NaN;
  const h = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h), hi = Math.ceil(h);
  return sortedAsc[lo]! + (h - lo) * (sortedAsc[hi]! - sortedAsc[lo]!);
}

/** Round to `digits` decimals without drift from binary representation (1.005 -> 1.01 is not promised; stable is). */
export const roundTo = (x: number, digits: number) => Number(x.toFixed(digits));
