/**
 * Contracts between the Kuber agent core (AAWDS L1–L3) and its governance layer (AAWDS L5,
 * TAGOF Domains 4, 6, 10, 14, 15). The core calls these at layer boundaries; the governance
 * implementation lives in this directory. Governance constrains admissibility, never generation.
 *
 * Boundaries (AAWDS §3.7):
 *   input     Envelope → L1   screenInput           (PRM-04 scope, PRM-06 injection)
 *   action    L2 → L1         authorizeTool         (TOL-01/02/04, AGT-01/03)
 *   observe   L1 → L2         screenToolOutput      (PRM-08 indirect injection)
 *   output    L4 → output     checkGrounding        (GEN-01 confabulation)
 *   cross     audit           TurnRecorder          (TOL-05, AGT-07, Domain 14)
 */

/** Reversibility class of a tool (TOL-03 / AGT-02). */
export type Reversibility =
  | "none"          // read only: no effect
  | "simulation"    // creates a plan; nothing changes until a person commits it
  | "reversible"    // changes state that can be reversed by a compensating entry
  | "irreversible"; // external effect or cannot be compensated (payments out, messages sent)

/** Tool authorization register entry (TOL-01). Tools absent from the register are blocked. */
export interface ToolRegistration {
  name: string;
  owner: string;                    // accountable role, e.g. "Financial Controller"
  reversibility: Reversibility;
  permission: string;               // identity action the acting person must hold, e.g. "read", "plan.prepare"
  dataClasses: ("financial" | "personal" | "counterparty" | "policy")[];
  untrustedOutput: boolean;         // output contains third-party or free text (narrations, ext_*): screen it
  enabled: boolean;
}

export interface InputVerdict { ok: boolean; reason?: string; category?: "in_scope" | "out_of_scope" | "injection" | "empty" | "too_long" }
export interface ToolVerdict { ok: boolean; reason?: string }
export interface ScreenedOutput { text: string; flags: string[] }   // flags e.g. ["instruction_like:ignore previous"]
export interface GroundingResult { ok: boolean; ungrounded: string[] }  // figures in the reply not found in tool outputs

export interface ToolCallRecord {
  tool: string; inputHash: string; outputHash: string; ok: boolean;
  reversibility: Reversibility; flags: string[]; ms: number; planId?: string;
}

/** One agent turn, recorded as a sealed event (AGT-07 action chain audit). */
export interface TurnRecord {
  turnId: string; sessionId: string | null; tenant: string; book: string;
  principal: string;                // agent principal, e.g. agent:copilot
  onBehalfOf: string;               // the signed-in person
  engine: string;                   // "rules" or "anthropic:<model>"
  promptId: string; promptVersion: string; promptHash: string;   // PRM-01..03
  input: InputVerdict; inputHash: string;
  tools: ToolCallRecord[];
  planIds: string[];
  grounding: GroundingResult;
  outcome: "answered" | "refused" | "error" | "halted";
  steps: number; tokensIn?: number; tokensOut?: number; ms: number;
}

export interface Governance {
  register(): ToolRegistration[];
  screenInput(text: string): InputVerdict;
  authorizeTool(tool: string, ctx: { tenant: string; book: string; onBehalfOf: string }): Promise<ToolVerdict>;
  screenToolOutput(tool: string, text: string): ScreenedOutput;
  checkGrounding(reply: string, toolOutputs: string[]): GroundingResult;
  prompt(id: string): { id: string; version: string; hash: string; text: string };
  halted(tenant: string, book: string): Promise<boolean>;   // AGT-09 kill switch for the agent
  record(turn: TurnRecord): Promise<void>;
}
