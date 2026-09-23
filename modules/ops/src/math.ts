/**
 * Pure ledger arithmetic used by operations. Integer paise only; every function here is
 * deterministic so a plan can be recomputed and compared byte for byte.
 */
import type { BookState } from "@kuber/gl";

export interface BalanceFilter { from?: string | null; to?: string | null; excludeVoucher?: string }

/** Balances (debit positive) computed from the authoritative book state, not a projection. */
export function balancesFromState(s: BookState, f: BalanceFilter = {}): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const j of s.journals.values()) {
    if (f.from && j.txnDate < f.from) continue;
    if (f.to && j.txnDate > f.to) continue;
    if (f.excludeVoucher && j.voucherType === f.excludeVoucher) continue;
    for (const l of j.lines) out.set(l.accountId, (out.get(l.accountId) ?? 0n) + BigInt(l.amount));
  }
  return out;
}

/**
 * Split a total by weights with the largest-remainder method: parts sum exactly to the total,
 * and ties go to the earlier weight so the result is stable.
 */
export function splitByWeights(total: bigint, weights: bigint[]): bigint[] {
  if (!weights.length) throw new Error("no weights");
  if (weights.some((w) => w < 0n)) throw new Error("weights must be non-negative");
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new Error("weights sum to zero");
  const sign = total < 0n ? -1n : 1n, abs = total * sign;
  const base = weights.map((w) => (abs * w) / sum);
  const rem = weights.map((w, i) => ({ i, r: (abs * w) % sum }));
  let left = abs - base.reduce((a, b) => a + b, 0n);
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rem) { if (left === 0n) break; base[i]! += 1n; left -= 1n; }
  return base.map((b) => b * sign);
}

/** Percent string ("33.33") to basis points (3333) without floating point. */
export function pctToBp(p: string | number): bigint {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(p).trim());
  if (!m) throw new Error(`bad percentage ${p}`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}

export interface Transfer { from: string; to: string; amount: bigint }

/**
 * Transfers that move a pool of accounts to target shares. Deficits are filled from the largest
 * surpluses first; transfers under `min` are skipped (not worth a transaction).
 */
export function rebalanceTransfers(current: { id: string; bal: bigint }[], targetBp: Map<string, bigint>, min = 0n): Transfer[] {
  const total = current.reduce((a, c) => a + c.bal, 0n);
  const ids = current.map((c) => c.id);
  const targets = splitByWeights(total, ids.map((id) => targetBp.get(id) ?? 0n));
  const gap = current.map((c, i) => ({ id: c.id, d: c.bal - targets[i]! }));  // + surplus, - deficit
  const give = gap.filter((g) => g.d > 0n).sort((a, b) => (a.d === b.d ? a.id.localeCompare(b.id) : a.d > b.d ? -1 : 1));
  const need = gap.filter((g) => g.d < 0n).sort((a, b) => (a.d === b.d ? a.id.localeCompare(b.id) : a.d < b.d ? -1 : 1));
  const out: Transfer[] = [];
  for (const n of need) {
    let want = -n.d;
    for (const g of give) {
      if (want === 0n) break;
      const x = g.d < want ? g.d : want;
      if (x <= 0n) continue;
      g.d -= x; want -= x;
      out.push({ from: g.id, to: n.id, amount: x });
    }
  }
  return out.filter((t) => t.amount >= min);
}

/** Indian financial year containing a date: 2026-10-12 -> { from: 2026-04-01, to: 2027-03-31 }. */
export function financialYear(iso: string) {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31`, label: `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}` };
}
