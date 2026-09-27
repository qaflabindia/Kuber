/**
 * Exact arithmetic for statements and metrics (FIN-RPT-01/02): amounts are integer paise (bigint),
 * ratios are bigint numerator/denominator pairs reduced by their gcd, and a figure becomes decimal
 * text only when it is formatted, with round-half-away-from-zero at the last shown place. No
 * floating point anywhere in a computed figure.
 */
import { isIsoDate } from "@kuber/contracts";

const abs = (x: bigint) => (x < 0n ? -x : x);
const gcd = (a: bigint, b: bigint): bigint => { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a; };

export class Rational {
  readonly n: bigint; readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new RangeError("rational with a zero denominator");
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g; this.d = d / g;
  }
  static of(x: bigint | number | Rational): Rational {
    if (x instanceof Rational) return x;
    if (typeof x === "number") { if (!Number.isSafeInteger(x)) throw new RangeError(`not an integer: ${x}`); return new Rational(BigInt(x)); }
    return new Rational(x);
  }
  add(o: Rational) { return new Rational(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Rational) { return new Rational(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Rational) { return new Rational(this.n * o.n, this.d * o.d); }
  /** Throws DivisionByZero (the caller turns it into an unavailable figure, never 0). */
  div(o: Rational) { if (o.n === 0n) throw new DivisionByZero(); return new Rational(this.n * o.d, this.d * o.n); }
  neg() { return new Rational(-this.n, this.d); }
  isZero() { return this.n === 0n; }
  sign() { return this.n === 0n ? 0 : this.n > 0n ? 1 : -1; }
  cmp(o: Rational) { const x = this.n * o.d - o.n * this.d; return x === 0n ? 0 : x > 0n ? 1 : -1; }
  equals(o: Rational) { return this.n === o.n && this.d === o.d; }
  /** Decimal text with `places` digits after the point, rounded half away from zero. */
  toFixed(places: number): string {
    const scale = 10n ** BigInt(places);
    const neg = this.n < 0n, num = abs(this.n) * scale;
    let q = num / this.d;
    if ((num % this.d) * 2n >= this.d) q += 1n;
    const s = q.toString().padStart(places + 1, "0");
    const body = places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
    return q === 0n ? body : `${neg ? "-" : ""}${body}`;
  }
  /** Exact "n/d" (the canonical form stored in exports and compared in tests). */
  toString() { return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`; }
  static parse(s: string): Rational {
    const m = /^(-?\d+)(?:\/(\d+))?$/.exec(s);
    if (m) return new Rational(BigInt(m[1]!), BigInt(m[2] ?? "1"));
    const d = /^(-?)(\d+)\.(\d+)$/.exec(s);
    if (d) return new Rational(BigInt(`${d[1]}${d[2]}${d[3]}`), 10n ** BigInt(d[3]!.length));
    throw new RangeError(`not a rational: ${s}`);
  }
}

export class DivisionByZero extends Error { constructor() { super("division by zero"); } }

// ---------------------------------------------------------------- strict dates
/** A real YYYY-MM-DD calendar date, or throws (F08: never let PostgreSQL normalise an impossible date). */
export function strictDate(s: string, what = "date"): string {
  if (typeof s !== "string" || !isIsoDate(s)) throw new RangeError(`${what} must be a real calendar date YYYY-MM-DD, got ${JSON.stringify(s)}`);
  return s;
}
const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
/** Same day `n` months later (clamped to the month's last day: 31 Mar − 1 month = 28/29 Feb). */
export function addMonths(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
  const t = y * 12 + (m - 1) + n, ny = Math.floor(t / 12), nm = (t % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${pad(nm)}-${pad(Math.min(d, daysIn(ny, nm)))}`;
}
const isMonthEnd = (iso: string) => Number(iso.slice(8, 10)) === daysIn(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));
/** The same span one year earlier; a period ending on a month end keeps ending on that month's end (29 Feb → 28 Feb). */
export function priorYear(from: string, to: string): { from: string; to: string } {
  const f = addMonths(from, -12), t = addMonths(to, -12);
  return { from: f, to: isMonthEnd(to) ? `${t.slice(0, 8)}${pad(daysIn(Number(t.slice(0, 4)), Number(t.slice(5, 7))))}` : t };
}
/** Days from `from` to `to`, both included. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
/** The fiscal year containing `iso` for a start month (1 = January, 4 = April). */
export function fiscalYearOf(iso: string, startMonth = 4) {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  const start = m >= startMonth ? y : y - 1;
  const endY = startMonth === 1 ? start : start + 1, endM = startMonth === 1 ? 12 : startMonth - 1;
  return { from: `${start}-${pad(startMonth)}-01`, to: `${endY}-${pad(endM)}-${pad(daysIn(endY, endM))}`,
    label: startMonth === 1 ? `FY ${start}` : `FY ${start}-${pad((start + 1) % 100)}` };
}
