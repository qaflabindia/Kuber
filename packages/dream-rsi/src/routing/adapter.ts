/**
 * Input adapters for the routing pool. Copilot turn records arrive as sealed `AgentTurnRecorded`
 * events once ws5/agent-gov lands (router hit or miss, tools, grounding result, the person's next
 * action). This package does not depend on that branch: it defines the adapter interface, a
 * fixture adapter, and `fromTurnRecord`, which maps the turn-record shape of
 * apps/core/src/copilot/governance/contracts.ts (plus the router and next-action fields the
 * event is expected to carry) to a feature-only RoutingTurn. The event-store adapter is a thin
 * reader over that mapping, added with the event type.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ReplayPool } from "../core/pool.ts";
import { sha256Hex } from "../core/util.ts";
import { RoutingTurnSchema, type IntentFamily, type RoutingTurn } from "./family.ts";

export interface TurnQuery { tenant: string; book?: string; from?: string; to?: string }

export interface TurnRecordAdapter {
  readonly name: string;
  load(q: TurnQuery): Promise<RoutingTurn[]>;
}

/** Turns from a JSON fixture (an array of RoutingTurn, or { turns: [...] }), validated: features only. */
export class FixtureTurnAdapter implements TurnRecordAdapter {
  readonly name = "fixture";
  private turns: RoutingTurn[];
  constructor(turns: unknown) {
    const list = Array.isArray(turns) ? turns : (turns as { turns?: unknown })?.turns;
    this.turns = z.array(RoutingTurnSchema).parse(list) as RoutingTurn[];
  }
  static fromFile(path: string) { return new FixtureTurnAdapter(JSON.parse(readFileSync(path, "utf8"))); }
  async load(): Promise<RoutingTurn[]> { return this.turns.map((t) => structuredClone(t)); }
}

export async function routingPool(adapter: TurnRecordAdapter, q: TurnQuery): Promise<ReplayPool<RoutingTurn>> {
  return new ReplayPool("copilot.routing", await adapter.load(q), { source: adapter.name, tenant: sha256Hex(`tenant|${q.tenant}`).slice(0, 16),
    from: q.from ?? null, to: q.to ?? null });
}

/**
 * The expected shape of an AgentTurnRecorded payload, as far as routing needs it: the governance
 * TurnRecord (turnId, engine, tools, grounding) plus the router's scored candidates, the account
 * resolution and the person's next action. Free text (the person's input, the reply) is never read.
 */
export interface TurnRecordLike {
  turnId: string;
  engine: string;
  tools: { tool: string; ok: boolean }[];
  grounding: { ok: boolean; ungrounded: string[] };
  outcome: "answered" | "refused" | "error" | "halted";
  router?: { hit: boolean; candidates: { op: string; score: number }[] };
  account?: { candidates: { accountId: string; similarity: number }[]; chosen: string | null; guessed?: boolean } | null;
  clarified?: boolean;
  next?: { action: "accepted" | "rephrased" | "corrected" | "abandoned" | "none"; tool?: string | null; accountId?: string | null };
}

const OP_FAMILY: Record<string, IntentFamily> = {
  dashboard: "position", balance: "books_check", reconcile: "reconcile", close: "period_close", carry_forward: "period_close",
  post: "post_drafts", rebalance: "rebalance", allocate: "allocate", simulate: "simulate", report: "report", capture: "capture", record: "capture",
};
export const familyOfOp = (op: string): IntentFamily => OP_FAMILY[op.replace(/^kuber_/, "")] ?? "other";
const toolOf = (op: string) => op.replace(/^kuber_/, "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64) || "unknown";

/**
 * Map one turn record to a RoutingTurn. `hashId` must be a keyed hash (the tenant's index key) so
 * turn and account ids cannot be linked back without the tenant's keys.
 */
export function fromTurnRecord(r: TurnRecordLike, seq: number, hashId: (kind: string, id: string) => string): RoutingTurn {
  const viaRouter = r.engine === "rules" || !!r.router?.hit;
  const firstTool = r.tools[0]?.tool ?? null;
  const path = r.clarified ? "clarify" : viaRouter ? "router" : "model";
  const nextTool = r.next?.tool ?? (r.next?.action === "accepted" ? firstTool : null);
  const nextAccount = r.next?.accountId ?? (r.next?.action === "accepted" ? r.account?.chosen ?? null : null);
  return {
    id: hashId("turn", r.turnId), seq,
    features: {
      router: { candidates: (r.router?.candidates ?? []).slice(0, 20).map((c) => ({ family: familyOfOp(c.op), tool: toolOf(c.op), score: Math.min(1, Math.max(0, c.score)) })) },
      account: r.account ? { candidates: r.account.candidates.slice(0, 50).map((c) => ({ id: hashId("account", c.accountId), similarity: Math.min(1, Math.max(0, c.similarity)) })) } : null,
    },
    action: { path, tool: path === "clarify" || !firstTool ? null : toolOf(firstTool) },
    outcome: {
      truth: { tool: nextTool ? toolOf(nextTool) : null, account: nextAccount ? hashId("account", nextAccount) : null },
      model: path === "model" ? { correct: r.next?.action === "accepted" && r.outcome === "answered", grounded: r.grounding.ok, guessedAccount: !!r.account?.guessed } : null,
      nextAction: r.next?.action ?? "none",
    },
  };
}
