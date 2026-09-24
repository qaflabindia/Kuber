/**
 * The Book's journals as a persistent, insertion-ordered map (F10), carrying the indexes that
 * interactive queries need so they do work proportional to the answer, not to history (F11):
 *
 * - balances: per account, an AVL tree of daily movement (all lines / lines outside closing
 *   vouchers) with range aggregates: any date-range balance is O(accounts x log days).
 * - open provisional journals (provisional and not reversed), in posting order.
 * - the latest transaction date.
 *
 * `with` returns a new JournalMap and never changes this one, so `evolve` stays pure. The key
 * order is kept in an append-only array shared between versions: a version reads only its own
 * prefix, and a second append from the same version (a branch) copies the prefix first.
 */
import type { JournalRecord } from "./book.ts";
import { PMap, addAt, rangeAgg, type Agg, type DateNode } from "./pmap.ts";

/** Lines per journal that the first-appearance key can order exactly; larger journals fall back to a scan. */
const LINE_SLOTS = 65536;

export interface BalanceQuery { from?: string | null; to?: string | null; excludeClosing?: boolean }

export class JournalMap implements ReadonlyMap<string, JournalRecord> {
  private constructor(
    private readonly map: PMap<{ o: number; v: JournalRecord }>,
    private readonly order: string[],
    readonly size: number,
    /** null when an update could not be applied incrementally; queries then scan. */
    private readonly accounts: PMap<DateNode> | null,
    private readonly accountOrder: string[],
    private readonly accountCount: number,
    private readonly prov: number[],
    private readonly provLen: number,
    readonly lastTxnDate: string | null,
  ) {}

  static empty(): JournalMap { return new JournalMap(PMap.empty(), [], 0, PMap.empty(), [], 0, [], 0, null); }

  static from(entries: Iterable<readonly [string, JournalRecord]>): JournalMap {
    let m = JournalMap.empty();
    for (const [k, v] of entries) m = m.with(k, v);
    return m;
  }

  get(k: string) { return this.map.get(k)?.v; }
  has(k: string) { return this.map.get(k) !== undefined; }
  /** True when the balance index and latest date are maintained (false only after an unusual update). */
  get indexed() { return this.accounts !== null; }

  /** A new map with `k` set to `v`. A new key goes last; an existing key keeps its place. */
  with(k: string, v: JournalRecord): JournalMap {
    const hit = this.map.get(k);
    const openNow = v.provisional && !v.reversedBy;
    if (hit) {
      const ord = hit.o, prev = hit.v;
      const map = this.map.set(k, { o: ord, v });
      const wasOpen = prev.provisional && !prev.reversedBy;
      const own = this.prov.slice(0, this.provLen);
      const prov = wasOpen === openNow ? this.prov : openNow ? insertSorted(own, ord) : own.filter((o) => o !== ord);
      const provLen = wasOpen === openNow ? this.provLen : prov.length;
      const sameLedger = prev.lines === v.lines && prev.txnDate === v.txnDate && prev.voucherType === v.voucherType;
      // Journals are never rewritten, only marked reversed; anything else disables the indexes.
      const accounts = sameLedger ? this.accounts : null;
      return new JournalMap(map, this.order, this.size, accounts, this.accountOrder, this.accountCount, prov, provLen, sameLedger ? this.lastTxnDate : null);
    }
    const ord = this.size;
    const map = this.map.set(k, { o: ord, v });
    const order = appendShared(this.order, this.size, k);
    let accounts = this.accounts, accountOrder = this.accountOrder, accountCount = this.accountCount;
    if (accounts && v.lines.length < LINE_SLOTS) {
      const closing = v.voucherType === "closing";
      v.lines.forEach((l, i) => {
        const amt = BigInt(l.amount), key = ord * LINE_SLOTS + i;
        const delta: Agg = { all: amt, non: closing ? 0n : amt, fa: key, fn: closing ? Infinity : key };
        const tree = accounts!.get(l.accountId);
        if (tree === undefined) { accountOrder = appendShared(accountOrder, accountCount, l.accountId); accountCount++; }
        accounts = accounts!.set(l.accountId, addAt(tree ?? null, v.txnDate, delta));
      });
    } else accounts = null;
    const prov = openNow ? appendShared(this.prov, this.provLen, ord) : this.prov;
    const provLen = this.provLen + (openNow ? 1 : 0);
    const last = !accounts ? null : this.lastTxnDate === null || v.txnDate > this.lastTxnDate ? v.txnDate : this.lastTxnDate;
    return new JournalMap(map, order, this.size + 1, accounts, accountOrder, accountCount, prov, provLen, last);
  }

  /**
   * Balances (debit positive) per account over a date range, in the order a scan of the journals
   * in posting order would first meet each account. null when the index is unavailable.
   */
  balances(q: BalanceQuery = {}): Map<string, bigint> | null {
    if (!this.accounts) return null;
    const lo = q.from || undefined, hi = q.to || undefined;
    const found: { id: string; key: number; bal: bigint }[] = [];
    for (let i = 0; i < this.accountCount; i++) {
      const id = this.accountOrder[i]!;
      const a = rangeAgg(this.accounts.get(id) ?? null, lo, hi);
      const key = q.excludeClosing ? a.fn : a.fa;
      if (key !== Infinity) found.push({ id, key, bal: q.excludeClosing ? a.non : a.all });
    }
    found.sort((x, y) => x.key - y.key);
    return new Map(found.map((f) => [f.id, f.bal]));
  }

  /** Open provisional journals (provisional, not reversed), in posting order. */
  *openProvisional(): Generator<[string, JournalRecord]> {
    for (let i = 0; i < this.provLen; i++) { const k = this.order[this.prov[i]!]!; yield [k, this.map.get(k)!.v]; }
  }
  *keys(): MapIterator<string> { for (let i = 0; i < this.size; i++) yield this.order[i]!; }
  *values(): MapIterator<JournalRecord> { for (let i = 0; i < this.size; i++) yield this.map.get(this.order[i]!)!.v; }
  *entries(): MapIterator<[string, JournalRecord]> { for (let i = 0; i < this.size; i++) { const k = this.order[i]!; yield [k, this.map.get(k)!.v]; } }
  [Symbol.iterator]() { return this.entries(); }
  forEach(cb: (v: JournalRecord, k: string, m: ReadonlyMap<string, JournalRecord>) => void, thisArg?: unknown) {
    for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this);
  }
  get [Symbol.toStringTag]() { return "JournalMap"; }
}

function appendShared<T>(arr: T[], len: number, x: T): T[] {
  if (arr.length === len) { arr.push(x); return arr; }
  const copy = arr.slice(0, len); copy.push(x); return copy;
}

function insertSorted(xs: number[], x: number): number[] {
  const out = [...xs, x];
  out.sort((a, b) => a - b);
  return out;
}

