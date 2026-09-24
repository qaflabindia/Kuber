/**
 * Persistent (immutable, structure-sharing) data structures for the Book aggregate, so `evolve`
 * stays pure without copying the whole book on every event (F10):
 *
 * - PMap: a hash array mapped trie with string keys. `set` copies one path, O(log32 n).
 * - AVL date trees with range aggregates, used by the balance index in journals.ts.
 *
 * Nothing here mutates a value another holder can see; every update returns a new root.
 */

// ------------------------------------------------------------------ PMap (HAMT)
type Leaf<V> = { t: 0; h: number; k: string; v: V };
type Coll<V> = { t: 1; h: number; e: Leaf<V>[] };
type Branch<V> = { t: 2; bm: number; c: Node<V>[] };
type Node<V> = Leaf<V> | Coll<V> | Branch<V>;

/** FNV-1a, 32 bit. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const popcnt = (x: number) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
};

function merge<V>(a: Leaf<V> | Coll<V>, b: Leaf<V>, shift: number): Branch<V> {
  // a.h !== b.h, so the hashes split at some level with shift <= 30
  const fa = (a.h >>> shift) & 31, fb = (b.h >>> shift) & 31;
  if (fa === fb) return { t: 2, bm: (1 << fa) | 0, c: [merge(a, b, shift + 5)] };
  return { t: 2, bm: (1 << fa) | (1 << fb), c: fa < fb ? [a, b] : [b, a] };
}

function setNode<V>(n: Node<V> | undefined, leaf: Leaf<V>, shift: number, added: { v: boolean }): Node<V> {
  if (!n) { added.v = true; return leaf; }
  if (n.t === 0) {
    if (n.k === leaf.k) return leaf;
    added.v = true;
    return n.h === leaf.h ? { t: 1, h: n.h, e: [n, leaf] } : merge(n, leaf, shift);
  }
  if (n.t === 1) {
    if (n.h !== leaf.h) { added.v = true; return merge(n, leaf, shift); }
    const i = n.e.findIndex((l) => l.k === leaf.k);
    if (i < 0) { added.v = true; return { t: 1, h: n.h, e: [...n.e, leaf] }; }
    const e = n.e.slice(); e[i] = leaf;
    return { t: 1, h: n.h, e };
  }
  const bit = 1 << ((leaf.h >>> shift) & 31);
  const idx = popcnt(n.bm & (bit - 1));
  if (!(n.bm & bit)) {
    added.v = true;
    const c = n.c.slice(); c.splice(idx, 0, leaf);
    return { t: 2, bm: n.bm | bit, c };
  }
  const c = n.c.slice(); c[idx] = setNode(n.c[idx], leaf, shift + 5, added);
  return { t: 2, bm: n.bm, c };
}

function* walk<V>(n: Node<V> | undefined): Generator<Leaf<V>> {
  if (!n) return;
  if (n.t === 0) yield n;
  else if (n.t === 1) yield* n.e;
  else for (const c of n.c) yield* walk(c);
}

/** Immutable string-keyed map. Iteration order is hash order, not insertion order. */
export class PMap<V> {
  private constructor(private readonly root: Node<V> | undefined, readonly size: number) {}
  static empty<V>(): PMap<V> { return new PMap<V>(undefined, 0); }

  get(k: string): V | undefined {
    const h = fnv1a(k);
    let n = this.root, shift = 0;
    while (n) {
      if (n.t === 0) return n.k === k ? n.v : undefined;
      if (n.t === 1) return n.h === h ? n.e.find((l) => l.k === k)?.v : undefined;
      const bit = 1 << ((h >>> shift) & 31);
      if (!(n.bm & bit)) return undefined;
      n = n.c[popcnt(n.bm & (bit - 1))];
      shift += 5;
    }
    return undefined;
  }
  has(k: string) { return this.get(k) !== undefined; }
  set(k: string, v: V): PMap<V> {
    const added = { v: false };
    const root = setNode(this.root, { t: 0, h: fnv1a(k), k, v }, 0, added);
    return new PMap(root, this.size + (added.v ? 1 : 0));
  }
  *entries(): Generator<[string, V]> { for (const l of walk(this.root)) yield [l.k, l.v]; }
}

// ------------------------------------------------------------------ AVL date tree with aggregates
/**
 * Per-account movement by date. Each node holds one date's totals; `agg` covers its subtree.
 * all = sum of every line, non = sum excluding closing vouchers; fa / fn = the smallest
 * "first-appearance key" among those lines (Infinity when there are none), which lets a range
 * query reproduce the account order a scan of the journals would produce.
 */
export interface Agg { all: bigint; non: bigint; fa: number; fn: number }
export interface DateNode { d: string; h: number; l: DateNode | null; r: DateNode | null; own: Agg; agg: Agg }

export const ZERO: Agg = { all: 0n, non: 0n, fa: Infinity, fn: Infinity };
const plus = (a: Agg, b: Agg): Agg => ({ all: a.all + b.all, non: a.non + b.non, fa: a.fa < b.fa ? a.fa : b.fa, fn: a.fn < b.fn ? a.fn : b.fn });
const ht = (n: DateNode | null) => (n ? n.h : 0);
const aggOf = (n: DateNode | null) => (n ? n.agg : ZERO);
const mk = (d: string, own: Agg, l: DateNode | null, r: DateNode | null): DateNode =>
  ({ d, own, l, r, h: 1 + Math.max(ht(l), ht(r)), agg: plus(plus(aggOf(l), own), aggOf(r)) });

function balance(d: string, own: Agg, l: DateNode | null, r: DateNode | null): DateNode {
  if (ht(l) > ht(r) + 1) {
    const L = l!;
    if (ht(L.l) >= ht(L.r)) return mk(L.d, L.own, L.l, mk(d, own, L.r, r));
    const LR = L.r!;
    return mk(LR.d, LR.own, mk(L.d, L.own, L.l, LR.l), mk(d, own, LR.r, r));
  }
  if (ht(r) > ht(l) + 1) {
    const R = r!;
    if (ht(R.r) >= ht(R.l)) return mk(R.d, R.own, mk(d, own, l, R.l), R.r);
    const RL = R.l!;
    return mk(RL.d, RL.own, mk(d, own, l, RL.l), mk(R.d, R.own, RL.r, R.r));
  }
  return mk(d, own, l, r);
}

/** Add `delta` at date `d` (path copy, O(log n)). */
export function addAt(n: DateNode | null, d: string, delta: Agg): DateNode {
  if (!n) return mk(d, delta, null, null);
  if (d === n.d) return mk(n.d, plus(n.own, delta), n.l, n.r);
  return d < n.d ? balance(n.d, n.own, addAt(n.l, d, delta), n.r) : balance(n.d, n.own, n.l, addAt(n.r, d, delta));
}

const geq = (n: DateNode | null, lo: string): Agg =>
  !n ? ZERO : n.d < lo ? geq(n.r, lo) : plus(plus(geq(n.l, lo), n.own), aggOf(n.r));
const leq = (n: DateNode | null, hi: string): Agg =>
  !n ? ZERO : n.d > hi ? leq(n.l, hi) : plus(plus(aggOf(n.l), n.own), leq(n.r, hi));

/** Aggregate over dates lo <= d <= hi (either bound optional), O(log n). */
export function rangeAgg(n: DateNode | null, lo?: string, hi?: string): Agg {
  while (n) {
    if (lo !== undefined && n.d < lo) { n = n.r; continue; }
    if (hi !== undefined && n.d > hi) { n = n.l; continue; }
    return plus(plus(lo === undefined ? aggOf(n.l) : geq(n.l, lo), n.own), hi === undefined ? aggOf(n.r) : leq(n.r, hi));
  }
  return ZERO;
}
