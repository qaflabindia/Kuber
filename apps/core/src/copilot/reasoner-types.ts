/**
 * The Reasoner: the model steps of the copilot's bounded loop (AAWDS L2, reactive), behind an
 * interface so the TypeScript core never calls a model directly (design section 7.1). The core keeps
 * the loop, the step bound, the timeout and every tool call; a Reasoner only proposes the next step
 * and composes the reply from tool outputs.
 *
 * Implementations live in reasoner.ts (ws5/agent-mw): MiddlewareReasoner (default, the Python DSPy
 * service), DirectAnthropicReasoner (tests and development only) and reasonerFromEnv(). This file
 * holds only the types they share with the core; `llmReasoner` adapts a legacy LlmProvider.
 */
import type { Block, LlmProvider, Message } from "./provider.ts";

export interface ReasonerTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ReasonerHistoryItem { role: "user" | "assistant"; text: string }
/** One completed step: the tool called, its arguments and the (screened) output the model may see. */
export interface ReasonerStep { tool: string; args: Record<string, unknown>; output: string; ok: boolean }
export interface ReasonerPrompt { id: string; version: string; hash: string; text: string }

export interface NextStepRequest {
  turnId: string;
  system: ReasonerPrompt;
  question: string;
  history: ReasonerHistoryItem[];
  tools: ReasonerTool[];
  steps: ReasonerStep[];
  context: { tenant: string; book: string; today: string };
  /** Steps left including this one (the core's bound). */
  remaining: number;
}
export type NextStep =
  | { action: "tool"; tool: string; args: Record<string, unknown> }
  | { action: "final"; draft: string };

export interface ComposeRequest {
  turnId: string;
  system: ReasonerPrompt;
  question: string;
  history: ReasonerHistoryItem[];
  steps: ReasonerStep[];
  context: { tenant: string; book: string; today: string };
  /** The model's final draft, when the loop ended with one. */
  draft?: string;
  /** Why the loop ended without a final step, e.g. "step_limit". */
  stopped?: string;
}

export interface Reasoner {
  readonly name: string;
  nextStep(req: NextStepRequest): Promise<NextStep>;
  compose(req: ComposeRequest): Promise<{ reply: string }>;
  /** Compiled artifacts this reasoner runs with (id, version, hash), for the turn record. */
  artifacts?(): { id: string; version: string; hash: string }[];
}

export const isReasoner = (x: unknown): x is Reasoner => !!x && typeof (x as Reasoner).nextStep === "function" && typeof (x as Reasoner).compose === "function";

/**
 * A Reasoner over a legacy LlmProvider (the Anthropic tool-use API), for development and existing
 * tests. It rebuilds the conversation from the steps each time and takes the first tool call of a
 * turn; compose returns the model's final draft unchanged (no second model call).
 */
export function llmReasoner(provider: LlmProvider): Reasoner {
  return {
    name: provider.name,
    async nextStep(req) {
      const messages: Message[] = [...req.history.map((h) => ({ role: h.role, content: h.text })), { role: "user", content: req.question }];
      req.steps.forEach((s, i) => {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: `s${i}`, name: s.tool, input: s.args }] });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `s${i}`, content: s.output, is_error: !s.ok }] });
      });
      const turn = await provider.turn(req.system.text, messages, req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));
      const use = turn.content.find((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      if (turn.stop === "tool_use" && use) return { action: "tool", tool: use.name, args: use.input ?? {} };
      return { action: "final", draft: turn.content.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n").trim() };
    },
    async compose(req) { return { reply: req.draft ?? "" }; },
  };
}
