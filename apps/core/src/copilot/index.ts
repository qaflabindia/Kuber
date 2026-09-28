/**
 * The copilot: answers from the books and turns a person's instruction into operation plans shown
 * as cards. AAWDS specification (design section 2):
 *
 *   E   trigger sync (one chat request per turn); adaptation: session memory only. History comes
 *       from the client, capped here at the last 8 messages (user and assistant only, oldest first);
 *       the server keeps no conversation. History is context for the model, never grounds: figures
 *       in it are not evidence (GEN-01 grounds only on this turn's tool outputs), a plan it names is
 *       simulated again, and a standing rule stated in chat becomes a governed proposal instead of
 *       being remembered (context integrity).
 *   L1  tools only (agent-tools.ts read tools, the ops catalogue as plan tools); no code execution.
 *       kuber_commit is never offered: writes are plans a person approves on the canvas.
 *   L3  mixed: the deterministic router (router.ts) is the static fast path; only when it cannot
 *       resolve does a bounded model loop run (at most 8 steps, a per-turn timeout, tools allowed
 *       only if the governance register admits them).
 *   L2  reactive (ReAct) inside that loop, through the Reasoner interface (never a model directly).
 *   L4  n = 1.
 *   L5  the Governance interface at every boundary: halted (AGT-09, first), admitTurn (TOL-07),
 *       screenInput (PRM-04/06), authorizeTool (TOL-01/04, AGT-01/03) before every tool call,
 *       screenToolOutput (PRM-08) before the model sees an output, checkGrounding (GEN-01) on the
 *       reply, record (TOL-05, AGT-07) for every turn on both paths, prompt (PRM-01..03).
 *
 * The copilot never acts as the person: it prepares plans as agent:copilot on their behalf, within
 * their role and book scope, and the person (or another approver) commits them.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Plan } from "@kuber/ops";
import { COPILOT } from "@kuber/identity";
import type { Cell } from "../cell.ts";
import { readGuard } from "../agent-tools.ts";
import { kuberTools, type ToolResult, type ToolSpec, type Who } from "../tools.ts";
import type { ExternalTools } from "./external.ts";
import type { LlmProvider } from "./provider.ts";
import { HELP, ROUTER_VERSION, helpText, route, type AccountRef, type Routed, type StandingRule } from "./router.ts";
import { isReasoner, llmReasoner, type Reasoner, type ReasonerPrompt, type ReasonerStep } from "./reasoner-types.ts";
import type { GroundingResult, InputVerdict, Reversibility, ToolCallRecord, TurnRecord } from "./governance/contracts.ts";
import { createStubGovernance, deniedFlag, type CoreGovernance } from "./governance/stub.ts";
import { checkCompleteness, extractFigures, toolValues } from "./governance/grounding.ts";

export interface CopilotReply {
  reply: string; cards: Plan[]; suggestions?: string[]; engine: string; trace: { tool: string; ok: boolean }[];
  /** Tools whose output the answer is built from ("Answered from: …"). */
  answeredFrom: string[];
  outcome: TurnRecord["outcome"];
  turnId: string;
}
export interface HistoryItem { role: "user" | "assistant"; text: string }
export interface CopilotOptions { maxSteps?: number; turnTimeoutMs?: number }

export const MAX_STEPS = 8;
export const TURN_TIMEOUT_MS = 45_000;
const HISTORY_MAX = 8, HISTORY_CHARS = 4000, OUTPUT_CHARS = 30_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const HALTED = "The copilot is halted for this book, so I can answer questions from the books but not prepare changes. A person with authority can resume it.";
const UNVERIFIED = "Some figures in the drafted answer could not be verified against the books, so this answer shows only what the tools returned.";
const PARTIAL_TOTAL = "The drafted answer presented a figure from a partial result as a total, so this answer shows only what the tools returned.";
const NO_MEMORY = "I don't keep rules or preferences from our conversation. To make that a standing rule, say it as one (for example \"Always book Swiggy to STAFFWELF\" or \"From now on, payments above 50,000 need my approval\") and I'll prepare it as a proposal for approval.";
const ASSERTED = "The figure you mentioned is not what the books show; the figures above are from the books as they are now.";
const PLAN_NOT_FOUND = "I can't find the plan mentioned earlier in this book, so I won't rely on what the conversation says about it. What would you like me to simulate against the current books?";

// ---------------------------------------------------------------- context integrity
/** The reply claims to remember something for later: the copilot keeps no memory, and standing rules are proposals. */
const MEMORY_CLAIM = /\b(I(?:'| wi)ll (?:remember|keep (?:that|this|it) in mind|note (?:that|this)|do (?:that|this|so) from now on|always (?:do|book|post|classify|use|treat))|noted for (?:the )?future|(?:got it|noted|understood|okay|ok)[,.!]?\s+(?:from now on|going forward|next time)|I(?:'ve| have) (?:noted|saved|remembered|stored) (?:that|this|it))\b/i;
/** The person refers to a plan from earlier in the conversation. */
const PLAN_REF = /\b(?:that|the|this|same|previous|earlier|above|last|your) plan\b|\bplan (?:above|from before|you (?:made|prepared|showed))\b|^\s*(?:ok(?:ay)?|yes|sure|fine)?[,.!\s]*(?:go ahead|proceed|do it|approve it|commit it|confirm(?: it)?)\b/i;
const PLAN_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** A question about a figure the person states ("my cash is 6 lakh, right?"). */
const ASKING = /\?\s*$|^(?:what|how|is|are|do|does|did|can|could|show|tell)\b|\b(?:right|correct|isn't it|is that right)\s*[?.!]*\s*$/i;
/** The most recent plan id the conversation mentions (newest message first). */
const historyPlanId = (hist: HistoryItem[]) => { for (const h of [...hist].reverse()) { const ids = h.text.match(PLAN_ID); if (ids?.length) return ids.at(-1)!.toLowerCase(); } return null; };
const POLICY_ID = /\bPOL-\d{3}\b/g;

/**
 * Stored controls are cited when they act (unretrieved context): a blocked plan names what blocks
 * it and the policies involved; a plan held for a person names the policy, its approver and reasons.
 */
export function policyCitation(writes: Plan[]): string {
  const blocked = writes.filter((w) => w.blocked);
  if (blocked.length) {
    const failing = blocked.flatMap((w) => w.checks.filter((c) => c.blocking && !c.ok));
    const ids = [...new Set(failing.flatMap((c) => `${c.label} ${c.detail ?? ""}`.match(POLICY_ID) ?? []))];
    const gov = [...new Set(blocked.flatMap((w) => w.policy?.ids ?? []))].filter((x) => !ids.includes(x));
    return `Blocked by: ${failing.map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}.${ids.length ? ` Policy: ${ids.join(", ")}.` : ""}${gov.length ? ` Governing policy for this operation: ${gov.join(", ")}.` : ""}`;
  }
  const held = writes.filter((w) => w.needsPerson && w.policy);
  if (!held.length) return "";
  return held.map((w) => `Policy ${w.policy!.ids.join(", ")} (${w.policy!.level}) requires approval by ${w.policy!.approver}${w.policy!.reasons.length ? `: ${w.policy!.reasons.join("; ")}` : ""}.`)
    .filter((x, i, a) => a.indexOf(x) === i).join(" ");
}

class TimedOut extends Error { constructor() { super("turn timed out"); } }
const within = <T>(p: Promise<T>, deadline: number): Promise<T> => {
  const ms = deadline - Date.now();
  if (ms <= 0) return Promise.reject(new TimedOut());
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new TimedOut()), ms); })]).finally(() => clearTimeout(timer));
};

/** What one turn accumulates for its reply and its record. */
interface TurnState {
  tools: ToolCallRecord[]; outputs: string[]; results: { tool: string; result: ToolResult }[]; question: string; tainted: boolean;
  cards: Plan[]; trace: { tool: string; ok: boolean }[];
}
const newTurn = (question = ""): TurnState => ({ tools: [], outputs: [], results: [], cards: [], trace: [], question, tainted: false });
/**
 * PRM-08 / finding AE-01: after a tool output carried instruction-like text, the model may not
 * propose a change the person did not ask for in this turn. "Asked" means the person's own words name
 * a write action; text inside tool outputs never counts.
 */
const WRITE_ASKED = /\b(record|post|approve|reconcile|allocate|rebalance|close|carry\s*forward|pay|paid|received|resolve|reclass\w*|schedule|accrue|prepa(?:y|id)|eliminat\w*|consolidat\w*|certify|adjust|move|transfer|split)\b/i;

export class Copilot {
  readonly reasoner: Reasoner | null;
  readonly governance: CoreGovernance;
  private maxSteps: number;
  private timeoutMs: number;

  /**
   * `reasoner`: a Reasoner (middleware by default in production), a legacy LlmProvider (adapted), or
   * null for rules only. `governance`: the L5 layer; a local stub when absent (see governance/stub.ts).
   */
  constructor(private cell: Cell, reasoner: Reasoner | LlmProvider | null, private external: ExternalTools | null, private clock: () => string,
              governance?: CoreGovernance, opts: CopilotOptions = {}) {
    this.reasoner = reasoner ? (isReasoner(reasoner) ? reasoner : llmReasoner(reasoner)) : null;
    this.governance = governance ?? createStubGovernance(cell);
    this.maxSteps = Math.min(Math.max(opts.maxSteps ?? MAX_STEPS, 1), MAX_STEPS);
    this.timeoutMs = opts.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  }

  get engine() { return this.reasoner?.name ?? "rules"; }

  async ask(who: Who, text: string, history: HistoryItem[] = [], opts: { sessionId?: string | null } = {}): Promise<CopilotReply> {
    const t0 = Date.now(), turnId = randomUUID(), gov = this.governance;
    const person = who.principal;
    const agentWho: Who = { ...who, principal: COPILOT, onBehalfOf: person };
    // Only user and assistant messages, the most recent HISTORY_MAX, in their original (oldest first) order.
    const hist: HistoryItem[] = (Array.isArray(history) ? history : []).filter((h) => h && (h.role === "user" || h.role === "assistant"))
      .slice(-HISTORY_MAX).map((h) => ({ role: h.role, text: String(h.text ?? "").slice(0, HISTORY_CHARS) }));
    const turn = newTurn(text);
    let input: InputVerdict = { ok: false, category: "empty" };
    let engine = "rules", steps = 0;
    let promptMeta = { id: "router", version: ROUTER_VERSION, hash: sha(`kuber-router@${ROUTER_VERSION}`) };
    let grounding: GroundingResult = { ok: true, ungrounded: [] };

    const finish = async (reply: string, outcome: TurnRecord["outcome"], extra: { suggestions?: string[] } = {}): Promise<CopilotReply> => {
      const latest = new Map<string, Plan>();                     // superseded simulations of the same operation: keep the latest
      for (const c of turn.cards) latest.set(c.op + (c.kind === "read" ? "" : c.planId), c);
      const answeredFrom = [...new Set(turn.results.filter((r) => !r.result.isError).map((r) => r.tool))];
      const record: TurnRecord = {
        turnId, sessionId: opts.sessionId ?? null, tenant: who.tenant, book: who.book, principal: COPILOT, onBehalfOf: person, engine,
        promptId: promptMeta.id, promptVersion: promptMeta.version, promptHash: promptMeta.hash,
        input, inputHash: sha(text), tools: turn.tools, planIds: turn.tools.map((t) => t.planId).filter((x): x is string => !!x),
        grounding, outcome, steps, ms: Date.now() - t0,
      };
      const artifacts = this.reasoner?.artifacts?.() ?? [];
      await (artifacts.length && gov.recordWith ? gov.recordWith(record, artifacts) : gov.record(record));
      return { reply, cards: [...latest.values()], engine, trace: turn.trace, answeredFrom, outcome, turnId, ...extra };
    };

    // AGT-09 first: while halted, reads are answered from rules and writes refused.
    const halted = await gov.halted(who.tenant, who.book);
    const admit = gov.admitTurn?.({ tenant: who.tenant, sessionId: opts.sessionId ?? null, onBehalfOf: person }) ?? { ok: true };
    input = gov.screenInput(text);
    if (!admit.ok) return finish(admit.reason ?? "Too many requests; wait a moment and try again.", "refused");
    if (!input.ok) return finish(input.reason ?? "I can only help with your books in Kuber.", "refused", { suggestions: HELP });

    // Route on the chart the person may read (the read guard runs before the chart is loaded).
    let accounts: AccountRef[], fyStartMonth = 4;
    try {
      await readGuard(this.cell, agentWho, "kuber_chart_of_accounts");
      const s = await this.cell.gl.state(who.tenant, who.book);
      accounts = [...s.accounts.values()].map((a) => ({ id: a.accountId, name: a.name, nature: a.nature, cash: a.isCashLike }));
      fyStartMonth = s.config?.fiscalYearStartMonth ?? 4;
    } catch (e) { return finish(`I can't read this book for you: ${errText(e)}`, "refused"); }
    const r = route(text, this.clock(), accounts, { fyStartMonth });
    const rulesDone = (reply: string, outcome: TurnRecord["outcome"], extra: { suggestions?: string[] } = {}) => {
      const post = this.contextChecks(reply, turn, text, "rules");
      grounding = gov.checkGrounding(post.reply, turn.outputs);
      if (post.partialTotals.length) grounding = { ok: false, ungrounded: [...grounding.ungrounded, ...post.partialTotals.map((x) => `${x} (partial total)`)], partialTotals: post.partialTotals };
      return finish(post.reply, outcome, extra);
    };

    // Competing context: a plan the conversation names is simulated again against the current books, never trusted from history.
    const planRef = PLAN_REF.test(text) ? historyPlanId(hist) : null;
    if (planRef) {
      if (halted) return finish(HALTED, "halted");
      return this.fromHistoryPlan(planRef, who, agentWho, turn, rulesDone);
    }

    if (halted) {
      const writes = r.kind === "chat" || r.kind === "standing_rule" || (r.kind === "op" && r.intents.some((i) => this.cell.ops.defs.get(i.op as never)?.kind === "write"));
      if (writes) return finish(HALTED, "halted");
      if (r.kind === "help" && r.reason === "unrecognised") return finish(`${HALTED} Ask a question the built-in rules answer, for example "Sales this month" or "Trial balance".`, "halted", { suggestions: HELP });
    }
    if (r.kind !== "help" || r.reason === "asked" || !this.reasoner || halted) return this.withRules(r, who, agentWho, turn, rulesDone);

    // ------------------------------------------------ bounded model loop (router could not resolve)
    engine = this.reasoner.name;
    const vars = { today: this.clock(), tenant: who.tenant, book: who.book };
    let system: ReasonerPrompt;
    try {
      system = gov.renderPrompt?.("copilot.system", vars) ?? (() => { const p = gov.prompt("copilot.system"); return { ...p, text: p.text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => (vars as Record<string, string>)[k] ?? "") }; })();
    } catch (e) { return finish(`The copilot's instructions are not approved for use, so I can only answer from rules. ${helpText("Try:")}`, "error", { suggestions: HELP }); }
    promptMeta = { id: system.id, version: system.version, hash: system.hash };
    const allowed = new Set(gov.register().filter((g) => g.enabled && (g.reversibility === "none" || g.reversibility === "simulation")).map((g) => g.name));
    const catalogue: ToolSpec[] = [...kuberTools(this.cell, agentWho, this.clock), ...(await this.external?.tools() ?? [])];
    const tools = catalogue.filter((t) => t.name !== "kuber_commit" && allowed.has(t.name));
    const deadline = t0 + this.timeoutMs;
    const stepsDone: ReasonerStep[] = [];
    const base = { turnId, system, question: text, history: hist, context: vars };
    let draft: string | undefined, stopped: string | undefined;
    try {
      for (let i = 0; i < this.maxSteps; i++) {
        const next = await within(this.reasoner.nextStep({ ...base, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), steps: stepsDone, remaining: this.maxSteps - i }), deadline);
        steps++;
        if (next.action === "final") { draft = next.draft; break; }
        const res = await this.call(turn, agentWho, person, tools.find((t) => t.name === next.tool), next.tool, next.args ?? {});
        stepsDone.push({ tool: next.tool, args: next.args ?? {}, output: res.text.slice(0, OUTPUT_CHARS), ok: res.ok });
      }
      if (draft === undefined) stopped = "step_limit";
    } catch (e) {
      if (!(e instanceof TimedOut)) return finish(`The reasoning service failed (${errText(e)}). ${this.grounded(turn) || helpText("Here is what I can answer from rules:")}`, "error", { suggestions: HELP });
      stopped = "timeout";
    }
    let reply = "";
    if (stopped === "timeout") reply = `${this.grounded(turn) || "I ran out of time before finding an answer."}${turn.results.length ? "\n\nI ran out of time before finishing; this is what the books showed so far." : ""}`;
    else {
      try { reply = (await within(this.reasoner.compose({ ...base, steps: stepsDone, ...(draft !== undefined ? { draft } : {}), ...(stopped ? { stopped } : {}) }), deadline)).reply?.trim() || draft || ""; }
      catch (e) { reply = this.grounded(turn) || `I couldn't compose an answer (${errText(e)}).`; }
      if (!reply) reply = this.grounded(turn) || "I couldn't find an answer in the books for that.";
    }
    // GEN-01: every figure must trace to a tool output; otherwise show only what the tools returned.
    grounding = gov.checkGrounding(reply, turn.outputs);
    let outcome: TurnRecord["outcome"] = "answered";
    if (!grounding.ok) {
      const summary = this.grounded(turn);
      reply = summary ? `${summary}\n\n${UNVERIFIED}` : `I couldn't verify the figures in that answer against your books, so I won't state them. Ask for a specific report, for example "Profit and loss this year".`;
      outcome = summary ? "answered" : "error";
    }
    // Context integrity: no memory claims, no partial result presented as a total, partial views and acting policies named.
    const post = this.contextChecks(reply, turn, text, "model");
    if (post.partialTotals.length) grounding = { ok: false, ungrounded: [...grounding.ungrounded, ...post.partialTotals.map((x) => `${x} (partial total)`)], partialTotals: post.partialTotals };
    return finish(post.reply, outcome);
  }

  /** A reply built only from tool summaries (figures exactly as the tools returned them), with any partial view named. */
  private grounded(turn: TurnState): string {
    const lines = [...new Set(turn.results.filter((r) => !r.result.isError).map((r) => r.result.summary ?? r.result.text.split("\n").slice(0, 2).join(" ")))];
    return lines.length ? [...lines, ...this.fragmentNotes(turn)].join("\n") : "";
  }

  /** The sentences naming every partial result this turn used ("Showing 6 of 14 accounts ..."). */
  private fragmentNotes(turn: TurnState): string[] {
    return [...new Set(turn.results.filter((r) => !r.result.isError && r.result.completenessNote).map((r) => r.result.completenessNote!))];
  }

  /**
   * Context integrity on a drafted reply (both paths):
   *   uncaptured   a model reply that claims to remember a rule is replaced (rules become proposals);
   *   fragment     a figure presented as a total that only a partial result grounds is refused, and
   *                every partial result used is named in the reply;
   *   competing    a figure the person asserts that the books do not show is called out;
   *   unretrieved  the policies and checks that block or hold a plan are cited.
   */
  private contextChecks(draft: string, turn: TurnState, question: string, path: "rules" | "model"): { reply: string; partialTotals: string[] } {
    let reply = draft;
    const proposals = turn.cards.some((c) => c.op === "propose_rule" || c.op === "propose_policy_change");
    if (path === "model" && MEMORY_CLAIM.test(reply) && !proposals) {
      const summary = this.grounded(turn);
      reply = summary ? `${summary}\n\n${NO_MEMORY}` : NO_MEMORY;
    }
    const frag = checkCompleteness(reply, turn.results.filter((r) => !r.result.isError).map((r) => ({ text: r.result.text, completeness: r.result.completeness, scopeTotals: r.result.scopeTotals })));
    if (!frag.ok) { const summary = this.grounded(turn); reply = summary ? `${summary}\n\n${PARTIAL_TOTAL}` : PARTIAL_TOTAL; }
    const low = reply.toLowerCase();
    const notes = this.fragmentNotes(turn).filter((n) => !low.includes(n.toLowerCase().split(" (")[0]!.split(";")[0]!));
    if (notes.length) reply = `${reply}\n${notes.join("\n")}`;
    const writes = turn.cards.filter((c) => c.kind === "write");
    const cite = policyCitation(writes);
    if (cite && ((cite.match(POLICY_ID) ?? []).some((id) => !reply.includes(id)) || (writes.some((w) => w.blocked) && !reply.includes("Blocked by")))) reply = `${reply} ${cite}`;
    // A figure the person states ("my cash is 6 lakh, right?") is a claim, not evidence: say when the books show otherwise.
    if (ASKING.test(question.trim()) && turn.results.some((r) => !r.result.isError)) {
      const vals = toolValues(turn.outputs);
      const claimed = extractFigures(question).filter((f) => f.kind === "money" && !vals.money.has(f.value));
      if (claimed.length && !reply.includes(ASSERTED)) reply = `${reply}\n${ASSERTED}`;
    }
    return { reply, partialTotals: frag.partialTotals };
  }

  /** A plan named in the conversation: looked up in this book and simulated again against the current books (never trusted from history). */
  private async fromHistoryPlan(planId: string, who: Who, agentWho: Who, turn: TurnState,
                                done: (reply: string, outcome: TurnRecord["outcome"], extra?: { suggestions?: string[] }) => Promise<CopilotReply>): Promise<CopilotReply> {
    let p: Plan | null = null;
    try { await readGuard(this.cell, agentWho, "kuber_plans"); p = await this.cell.ops.get(who.tenant, planId); } catch { p = null; }
    if (!p || p.bookId !== who.book) return done(PLAN_NOT_FOUND, "answered");
    if (p.status === "committed" || p.status === "discarded") return done(`The plan mentioned earlier is already ${p.status}, so there is nothing to approve. What would you like me to simulate against the current books?`, "answered");
    if (!p.input) return done("The plan mentioned earlier was made before Kuber kept plan inputs, so I can't simulate it again from the conversation. What would you like me to simulate against the current books?", "answered");
    const cur = await this.cell.gl.state(who.tenant, who.book);
    const changed = p.status === "stale" || p.basisVersion === undefined || p.basisVersion !== cur.version;
    const name = `kuber_${p.op}`;
    const res = await this.call(turn, agentWho, who.principal, kuberTools(this.cell, agentWho, this.clock).find((t) => t.name === name), name, p.input);
    if (!res.ok) return done(`I couldn't simulate the plan mentioned earlier again: ${"reason" in res ? res.reason : res.text}`, "answered");
    const lead = changed ? "The books changed since the plan mentioned earlier was simulated, so I simulated it again against the current books instead of relying on the conversation."
      : "I simulated the plan mentioned earlier again against the current books instead of relying on the conversation.";
    const writes = turn.cards.filter((c) => c.kind === "write");
    return done(`${lead} ${writes.some((c) => c.blocked) ? "This can't go ahead yet." : "Here is exactly what would change. Nothing is posted until you approve it."}`, "answered");
  }

  private reversibility(name: string, tool?: ToolSpec): Reversibility {
    return this.governance.register().find((g) => g.name === name)?.reversibility ?? (tool?.readOnly ? "none" : "simulation");
  }

  /** One governed tool call: authorizeTool → run → screenToolOutput, recorded either way. */
  private async call(turn: TurnState, agentWho: Who, person: string, tool: ToolSpec | undefined, name: string, args: Record<string, unknown>) {
    const t0 = Date.now(), inputHash = sha(JSON.stringify(args ?? {})), rev = this.reversibility(name, tool);
    const refuse = (reason: string, flags: string[]) => {
      turn.tools.push({ tool: name, inputHash, outputHash: sha(""), ok: false, reversibility: rev, flags, ms: Date.now() - t0 });
      turn.trace.push({ tool: name, ok: false });
      return { ok: false as const, text: `Refused: ${reason}`, reason };
    };
    const verdict = await this.governance.authorizeTool(name, { tenant: agentWho.tenant, book: agentWho.book, onBehalfOf: person });
    if (!verdict.ok) return refuse(verdict.reason ?? "not authorized", [deniedFlag(verdict.reason ?? "not authorized")]);
    if (!tool || name === "kuber_commit") return refuse(`tool ${name} is not available to the copilot`, [deniedFlag(`tool ${name} is not available to the copilot`)]);
    if (turn.tainted && rev !== "none" && !WRITE_ASKED.test(turn.question)) {
      const why = "an earlier tool result contained instruction-like text, and you did not ask for a change in this turn";
      return refuse(why, [deniedFlag("write_after_untrusted_instruction")]);
    }
    let r: ToolResult;
    try { r = await tool.run(args ?? {}); }
    catch (e) {
      turn.tools.push({ tool: name, inputHash, outputHash: sha(errText(e)), ok: false, reversibility: rev, flags: ["error"], ms: Date.now() - t0 });
      turn.trace.push({ tool: name, ok: false });
      return { ok: false as const, text: `Error: ${errText(e)}`, reason: errText(e) };
    }
    const screened = this.governance.screenToolOutput(name, r.text);
    if (screened.flags.some((f) => f.startsWith("instruction_like:"))) turn.tainted = true;
    turn.outputs.push(r.text);
    turn.results.push({ tool: name, result: r });
    if (r.plan) turn.cards.push(r.plan);
    turn.tools.push({ tool: name, inputHash, outputHash: sha(r.text), ok: !r.isError, reversibility: rev, flags: screened.flags, ms: Date.now() - t0,
      ...(r.plan?.kind === "write" && r.plan.status === "proposed" ? { planId: r.plan.planId } : {}) });
    turn.trace.push({ tool: name, ok: !r.isError });
    return { ok: !r.isError, text: screened.text, result: r };
  }

  // ------------------------------------------------------------------ deterministic path
  private async withRules(r: Routed, who: Who, agentWho: Who, turn: TurnState,
                          done: (reply: string, outcome: TurnRecord["outcome"], extra?: { suggestions?: string[] }) => Promise<CopilotReply>): Promise<CopilotReply> {
    if (r.kind === "help") return done(r.text, "answered", { suggestions: HELP });
    if (r.kind === "clarify") return done(r.text, "answered", r.suggestions ? { suggestions: r.suggestions } : {});
    if (r.kind === "standing_rule") return this.captureRule(r.rule, who, agentWho, turn, done);
    if (r.kind === "chat") {
      // Capture path: channels parse it, the agent classifies it, policy decides whether it posts. Done as the person.
      const t0 = Date.now();
      await this.cell.identity.authorize(who.tenant, who.principal, "capture", { book: who.book });
      const res = await this.cell.channels.submitChat(who.tenant, who.book, r.text, who.principal, this.clock());
      turn.tools.push({ tool: "capture", inputHash: sha(r.text), outputHash: sha(JSON.stringify(res ?? null)), ok: !!res, reversibility: "reversible", flags: ["as_person"], ms: Date.now() - t0 });
      turn.trace.push({ tool: "capture", ok: !!res });
      if (!res) return done("I couldn't read an amount and direction from that. Try \"Paid 450 to the plumber in cash\".", "answered");
      return done("Captured. Kuber will classify it; if policy doesn't let it post on its own, it will wait for you in Review.", "answered");
    }
    const calls = r.kind === "read" ? r.calls.map((c) => ({ name: c.tool, args: c.args })) : r.intents.map((i) => ({ name: `kuber_${i.op}`, args: i.input }));
    const catalogue = kuberTools(this.cell, agentWho, this.clock);
    const errors: string[] = [];
    for (const c of calls) {
      const res = await this.call(turn, agentWho, who.principal, catalogue.find((t) => t.name === c.name), c.name, c.args);
      if (!res.ok) errors.push("reason" in res ? res.reason : res.text);
    }
    const writes = turn.cards.filter((c) => c.kind === "write");
    const reads = turn.results.filter((x) => !x.result.isError && x.result.plan?.kind !== "write").map((x) => x.result.summary).filter(Boolean);
    const cite = policyCitation(writes);
    const reply = errors.length ? `That didn't work: ${errors.join("; ")}`
      : writes.some((c) => c.blocked) ? `This can't go ahead yet. The card shows what to resolve first.${cite ? ` ${cite}` : ""}`
      : writes.length ? `Here is exactly what would change. Nothing is posted until you approve it.${cite ? ` ${cite}` : ""}`
      : reads.join("\n");
    return done(reply, errors.length && !turn.results.length ? "error" : "answered");
  }

  /**
   * Never captured: a standing rule stated in chat becomes a governed proposal (a classification rule
   * or a POL-900 policy change note), prepared through the same governed tool call as any plan. It is
   * never kept as conversation: the reply says so, and nothing changes until a person approves.
   */
  private async captureRule(rule: StandingRule, who: Who, agentWho: Who, turn: TurnState,
                            done: (reply: string, outcome: TurnRecord["outcome"], extra?: { suggestions?: string[] }) => Promise<CopilotReply>): Promise<CopilotReply> {
    const name = rule.kind === "classification" ? "kuber_propose_rule" : "kuber_propose_policy_change";
    const args = rule.kind === "classification" ? { pattern: rule.pattern, account: rule.account, statedAs: rule.statedAs } : { statement: rule.statement };
    const res = await this.call(turn, agentWho, who.principal, kuberTools(this.cell, agentWho, this.clock).find((t) => t.name === name), name, args);
    if (!res.ok) return done(`I couldn't prepare that rule as a proposal (${"reason" in res ? res.reason : res.text}). I don't keep rules from our conversation, so nothing changes.`, "answered");
    const plan = turn.cards.at(-1);
    if (!plan || plan.blocked) {
      const why = plan ? plan.checks.filter((c) => c.blocking && !c.ok).map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ""}`).join("; ") : "no proposal was prepared";
      return done(`I prepared that rule as a proposal, but it can't go ahead: ${why}. I don't keep rules from our conversation, so nothing changes.`, "answered");
    }
    const who2 = rule.kind === "classification" ? "A person with rules.manage approves it on the card" : "Under POL-900 a person records the note and an admin approves any new policy version";
    return done(`Captured as a proposal awaiting approval, not as something I remember from this conversation. ${plan.summary} ${who2}.`, "answered");
  }
}
