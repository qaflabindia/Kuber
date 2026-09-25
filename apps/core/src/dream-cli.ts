/**
 * Dream-RSI offline policy improvement (design 7.2). Run with `pnpm dream <command>`.
 *
 *   dream run --family autonomy --tenant t --book b --from d --to d [--seed 7] [--iterations 200] [--episodes 200] [--unsafe-cap n]
 *        extract the tenant's replay pool (refused unless the owner opted in), dream per action type, write
 *        requirements/evidence/dream-autonomy-<tenant>-<date>.{json,md}; a winner becomes a proposal (nothing changes yet)
 *   dream run --family routing --tenant t --turns <fixture.json> [--seed 7] [--iterations 200]
 *        dream over copilot turn records; a winner becomes agent/artifacts/routing-policy.<n>.json with approvedBy null
 *        (turn records from the event store arrive with ws5/agent-gov; until then pass a fixture)
 *   dream proposals [--tenant t] [--status proposed|approved|rejected]
 *   dream approve <id> --as <principal> [--tenant t]      needs autonomy.manage for the book; applies the thresholds
 *   dream reject <id> --as <principal> --reason "…" [--tenant t]
 *
 * Environment as for `pnpm ops`: MIGRATION_URL (owner), DATABASE_URL, SYSTEM_DATABASE_URL, KUBER_MASTER_KEY_FILE, POLICY_DIR, CELL_ID;
 * KUBER_DREAM_EVIDENCE_DIR / KUBER_DREAM_ARTIFACTS_DIR override requirements/evidence and agent/artifacts.
 */
import { LocalFileKms } from "@kuber/crypto";
import { FixtureTurnAdapter } from "@kuber/dream-rsi";
import { Cell } from "./cell.ts";

const argv = process.argv.slice(2);
if (argv[0] === "dream") argv.shift();
const [cmd, ...args] = argv;
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const req = (name: string) => { const v = flag(name); if (!v) throw new Error(`missing ${name}`); return v; };
const int = (name: string, dflt: number) => { const v = flag(name); if (v === undefined) return dflt; const n = Number(v); if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`); return n; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));

const ownerUrl = need("MIGRATION_URL");
const cell = await Cell.start({
  databaseUrl: process.env.DATABASE_URL ?? ownerUrl, migrationUrl: ownerUrl, appRole: process.env.APP_ROLE,
  systemDatabaseUrl: process.env.SYSTEM_DATABASE_URL, cellId: process.env.CELL_ID ?? "local", bus: "memory",
  policyDir: process.env.POLICY_DIR ?? "./policies",
  kms: LocalFileKms.load(need("KUBER_MASTER_KEY_FILE"), { strictPermissions: process.env.KUBER_KEY_FILE_STRICT !== "false" }),
  poolSize: 3,
  dream: { evidenceDir: process.env.KUBER_DREAM_EVIDENCE_DIR, artifactsDir: process.env.KUBER_DREAM_ARTIFACTS_DIR },
});

async function tenantOf(id: string) {
  const t = flag("--tenant");
  if (t) return t;
  const hit = (await cell.dream.allProposals()).find((p) => p.proposalId === id);
  if (!hit) throw new Error(`no proposal ${id}`);
  return hit.tenant;
}

try {
  switch (cmd) {
    case "run": {
      const family = req("--family"), tenant = req("--tenant");
      const common = { seed: int("--seed", 7), iterations: int("--iterations", 200), episodes: int("--episodes", 200) };
      if (family === "autonomy") {
        const cap = flag("--unsafe-cap");
        const r = await cell.dream.runAutonomy({ ...common, tenant, book: req("--book"), from: req("--from"), to: req("--to"),
          unsafeCap: cap === undefined ? undefined : Number(cap) });
        print({ decision: r.report.decision, reportHash: r.report.reportHash, poolSliceHash: r.report.pool.sliceHash, evidence: r.files,
          proposal: r.proposal ? { proposalId: r.proposal.proposalId, segments: r.proposal.segments.map((s) => ({ actionType: s.actionType, diff: s.diff, score: s.score })) } : null,
          segments: r.report.segments.map((s) => ({ segment: s.segment, skipped: s.skipped, decision: s.result?.decision, reasons: s.result?.reasons })) });
      } else if (family === "routing") {
        const turns = flag("--turns");
        if (!turns) throw new Error("routing needs --turns <fixture.json>: turn records from the event store arrive with ws5/agent-gov (AgentTurnRecorded)");
        const r = await cell.dream.runRouting({ ...common, tenant, adapter: FixtureTurnAdapter.fromFile(turns) });
        print({ decision: r.report.decision, reportHash: r.report.reportHash, evidence: r.files, artifact: r.artifact, reasons: r.result.reasons });
      } else throw new Error("--family must be autonomy or routing");
      break;
    }
    case "proposals": {
      const status = flag("--status") as "proposed" | "approved" | "rejected" | undefined;
      const t = flag("--tenant");
      print(t ? await cell.dream.proposals(t, status) : await cell.dream.allProposals(status));
      break;
    }
    case "approve": case "reject": {
      const id = positional[0]; if (!id) throw new Error(`usage: dream ${cmd} <id> --as <principal>`);
      const as = req("--as"), tenant = await tenantOf(id);
      print(cmd === "approve" ? await cell.dream.approve(tenant, id, as) : await cell.dream.reject(tenant, id, as, req("--reason")));
      break;
    }
    default:
      console.error("usage: dream run --family autonomy|routing … | proposals | approve <id> --as <principal> | reject <id> --as <principal> --reason …");
      process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await cell.close();
}
