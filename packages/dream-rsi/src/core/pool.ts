/**
 * The recorded world a dream replays, and the record of the dream itself.
 *
 * ReplayPool   recorded decisions: context features, the action the deployed policy took, and the
 *              outcome that was later recorded (open-dream-rsi's DiscoveryTree plays this role for
 *              code attempts; for a policy over independent decisions the history is a sequence).
 * DiscoveryTree  port of open-dream-rsi core/tree.py: every candidate a dream evaluated, as a node
 *              under the candidate it was proposed from, with its score; the best trajectory is the
 *              chain of accepted improvements the evidence report shows.
 */
import { hashOf } from "./util.ts";

/** One recorded decision. `seq` orders the pool (decision time); ids are hashed, never raw. */
export interface RecordedDecision<F = unknown, A = unknown, O = unknown> {
  id: string;
  seq: number;
  features: F;
  action: A;
  outcome: O;
}

export class ReplayPool<D extends RecordedDecision = RecordedDecision> {
  readonly items: readonly D[];
  private cachedHash: string | null = null;

  /** `kind` names the decision family the items belong to; items are ordered by seq, then id. */
  constructor(readonly kind: string, items: readonly D[], readonly meta: Record<string, unknown> = {}) {
    this.items = [...items].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ids = new Set<string>();
    for (const d of this.items) {
      if (ids.has(d.id)) throw new Error(`replay pool ${kind}: duplicate decision id ${d.id}`);
      ids.add(d.id);
    }
  }

  get size() { return this.items.length; }

  /** SHA-256 of the canonical pool slice (kind, meta and items): identifies exactly what was replayed. */
  hash(): string {
    return (this.cachedHash ??= hashOf({ kind: this.kind, meta: this.meta, items: this.items }));
  }

  /** A sub-pool (e.g. one segment); meta records the filter so the slice hash differs from the parent's. */
  filter(label: string, pred: (d: D) => boolean): ReplayPool<D> {
    return new ReplayPool(this.kind, this.items.filter(pred), { ...this.meta, slice: label });
  }

  toJSON() { return { kind: this.kind, meta: this.meta, items: this.items }; }
}

export interface TreeNode {
  nodeId: string;
  /** What was tried: here, the hash of the candidate's parameters. */
  action: string;
  result: unknown;
  score: number;
  parentId: string | null;
  children: string[];
  /** Short label of the idea (open-dream-rsi's `thought`): which proposer produced it and why. */
  thought: string;
}

export class DiscoveryTree {
  readonly nodes = new Map<string, TreeNode>();
  rootId: string | null = null;

  addNode(nodeId: string, action: string, result: unknown, score: number, parentId: string | null = null, thought = ""): TreeNode {
    const node: TreeNode = { nodeId, action, result, score, parentId, children: [], thought };
    this.nodes.set(nodeId, node);
    const parent = parentId ? this.nodes.get(parentId) : undefined;
    if (parent) parent.children.push(nodeId);
    else if (this.rootId === null) this.rootId = nodeId;
    return node;
  }

  /** Root-to-node path of the best-scoring node (ties: the earliest), as tree.py get_best_trajectory. */
  bestTrajectory(accept: (n: TreeNode) => boolean = () => true): TreeNode[] {
    let best: TreeNode | null = null;
    for (const n of this.nodes.values()) if (accept(n) && (!best || n.score > best.score)) best = n;
    const out: TreeNode[] = [];
    for (let cur = best; cur; cur = cur.parentId ? this.nodes.get(cur.parentId) ?? null : null) out.push(cur);
    return out.reverse();
  }
}
