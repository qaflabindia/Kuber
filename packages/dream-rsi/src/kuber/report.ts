/**
 * Dream run evidence (design 7.2 "Evidence"): one JSON and one Markdown file per run in
 * requirements/evidence/dream-<family>-<tenant>-<date>.{json,md}: the pool slice hash, seed,
 * candidates evaluated, incumbent and winner scores, the confidence interval, every constraint
 * check and the decision. `reportHash` is SHA-256 over the canonical report without the hash,
 * signature and file paths, so the same pool and seed give the same hash.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DreamResult } from "../core/dreamer.ts";
import { canonicalJson, hashOf } from "../core/util.ts";

export interface SegmentReport {
  segment: string;
  skipped?: string;
  result?: Omit<DreamResult<unknown>, "incumbent" | "winner"> & {
    incumbent: DreamResult<unknown>["incumbent"] & { source: string };
    winner: DreamResult<unknown>["winner"];
  };
}

export interface DreamReport {
  kind: "kuber.dream-report";
  version: 1;
  family: "autonomy" | "routing";
  tenant: string;
  book: string | null;
  range: { from: string | null; to: string | null };
  date: string;
  seed: number;
  iterations: number;
  episodes: number;
  confidence: number;
  pool: { kind: string; size: number; sliceHash: string; source: string; skipped?: Record<string, number> };
  segments: SegmentReport[];
  decision: "promote" | "keep_incumbent";
  reportHash: string;
  /** HMAC of reportHash under the tenant's index key (verifiable by the tenant's key holders); null for fixture runs. */
  signature: { alg: "hmac-sha256/tenant-index"; value: string } | null;
}

export function finalizeReport(r: Omit<DreamReport, "reportHash" | "signature">, sign?: (hash: string) => string): DreamReport {
  const reportHash = hashOf(r);
  return { ...r, reportHash, signature: sign ? { alg: "hmac-sha256/tenant-index", value: sign(reportHash) } : null };
}

/** Recompute the hash of a report (its content without reportHash and signature). */
export function reportHashOf(r: DreamReport): string {
  const { reportHash: _h, signature: _s, ...rest } = r;
  return hashOf(rest);
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "_");

export function writeEvidence(r: DreamReport, dir: string): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `dream-${r.family}-${safe(r.tenant)}-${r.date}`);
  writeFileSync(`${base}.json`, JSON.stringify(JSON.parse(canonicalJson(r)), null, 2) + "\n");
  writeFileSync(`${base}.md`, renderMarkdown(r));
  return { json: `${base}.json`, md: `${base}.md` };
}

const fmt = (x: number | undefined) => (x === undefined ? "—" : Number.isInteger(x) ? String(x) : x.toFixed(6));

export function renderMarkdown(r: DreamReport): string {
  const out: string[] = [
    `# Dream-RSI run: ${r.family}, tenant ${r.tenant}${r.book ? `, book ${r.book}` : ""}, ${r.date}`, "",
    `- Decision: **${r.decision}**${r.decision === "promote" ? (r.family === "autonomy" ? " (a proposal for the owner; nothing changes until it is approved)" : " (an unapproved routing artifact; approval is through the prompt lock)") : ""}`,
    `- Pool: ${r.pool.kind}, ${r.pool.size} recorded decisions, slice hash \`${r.pool.sliceHash}\`, source ${r.pool.source}`,
    `- Range: ${r.range.from ?? "—"} to ${r.range.to ?? "—"}; seed ${r.seed}; ${r.iterations} iterations; ${r.episodes} bootstrap episodes; ${Math.round(r.confidence * 100)}% interval`,
    `- Report hash: \`${r.reportHash}\`${r.signature ? `; signature (${r.signature.alg}) \`${r.signature.value}\`` : ""}`,
  ];
  if (r.pool.skipped) out.push(`- Not in the pool: ${Object.entries(r.pool.skipped).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const s of r.segments) {
    out.push("", `## Segment ${s.segment}`, "");
    if (!s.result) { out.push(`Skipped: ${s.skipped ?? "no eligible decisions"}.`); continue; }
    const x = s.result;
    out.push(`Decision: **${x.decision}**. ${x.reasons.join("; ")}.`, "",
      `Candidates: ${x.candidates.proposed} proposed, ${x.candidates.evaluated} evaluated, ${x.candidates.rejectedOutOfBounds} rejected by bounds, ${x.candidates.duplicates} duplicates, ${x.candidates.infeasible} infeasible, ${x.candidates.accepted} accepted improvements. Metric \`${x.metric}\`; slice hash \`${x.pool.sliceHash}\` (${x.pool.size} decisions).`, "",
      "| | Score (episode mean) | Pool score | Metrics |", "| --- | --- | --- | --- |",
      `| Incumbent (${x.incumbent.source}) | ${fmt(x.incumbent.score)} | ${fmt(x.incumbent.poolScore)} | ${Object.entries(x.incumbent.metrics).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")} |`,
      `| Winner | ${fmt(x.winner.score)} | ${fmt(x.winner.poolScore)} | ${Object.entries(x.winner.metrics).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")} |`, "",
      x.improvement ? `Improvement ${fmt(x.improvement.mean)}, interval ${fmt(x.improvement.ciLower)} to ${fmt(x.improvement.ciUpper)}.` : "No improvement to test.", "",
      "| Constraint | Winner | Limit | OK | Detail |", "| --- | --- | --- | --- | --- |",
      ...x.winner.constraints.map((c) => `| ${c.name} | ${c.value} | ${c.limit} | ${c.ok ? "yes" : "NO"} | ${c.detail} |`), "");
    if (x.diff.length) out.push("| Parameter | Incumbent | Winner |", "| --- | --- | --- |", ...x.diff.map((d) => `| ${d.param} | ${String(d.from)} | ${String(d.to)} |`));
    else out.push("Winner parameters equal the incumbent's.");
  }
  return out.join("\n") + "\n";
}

export interface RoutingArtifact {
  kind: "kuber.routing-policy";
  version: number;
  family: "routing";
  metric: string;
  params: unknown;
  evidence: { reportHash: string; poolSliceHash: string; seed: number; report: string };
  approvedBy: null;
  locked: false;
  sha256: string;
}

/** Write agent/artifacts/routing-policy.<version>.json (next version), unapproved and unlocked. */
export function writeRoutingArtifact(dir: string, a: Omit<RoutingArtifact, "version" | "sha256" | "approvedBy" | "locked" | "kind" | "family">): { path: string; artifact: RoutingArtifact } {
  mkdirSync(dir, { recursive: true });
  const versions = readdirSync(dir).map((f) => /^routing-policy\.(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number);
  const version = (versions.length ? Math.max(...versions) : 0) + 1;
  const body = { kind: "kuber.routing-policy" as const, version, family: "routing" as const, ...a, approvedBy: null, locked: false as const };
  const artifact: RoutingArtifact = { ...body, sha256: hashOf(body) };
  const path = join(dir, `routing-policy.${version}.json`);
  writeFileSync(path, JSON.stringify(JSON.parse(canonicalJson(artifact)), null, 2) + "\n", { flag: "wx" });
  return { path, artifact };
}
