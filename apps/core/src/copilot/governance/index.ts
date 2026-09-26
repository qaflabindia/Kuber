/**
 * The copilot's governance layer (AAWDS L5; TAGOF Domains 4, 6, 10, 12, 14, 15). The agent core calls
 * it at the layer boundaries named in contracts.ts; governance constrains what the agent may emit or
 * execute, never what it considers (AAWDF §3.7).
 *
 *   register        tool authorization register, default deny           register.ts   TOL-01/02/03, AGT-01/02
 *   screenInput     length, empty, scope, injection library              screening.ts  PRM-04/06/07
 *   authorizeTool   register + person's permission + copilot halt + rate  register.ts   TOL-01/04, AGT-01/03, TOL-07
 *   screenToolOutput  indirect injection in third-party text             screening.ts  PRM-08
 *   checkGrounding  every ₹ figure and % traced to tool outputs          grounding.ts  GEN-01
 *   prompt          approved, hash-locked system prompts (and artifacts)  prompts.ts    PRM-01..03
 *   halted          the copilot kill switch (scope "copilot")            identity      AGT-09
 *   record          sealed turn record + index                           recorder.ts   TOL-05, AGT-07, Domain 14
 *
 * Extras the core may use beyond the contract: renderPrompt, artifact, admitTurn (TOL-07 before a
 * turn), turns/turnEvent/stats (query and monitoring), processing (Domain 12 gate state).
 */
import type { Cell } from "../../cell.ts";
import type { Action } from "@kuber/identity";
import type { Governance, InputVerdict, ScreenedOutput, ToolRegistration, ToolVerdict, TurnRecord, GroundingResult } from "./contracts.ts";
import { checkGrounding } from "./grounding.ts";
import { AGENT_DIR, PromptRegistry, type ArtifactVersion, type PromptVersion } from "./prompts.ts";
import { processingFromEnv, type ProcessingCheck } from "./processing.ts";
import { DEFAULT_LIMITS, RateLimiter, TurnRecorder, type AgentPeriodStats, type RateLimits, type TurnRow } from "./recorder.ts";
import { ToolRegister, loadRegister } from "./register.ts";
import { MAX_INPUT_CHARS, loadPatterns, screenInput, screenToolOutput, type PatternLibrary } from "./screening.ts";

export type * from "./contracts.ts";
export { checkGrounding, extractFigures } from "./grounding.ts";
export { AGENT_DIR, PromptRegistry, RegistryError, checkLock, computeLock, writeLock } from "./prompts.ts";
export { PROCESSING_ENV, PROCESSING_HEADER, ProcessingNotApproved, middlewareHeaders, parseProcessingApproval, processingFromEnv, requireProcessingApproval } from "./processing.ts";
export { AGENT_GOVERNANCE_MIGRATIONS, DEFAULT_LIMITS, RateLimiter, TurnRecorder, turnStream, type AgentPeriodStats, type RateLimits, type TurnRow } from "./recorder.ts";
export { COPILOT_EXECUTABLE, ToolRegister, loadRegister } from "./register.ts";
export { DATA_CLOSE, DATA_OPEN, MAX_INPUT_CHARS, REDIRECT, classifyScope, digitRuns, loadPatterns } from "./screening.ts";

/** Flag the core puts on a ToolCallRecord for a tool authorizeTool refused (counted as a tool denial). */
export const deniedFlag = (reason: string) => `denied:${reason.slice(0, 180)}`;

export interface GovernanceOptions {
  /** The control-plane directory (prompts, register, patterns, lock). Default: the repository's agent/. */
  dir?: string;
  limits?: Partial<RateLimits>;
  maxInputChars?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface KuberGovernance extends Governance {
  renderPrompt(id: string, vars: { today: string; tenant: string; book: string }): PromptVersion;
  artifact(id: string): ArtifactVersion;
  /** TOL-07: call before starting a turn; a refusal is a turn with outcome "refused". */
  admitTurn(ctx: { tenant: string; sessionId: string | null; onBehalfOf: string }): { ok: boolean; reason?: string };
  /** record() with the DSPy artifacts / routing policies the turn ran with. */
  recordWith(turn: TurnRecord, artifacts: { id: string; version: string; hash: string }[]): Promise<void>;
  turns(tenant: string, q?: { book?: string; since?: string; limit?: number; before?: string }): Promise<{ turns: TurnRow[]; next: string | null }>;
  turnEvent(tenant: string, turnId: string): ReturnType<TurnRecorder["event"]>;
  stats(tenant: string, q?: { since?: string; book?: string }): Promise<AgentPeriodStats[]>;
  processing(): ProcessingCheck;
  readonly registry: PromptRegistry;
  readonly tools: ToolRegister;
  readonly patterns: PatternLibrary;
}

export function createGovernance(cell: Cell, opts: GovernanceOptions = {}): KuberGovernance {
  const dir = opts.dir ?? AGENT_DIR;
  const registry = new PromptRegistry(dir);            // refuses to load anything not in the lock
  const tools = new ToolRegister(loadRegister(dir));
  const patterns = loadPatterns(dir);
  const limiter = new RateLimiter({ ...DEFAULT_LIMITS, ...opts.limits }, opts.now);
  const recorder = new TurnRecorder(cell.store, tools, limiter);
  const permit = async (tenant: string, principal: string, action: string, book: string) => {
    await cell.identity.authorize(tenant, principal, action as Action, { book });
  };

  return {
    registry, tools, patterns,
    register(): ToolRegistration[] { return tools.list(); },
    screenInput(text: string): InputVerdict { return screenInput(patterns, text, opts.maxInputChars ?? MAX_INPUT_CHARS); },

    async authorizeTool(tool, ctx): Promise<ToolVerdict> {
      const deny = (reason: string, rate = false): ToolVerdict => { recorder.noteDenial(ctx, rate); return { ok: false, reason }; };
      try {
        const a = tools.admissible(tool);
        if (!a.ok) return deny(a.reason!);
        // AGT-09: while the copilot is halted, only reads run (the core answers read-only or by rules).
        if (a.entry!.reversibility !== "none" && await cell.identity.copilotHalted(ctx.tenant, ctx.book)) return deny("the copilot is halted for this book: read-only answers only");
        const v = await tools.authorize(tool, ctx, permit);
        if (!v.ok) return deny(v.reason!);
        const r = limiter.toolCall(ctx);
        if (!r.ok) return deny(r.reason!, true);
        return { ok: true };
      } catch (e) {
        return deny(`authorization failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    screenToolOutput(tool: string, text: string): ScreenedOutput { return screenToolOutput(patterns, text, tools.untrusted(tool)); },
    checkGrounding(reply: string, toolOutputs: string[]): GroundingResult { return checkGrounding(reply, toolOutputs); },
    prompt(id: string) { const p = registry.prompt(id); return { id: p.id, version: p.version, hash: p.hash, text: p.text }; },
    renderPrompt: (id, vars) => registry.render(id, vars),
    artifact: (id) => registry.artifact(id),
    halted: (tenant, book) => cell.identity.copilotHalted(tenant, book),
    admitTurn: (ctx) => limiter.admitTurn(ctx),
    record: (turn) => recorder.record(turn),
    recordWith: (turn, artifacts) => recorder.record(turn, artifacts),
    turns: (tenant, q) => recorder.query(tenant, q),
    turnEvent: (tenant, turnId) => recorder.event(tenant, turnId),
    stats: (tenant, q) => recorder.stats(tenant, q),
    processing: () => processingFromEnv(opts.env ?? process.env),
  };
}
