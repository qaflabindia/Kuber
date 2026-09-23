/**
 * A cell: one complete, independent Kuber stack for a set of tenants (design section 16.6).
 * In phase 0 every module runs in this one process, but modules talk only through events on
 * the bus and never read each other's tables.
 */
import postgres, { type Sql } from "postgres";
import { EVENTSTORE_MIGRATIONS, EventStore, OutboxRelay, appGrants, migrate, openEnvelope, type LegacyPolicy } from "@kuber/eventstore";
import { Keyring, type Kms } from "@kuber/crypto";
import type { Envelope } from "@kuber/contracts";
import { MemoryBus, NatsBus, type Bus } from "@kuber/bus";
import { GeneralLedger } from "@kuber/gl";
import { PolicyEngine } from "@kuber/policy";
import { Channels } from "@kuber/channels";
import { AGENT_MIGRATIONS, Agent, type LlmClassifier } from "@kuber/agent";
import { REPORTING_MIGRATIONS, Reporting } from "@kuber/reporting";
import { OPS_MIGRATIONS, Operations } from "@kuber/ops";

export interface CellOptions {
  /** Application connection: must be a role without SUPERUSER or BYPASSRLS, or tenant isolation does not apply. */
  databaseUrl: string;
  /** Owner connection used only for migrations and grants. Defaults to databaseUrl (development only). */
  migrationUrl?: string;
  /** Application role name to grant privileges to after migrating. */
  appRole?: string;
  cellId?: string;
  bus?: "memory" | { natsUrl: string; caFile?: string; retentionDays?: number; token?: string };
  policyDir: string;
  /** Key management service holding the master key(s). Required: there is no unencrypted mode. */
  kms: Kms;
  /** Rows written before encryption: "reject" (default) or "allow" while migrating. */
  legacy?: LegacyPolicy;
  clock?: () => string;
  poolSize?: number;
  /** Optional LLM step in classification; without it unmatched transactions go to suspense. */
  classifier?: LlmClassifier;
}

/** Apply every module's migrations as the owner, then grant the application role its privileges. */
export async function migrateCell(ownerUrl: string, appRole?: string) {
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(owner, [...EVENTSTORE_MIGRATIONS, ...AGENT_MIGRATIONS, ...REPORTING_MIGRATIONS, ...OPS_MIGRATIONS]);
    if (appRole) await owner.unsafe(appGrants(appRole, ["es", "agent", "reporting", "ops", "keys"]));
  } finally { await owner.end(); }
}

export class Cell {
  private constructor(
    public readonly cellId: string, public readonly sql: Sql, public readonly store: EventStore, public readonly bus: Bus,
    public readonly relay: OutboxRelay, public readonly gl: GeneralLedger, public readonly channels: Channels,
    public readonly agent: Agent, public readonly reporting: Reporting, public readonly policies: PolicyEngine,
    public readonly ops: Operations, public readonly keyring: Keyring,
  ) {}

  static async start(o: CellOptions): Promise<Cell> {
    const cellId = o.cellId ?? "local";
    await migrateCell(o.migrationUrl ?? o.databaseUrl, o.appRole);
    const sql = postgres(o.databaseUrl, { max: o.poolSize ?? 10, onnotice: () => undefined });
    const [r] = await sql<{ bypass: boolean }[]>`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    if (r?.bypass) console.warn("WARNING: the application role bypasses row-level security; tenant isolation is not enforced by the database");
    const keyring = new Keyring(sql, o.kms);
    const store = new EventStore(sql, cellId, { keyring, legacy: o.legacy ?? "reject" });
    const bus: Bus = !o.bus || o.bus === "memory" ? new MemoryBus() : await NatsBus.connect(o.bus.natsUrl, cellId, { caFile: o.bus.caFile, retentionDays: o.bus.retentionDays, token: o.bus.token });
    const relay = new OutboxRelay(sql, (subject, env) => bus.publish(subject, env));
    const policies = PolicyEngine.fromDir(o.policyDir);
    const gl = new GeneralLedger(store);
    const channels = new Channels(store);
    const agent = new Agent(sql, store, policies, o.clock, o.classifier);
    const reporting = new Reporting(sql, store);
    const ops = new Operations(sql, store, { gl, reporting, agent, policies }, o.clock);

    const s = (module: string, type: string) => `kuber.${cellId}.${module}.${type}.*`;
    // The broker carries sealed payloads; decrypt just before the module's handler runs.
    const opened = (h: (e: Envelope) => Promise<void>) => async (e: Envelope) => h(await openEnvelope(keyring, e, o.legacy ?? "reject"));
    await bus.subscribe({ name: "gl", filter: [s("agent", "PostingRequested"), s("agent", "CorrectionRequested")], handler: opened(gl.handler) });
    await bus.subscribe({ name: "agent", filter: [s("channels", "TransactionExtracted"), s("gl", "BookOpened"), s("gl", "AccountAdded"),
      s("gl", "JournalPosted"), s("gl", "JournalReversed")], handler: opened(agent.handler) });
    await bus.subscribe({ name: "reporting", filter: [s("gl", "BookOpened"), s("gl", "AccountAdded"), s("gl", "JournalPosted")], handler: opened(reporting.handler) });
    return new Cell(cellId, sql, store, bus, relay, gl, channels, agent, reporting, policies, ops, keyring);
  }

  /** In-process runs: publish everything pending and wait until every module has caught up. */
  async settle(): Promise<void> {
    if (!(this.bus instanceof MemoryBus)) throw new Error("settle() is for the in-memory bus; use the relay loop with NATS");
    for (let i = 0; i < 100; i++) {
      const n = await this.relay.drainAll();
      await this.bus.idle();
      if (n === 0) {
        if (this.bus.deadLetters.length) throw new Error(`dead letters: ${this.bus.deadLetters.map((d) => `${d.sub}: ${String(d.error)}`).join("; ")}`);
        return;
      }
    }
    throw new Error("cell did not settle");
  }

  async close() {
    this.relay.stop();
    await this.bus.close();
    await this.sql.end({ timeout: 5 });
  }
}
