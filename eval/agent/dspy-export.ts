/**
 * Export of the copilot golden set in the JSONL schema the DSPy optimiser reads
 * (services/agent-mw/optimize/dataset.py):
 *
 *   next_step  {id, utterance, history?, catalogue: [{name, description}], gold: {tool, args} | {action: "final"}}
 *   compose    {id, utterance, tool_outputs: [{tool, output}], gold_answer_facts: [str]}
 *
 * Only the copilot set is exported here, to eval/agent/dspy/copilot.jsonl. The statement classifier
 * has its own set (eval/classifier/classify.jsonl, gold_account rows) scored by its own metric:
 * tuning both against one scoring function would create ASDGF relation A3 (a shared objective)
 * between the copilot and the classifier (agent design 7.3). tests/agent-eval.test.ts checks the two
 * sets stay separate.
 *
 * Compose facts are figures from the fixture truth (fixtures.ts), never from the system's output, and
 * a compose row is written only when every fact is present in the tool outputs of a rules run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@kuber/core";
import type { Cell } from "@kuber/core";
import type { Case, CaseResult } from "./harness.ts";
import { extractFigures } from "./harness.ts";
import { FIXTURES, OWNER, TENANT, groupTruth, inr, truth, type Truth } from "./fixtures.ts";

export interface ExportOptions {
  outDir: string;
  /** With a cell, the catalogue carries the build's descriptions and schemas; otherwise tool names only. */
  cell?: Cell;
  observed?: CaseResult[];
  /** Read-card texts per case id from a rules run, as tool outputs. */
  observedCards?: Record<string, { tool: string; output: string }[]>;
}

export function exportDspy(cases: Case[], o: ExportOptions): string[] {
  // Names and descriptions only: full schemas repeated on every row would make the file megabytes; the loader defaults input_schema.
  let catalogue: (string | { name: string; description: string })[];
  if (o.cell) {
    const kuberTools = (core as unknown as { kuberTools: (c: Cell, w: unknown) => { name: string; description: string; inputSchema: Record<string, unknown> }[] }).kuberTools;
    catalogue = kuberTools(o.cell, { tenant: TENANT, book: "acme", principal: OWNER }).filter((t) => t.name !== "kuber_commit")
      .map((t) => ({ name: t.name, description: (t.description.split(/(?<=\.)\s/)[0] ?? t.description).slice(0, 200) }));
  } else {
    const names = new Set<string>();
    for (const c of cases) {
      for (const g of c.expect.tools ?? []) for (const t of g) names.add(t);
      if (c.gold && "tool" in c.gold) names.add(c.gold.tool);
    }
    names.delete("kuber_commit");
    catalogue = [...names].sort();
  }
  const offered = new Set(catalogue.map((t) => (typeof t === "string" ? t : t.name)));
  const rows: Record<string, unknown>[] = [];
  for (const c of cases) {
    if (!c.gold) continue;
    if ("tool" in c.gold && !offered.has(c.gold.tool)) continue;   // gold must be callable
    rows.push({ id: `ns-${c.id}`, utterance: c.utterance, ...(c.history ? { history: c.history } : {}), catalogue, gold: c.gold,
      category: c.category, ...(c.adversarial ? { adversarial: c.adversarial } : {}) });
  }
  const truths: Record<string, Truth> = Object.fromEntries(Object.values(FIXTURES).map((f) => [f.name, truth(f)]));
  truths.grp = groupTruth();
  for (const c of cases) {
    const outs = o.observedCards?.[c.id];
    const keys = [...(c.expect.figures ?? [])];
    if (!outs?.length || !keys.length) continue;
    const t = truths[c.fixture]!;
    const facts = keys.map((k) => t.figures[k]).filter((v): v is bigint => v !== undefined);
    const present = new Set(outs.flatMap((x) => extractFigures(x.output)));
    if (facts.length !== keys.length || !facts.every((v) => present.has(v < 0n ? -v : v))) continue;
    rows.push({ id: `co-${c.id}`, utterance: c.utterance, tool_outputs: outs.map((x) => ({ tool: x.tool, output: x.output.slice(0, 30_000) })),
      gold_answer_facts: facts.map((v) => inr(v)), category: c.category });
  }
  const dir = join(o.outDir, "agent", "dspy");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "copilot.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return [file];
}
