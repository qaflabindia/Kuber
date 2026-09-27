/**
 * Operational commands (F12, F15). Run with `pnpm ops <command>` or `./kuber run --rm tools ops <command>`.
 *
 *   ops status                                    outbox backlog, open dead letters, unprocessed events, report lag per book
 *   ops dead-letters [--all] [--consumer c] [--tenant t]
 *   ops retry <id|all> [--consumer c] [--tenant t]  re-run the handler on the event read from PostgreSQL
 *   ops discard <id> --reason "…"                 close a dead letter without processing it
 *   ops gaps [--consumer c]                       events a consumer has not processed (older than 1 min)
 *   ops check <reporting|agent|evidence> [--tenant t]   projection vs event store (balances, counts, gaps)
 *   ops rebuild <reporting|agent|evidence> [--tenant t] truncate + replay from the event store, then check
 *   ops prune-outbox                              delete published outbox rows past the bus retention
 *   ops certify <tenant> <book> <trial-balance|profit-and-loss|balance-sheet> [--from d] [--to d] [--as-of d] [--timeout ms]
 *   ops snapshots <tenant> [book]                 list certified report snapshots
 *   ops reproduce <tenant> <snapshotId>           recompute a certified report at its ledger position and compare
 *   ops bus-consumers [--prune] [--force]         durable consumers on the cell's NATS stream: expected ones for
 *                                                 KUBER_BUS_PARTITIONS, pending counts, stale ones (un-suffixed
 *                                                 <module>, lanes beyond the partition count); --prune deletes stale
 *                                                 ones whose pending messages are processed (es.inbox), --force all stale
 *   ops backfill-confirmations [--tenant t]       emit ProvisionalConfirmed for confirmations the GL never heard of
 *                                                 (databases from before propagation); idempotent
 *   ops verify [--full] [--tenant t]              link chains and digests from each stream's verified checkpoint
 *                                                 (--full: from the first event); moves checkpoints of clean streams
 *   ops verify-signatures [--tenant t]          re-verify every stored command signature (design 14.4/16.4) offline against
 *                                                 the stored public key and its event's command digest; lists development
 *                                                 confirmations (not signatures) and period operations committed unsigned;
 *                                                 exit 1 when any signature fails (also: keys ops verify-signatures)
 *   ops run-schedules [--as-of d] [--tenant t]    post approved recurring / recognition schedule occurrences due on or
 *                                                 before d (default today) once each, as system:scheduler; locked periods
 *                                                 become exception cases (FIN-GL-02/03); idempotent and safe to run concurrently
 *
 * Finance controls (writes act as a member, `--as <principal>`, and pass the same authorization as the API):
 *   ops access-review [--tenant t] [--since d] [--dormant-days n]      FIN-MDM-05: removed and dormant members,
 *                                                 role/scope changes and every identity change, with dispositions
 *   ops access-review dispose <tenant> <itemId> --decision appropriate|revoke|investigate|accepted --note "…" --as p
 *   ops autonomy [status] [--tenant t]            FIN-OPS-03: kill-switch state and autonomous errors per period
 *   ops autonomy halt|resume <tenant> [--book b] [--scope autonomy|copilot] --reason "…" --as p
 *                                                 the kill switch: scope autonomy (default, FIN-OPS-03, owner/controller)
 *                                                 or copilot (AGT-09: the model-driven copilot only; System Owner)
 *   ops agent-turns [--tenant t] [--book b] [--since d] [--limit n]   TOL-05/AGT-07: recorded copilot turns (hashes, counts)
 *   ops agent-signals [--tenant t] [--since d]     TAGOF Part VII: copilot monitoring signals per month (also in ops status)
 *   ops incident list <tenant> [--status s] | show <tenant> <id>        FIN-OPS-02: the incident register
 *   ops incident open <tenant> --title "…" --description "…" --books a,b --periods 2026-10 --loss <paise>
 *                    [--duplication] --owner p --as p
 *   ops incident update <tenant> <id> [--containment "…"] [--corrections j1,j2] [--owner p] [--note "…"] --as p
 *   ops incident close <tenant> <id> --reconciliation <ref> [--note "…"] --as p   (not the incident's owner)
 *   ops bank …                                    FIN-CASH-01..03 bank accounts, statements, coverage, reconciliation, certify (bank-cli.ts)
 *   ops consolidate …                             FIN-GRP-01..04 group consolidation: groups, register plans, run, certify,
 *                                                 group reports, IC disputes, linked tenants (see group-cli.ts)
 *   ops drill-compare --source <owner url> --restored <owner url> [--out file] [--meta json]
 *                                                 FIN-OPS-01: compare a restored database with its source
 *                                                 (used by scripts/restore-drill.sh); exit 1 on any difference
 *
 * It starts a cell with the in-memory bus and no relay: handlers run here, events they append are
 * published by the running core's relay. Environment as for the core: DATABASE_URL, MIGRATION_URL
 * (owner; required: rebuild deletes projection rows), SYSTEM_DATABASE_URL, KUBER_MASTER_KEY_FILE,
 * POLICY_DIR, CELL_ID, KUBER_BUS_RETENTION_DAYS; bus-consumers also NATS_URL, NATS_TLS_CA, NATS_TOKEN,
 * KUBER_BUS_PARTITIONS.
 */
import postgres from "postgres";
import { LocalFileKms } from "@kuber/crypto";
import { NatsConsumerAdmin, busPartitions, streamNameFor } from "@kuber/bus";
import { renderText, type CertifiableKind } from "@kuber/reporting";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REVIEW_DECISIONS, SWITCH_SCOPES, type ReviewDecision, type SwitchScope } from "@kuber/identity";
import { Cell } from "./cell.ts";
import { OpsAdmin } from "./ops-admin.ts";
import { groupCommand } from "./group-cli.ts";
import { bankCommand } from "./bank-cli.ts";

const argv = process.argv.slice(2);
if (argv[0] === "ops") argv.shift();
const [cmd, ...args] = argv;
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && args[i - 1] !== "--all"));
const operator = process.env.USER ? `operator:${process.env.USER}` : "operator";
const print = (x: unknown) => console.log(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const ownerUrl = need("MIGRATION_URL");
const cell = await Cell.start({
  databaseUrl: process.env.DATABASE_URL ?? ownerUrl, migrationUrl: ownerUrl, appRole: process.env.APP_ROLE,
  systemDatabaseUrl: process.env.SYSTEM_DATABASE_URL, cellId: process.env.CELL_ID ?? "local", bus: "memory",
  policyDir: process.env.POLICY_DIR ?? "./policies",
  kms: LocalFileKms.load(need("KUBER_MASTER_KEY_FILE"), { strictPermissions: process.env.KUBER_KEY_FILE_STRICT !== "false" }),
  poolSize: 3,
});
const owner = postgres(ownerUrl, { max: 2, onnotice: () => undefined });
const ops = new OpsAdmin(owner, cell, { busRetentionMs: Number(process.env.KUBER_BUS_RETENTION_DAYS ?? "7") * 86_400_000 });

try {
  switch (cmd) {
    case "status": print(await ops.status()); break;
    case "dead-letters": print(await ops.deadLetters({ status: args.includes("--all") ? "all" : "open", consumer: flag("--consumer"), tenantId: flag("--tenant") })); break;
    case "retry": {
      const id = positional[0]; if (!id) throw new Error("usage: ops retry <id|all>");
      const r = id === "all" ? await ops.retryAll(operator, { consumer: flag("--consumer"), tenantId: flag("--tenant") }) : [await ops.retry(id, operator)];
      print(r); process.exitCode = r.every((x) => x.ok) ? 0 : 1;
      break;
    }
    case "discard": {
      const id = positional[0], reason = flag("--reason");
      if (!id || !reason) throw new Error('usage: ops discard <id> --reason "why"');
      await ops.discard(id, operator, reason); console.log(`discarded ${id}`);
      break;
    }
    case "gaps": print(await ops.gaps(60_000, flag("--consumer"))); break;
    case "check": case "rebuild": {
      const name = positional[0]; if (!name) throw new Error(`usage: ops ${cmd} <reporting|agent|evidence> [--tenant t]`);
      const r = cmd === "check" ? await ops.check(name, flag("--tenant"))
        : await ops.rebuild(name, flag("--tenant"), (t, n) => process.stderr.write(`\r${name} ${t}: ${n} event(s) replayed`));
      if (cmd === "rebuild") process.stderr.write("\n");
      print(r);
      process.exitCode = r.every((x) => ("check" in x ? x.check.ok : (x as { ok: boolean }).ok)) ? 0 : 1;
      break;
    }
    case "prune-outbox": console.log(`pruned ${await ops.pruneOutbox()} published outbox row(s)`); break;
    case "certify": {
      const [tenant, book, kind] = positional as [string, string, CertifiableKind];
      if (!tenant || !book || !["trial-balance", "profit-and-loss", "balance-sheet"].includes(kind)) throw new Error("usage: ops certify <tenant> <book> <trial-balance|profit-and-loss|balance-sheet> [--from d] [--to d] [--as-of d]");
      const s = await cell.reporting.certify(tenant, book, kind, { from: flag("--from") ?? null, to: flag("--to") ?? null, asOf: flag("--as-of") ?? null }, operator,
        { freshness: "wait", timeoutMs: Number(flag("--timeout") ?? "30000") });
      console.log(`certified ${s.snapshotId} at journal ${s.seq} (ledger hash ${s.ledgerHash}); content hash ${s.contentHash}`);
      break;
    }
    case "snapshots": {
      const [tenant, book] = positional; if (!tenant) throw new Error("usage: ops snapshots <tenant> [book]");
      print(await cell.reporting.listSnapshots(tenant, book));
      break;
    }
    case "reproduce": {
      const [tenant, id] = positional; if (!tenant || !id) throw new Error("usage: ops reproduce <tenant> <snapshotId>");
      const r = await cell.reporting.reproduceSnapshot(tenant, id);
      console.log(renderText({ title: r.reproduced.title, rows: r.reproduced.rows.map((x) => ({ ...x, amount: BigInt(x.amount) })),
        totals: Object.fromEntries(Object.entries(r.reproduced.totals).map(([k, v]) => [k, BigInt(v)])) }));
      console.log(r.matches ? `REPRODUCED: content hash ${r.contentHash} matches the certified snapshot`
        : `MISMATCH: snapshot verified=${r.snapshot.verified}, ledger matches=${r.ledgerMatches}, hash ${r.contentHash} vs ${r.snapshot.contentHash}`);
      process.exitCode = r.matches ? 0 : 1;
      break;
    }
    case "backfill-confirmations": {
      const r = await ops.backfillConfirmations(flag("--tenant"));
      print(r);
      console.log(`emitted ${r.reduce((n, x) => n + x.emitted, 0)} confirmation(s) for ${r.length} tenant(s); the core's relay publishes them to the GL`);
      break;
    }
    case "bus-consumers": {
      const nats = await NatsConsumerAdmin.connect(need("NATS_URL"), streamNameFor(process.env.CELL_ID ?? "local"),
        { caFile: process.env.NATS_TLS_CA, token: process.env.NATS_TOKEN });
      try {
        const r = await ops.busConsumers(nats, { partitions: busPartitions(), prune: args.includes("--prune"), force: args.includes("--force") });
        print({ stream: nats.stream, ...r });
        // without --prune: exit 1 when something stale is left, so a deploy check can notice
        if (!args.includes("--prune") && r.consumers.some((c) => c.kind === "legacy" || c.kind === "retired_lane")) process.exitCode = 1;
        if (args.includes("--prune") && r.consumers.some((c) => (c.kind === "legacy" || c.kind === "retired_lane") && !c.deleted)) process.exitCode = 1;
      } finally { await nats.close(); }
      break;
    }
    case "run-schedules": {
      const asOf = flag("--as-of");
      if (asOf !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("usage: ops run-schedules [--as-of YYYY-MM-DD] [--tenant t]");
      const r = await ops.runSchedules(asOf, flag("--tenant"));
      print(r);
      console.log(`posted ${r.reduce((n, x) => n + x.posted.length, 0)}, reversed ${r.reduce((n, x) => n + x.reversed.length, 0)}, exceptions ${r.reduce((n, x) => n + x.exceptions.length, 0)}`);
      process.exitCode = r.some((x) => x.exceptions.length || x.skipped.length) ? 1 : 0;
      break;
    }
    case "verify": {
      const v = await ops.verify({ full: args.includes("--full"), tenantId: flag("--tenant") });
      print(v); process.exitCode = v.problems.length ? 1 : 0;
      break;
    }
    case "verify-signatures": {
      const r = await ops.verifySignatures(flag("--tenant"));
      print(r);
      const n = r.tenants.reduce((a, t) => a + t.checked, 0), bad = r.tenants.reduce((a, t) => a + t.failures.length, 0);
      console.log(bad ? `SIGNATURE FAILURES: ${bad} of ${n} stored signature(s) do not verify` : `${n} stored signature(s) verified offline`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    // ---------------------------------------------------------------- finance controls
    case "access-review": {
      if (positional[0] === "dispose") {
        const [, tenant, itemId] = positional, decision = flag("--decision") as ReviewDecision, note = flag("--note"), as = flag("--as");
        if (!tenant || !itemId || !REVIEW_DECISIONS.includes(decision) || !note || !as) throw new Error(`usage: ops access-review dispose <tenant> <itemId> --decision ${REVIEW_DECISIONS.join("|")} --note "…" --as <principal>`);
        print(await cell.identity.accessReview.dispose(tenant, as, itemId, { decision, note }));
        break;
      }
      const r = await ops.accessReview({ tenant: flag("--tenant"), since: flag("--since"), dormantDays: flag("--dormant-days") ? Number(flag("--dormant-days")) : undefined });
      print(r);
      process.exitCode = r.some((x) => x.unreviewed > 0) ? 1 : 0;           // a scheduled review can alert on open items
      break;
    }
    case "autonomy": {
      const sub = positional[0] ?? "status";
      if (sub === "status") { print(await ops.autonomy(flag("--tenant"))); break; }
      const tenant = positional[1], reason = flag("--reason"), as = flag("--as");
      const scope = (flag("--scope") ?? "autonomy") as SwitchScope;
      if ((sub !== "halt" && sub !== "resume") || !tenant || !reason || !as || !SWITCH_SCOPES.includes(scope)) throw new Error('usage: ops autonomy halt|resume <tenant> [--book b] [--scope autonomy|copilot] --reason "…" --as <principal>');
      print(await cell.identity.autonomy.set(tenant, as, { book: flag("--book") ?? null, halted: sub === "halt", reason, scope }));
      break;
    }
    case "agent-turns": {
      const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
      print(await ops.agentTurns({ tenant: flag("--tenant"), book: flag("--book"), since: flag("--since"), limit }));
      break;
    }
    case "agent-signals": {
      const r = await ops.agent(flag("--tenant"), flag("--since"));
      print(r);
      process.exitCode = r.some((t) => t.hitlBypass > 0) ? 1 : 0;           // MON-09: any HITL bypass is an incident
      break;
    }
    case "incident": {
      const [sub, tenant, id] = positional, as = flag("--as");
      const list = (k: string) => flag(k)?.split(",").map((x) => x.trim()).filter(Boolean);
      if (!sub || !tenant) throw new Error("usage: ops incident list|show|open|update|close <tenant> …");
      if (sub === "list") print(await cell.incidents.list(tenant, { status: flag("--status") as never }));
      else if (sub === "show" && id) print(await cell.incidents.get(tenant, id));
      else if (!as) throw new Error("incident changes need --as <principal>");
      else if (sub === "open") {
        print(await cell.incidents.open(tenant, as, { title: flag("--title") ?? "", description: flag("--description") ?? "", books: list("--books") ?? [],
          periods: list("--periods") ?? [], possibleLossPaise: flag("--loss") ?? "0", duplication: args.includes("--duplication"), owner: flag("--owner") ?? as }));
      } else if (sub === "update" && id) {
        print(await cell.incidents.update(tenant, as, id, { containment: flag("--containment"), corrections: list("--corrections"), owner: flag("--owner"), note: flag("--note") }));
      } else if (sub === "close" && id) {
        print(await cell.incidents.close(tenant, as, id, { reconciliationRef: flag("--reconciliation") ?? "", note: flag("--note") }));
      } else throw new Error("usage: ops incident list|show|open|update|close <tenant> …");
      break;
    }
    case "consolidate": print(await groupCommand(cell, args)); break;
    case "bank": print(await bankCommand(cell, args)); break;
    case "drill-compare": {
      const source = flag("--source"), restored = flag("--restored");
      if (!source || !restored) throw new Error("usage: ops drill-compare --source <owner url> --restored <owner url> [--out file] [--meta json]");
      const r = await OpsAdmin.compareCells(source, restored);
      const evidence = { kind: "restore-drill", ...(flag("--meta") ? { drill: JSON.parse(flag("--meta")!) } : {}), comparison: r };
      const out = flag("--out");
      if (out) { mkdirSync(dirname(out), { recursive: true, mode: 0o700 }); writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 }); }
      print({ ok: r.ok, tenants: r.tenants.map((t) => ({ tenant: t.tenant, ok: t.ok, failed: Object.entries(t.checks).filter(([, c]) => !c.ok).map(([k]) => k) })),
        missingTenants: r.missingTenants, extraTenants: r.extraTenants, ...(out ? { evidence: out } : {}) });
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    default:
      console.error("ops commands: status, dead-letters, retry, discard, gaps, check, rebuild, prune-outbox, certify, snapshots, reproduce, verify, verify-signatures, bus-consumers, backfill-confirmations, run-schedules, access-review, autonomy, agent-turns, agent-signals, incident, consolidate, bank, drill-compare");
      process.exitCode = 2;
  }
} finally {
  await owner.end();
  await cell.close();
}
