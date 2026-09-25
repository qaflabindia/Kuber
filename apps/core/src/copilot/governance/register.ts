/**
 * Tool authorization register (TAGOF TOL-01/02/03, AGT-01/02). The register is control-plane data
 * in `agent/tools.register.json`, locked by hash with the prompts (prompts.ts). Enforcement is here:
 *
 *   - default deny: a tool absent from the register, or present with enabled false, is refused;
 *   - the copilot may run only tools whose reversibility is "none" (reads) or "simulation" (plans):
 *     anything that changes state directly is refused however it is registered (AGT-03, TOL-04);
 *   - the acting person (onBehalfOf) must hold the tool's identity permission within the book, checked
 *     by the identity module's own authorize (the same guard every HTTP route and ops step uses).
 *
 * `authorize` returns a verdict and never throws for a denial.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ACTIONS } from "@kuber/identity";
import type { Reversibility, ToolRegistration, ToolVerdict } from "./contracts.ts";
import { AGENT_DIR } from "./prompts.ts";

const Entry = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  owner: z.string().min(1),
  reversibility: z.enum(["none", "simulation", "reversible", "irreversible"]),
  permission: z.string().refine((p) => (ACTIONS as readonly string[]).includes(p), "not an identity action"),
  dataClasses: z.array(z.enum(["financial", "personal", "counterparty", "policy"])).min(1),
  untrustedOutput: z.boolean(),
  enabled: z.boolean(),
  /** The ops operation behind the tool, when there is one. */
  op: z.string().optional(),
  /** TOL-03: reversibility of what a person's commit of the plan does (the tool itself only simulates). */
  onCommit: z.enum(["reversible", "irreversible"]).optional(),
  note: z.string().optional(),
});
export type RegisterEntry = z.infer<typeof Entry>;
const RegisterFile = z.object({
  version: z.string(), owner: z.string(), approvedBy: z.string(), approvedAt: z.string(), changeNote: z.string(), policy: z.string(),
  tools: z.array(Entry),
});
export type RegisterFile = z.infer<typeof RegisterFile>;

/** Reversibility classes the copilot may execute at all. */
export const COPILOT_EXECUTABLE: ReadonlySet<Reversibility> = new Set(["none", "simulation"]);

export function loadRegister(dir = AGENT_DIR): RegisterFile {
  const r = RegisterFile.parse(JSON.parse(readFileSync(join(dir, "tools.register.json"), "utf8")));
  const dup = r.tools.map((t) => t.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) throw new Error(`tool register lists ${dup.join(", ")} more than once`);
  for (const t of r.tools) {
    if (t.op && t.reversibility === "simulation" && !t.onCommit) throw new Error(`${t.name}: a plan tool needs onCommit (TOL-03)`);
    if (t.reversibility === "none" && t.permission !== "read") throw new Error(`${t.name}: a read tool needs the read permission (least privilege, TOL-02)`);
  }
  return r;
}

export const toRegistration = (e: RegisterEntry): ToolRegistration =>
  ({ name: e.name, owner: e.owner, reversibility: e.reversibility, permission: e.permission, dataClasses: e.dataClasses, untrustedOutput: e.untrustedOutput, enabled: e.enabled });

export type PermissionCheck = (tenant: string, principal: string, action: string, book: string) => Promise<void>;

export class ToolRegister {
  private byName: Map<string, RegisterEntry>;
  constructor(readonly file: RegisterFile) { this.byName = new Map(file.tools.map((t) => [t.name, t])); }

  list(): ToolRegistration[] { return this.file.tools.map(toRegistration); }
  get(name: string): RegisterEntry | undefined { return this.byName.get(name); }
  /** Tool names for ops operations, e.g. kuber_close → close. */
  ops(): string[] { return this.file.tools.filter((t) => t.op).map((t) => t.op!); }

  /** Output is third-party text: registered as such, or an external (ext_*) or unknown tool. */
  untrusted(name: string): boolean { const t = this.byName.get(name); return !t || t.untrustedOutput || name.startsWith("ext_"); }

  /** The register-only part of the verdict (no identity check). */
  admissible(name: string): ToolVerdict & { entry?: RegisterEntry } {
    const t = this.byName.get(name);
    if (!t) return { ok: false, reason: `tool ${name} is not in the tool register (default deny, TOL-01)` };
    if (!t.enabled) return { ok: false, reason: `tool ${name} is registered but disabled for the copilot`, entry: t };
    if (!COPILOT_EXECUTABLE.has(t.reversibility)) return { ok: false, reason: `tool ${name} is ${t.reversibility}; the copilot runs only reads and simulations (AGT-03)`, entry: t };
    return { ok: true, entry: t };
  }

  async authorize(name: string, ctx: { tenant: string; book: string; onBehalfOf: string }, permit: PermissionCheck): Promise<ToolVerdict> {
    const a = this.admissible(name);
    if (!a.ok) return { ok: false, reason: a.reason };
    if (!ctx.onBehalfOf || ctx.onBehalfOf.startsWith("agent:") || ctx.onBehalfOf.startsWith("system:")) {
      return { ok: false, reason: "the copilot acts only on behalf of a signed-in person" };
    }
    try {
      await permit(ctx.tenant, ctx.onBehalfOf, a.entry!.permission, ctx.book);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `${ctx.onBehalfOf} may not use ${name}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
