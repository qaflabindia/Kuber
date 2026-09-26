/**
 * The only place the harness touches the build: it constructs the copilot through its stable entry
 * point (`new Copilot(cell, model, external, clock)` then `ask(who, text, history)`) and detects what
 * this build offers, so cases that need a missing tool or control are reported as
 * "not-yet-available" instead of failed.
 *
 * Detection is by feature, never by branch name:
 *   tools        names in `kuberTools(cell, who)` (the one catalogue every agent surface uses)
 *   governance   `createGovernance` exported by @kuber/core (ws5/agent-gov); passed to the copilot
 *                as its fifth constructor argument (ws5/agent-core), ignored by older builds
 *   reasoner     `isReasoner` exported (the copilot accepts a Reasoner as well as an LlmProvider)
 *   kill_switch  `identity.copilotHalted` (AGT-09 copilot scope)
 *   roles_v2     the identity module accepts admin, customer and supplier members (role model v2)
 */
import * as core from "@kuber/core";
import type { Cell } from "@kuber/core";
import { OWNER, ROLE_PRINCIPALS, TENANT } from "./fixtures.ts";

export interface Capabilities {
  tools: string[];
  governance: boolean;
  reasoner: boolean;
  kill_switch: boolean;
  roles_v2: boolean;
  notes: string[];
}

export interface Card { planId: string; op: string; kind: "read" | "write"; bookId: string; status: string; blocked: boolean; text: string }
export interface Reply {
  reply: string; cards: Card[]; trace: { tool: string; ok: boolean }[]; engine: string;
  outcome?: string; suggestions?: string[];
}
export interface Who { tenant: string; book: string; principal: string }
interface CopilotLike { ask(who: Who, text: string, history?: { role: "user" | "assistant"; text: string }[], opts?: { sessionId?: string | null }): Promise<Record<string, unknown>> }

const exported = (name: string): unknown => (core as Record<string, unknown>)[name];

export async function detect(cell: Cell): Promise<Capabilities> {
  const notes: string[] = [];
  const kuberTools = exported("kuberTools") as (c: Cell, w: Who, clock?: () => string) => { name: string }[];
  const tools = kuberTools(cell, { tenant: TENANT, book: "acme", principal: OWNER }).map((t) => t.name).filter((n) => n !== "kuber_commit");
  const governance = typeof exported("createGovernance") === "function";
  const reasoner = typeof exported("isReasoner") === "function";
  const kill_switch = typeof (cell.identity as unknown as Record<string, unknown>).copilotHalted === "function";
  let roles_v2 = true;
  const members: [string, string | null][] = [[ROLE_PRINCIPALS.admin, null], [ROLE_PRINCIPALS.customer, "C-ACME"], [ROLE_PRINCIPALS.supplier, "V-CLOUD"]];
  for (const [principal, partyId] of members) {
    try {
      await (cell.identity.addMember as unknown as (t: string, by: string, m: Record<string, unknown>) => Promise<unknown>)(TENANT, "operator:eval", { principal, books: null, ...(partyId ? { partyId } : {}) });
    } catch (e) { roles_v2 = false; notes.push(`role member ${principal} not accepted: ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (!governance) notes.push("no createGovernance export: the copilot runs without the L5 governance layer (ws5/agent-gov)");
  if (!kill_switch) notes.push("no identity.copilotHalted: kill-switch cases are not-yet-available");
  return { tools, governance, reasoner, kill_switch, roles_v2, notes };
}

/** Build the copilot as a deployment would: with the governance layer when the build has one. */
export function makeCopilot(cell: Cell, model: unknown, clock: () => string, caps: Capabilities): CopilotLike {
  const Ctor = exported("Copilot") as new (...args: unknown[]) => CopilotLike;
  let governance: unknown;
  if (caps.governance) {
    const create = exported("createGovernance") as (c: Cell, o: Record<string, unknown>) => unknown;
    // Evaluation turns come fast from one person: lift the rate limits (TOL-07 is tested elsewhere).
    try { governance = create(cell, { limits: { sessionTurnsPerMinute: 1e6, principalTurnsPerHour: 1e6, principalToolCallsPerMinute: 1e6 } }); }
    catch (e) { caps.notes.push(`createGovernance failed, running without it: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return governance === undefined ? new Ctor(cell, model, null, clock) : new Ctor(cell, model, null, clock, governance);
}

/** One turn through the stable entry point, normalised (cards rendered with the exported planText). */
export async function ask(copilot: CopilotLike, who: Who, text: string, history: { role: "user" | "assistant"; text: string }[] = [], sessionId: string | null = null): Promise<Reply> {
  const planText = exported("planText") as (p: unknown) => string;
  const r = await copilot.ask(who, text, history, { sessionId });
  const cards = ((r.cards ?? []) as Record<string, unknown>[]).map((c) => ({
    planId: String(c.planId ?? ""), op: String(c.op ?? ""), kind: c.kind === "write" ? "write" as const : "read" as const,
    bookId: String(c.bookId ?? ""), status: String(c.status ?? ""), blocked: !!c.blocked,
    text: (() => { try { return planText(c); } catch { return JSON.stringify(c); } })(),
  }));
  return {
    reply: String(r.reply ?? ""), cards, trace: (r.trace ?? []) as Reply["trace"], engine: String(r.engine ?? ""),
    ...(typeof r.outcome === "string" ? { outcome: r.outcome } : {}),
    ...(Array.isArray(r.suggestions) ? { suggestions: r.suggestions as string[] } : {}),
  };
}
