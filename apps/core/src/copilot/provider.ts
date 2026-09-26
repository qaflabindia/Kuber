/**
 * Language-model provider behind an interface, so the copilot is not tied to one vendor.
 * The model only plans and explains; the accounting is done by deterministic tools.
 */
import Anthropic from "@anthropic-ai/sdk";
import { processingFromEnv } from "./governance/processing.ts";

export interface LlmTool { name: string; description: string; input_schema: Record<string, unknown> }
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export interface Message { role: "user" | "assistant"; content: string | Block[] }
export interface Turn { stop: "end" | "tool_use"; content: Block[] }

export interface LlmProvider {
  readonly name: string;
  turn(system: string, messages: Message[], tools: LlmTool[]): Promise<Turn>;
}

export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private client: Anthropic;
  constructor(apiKey: string, private model: string, private maxTokens = 2048) {
    this.client = new Anthropic({ apiKey });
    this.name = `anthropic:${model}`;
  }
  async turn(system: string, messages: Message[], tools: LlmTool[]): Promise<Turn> {
    const r = await this.client.messages.create({
      model: this.model, max_tokens: this.maxTokens, system,
      messages: messages as Anthropic.MessageParam[], tools: tools as Anthropic.Tool[],
    });
    const content: Block[] = [];
    for (const b of r.content) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> });
    }
    return { stop: r.stop_reason === "tool_use" ? "tool_use" : "end", content };
  }
}

/**
 * Build the configured provider, or null (the copilot then uses its deterministic router).
 * TAGOF Domain 12 / GEN-04: no model path without a recorded processing decision
 * (KUBER_LLM_PROCESSING_APPROVED=<approver>:<date>:<data-location>, see governance/processing.ts).
 */
export function providerFromEnv(env = process.env): LlmProvider | null {
  const key = env.ANTHROPIC_API_KEY, model = env.KUBER_LLM_MODEL;
  if (!key) return null;
  if (!model) { console.warn("ANTHROPIC_API_KEY is set but KUBER_LLM_MODEL is not; copilot uses the rule-based router"); return null; }
  const processing = processingFromEnv(env);
  if (!processing.ok) { console.warn(`copilot uses the rule-based router: ${processing.reason}`); return null; }
  return new AnthropicProvider(key, model);
}
