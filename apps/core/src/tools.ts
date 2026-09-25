/**
 * One tool catalogue for every agent surface: the MCP server (external agents such as Claude
 * Desktop) and Kuber's own copilot. Tools are thin: validation, simulation, policy and authority
 * all live in the operations service, so no surface can do more than another.
 */
import { z } from "zod";
import type { Plan } from "@kuber/ops";
import type { Cell } from "./cell.ts";
import { planText, readGuard, readTools, rs } from "./agent-tools.ts";

/** Who a tool acts as. `book` bounds every call (an MCP grant is for one book); `onBehalfOf` is the person the copilot works for. */
export interface Who { tenant: string; book: string; principal: string; onBehalfOf?: string }
/** `summary`: one grounded line (figures exactly as in `text`), used for rules answers and grounded fallbacks. */
export interface ToolResult { text: string; plan?: Plan; data?: unknown; isError?: boolean; summary?: string }
export interface ToolSpec {
  name: string; title: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

export { planText, rs } from "./agent-tools.ts";

const WRITE_SUFFIX = " Returns a simulation (plan) with planId and hash; nothing changes until kuber_commit is called with both. If the plan says a person must commit, tell the user it is waiting for their approval in Kuber.";

export function kuberTools(cell: Cell, who: Who, clock?: () => string): ToolSpec[] {
  const ops: ToolSpec[] = cell.ops.list().map((o) => {
    const def = cell.ops.defs.get(o.name)!;
    return {
      name: `kuber_${o.name}`, title: o.title, readOnly: o.kind === "read",
      description: o.description + (o.kind === "write" ? WRITE_SUFFIX : "") + (o.gate === "human" ? " Always needs a person's approval." : ""),
      inputSchema: z.toJSONSchema(def.input as z.ZodType, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
      async run(args) {
        const p = await cell.ops.plan(who.tenant, who.book, who.principal, o.name, args, { onBehalfOf: who.onBehalfOf });
        return { text: planText(p), plan: p, summary: `${p.title}: ${p.summary}` };
      },
    };
  });
  return [
    {
      name: "kuber_accounts", title: "List accounts", readOnly: true,
      description: "The chart of accounts with ids, names, natures and current balances. Use the ids in other tools.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        await readGuard(cell, who, "kuber_accounts");
        const a = await cell.reporting.accounts(who.tenant, who.book) as unknown as { account_id: string; name: string; nature: string; balance: string }[];
        return { text: a.map((x) => `${x.account_id} · ${x.name} · ${x.nature} · ${rs(["asset", "expense"].includes(x.nature) ? x.balance : (-BigInt(x.balance)).toString())}`).join("\n"), data: a };
      },
    },
    ...readTools(cell, who, clock),
    ...ops,
    {
      name: "kuber_commit", title: "Commit a plan", readOnly: false,
      description: "Execute a plan exactly as simulated. Needs the planId and hash from the plan. Refused if the books changed since (simulate again) or if a person must approve it.",
      inputSchema: { type: "object", properties: { planId: { type: "string" }, hash: { type: "string" } }, required: ["planId", "hash"] },
      async run(args) {
        const b = z.object({ planId: z.string(), hash: z.string() }).parse(args);
        // A grant is for one book: a plan of another book is refused even with its id and hash (A12).
        const p = await cell.ops.get(who.tenant, b.planId);
        if (p.bookId !== who.book) throw new Error(`plan ${b.planId} is not in book ${who.book}`);
        const r = await cell.ops.commit(who.tenant, b.planId, who.principal, b.hash);
        return { text: r.status === "committed" ? `Committed: ${r.steps.join(", ")}` : r.message, data: r };
      },
    },
    {
      name: "kuber_plans", title: "Open plans", readOnly: true,
      description: "Plans proposed but not yet committed or discarded, newest first.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        await readGuard(cell, who, "kuber_plans");
        const ps = await cell.ops.pending(who.tenant, who.book);
        return { text: ps.length ? ps.map((p) => `- ${p.planId} · ${p.title} · ${p.needsPerson ? "needs a person" : "committable"}${p.blocked ? " · blocked" : ""}`).join("\n") : "No open plans.", data: ps };
      },
    },
  ];
}
