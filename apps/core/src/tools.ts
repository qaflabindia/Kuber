/**
 * One tool catalogue for every agent surface: the MCP server (external agents such as Claude
 * Desktop) and Kuber's own copilot. Tools are thin: validation, simulation, policy and authority
 * all live in the operations service, so no surface can do more than another.
 */
import { z } from "zod";
import type { Plan } from "@kuber/ops";
import type { Cell } from "./cell.ts";

export interface Who { tenant: string; book: string; principal: string }
export interface ToolResult { text: string; plan?: Plan; data?: unknown; isError?: boolean }
export interface ToolSpec {
  name: string; title: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

const rs = (paise: string | bigint) => {
  const p = BigInt(paise), n = p < 0n ? -p : p;
  return `${p < 0n ? "-" : ""}₹${(n / 100n).toLocaleString("en-IN")}${n % 100n ? "." + String(n % 100n).padStart(2, "0") : ""}`;
};

/** A plan as plain text: what a model (or a person reading a transcript) needs to judge it. */
export function planText(p: Plan): string {
  const out = [`# ${p.title}`, p.summary];
  if (p.kind === "write") out.push(`planId: ${p.planId}\nhash: ${p.hash}\nstatus: ${p.status}${p.blocked ? " (BLOCKED)" : ""} · commit by: ${p.needsPerson ? "a person in Kuber" : "you (policy allows)"}`);
  if (p.policy) out.push(`Policy ${p.policy.ids.join(", ")} → ${p.policy.level}, approver ${p.policy.approver}${p.policy.reasons.length ? ` (${p.policy.reasons.join("; ")})` : ""}`);
  if (p.checks.length) out.push("Checks:\n" + p.checks.map((c) => `- [${c.ok ? "x" : " "}] ${c.label}${c.detail ? `: ${c.detail}` : ""}${!c.ok && c.blocking ? " (blocking)" : ""}`).join("\n"));
  if (p.journals.length) out.push("Journals:\n" + p.journals.map((j) => `- ${j.txnDate} ${j.narration} [${j.voucherType}]\n` +
    j.lines.map((l) => `    ${l.accountId.padEnd(10)} ${BigInt(l.amount) > 0n ? "Dr" : "Cr"} ${rs(BigInt(l.amount) < 0n ? -BigInt(l.amount) : BigInt(l.amount))}${l.dimensions ? " " + JSON.stringify(l.dimensions) : ""}`).join("\n")).join("\n"));
  if (p.effects.length) out.push("Effect on balances:\n" + p.effects.map((e) => `- ${e.name}: ${rs(e.before)} → ${rs(e.after)}`).join("\n"));
  for (const s of p.sections) {
    const fmt = (v: unknown, i: number) => (s.money?.includes(i) && typeof v === "string" && /^-?\d+$/.test(v) ? rs(v) : String(v ?? ""));
    out.push(`${s.title}:\n` + (s.columns ? `| ${s.columns.join(" | ")} |\n` : "") + s.rows.map((r) => (s.kind === "kv" ? `- ${r[0]}: ${fmt(r[1], 1)}` : `| ${r.map(fmt).join(" | ")} |`)).join("\n"));
  }
  if (p.notes.length) out.push(p.notes.join("\n"));
  return out.join("\n\n");
}

const WRITE_SUFFIX = " Returns a simulation (plan) with planId and hash; nothing changes until kuber_commit is called with both. If the plan says a person must commit, tell the user it is waiting for their approval in Kuber.";

export function kuberTools(cell: Cell, who: Who): ToolSpec[] {
  const ops: ToolSpec[] = cell.ops.list().map((o) => {
    const def = cell.ops.defs.get(o.name)!;
    return {
      name: `kuber_${o.name}`, title: o.title, readOnly: o.kind === "read",
      description: o.description + (o.kind === "write" ? WRITE_SUFFIX : "") + (o.gate === "human" ? " Always needs a person's approval." : ""),
      inputSchema: z.toJSONSchema(def.input as z.ZodType, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
      async run(args) {
        const p = await cell.ops.plan(who.tenant, who.book, who.principal, o.name, args);
        return { text: planText(p), plan: p };
      },
    };
  });
  return [
    {
      name: "kuber_accounts", title: "List accounts", readOnly: true,
      description: "The chart of accounts with ids, names, natures and current balances. Use the ids in other tools.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        const a = await cell.reporting.accounts(who.tenant, who.book) as unknown as { account_id: string; name: string; nature: string; balance: string }[];
        return { text: a.map((x) => `${x.account_id} · ${x.name} · ${x.nature} · ${rs(["asset", "expense"].includes(x.nature) ? x.balance : (-BigInt(x.balance)).toString())}`).join("\n"), data: a };
      },
    },
    ...ops,
    {
      name: "kuber_commit", title: "Commit a plan", readOnly: false,
      description: "Execute a plan exactly as simulated. Needs the planId and hash from the plan. Refused if the books changed since (simulate again) or if a person must approve it.",
      inputSchema: { type: "object", properties: { planId: { type: "string" }, hash: { type: "string" } }, required: ["planId", "hash"] },
      async run(args) {
        const b = z.object({ planId: z.string(), hash: z.string() }).parse(args);
        const r = await cell.ops.commit(who.tenant, b.planId, who.principal, b.hash);
        return { text: r.status === "committed" ? `Committed: ${r.steps.join(", ")}` : r.message, data: r };
      },
    },
    {
      name: "kuber_plans", title: "Open plans", readOnly: true,
      description: "Plans proposed but not yet committed or discarded, newest first.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        const ps = await cell.ops.pending(who.tenant, who.book);
        return { text: ps.length ? ps.map((p) => `- ${p.planId} · ${p.title} · ${p.needsPerson ? "needs a person" : "committable"}${p.blocked ? " · blocked" : ""}`).join("\n") : "No open plans.", data: ps };
      },
    },
  ];
}
