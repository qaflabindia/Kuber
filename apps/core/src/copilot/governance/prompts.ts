/**
 * Prompt and artifact registry (TAGOF PRM-01..03, Part XI 11.4; agent design 7.1 artifacts).
 *
 * The control plane lives in `agent/`:
 *   prompts/<id>.v<major>.md     system prompts, markdown with front matter (id, version, owner,
 *                                approvedBy, approvedAt, changeNote); placeholders {{today}}, {{tenant}}, {{book}}
 *   artifacts/*.json             compiled DSPy programs (kind "dspy_artifact") and Dream-RSI routing
 *                                policies (kind "routing_policy"): { kind, id, version, owner, approvedBy, ... }
 *   tools.register.json          the tool authorization register (TOL-01)
 *   injection-patterns.json      the injection / jailbreak pattern library (PRM-07)
 *   prompts.lock.json            id → version → sha256 → approver for every file above
 *
 * The runtime loads only what the lock approves: a file whose hash differs from its lock entry, a
 * governed file missing from the lock, or a lock entry without its file refuses to load. Changing
 * any of them therefore needs a lock update in the same change, which is the review point (the
 * CI stand-in for the approval workflow; the approval itself is recorded as approvedBy/approvedAt).
 *
 * Regenerate the lock after an approved change:  pnpm tsx apps/core/src/copilot/governance/prompts.ts --write-lock
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AGENT_DIR = fileURLToPath(new URL("../../../../../agent/", import.meta.url));
export const LOCK_FILE = "prompts.lock.json";

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export type LockKind = "prompt" | "dspy_artifact" | "routing_policy" | "tool_register" | "injection_patterns";
export interface LockEntry { kind: LockKind; id: string; version: string; sha256: string; approver: string; approvedAt: string; file: string }
export interface Lock { version: 1; entries: LockEntry[] }

export interface PromptVersion { id: string; version: string; hash: string; text: string; owner: string; approvedBy: string; approvedAt: string; approved: boolean }
export interface ArtifactVersion { kind: "dspy_artifact" | "routing_policy"; id: string; version: string; hash: string; approver: string; approved: boolean; content: Record<string, unknown> }

export class RegistryError extends Error {
  constructor(public problems: string[]) { super(`agent registry refused to load: ${problems.join("; ")}`); }
}

const PENDING = /^pending\b/i;
const isApproved = (approver: string, at: string) => !!approver && !PENDING.test(approver) && !/^pending/i.test(at) && /^\d{4}-\d{2}-\d{2}/.test(at);

/** Split `---` front matter (simple `key: value` lines) from the body. */
export function parseFrontMatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

const PROMPT_FIELDS = ["id", "version", "owner", "approvedBy", "approvedAt", "changeNote"] as const;

/** Every governed file in `dir` with the entry it should have in the lock (hashes computed now). */
export function computeLock(dir = AGENT_DIR): { entries: LockEntry[]; problems: string[] } {
  const entries: LockEntry[] = [], problems: string[] = [];
  const rel = (p: string) => relative(dir, p).split("\\").join("/");
  const promptDir = join(dir, "prompts");
  for (const f of existsSync(promptDir) ? readdirSync(promptDir).filter((x) => x.endsWith(".md")).sort() : []) {
    const path = join(promptDir, f);
    const { meta, body } = parseFrontMatter(readFileSync(path, "utf8"));
    const missing = PROMPT_FIELDS.filter((k) => !meta[k]);
    if (missing.length) problems.push(`${rel(path)}: front matter is missing ${missing.join(", ")}`);
    if (meta.id && meta.version && !f.startsWith(`${meta.id}.v${meta.version.split(".")[0]}`)) problems.push(`${rel(path)}: file name does not match id ${meta.id} and major version ${meta.version}`);
    entries.push({ kind: "prompt", id: meta.id ?? f, version: meta.version ?? "", sha256: sha256(body), approver: meta.approvedBy ?? "", approvedAt: meta.approvedAt ?? "", file: rel(path) });
  }
  const artDir = join(dir, "artifacts");
  for (const f of existsSync(artDir) ? readdirSync(artDir).filter((x) => x.endsWith(".json")).sort() : []) {
    const path = join(artDir, f), raw = readFileSync(path);
    let a: Record<string, unknown> = {};
    try { a = JSON.parse(raw.toString("utf8")); } catch { problems.push(`${rel(path)}: not JSON`); continue; }
    if (a.kind !== "dspy_artifact" && a.kind !== "routing_policy") { problems.push(`${rel(path)}: kind must be dspy_artifact or routing_policy`); continue; }
    for (const k of ["id", "version", "owner", "approvedBy"]) if (typeof a[k] !== "string" || !a[k]) problems.push(`${rel(path)}: missing ${k}`);
    entries.push({ kind: a.kind, id: String(a.id ?? f), version: String(a.version ?? ""), sha256: sha256(raw), approver: String(a.approvedBy ?? ""),
      approvedAt: String(a.approvedAt ?? "pending"), file: rel(path) });
  }
  for (const [kind, file] of [["tool_register", "tools.register.json"], ["injection_patterns", "injection-patterns.json"]] as const) {
    const path = join(dir, file);
    if (!existsSync(path)) { problems.push(`${file} is missing`); continue; }
    const raw = readFileSync(path);
    const j = JSON.parse(raw.toString("utf8")) as { version?: string; approvedBy?: string; owner?: string; approvedAt?: string };
    entries.push({ kind, id: kind, version: j.version ?? "", sha256: sha256(raw), approver: j.approvedBy ?? j.owner ?? "", approvedAt: j.approvedAt ?? "pending", file });
  }
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(`${e.kind}:${e.id}`)) problems.push(`${e.kind} ${e.id} is defined twice (one live version per id)`);
    seen.add(`${e.kind}:${e.id}`);
  }
  return { entries, problems };
}

export function readLock(dir = AGENT_DIR): Lock {
  const path = join(dir, LOCK_FILE);
  if (!existsSync(path)) return { version: 1, entries: [] };
  return JSON.parse(readFileSync(path, "utf8")) as Lock;
}

/** Differences between the files and the lock: empty when every governed file is exactly as approved. */
export function checkLock(dir = AGENT_DIR): string[] {
  const { entries, problems } = computeLock(dir);
  const lock = readLock(dir);
  const out = [...problems];
  const key = (e: Pick<LockEntry, "kind" | "id">) => `${e.kind}:${e.id}`;
  const locked = new Map(lock.entries.map((e) => [key(e), e]));
  for (const e of entries) {
    const l = locked.get(key(e));
    if (!l) { out.push(`${e.file} (${e.kind} ${e.id}) is not in ${LOCK_FILE}`); continue; }
    if (l.version !== e.version) out.push(`${e.file}: version ${e.version}, lock says ${l.version}`);
    if (l.sha256 !== e.sha256) out.push(`${e.file}: content changed since it was locked (sha256 ${e.sha256.slice(0, 12)}…, lock ${l.sha256.slice(0, 12)}…)`);
    if (l.approver !== e.approver) out.push(`${e.file}: approver ${e.approver}, lock says ${l.approver}`);
    if (l.file !== e.file) out.push(`${e.kind} ${e.id}: file ${e.file}, lock says ${l.file}`);
    locked.delete(key(e));
  }
  for (const l of locked.values()) out.push(`${LOCK_FILE} lists ${l.kind} ${l.id} (${l.file}) but the file is missing`);
  return out;
}

export function writeLock(dir = AGENT_DIR): Lock {
  const { entries, problems } = computeLock(dir);
  if (problems.length) throw new RegistryError(problems);
  const lock: Lock = { version: 1, entries };
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify(lock, null, 2) + "\n");
  return lock;
}

/** The runtime view: loads only locked content; refuses to construct otherwise. */
export class PromptRegistry {
  private prompts = new Map<string, PromptVersion>();
  private artifacts = new Map<string, ArtifactVersion>();
  readonly lock: Lock;

  constructor(readonly dir = AGENT_DIR) {
    const problems = checkLock(dir);
    if (problems.length) throw new RegistryError(problems);
    this.lock = readLock(dir);
    for (const e of this.lock.entries) {
      const src = readFileSync(join(dir, e.file), "utf8");
      if (e.kind === "prompt") {
        const { meta, body } = parseFrontMatter(src);
        this.prompts.set(e.id, { id: e.id, version: e.version, hash: e.sha256, text: body, owner: meta.owner ?? "", approvedBy: e.approver,
          approvedAt: e.approvedAt, approved: isApproved(e.approver, e.approvedAt) });
      } else if (e.kind === "dspy_artifact" || e.kind === "routing_policy") {
        this.artifacts.set(e.id, { kind: e.kind, id: e.id, version: e.version, hash: e.sha256, approver: e.approver,
          approved: isApproved(e.approver, e.approvedAt), content: JSON.parse(src) });
      }
    }
  }

  prompt(id: string): PromptVersion {
    const p = this.prompts.get(id);
    if (!p) throw new Error(`no approved prompt ${id} in the registry`);
    return p;
  }

  /** The prompt with its placeholders filled; the hash stays the approved template's. */
  render(id: string, vars: { today: string; tenant: string; book: string }): PromptVersion {
    const p = this.prompt(id);
    return { ...p, text: p.text.replace(/\{\{(today|tenant|book)\}\}/g, (_m, k: keyof typeof vars) => vars[k]) };
  }

  artifact(id: string): ArtifactVersion {
    const a = this.artifacts.get(id);
    if (!a) throw new Error(`no approved artifact ${id} in the registry`);
    return a;
  }

  list() { return this.lock.entries.map(({ kind, id, version, sha256, approver, approvedAt }) => ({ kind, id, version, sha256, approver, approvedAt, approved: isApproved(approver, approvedAt) })); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--write-lock")) { const l = writeLock(); console.log(`wrote ${LOCK_FILE}: ${l.entries.length} entries`); }
  else { const p = checkLock(); console.log(p.length ? p.join("\n") : "lock matches"); process.exitCode = p.length ? 1 : 0; }
}
