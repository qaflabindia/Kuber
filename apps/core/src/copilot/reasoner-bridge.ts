/**
 * Bridge between the copilot loop's Reasoner contract (reasoner-types.ts, one request object per step)
 * and the middleware client (reasoner.ts, context + input, returns meta). The TypeScript core keeps the
 * loop, tools and governance; the Python middleware only proposes the next step and composes the reply
 * (agent design 7.1). The middleware's compiled DSPy program carries its own approved instructions, so the
 * core's system prompt is not sent on this path; both are hash-locked in agent/prompts.lock.json.
 */
import type { ComposeRequest, NextStep, NextStepRequest, Reasoner as CoreReasoner } from "./reasoner-types.ts";
import { ReasonerError, type Reasoner as MwReasoner, type ReasonerMeta } from "./reasoner.ts";

export function bridgeReasoner(mw: MwReasoner, principal = "agent:copilot"): CoreReasoner {
  const seen = new Map<string, { id: string; version: string; hash: string }>();
  const note = (m: ReasonerMeta) => {
    if (m.artifactId && m.artifactHash) seen.set(m.artifactId, { id: m.artifactId, version: m.program, hash: m.artifactHash });
  };
  return {
    name: mw.name,
    async nextStep(req: NextStepRequest): Promise<NextStep> {
      const r = await mw.nextStep({ tenant: req.context.tenant, principal }, {
        request: req.question,
        history: req.history,
        catalogue: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        priorSteps: req.steps.map((s) => ({ tool: s.tool, args: s.args, output: s.output })),
      });
      note(r.meta);
      return r.action === "tool" ? { action: "tool", tool: r.tool, args: r.args } : { action: "final", draft: r.draft };
    },
    async compose(req: ComposeRequest): Promise<{ reply: string }> {
      try {
        const r = await mw.compose({ tenant: req.context.tenant, principal }, {
          request: req.question, toolOutputs: req.steps.filter((s) => s.ok).map((s) => ({ tool: s.tool, output: s.output })), draft: req.draft ?? null,
        });
        note(r.meta);
        return { reply: r.answer };
      } catch (e) {
        // The middleware refused its own draft (e.g. ungrounded figures): hand the core the loop's draft,
        // and the core's grounding check (authoritative) decides whether it may be shown.
        if (e instanceof ReasonerError && e.kind === "rejected") return { reply: req.draft ?? "" };
        throw e;
      }
    },
    artifacts: () => [...seen.values()],
  };
}
