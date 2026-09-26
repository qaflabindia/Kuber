/**
 * ASDGF §1.3 scope check (eval/agent/asdgf-scope.md). The determination records which agent
 * configurations were reviewed; with LLM classification and the model copilot both on, classifier
 * drafts enter the copilot's context (relation A4) and Kuber is in ASDGF scope, so that configuration
 * may run only once the file lists it as reviewed.
 */
export type ClassifierMode = "rules" | "llm";
export type CopilotMode = "rules" | "model";
export interface AgentConfig { classifier: ClassifierMode; copilot: CopilotMode }

/** The configuration a core started with `env` would run (main.ts, llm-classifier.ts, reasoner.ts). */
export function configFromEnv(env: NodeJS.ProcessEnv): AgentConfig {
  const classifier: ClassifierMode = env.KUBER_LLM_CLASSIFY === "on" ? "llm" : "rules";
  const processing = !!env.KUBER_LLM_PROCESSING_APPROVED;
  const reasoner = !!env.AGENT_MW_URL || (env.NODE_ENV !== "production" && !!env.ANTHROPIC_API_KEY && !!env.KUBER_LLM_MODEL);
  return { classifier, copilot: processing && reasoner ? "model" : "rules" };
}

/** Configurations listed under "## Reviewed configurations": lines "- `classifier=<m> copilot=<m>`: reviewed <date> ...". */
export function reviewedConfigs(markdown: string): (AgentConfig & { date: string })[] {
  const section = markdown.split(/^## /m).find((s) => s.startsWith("Reviewed configurations"));
  if (!section) return [];
  const out: (AgentConfig & { date: string })[] = [];
  for (const m of section.matchAll(/^- `classifier=(rules|llm) copilot=(rules|model)`\s*:\s*reviewed (\d{4}-\d{2}-\d{2})/gim)) {
    out.push({ classifier: m[1]!.toLowerCase() as ClassifierMode, copilot: m[2]!.toLowerCase() as CopilotMode, date: m[3]! });
  }
  return out;
}

/** null when the configuration may run; otherwise why not. */
export function scopeProblem(cfg: AgentConfig, markdown: string): string | null {
  if (reviewedConfigs(markdown).some((r) => r.classifier === cfg.classifier && r.copilot === cfg.copilot)) return null;
  const inScope = cfg.classifier === "llm" && cfg.copilot === "model";
  return `configuration classifier=${cfg.classifier} copilot=${cfg.copilot} is not recorded as reviewed in eval/agent/asdgf-scope.md`
    + (inScope ? " (it is in ASDGF scope through A4: LLM classifier drafts enter the model copilot's context)" : "");
}
