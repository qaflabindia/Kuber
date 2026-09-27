/**
 * Statement mappings (FIN-RPT-01). An account's statement mapping (its taxonomy tag, FIN-MDM-02)
 * is grouped into statement lines by the mapping that belongs to the book's framework label. A
 * mapping is data (modules/reporting/src/mappings/*.json), validated when loaded; the illustrative
 * Schedule III template ships with status "illustrative" and needs CA review before statements
 * prepared with it can be certified.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, sha256 } from "@kuber/contracts";

export type CashFlowClass = "cash" | "operating" | "investing" | "financing" | "noncash";
export interface MappingLine {
  key: string; statement: "BS" | "PL"; group?: string; section: string; label: string; side: "debit" | "credit";
  /** Balance-sheet lines: how the line's movement appears in the cash-flow statement. */
  cashFlow?: CashFlowClass;
  current?: boolean; equity?: boolean;
  /** The equity line that holds profit not yet closed into reserves (at most one). */
  profit?: boolean;
  inventory?: boolean;
  /** A non-zero balance on this line blocks certification, with this reason. */
  blockIfNonZero?: string;
}
export interface StatementMapping {
  id: string; version: number; status: "illustrative" | "approved"; title: string; reviewNote: string;
  /** Book framework labels (FIN-MDM-01) this mapping serves. */
  frameworks: string[];
  lines: MappingLine[];
  /** Account taxonomy tag -> line key. */
  tags: Record<string, string>;
}
export interface AccountInfo { accountId: string; name: string; nature: string; parentId?: string | null; taxonomyTag?: string | null }
export interface Mapped { account: AccountInfo; line: MappingLine }
export interface Unmapped { account: AccountInfo; reason: string }

const PL_NATURES = new Set(["income", "expense"]);

/** Problems with a mapping definition (empty when it is valid). */
export function validateMapping(m: unknown): string[] {
  const out: string[] = [];
  const o = m as Partial<StatementMapping>;
  if (!o || typeof o !== "object") return ["mapping is not an object"];
  if (typeof o.id !== "string" || !/^[a-z0-9-]+$/.test(o.id)) out.push("id: lower-case letters, digits and dashes");
  if (!Number.isInteger(o.version) || (o.version as number) < 1) out.push("version: a positive integer");
  if (o.status !== "illustrative" && o.status !== "approved") out.push("status: illustrative or approved");
  if (typeof o.title !== "string" || !o.title) out.push("title required");
  if (typeof o.reviewNote !== "string") out.push("reviewNote required");
  if (!Array.isArray(o.frameworks) || !o.frameworks.length || o.frameworks.some((f) => typeof f !== "string" || !f)) out.push("frameworks: non-empty list of labels");
  if (!Array.isArray(o.lines) || !o.lines.length) { out.push("lines: non-empty list"); return out; }
  const keys = new Set<string>();
  let profit = 0, cash = 0;
  for (const [i, l] of o.lines.entries()) {
    const at = `lines[${i}]`;
    if (typeof l.key !== "string" || !l.key) { out.push(`${at}.key required`); continue; }
    if (keys.has(l.key)) out.push(`${at}: duplicate key ${l.key}`);
    keys.add(l.key);
    if (l.statement !== "BS" && l.statement !== "PL") out.push(`${l.key}: statement BS or PL`);
    if (l.side !== "debit" && l.side !== "credit") out.push(`${l.key}: side debit or credit`);
    if (typeof l.label !== "string" || !l.label || typeof l.section !== "string" || !l.section) out.push(`${l.key}: label and section required`);
    if (l.statement === "BS" && !["cash", "operating", "investing", "financing", "noncash"].includes(l.cashFlow as string)) out.push(`${l.key}: a balance-sheet line needs cashFlow (cash, operating, investing, financing, noncash)`);
    if (l.statement === "PL" && !["Income", "Expenses", "Tax expense"].includes(l.section)) out.push(`${l.key}: a P&L line's section is Income, Expenses or Tax expense`);
    if (l.profit) { profit++; if (!l.equity) out.push(`${l.key}: the profit line must be an equity line`); }
    if (l.cashFlow === "cash") cash++;
  }
  if (profit !== 1) out.push("exactly one equity line must hold profit (profit: true)");
  if (cash < 1) out.push("at least one line must be cash and cash equivalents (cashFlow: cash)");
  if (!o.tags || typeof o.tags !== "object") out.push("tags: object of taxonomy tag -> line key");
  else for (const [t, k] of Object.entries(o.tags)) if (!keys.has(k)) out.push(`tags.${t}: unknown line ${k}`);
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAPPINGS_DIR = join(HERE, "..", "mappings");

/** Every mapping file in the directory, validated (throws listing the problems). */
export function loadMappings(dir = MAPPINGS_DIR): StatementMapping[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const problems = validateMapping(m);
    if (problems.length) throw new Error(`mapping ${f}: ${problems.join("; ")}`);
    return m as StatementMapping;
  });
}

export const mappingHash = (m: StatementMapping) => sha256(canonical(m));
export const mappingLabel = (m: StatementMapping) => `${m.id} v${m.version} (${m.status === "approved" ? "approved" : "illustrative, needs CA review"})`;

/** The mapping for a framework label: an approved one first, then an illustrative one; null when none serves it. */
export function mappingFor(mappings: StatementMapping[], framework: string): StatementMapping | null {
  const f = framework.trim().toLowerCase();
  const serving = mappings.filter((m) => m.frameworks.some((x) => x.toLowerCase() === f));
  return serving.find((m) => m.status === "approved") ?? serving[0] ?? null;
}

/** Each account's line, or why it has none (no tag, a tag the mapping does not know, or a statement/nature mismatch). */
export function resolveAccounts(m: StatementMapping, accounts: AccountInfo[]): { mapped: Map<string, Mapped>; unmapped: Map<string, Unmapped> } {
  const lines = new Map(m.lines.map((l) => [l.key, l]));
  const mapped = new Map<string, Mapped>(), unmapped = new Map<string, Unmapped>();
  for (const a of accounts) {
    const tag = a.taxonomyTag ?? null;
    const key = tag ? m.tags[tag] : undefined;
    const line = key ? lines.get(key) : undefined;
    if (!tag) { unmapped.set(a.accountId, { account: a, reason: "the account has no statement mapping (taxonomy tag)" }); continue; }
    if (!line) { unmapped.set(a.accountId, { account: a, reason: `statement mapping ${tag} is not in ${m.id} v${m.version}` }); continue; }
    const pl = PL_NATURES.has(a.nature);
    if (pl !== (line.statement === "PL")) {
      unmapped.set(a.accountId, { account: a, reason: `${tag} maps to "${line.label}", a ${line.statement === "PL" ? "profit and loss" : "balance sheet"} line, but the account is ${a.nature}` });
      continue;
    }
    mapped.set(a.accountId, { account: a, line });
  }
  return { mapped, unmapped };
}
