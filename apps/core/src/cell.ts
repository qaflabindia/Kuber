/**
 * A cell: one complete, independent Kuber stack for a set of tenants (design section 16.6).
 * In phase 0 every module runs in this one process, but modules talk only through events on
 * the bus and never read each other's tables.
 */
import postgres, { type Sql } from "postgres";
import { EVENTSTORE_MIGRATIONS, EventStore, OutboxRelay, SYSTEM_SCOPE_ROLE, appGrants, migrate, openEnvelope, systemGrants, type LegacyPolicy } from "@kuber/eventstore";
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
  /**
   * System connection (outbox relay, catch-up reads): a role in kuber_system_scope that sees every
   * tenant. Tenant requests never use it. Defaults to the owner connection (development only).
   */
  systemDatabaseUrl?: string;
  /** System login role to create or update while migrating, and grant system scope to. */
  systemRole?: { name: string; password?: string };
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

const SCHEMAS = ["es", "agent", "reporting", "ops", "keys"];
const ident = (role: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`invalid role name ${role}`); return role; };

/**
 * Apply every module's migrations as the owner, then grant the application role its privileges
 * and, if given, create or update the system role and grant it system scope.
 */
export async function migrateCell(ownerUrl: string, appRole?: string, systemRole?: CellOptions["systemRole"]) {
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(owner, [...EVENTSTORE_MIGRATIONS, ...AGENT_MIGRATIONS, ...REPORTING_MIGRATIONS, ...OPS_MIGRATIONS]);
    if (appRole) {
      await owner.unsafe(appGrants(ident(appRole), SCHEMAS));
      // A tenant request role that could see every tenant would defeat row-level security.
      await owner.unsafe(`REVOKE ${SYSTEM_SCOPE_ROLE} FROM ${appRole}`);
    }
    if (systemRole) {
      const name = ident(systemRole.name);
      if (name === appRole) throw new Error("the system role must differ from the application role");
      const [exists] = await owner`SELECT 1 FROM pg_roles WHERE rolname = ${name}`;
      if (!exists) await owner.unsafe(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS`);
      if (systemRole.password) {
        await owner`SET password_encryption = 'scram-sha-256'`;
        await owner.unsafe(`ALTER ROLE ${name} PASSWORD '${systemRole.password.replace(/'/g, "''")}'`);
      }
      await owner.unsafe(systemGrants(name, SCHEMAS));
    }
  } finally { await owner.end(); }
}

export class Cell {
  private constructor(
    public readonly cellId: string, public readonly sql: Sql, private readonly systemSql: Sql, public readonly store: EventStore, public readonly bus: Bus,
    public readonly relay: OutboxRelay, public readonly gl: GeneralLedger, public readonly channels: Channels,
    public readonly agent: Agent, public readonly reporting: Reporting, public readonly policies: PolicyEngine,
    public readonly ops: Operations, public readonly keyring: Keyring,
  ) {}

  static async start(o: CellOptions): Promise<Cell> {
    const cellId = o.cellId ?? "local";
    const ownerUrl = o.migrationUrl ?? o.databaseUrl;
    await migrateCell(ownerUrl, o.appRole, o.systemRole);
    const sql = postgres(o.databaseUrl, { max: o.poolSize ?? 10, onnotice: () => undefined });
    const [r] = await sql<{ bypass: boolean; system: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass, pg_has_role(current_user, ${SYSTEM_SCOPE_ROLE}, 'MEMBER') AS system
      FROM pg_roles WHERE rolname = current_user`;
    if (r?.bypass) console.warn("WARNING: the application role bypasses row-level security; tenant isolation is not enforced by the database");
    else if (r?.system) { await sql.end(); throw new Error(`the application role is a member of ${SYSTEM_SCOPE_ROLE}: tenant requests could read every tenant`); }
    if (!o.systemDatabaseUrl) console.warn("WARNING: no systemDatabaseUrl; system work (relay, catch-up reads) runs as the database owner");
    const systemSql = postgres(o.systemDatabaseUrl ?? ownerUrl, { max: 3, onnotice: () => undefined });
    const keyring = new Keyring(sql, o.kms);
    const store = new EventStore(sql, cellId, { keyring, legacy: o.legacy ?? "reject" }, systemSql);
    const bus: Bus = !o.bus || o.bus === "memory" ? new MemoryBus() : await NatsBus.connect(o.bus.natsUrl, cellId, { caFile: o.bus.caFile, retentionDays: o.bus.retentionDays, token: o.bus.token });
    const relay = new OutboxRelay(systemSql, (subject, env) => bus.publish(subject, env));
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
    return new Cell(cellId, sql, systemSql, store, bus, relay, gl, channels, agent, reporting, policies, ops, keyring);
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
    await this.systemSql.end({ timeout: 5 });
  }
}
