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
 *   ops verify [--full] [--tenant t]              link chains and digests from each stream's verified checkpoint
 *                                                 (--full: from the first event); moves checkpoints of clean streams
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
import { Cell } from "./cell.ts";
import { OpsAdmin } from "./ops-admin.ts";

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
    case "verify": {
      const v = await ops.verify({ full: args.includes("--full"), tenantId: flag("--tenant") });
      print(v); process.exitCode = v.problems.length ? 1 : 0;
      break;
    }
    default:
      console.error("ops commands: status, dead-letters, retry, discard, gaps, check, rebuild, prune-outbox, certify, snapshots, reproduce, verify, bus-consumers");
      process.exitCode = 2;
  }
} finally {
  await owner.end();
  await cell.close();
}
