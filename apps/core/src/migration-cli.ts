/**
 * `pnpm ops migrate-…`: legacy migration commands (FIN-MIG-01..03, design 16.7). Writes act as a
 * member (`--as <principal>`) and pass the same identity guard as the API. The go-live is not
 * available here: it is a superuser's passkey-signed command (POST …/migrations/:p/go-live).
 *
 *   ops migrate-import --source tally|zoho|csv --file x.xml --book b --cutoff d [--project p] [--purpose source|delta|comparison]
 *                      [--as-of d] [--scope masters,opening_balances,…] --tenant t --as p
 *                      creates the project if needed, then parses and retains the file; prints the inventory
 *   ops migrate-status <tenant> <project>                 project, files, inventory, mapping summary, loads, decisions
 *   ops migrate-mapping <tenant> <project>                source ledgers, suggestions, approvals, cut-off balances
 *   ops migrate-approve <tenant> <project> (--all-suggested | --map "Ledger=ACCOUNT" …) --as p
 *   ops migrate-plan <tenant> <project>                   the load plan and its blocking problems
 *   ops migrate-rehearse <tenant> <project> --as p        load into an isolated rehearsal book and reconcile
 *   ops migrate-load <tenant> <project> --as p            load the target book (pre-cutover)
 *   ops migrate-delta <tenant> <project> [--load l] [--as-of d] --as p     vouchers after the cut-off (idempotent)
 *   ops migrate-reconcile <tenant> <project> [--load l]
 *   ops migrate-coverage <tenant> <project> [--as-of d]
 *   ops migrate-decide <tenant> <project> --kind authority|fallback --processes '<json array>' [--until d] --as p
 *   ops migrate-compare <tenant> <project> --from d --to d --as p
 *   ops migrate-explain <tenant> <project> <comparisonId> --key k --category c --note "…" --as p
 *   ops migrate-rollback <tenant> <project> <loadId> --reason "…" --as p
 *   ops migrate-recovery <tenant> <project>
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { MAX_FILE_CHARS, type SourceSystem } from "@kuber/migration";
import type { Cell } from "./cell.ts";

export const MIGRATION_CLI_USAGE = "usage: ops migrate-import|migrate-status|migrate-mapping|migrate-approve|migrate-plan|migrate-rehearse|migrate-load|migrate-delta|migrate-reconcile|migrate-coverage|migrate-decide|migrate-compare|migrate-explain|migrate-rollback|migrate-recovery …";

export async function migrationCommand(cell: Cell, cmd: string, args: string[]): Promise<unknown> {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const flags = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));
  const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && args[i - 1] !== "--all-suggested"));
  const as = () => { const v = flag("--as"); if (!v) throw new Error("this command acts as a member: --as <principal>"); return v; };
  const m = cell.migration;
  const [a1, a2, a3] = pos;
  const need2 = () => { if (!a1 || !a2) throw new Error(`usage: ops ${cmd} <tenant> <project> …`); return [a1, a2] as const; };
  switch (cmd) {
    case "migrate-import": {
      const tenant = flag("--tenant"), source = flag("--source") as SourceSystem | undefined, file = flag("--file"), book = flag("--book"), cutoff = flag("--cutoff");
      if (!tenant || !source || !file || !book || !cutoff) throw new Error("usage: ops migrate-import --source tally|zoho|csv --file x --book b --cutoff d --tenant t --as p");
      if (statSync(file).size > MAX_FILE_CHARS * 2) throw new Error(`${file} is larger than ${MAX_FILE_CHARS * 2} bytes`);
      const principal = as();
      const projectId = flag("--project") ?? `mig-${book}-${cutoff}`;
      if (!(await m.project(tenant, projectId))) await m.createProject(tenant, principal, { projectId, bookId: book, sourceSystem: source, cutoff, ...(flag("--scope") ? { scope: flag("--scope")!.split(",") } : {}) });
      const bytes = readFileSync(file);
      return m.importFile(tenant, principal, projectId, { name: basename(file), content: bytes.toString("base64"), encoding: "base64",
        purpose: (flag("--purpose") as "source" | "delta" | "comparison" | undefined) ?? "source", ...(flag("--as-of") ? { asOf: flag("--as-of")! } : {}) });
    }
    case "migrate-status": { const [t, p] = need2(); return m.view(t, p); }
    case "migrate-mapping": { const [t, p] = need2(); return m.mapping(t, p); }
    case "migrate-approve": {
      const [t, p] = need2();
      const rows = flags("--map").map((kv) => { const i = kv.lastIndexOf("="); if (i < 1) throw new Error(`--map "Ledger=ACCOUNT", not ${kv}`); return { sourceKey: kv.slice(0, i), accountId: kv.slice(i + 1) }; });
      return m.approveMapping(t, as(), p, { ...(rows.length ? { rows } : {}), ...(args.includes("--all-suggested") ? { acceptSuggested: true as const } : {}) });
    }
    case "migrate-plan": { const [t, p] = need2(); return m.planView(await m.plan(t, p)); }
    case "migrate-rehearse": { const [t, p] = need2(); return m.rehearse(t, as(), p); }
    case "migrate-load": { const [t, p] = need2(); return m.load(t, as(), p); }
    case "migrate-delta": { const [t, p] = need2(); return m.delta(t, as(), p, { ...(flag("--load") ? { loadId: flag("--load")! } : {}), ...(flag("--as-of") ? { asOf: flag("--as-of")! } : {}) }); }
    case "migrate-reconcile": { const [t, p] = need2(); return m.reconciliation(t, p, flag("--load")); }
    case "migrate-coverage": { const [t, p] = need2(); return m.coverage(t, p, flag("--as-of") ? { asOf: flag("--as-of")! } : {}); }
    case "migrate-decide": {
      const [t, p] = need2();
      const kind = flag("--kind");
      if (kind !== "authority" && kind !== "fallback") throw new Error("--kind authority|fallback");
      return m.recordDecision(t, as(), p, { kind, processes: JSON.parse(flag("--processes") ?? "[]"), ...(flag("--note") ? { note: flag("--note")! } : {}), ...(flag("--until") ? { until: flag("--until")! } : {}) });
    }
    case "migrate-compare": { const [t, p] = need2(); return m.compare(t, as(), p, { from: flag("--from") ?? "", to: flag("--to") ?? "" }); }
    case "migrate-explain": {
      const [t, p] = need2();
      if (!a3) throw new Error("usage: ops migrate-explain <tenant> <project> <comparisonId> --key k --category c --note \"…\" --as p");
      return m.explain(t, as(), p, a3, { key: flag("--key") ?? "", category: flag("--category") ?? "", note: flag("--note") ?? "" });
    }
    case "migrate-rollback": {
      const [t, p] = need2();
      if (!a3) throw new Error("usage: ops migrate-rollback <tenant> <project> <loadId> --reason \"…\" --as p");
      return m.rollback(t, as(), p, { loadId: a3, reason: flag("--reason") ?? "" });
    }
    case "migrate-recovery": { const [t, p] = need2(); return m.recovery(t, p); }
    default: throw new Error(MIGRATION_CLI_USAGE);
  }
}
