/**
 * Agent evaluation runner (design section 5, workstream 3; TAGOF Part XII).
 *
 *   pnpm eval:agent                          rules engine (default): no model, no network, CI-safe
 *   pnpm eval:agent --engine scripted        deterministic adversarial fake LlmProvider (eval/agent/scripted.ts)
 *   pnpm eval:agent --engine scripted-dspy   the same policy as a fake middleware Reasoner (nextStep / compose)
 *   pnpm eval:agent --engine live            the real model; only with ANTHROPIC_API_KEY, KUBER_LLM_MODEL and
 *                                            KUBER_LLM_PROCESSING_APPROVED set, otherwise skipped (exit 0)
 *   options: --cases <jsonl>  --only <id-or-category,...>  --out <dir>  --no-write  --export-dspy [--static]
 *
 * Needs PostgreSQL (TEST_DATABASE_ADMIN_URL, as the test suite): a fresh database is created and dropped.
 * Writes requirements/evidence/agent-eval-<engine>-<commit>.{json,md}. Exit status: 0 all thresholds met,
 * 1 a hard gate missed, 3 only soft targets missed, 2 usage or setup error.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, enrol, startCell } from "../tests/helpers.ts";
import { ENGINES, checkThresholds, loadCases, metrics, run, type Engine, type OpenFinding, type Threshold } from "../eval/agent/harness.ts";
import { buildReport, markdown } from "../eval/agent/report.ts";
import { ScriptedProvider, ScriptedReasoner } from "../eval/agent/scripted.ts";
import { exportDspy } from "../eval/agent/dspy-export.ts";

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name: string) => args.includes(`--${name}`);
const engine = (opt("engine") ?? "rules") as Engine;
if (!ENGINES.includes(engine)) { console.error(`unknown engine ${engine}; one of ${ENGINES.join(", ")}`); process.exit(2); }
const casesPath = opt("cases") ?? join(ROOT, "eval", "agent", "cases.jsonl");
const outDir = opt("out") ?? join(ROOT, "requirements", "evidence");

if (flag("export-dspy") && flag("static")) {
  const files = exportDspy(loadCases(casesPath), { outDir: join(ROOT, "eval") });
  console.log(`wrote ${files.map((f) => relative(ROOT, f)).join(", ")}`);
  process.exit(0);
}

async function model(): Promise<unknown> {
  if (engine === "rules") return null;
  if (engine === "scripted") return new ScriptedProvider();
  if (engine === "scripted-dspy") return new ScriptedReasoner();
  const missing = ["ANTHROPIC_API_KEY", "KUBER_LLM_MODEL", "KUBER_LLM_PROCESSING_APPROVED"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.log(`live engine skipped: ${missing.join(", ")} not set. The live model path needs a key, a model id and the operator's recorded processing approval (TAGOF Domain 12); nothing was run.`);
    process.exit(0);
  }
  const { AnthropicProvider } = await import("../apps/core/src/copilot/provider.ts");
  return new AnthropicProvider(process.env.ANTHROPIC_API_KEY!, process.env.KUBER_LLM_MODEL!);
}

const git = (...a: string[]) => { try { return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return ""; } };

async function main() {
  const m = await model();
  let cases = loadCases(casesPath);
  const only = opt("only")?.split(",");
  if (only) cases = cases.filter((c) => only.includes(c.id) || only.includes(c.category));
  const cfg = JSON.parse(readFileSync(join(ROOT, "eval", "agent", "thresholds.json"), "utf8")) as { thresholds: Threshold[]; openFindings?: OpenFinding[] };
  const thresholds = cfg.thresholds;
  const clock = { value: "2026-11-15" };
  const { cell, stop } = await startCell(clock);
  try {
    const result = await run({ engine, cases, cell, model: m, clock, enrol: (t, p, b) => enrol(cell, t, p, b),
      onCase: (r) => process.stdout.write(`${r.status === "pass" ? "." : r.status === "nya" ? "n" : "F"}`) });
    process.stdout.write("\n");
    const overall = metrics(result.results);
    const checked = checkThresholds(thresholds, overall, engine);
    const commit = git("rev-parse", "--short", "HEAD") || "unknown";
    const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
    const report = buildReport(result, { commit, dirty, datasetPath: relative(ROOT, casesPath), datasetSha: createHash("sha256").update(readFileSync(casesPath)).digest("hex") }, checked, cfg.openFindings ?? []);
    const md = markdown(report);
    if (!flag("no-write")) {
      mkdirSync(outDir, { recursive: true });
      const base = join(outDir, `agent-eval-${engine}-${commit}`);
      writeFileSync(`${base}.json`, JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
      writeFileSync(`${base}.md`, md + "\n");
      console.log(`wrote ${relative(ROOT, base)}.json and .md`);
    }
    if (flag("export-dspy")) {
      const files = exportDspy(cases, { outDir: join(ROOT, "eval"), observed: result.results, cell, observedCards: result.cards });
      console.log(`wrote ${files.map((f) => relative(ROOT, f)).join(", ")}`);
    }
    const o = overall;
    console.log(`${engine}: ${o.passed}/${o.available} available cases passed (${o.nya} not yet available) in ${(result.durationMs / 1000).toFixed(1)} s; `
      + `unsafe ${o.unsafeActions}, injection ${o.injectionFollowed}, commit ${o.commitByAgent}, leak ${o.crossBookLeakage}, grounding ${o.groundingViolations}; `
      + `in-scope reads ${o.inScopeReadPassRateAll ?? "–"} (all) / ${o.inScopeReadPassRate ?? "–"} (available)`);
    for (const t of checked.filter((x) => !x.met)) console.log(`  missed ${t.severity}: ${t.metric} ${t.op} ${t.value} (actual ${t.actual})`);
    for (const b of report.gateBreaches) console.log(`  gate breach ${b.gate} in ${b.case}: ${b.finding ? `open finding ${b.finding}` : "NEW (not recorded)"}`);
    process.exitCode = !report.hardGatesMet ? 1 : !report.softTargetsMet ? 3 : 0;
  } finally { await stop(); }
}

main().catch((e) => { console.error(e); process.exit(2); });
