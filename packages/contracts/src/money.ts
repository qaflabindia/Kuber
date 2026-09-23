/**
 * Money is integer minor units (paise) as bigint in the domain, and as a decimal
 * integer string on the wire and in stored events. `number` is never used for money.
 */
import { z } from "zod";

declare const PaiseBrand: unique symbol;
/** An amount in paise. Debit positive, credit negative when used on a ledger line. */
export type Paise = bigint & { readonly [PaiseBrand]: true };

/** Wire format: "-12345". */
export const MinorString = z.string().regex(/^-?\d{1,20}$/, "amount must be an integer number of paise");
export type MinorString = z.infer<typeof MinorString>;

export const paise = (v: bigint | number | string): Paise => {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new RangeError(`not an integer paise amount: ${v}`);
    return BigInt(v) as Paise;
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) throw new RangeError(`not an integer paise amount: ${v}`);
    return BigInt(v) as Paise;
  }
  return v as Paise;
};

export const toWire = (p: bigint): MinorString => p.toString();
export const fromWire = (s: string): Paise => paise(s);

const CLEAN = /[,\s₹]|INR|Rs\.?/gi;

/** Parse "1,20,000.50", "₹450", "(1,000)" into paise; half-up rounding to the paisa. */
export function parseAmount(text: string): Paise {
  let t = text.replace(CLEAN, "").trim();
  let neg = false;
  if (t.startsWith("(") && t.endsWith(")")) { neg = true; t = t.slice(1, -1); }
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1); }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new RangeError(`not an amount: ${text}`);
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? "").padEnd(3, "0");
  let p = whole * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) p += 1n;
  return paise(neg ? -p : p);
}

/** Indian grouping: ₹12,34,567.89 */
export function formatINR(p: bigint): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const rupees = (abs / 100n).toString();
  const ps = (abs % 100n).toString().padStart(2, "0");
  let head = rupees.length > 3 ? rupees.slice(0, -3) : "";
  const tail = rupees.length > 3 ? rupees.slice(-3) : rupees;
  const groups: string[] = [];
  while (head.length > 2) { groups.unshift(head.slice(-2)); head = head.slice(0, -2); }
  if (head) groups.unshift(head);
  return `${neg ? "-" : ""}₹${[...groups, tail].join(",")}.${ps}`;
}

export const sum = (xs: Iterable<bigint>): bigint => { let s = 0n; for (const x of xs) s += x; return s; };
