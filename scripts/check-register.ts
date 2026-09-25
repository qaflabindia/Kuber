/**
 * Requirements traceability register check (requirements/register.md).
 *
 *   pnpm register                 static checks (no database): statuses, duplicate IDs, test IDs that
 *                                 resolve to real it()/describe() titles, evidence for "verified" rows,
 *                                 no finance approval or sign-off while the business owner is unassigned.
 *   pnpm register --run           also runs every test file the register references (needs PostgreSQL,
 *                                 TEST_DATABASE_ADMIN_URL) and fails if any test in them fails, or if a
 *                                 test cited by a "verified" row did not pass (skipped counts as not passed).
 *   pnpm register --run --write-evidence requirements/evidence/vitest-<sha>.json
 *                                 writes the per-test results of that run as an evidence artifact.
 *
 * Exit 0 when the register is consistent, 1 otherwise (each problem is printed).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STATUSES = ["proposed", "finance-approved", "implemented", "verified", "operationally proven", "blocked", "failed"] as const;
export type Status = (typeof STATUSES)[number];

export const COLUMNS = [
  "Requirement ID", "Source section", "Business owner", "Delivery owner", "Gate", "Status", "Code/config ref",
  "UAT/test ID", "Evidence artifact and tested commit", "Finance sign-off", "Deferral/expiry",
] as const;

export interface Row {
  line: number;
  id: string; source: string; businessOwner: string; deliveryOwner: string; gate: string; status: string;
  codeRef: string; testIds: string; evidence: string; signOff: string; deferral: string;
}

export interface TestRef { file: string; title: string }

/** A test title found in a source file: the literal after it( / test( / describe(. */
export interface FoundTitle { kind: "it" | "test" | "describe"; title: string; skipped: boolean; dynamic: boolean }

/** Condensed vitest results committed as an evidence artifact. */
export interface EvidenceFile {
  commit: string; dirty: boolean; ranAt: string; command: string;
  summary: { passed: number; failed: number; skipped: number };
  results: { file: string; ancestors: string[]; title: string; status: string }[];
}

export interface Fs { exists(path: string): boolean; read(path: string): string }

// ------------------------------------------------------------------------------------------ parsing

const splitCells = (line: string): string[] => {
  const cells: string[] = []; let cur = ""; let code = false;
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\" && body[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
};

/** Parse the register table (the one whose header starts with "Requirement ID"). */
export function parseRegister(md: string): { rows: Row[]; errors: string[] } {
  const lines = md.split("\n");
  const errors: string[] = [];
  const start = lines.findIndex((l) => /^\s*\|\s*Requirement ID\s*\|/.test(l));
  if (start < 0) return { rows: [], errors: ["no register table: expected a markdown table whose first column is 'Requirement ID'"] };
  const header = splitCells(lines[start]!);
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) errors.push(`register header is missing column(s): ${missing.join(", ")}`);
  const col = (cells: string[], name: string) => cells[header.indexOf(name)] ?? "";
  const rows: Row[] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim().startsWith("|")) break;
    const cells = splitCells(l);
    if (cells.length !== header.length) errors.push(`line ${i + 1}: ${cells.length} cells, the header has ${header.length}`);
    rows.push({
      line: i + 1, id: col(cells, "Requirement ID").replace(/\*\*/g, ""), source: col(cells, "Source section"),
      businessOwner: col(cells, "Business owner"), deliveryOwner: col(cells, "Delivery owner"), gate: col(cells, "Gate"),
      status: col(cells, "Status").replace(/\*\*/g, "").trim(), codeRef: col(cells, "Code/config ref"),
      testIds: col(cells, "UAT/test ID"), evidence: col(cells, "Evidence artifact and tested commit"),
      signOff: col(cells, "Finance sign-off"), deferral: col(cells, "Deferral/expiry"),
    });
  }
  if (!rows.length) errors.push("the register table has no rows");
  return { rows, errors };
}

/** Test IDs in a cell: code spans of the form `tests/<file>.test.ts::<title>` (several may be separated by <br>). */
export function parseTestIds(cell: string): { refs: TestRef[]; malformed: string[] } {
  const refs: TestRef[] = []; const malformed: string[] = [];
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    const s = m[1]!;
    const i = s.indexOf("::");
    if (i < 0) { malformed.push(s); continue; }
    const file = s.slice(0, i).trim(), title = s.slice(i + 2).trim();
    if (!/^(tests|review)\/[\w./-]+\.test\.ts$/.test(file) || !title) { malformed.push(s); continue; }
    refs.push({ file, title });
  }
  return { refs, malformed };
}

const readString = (src: string, at: number): { value: string; end: number; dynamic: boolean } | null => {
  const q = src[at];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let value = "", dynamic = false;
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") { const n = src[i + 1] ?? ""; value += n === "n" ? "\n" : n === "t" ? "\t" : n; i++; continue; }
    if (c === q) return { value, end: i + 1, dynamic };
    if (q === "`" && c === "$" && src[i + 1] === "{") dynamic = true;
    value += c;
  }
  return null;
};

const skipParens = (src: string, at: number): number => {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") { const s = readString(src, i); if (!s) return -1; i = s.end - 1; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
};

/** Every literal title passed to it(), test() or describe() (with .skip/.only/.skipIf(...)/... modifiers) in `src`. */
export function findTitles(src: string): FoundTitle[] {
  const out: FoundTitle[] = [];
  const re = /(?<![\w.$])(describe|it|test)(?=[.(\s])/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let i = m.index + m[1]!.length; let skipped = false;
    for (;;) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== ".") break;
      const id = /^\.(\w+)/.exec(src.slice(i));
      if (!id) break;
      i += id[0].length;
      if (id[1] === "skip" || id[1] === "todo") skipped = true;
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] === "(" && ["skipIf", "runIf", "each", "for"].includes(id[1]!)) { const e = skipParens(src, i); if (e < 0) break; i = e; }
    }
    while (/\s/.test(src[i] ?? "")) i++;
    if (src[i] !== "(") continue;
    i++;
    while (/\s/.test(src[i] ?? "")) i++;
    const s = readString(src, i);
    if (s) out.push({ kind: m[1] as FoundTitle["kind"], title: s.value, skipped, dynamic: s.dynamic });
  }
  return out;
}

/** Why `ref` does not resolve to a runnable test, or null when it does. */
export function resolveTestRef(ref: TestRef, fs: Fs): string | null {
  if (!fs.exists(ref.file)) return `test file ${ref.file} does not exist`;
  const found = findTitles(fs.read(ref.file)).filter((t) => !t.dynamic && t.title === ref.title);
  if (!found.length) return `no it()/describe() titled "${ref.title}" in ${ref.file}`;
  if (found.every((t) => t.skipped)) return `"${ref.title}" in ${ref.file} is marked .skip/.todo`;
  return null;
}

const COMMIT = /\b[0-9a-f]{7,40}\b/;
/** "Unassigned — <role>", TBD or empty: no named person owns the row yet. */
export const unassigned = (owner: string) => /unassigned|tbd/i.test(owner) || !owner.replace(/[—\-\s*]/g, "");
/** Anything but Pending / Rejected / N/A / empty claims a finance sign-off. */
export const signedOff = (s: string) => !/^\s*(pending|not signed|rejected|n\/a|none|—|-)?\s*$/i.test(s.replace(/\*\*/g, ""));

/** Evidence paths named in the evidence cell (code spans pointing into the repository). */
export const evidencePaths = (cell: string): string[] =>
  [...cell.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]!).filter((p) => p.includes("/"));

/** Tests in the evidence that a reference covers (the test itself, or every test under a describe of that title). */
export const coveredBy = (ev: EvidenceFile, ref: TestRef) =>
  ev.results.filter((r) => r.file === ref.file && (r.title === ref.title || r.ancestors.includes(ref.title)));

// ------------------------------------------------------------------------------------------ checks

export function checkRegister(rows: Row[], fs: Fs): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const evidenceCache = new Map<string, EvidenceFile | string>();
  const loadEvidence = (p: string): EvidenceFile | string => {
    if (!evidenceCache.has(p)) {
      try {
        const ev = JSON.parse(fs.read(p)) as EvidenceFile;
        evidenceCache.set(p, Array.isArray(ev.results) && typeof ev.commit === "string" ? ev : `${p} is not an evidence file (commit, results)`);
      } catch (e) { evidenceCache.set(p, `${p} cannot be read as JSON: ${e instanceof Error ? e.message : e}`); }
    }
    return evidenceCache.get(p)!;
  };

  for (const r of rows) {
    const at = `line ${r.line} ${r.id || "(no id)"}`;
    if (!r.id) errors.push(`${at}: empty Requirement ID`);
    else if (seen.has(r.id)) errors.push(`${at}: duplicate Requirement ID (first on line ${seen.get(r.id)})`);
    else seen.set(r.id, r.line);

    const status = r.status as Status;
    if (!STATUSES.includes(status)) { errors.push(`${at}: status "${r.status}" is not one of ${STATUSES.join(", ")}`); continue; }

    const { refs, malformed } = parseTestIds(r.testIds);
    for (const m of malformed) errors.push(`${at}: malformed test ID \`${m}\` (expected tests/<file>.test.ts::<describe or it title>)`);

    if (status === "verified" || status === "operationally proven") {
      if (!refs.length) errors.push(`${at}: "${status}" needs a UAT/test ID`);
      for (const ref of refs) { const why = resolveTestRef(ref, fs); if (why) errors.push(`${at}: ${why}`); }
    }

    if (status === "verified") {
      const commit = COMMIT.exec(r.evidence)?.[0];
      const paths = evidencePaths(r.evidence);
      if (!commit || !paths.length) errors.push(`${at}: "verified" needs an evidence artifact and the tested commit`);
      for (const p of paths) {
        if (!/^[\w.-]+\//.test(p) || /^https?:/.test(p)) continue;               // not a repository path
        if (!fs.exists(p)) { errors.push(`${at}: evidence artifact ${p} does not exist`); continue; }
        if (!p.endsWith(".json")) continue;
        const ev = loadEvidence(p);
        if (typeof ev === "string") { errors.push(`${at}: ${ev}`); continue; }
        if (commit && !ev.commit.startsWith(commit) && !commit.startsWith(ev.commit)) errors.push(`${at}: evidence ${p} is for commit ${ev.commit}, the row cites ${commit}`);
        for (const ref of refs) {
          const tests = coveredBy(ev, ref);
          if (!tests.length) errors.push(`${at}: evidence ${p} has no result for ${ref.file}::${ref.title}`);
          else if (tests.some((t) => t.status !== "passed")) errors.push(`${at}: evidence ${p} records ${ref.file}::${ref.title} as ${[...new Set(tests.map((t) => t.status))].join("/")}, not passed`);
        }
      }
    }
    if (status === "operationally proven" && !r.evidence.replace(/[—\-\s]/g, "")) errors.push(`${at}: "operationally proven" needs observed operation or recovery evidence`);

    if (unassigned(r.businessOwner)) {
      if (status === "finance-approved" || status === "operationally proven") errors.push(`${at}: "${status}" while the business owner is unassigned (${r.businessOwner || "empty"})`);
      if (signedOff(r.signOff)) errors.push(`${at}: finance sign-off "${r.signOff}" while the business owner is unassigned (${r.businessOwner || "empty"})`);
    }
  }
  return errors;
}

// ------------------------------------------------------------------------------------------ --run

export function referencedFiles(rows: Row[]): string[] {
  return [...new Set(rows.flatMap((r) => parseTestIds(r.testIds).refs.map((t) => t.file)))].sort();
}

interface VitestJson { numPassedTests: number; numFailedTests: number; numPendingTests: number; numTodoTests: number;
  testResults: { name: string; status: string; message?: string; assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[] }

export function runReferencedTests(rows: Row[], root: string, writeEvidence?: string): string[] {
  const files = referencedFiles(rows);
  const errors: string[] = [];
  if (!files.length) return ["--run: the register references no test files"];
  const out = join(mkdtempSync(join(tmpdir(), "register-")), "vitest.json");
  const configs = [...new Set(files.map((f) => (f.startsWith("review/") ? "review/vitest.config.ts" : "vitest.config.ts")))];
  const evidence: EvidenceFile["results"] = [];
  const summary = { passed: 0, failed: 0, skipped: 0 };
  const commands: string[] = [];
  for (const config of configs) {
    const group = files.filter((f) => (config.startsWith("review/") ? f.startsWith("review/") : !f.startsWith("review/")));
    const args = ["vitest", "run", "--config", config, "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile=${out}`, ...group];
    commands.push(`npx ${args.join(" ")}`);
    console.log(`> npx ${args.join(" ")}`);
    const res = spawnSync("npx", args, { cwd: root, stdio: "inherit", env: process.env });
    if (!existsSync(out)) { errors.push(`--run: vitest produced no results (exit ${res.status})`); continue; }
    const json = JSON.parse(readFileSync(out, "utf8")) as VitestJson;
    for (const f of json.testResults) {
      const file = f.name.startsWith(root) ? f.name.slice(root.length + 1) : f.name;
      if (f.status === "failed" && !f.assertionResults.length) errors.push(`--run: ${file} failed to load: ${f.message ?? ""}`.trim());
      for (const a of f.assertionResults) {
        const status = a.status === "pending" || a.status === "todo" ? "skipped" : a.status;
        evidence.push({ file, ancestors: a.ancestorTitles, title: a.title, status });
        if (status === "passed") summary.passed++; else if (status === "failed") summary.failed++; else summary.skipped++;
        if (status === "failed") errors.push(`--run: failed ${file} > ${[...a.ancestorTitles, a.title].join(" > ")}`);
      }
    }
  }
  const ev: EvidenceFile = { commit: git(root, "rev-parse", "HEAD"), dirty: git(root, "status", "--porcelain").length > 0,
    ranAt: new Date().toISOString(), command: commands.join(" && "), summary, results: evidence };
  for (const r of rows.filter((r) => r.status === "verified" || r.status === "operationally proven")) {
    for (const ref of parseTestIds(r.testIds).refs) {
      const tests = coveredBy(ev, ref);
      if (!tests.length) errors.push(`--run: ${r.id}: ${ref.file}::${ref.title} did not run`);
      else if (tests.some((t) => t.status !== "passed")) errors.push(`--run: ${r.id}: ${ref.file}::${ref.title} did not pass (${[...new Set(tests.map((t) => t.status))].join("/")})`);
    }
  }
  console.log(`--run: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped in ${files.length} referenced file(s) at ${ev.commit}${ev.dirty ? " (uncommitted changes)" : ""}`);
  if (writeEvidence) { writeFileSync(resolve(root, writeEvidence), JSON.stringify(ev, null, 1) + "\n"); console.log(`--run: evidence written to ${writeEvidence}`); }
  return errors;
}

const git = (root: string, ...args: string[]) => {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return "unknown"; }
};

// ------------------------------------------------------------------------------------------ CLI

export const repoFs = (root: string): Fs => ({
  exists: (p) => existsSync(resolve(root, p)),
  read: (p) => readFileSync(resolve(root, p), "utf8"),
});

export function main(argv: string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const registerPath = argv.find((a, i) => argv[i - 1] === "--register") ?? "requirements/register.md";
  const writeEvidence = argv.find((a, i) => argv[i - 1] === "--write-evidence");
  const fs = repoFs(root);
  if (!fs.exists(registerPath)) { console.error(`register: ${registerPath} not found`); return 1; }
  const { rows, errors } = parseRegister(fs.read(registerPath));
  errors.push(...checkRegister(rows, fs));
  const counts = STATUSES.map((s) => `${s} ${rows.filter((r) => r.status === s).length}`).join(", ");
  console.log(`register: ${rows.length} rows (${counts})`);
  if (argv.includes("--run")) errors.push(...runReferencedTests(rows, root, writeEvidence));
  for (const e of errors) console.error(`register: ${e}`);
  console.log(errors.length ? `register: FAILED, ${errors.length} problem(s)` : "register: OK");
  return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
