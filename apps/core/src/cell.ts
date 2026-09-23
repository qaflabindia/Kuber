/**
 * A cell: one complete, independent Kuber stack for a set of tenants (design section 16.6).
 * In phase 0 every module runs in this one process, but modules talk only through events on
 * the bus and never read each other's tables.
 */
import postgres, { type Sql } from "postgres";
import { EVENTSTORE_MIGRATIONS, EventStore, OutboxRelay, appGrants, migrate } from "@kuber/eventstore";
import { MemoryBus, NatsBus, type Bus } from "@kuber/bus";
import { GeneralLedger } from "@kuber/gl";
import { PolicyEngine } from "@kuber/policy";
import { Channels } from "@kuber/channels";
import { AGENT_MIGRATIONS, Agent } from "@kuber/agent";
import { REPORTING_MIGRATIONS, Reporting } from "@kuber/reporting";

export interface CellOptions {
  /** Application connection: must be a role without SUPERUSER or BYPASSRLS, or tenant isolation does not apply. */
  databaseUrl: string;
  /** Owner connection used only for migrations and grants. Defaults to databaseUrl (development only). */
  migrationUrl?: string;
  /** Application role name to grant privileges to after migrating. */
  appRole?: string;
  cellId?: string;
  bus?: "memory" | { natsUrl: string };
  policyDir: string;
  clock?: () => string;
  poolSize?: number;
}

export class Cell {
  private constructor(
    public readonly cellId: string, public readonly sql: Sql, public readonly store: EventStore, public readonly bus: Bus,
    public readonly relay: OutboxRelay, public readonly gl: GeneralLedger, public readonly channels: Channels,
    public readonly agent: Agent, public readonly reporting: Reporting, public readonly policies: PolicyEngine,
  ) {}

  static async start(o: CellOptions): Promise<Cell> {
    const cellId = o.cellId ?? "local";
    const migrations = [...EVENTSTORE_MIGRATIONS, ...AGENT_MIGRATIONS, ...REPORTING_MIGRATIONS];
    const owner = postgres(o.migrationUrl ?? o.databaseUrl, { max: 1, onnotice: () => undefined });
    await migrate(owner, migrations);
    if (o.appRole) await owner.unsafe(appGrants(o.appRole, ["es", "agent", "reporting"]));
    await owner.end();
    const sql = postgres(o.databaseUrl, { max: o.poolSize ?? 10, onnotice: () => undefined });
    const [r] = await sql<{ bypass: boolean }[]>`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    if (r?.bypass) console.warn("WARNING: the application role bypasses row-level security; tenant isolation is not enforced by the database");
    const store = new EventStore(sql, cellId);
    const bus: Bus = !o.bus || o.bus === "memory" ? new MemoryBus() : await NatsBus.connect(o.bus.natsUrl, cellId);
    const relay = new OutboxRelay(sql, (subject, env) => bus.publish(subject, env));
    const policies = PolicyEngine.fromDir(o.policyDir);
    const gl = new GeneralLedger(store);
    const channels = new Channels(store);
    const agent = new Agent(sql, store, policies, o.clock);
    const reporting = new Reporting(sql, store);

    const s = (module: string, type: string) => `kuber.${cellId}.${module}.${type}.*`;
    await bus.subscribe({ name: "gl", filter: [s("agent", "PostingRequested"), s("agent", "CorrectionRequested")], handler: gl.handler });
    await bus.subscribe({ name: "agent", filter: [s("channels", "TransactionExtracted"), s("gl", "BookOpened"), s("gl", "AccountAdded"),
      s("gl", "JournalPosted"), s("gl", "JournalReversed")], handler: agent.handler });
    await bus.subscribe({ name: "reporting", filter: [s("gl", "BookOpened"), s("gl", "AccountAdded"), s("gl", "JournalPosted")], handler: reporting.handler });
    return new Cell(cellId, sql, store, bus, relay, gl, channels, agent, reporting, policies);
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
