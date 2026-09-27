/**
 * A cell: one complete, independent Kuber stack for a set of tenants (design section 16.6).
 * In phase 0 every module runs in this one process, but modules talk only through events on
 * the bus and never read each other's tables.
 */
import postgres, { type Sql } from "postgres";
import { DeadLetterStore, EVENTSTORE_MIGRATIONS, EventStore, LIFECYCLE_MIGRATIONS, OutboxRelay, SYSTEM_SCOPE_ROLE, appGrants, migrate, openEnvelope, systemGrants, type LegacyPolicy } from "@kuber/eventstore";
import { Keyring, type Kms } from "@kuber/crypto";
import type { Envelope } from "@kuber/contracts";
import { MemoryBus, NatsBus, busPartitions, type Bus } from "@kuber/bus";
import { GeneralLedger, PARTY_MIGRATIONS, PartyMaster } from "@kuber/gl";
import { PolicyEngine } from "@kuber/policy";
import { CHANNELS_MIGRATIONS, Channels, channelsGrants } from "@kuber/channels";
import { AGENT_MIGRATIONS, Agent, type LlmClassifier } from "@kuber/agent";
import { REPORTING_MIGRATIONS, Reporting } from "@kuber/reporting";
import { Incidents, OPS_MIGRATIONS, Operations, type Services } from "@kuber/ops";
import { EVIDENCE_MIGRATIONS, EvidenceService } from "@kuber/evidence";
import { IDENTITY_MIGRATIONS, IDENTITY_SEAL_MIGRATION, Identity, type IdentityOptions } from "@kuber/identity";
import { DREAM_MIGRATIONS, DreamService } from "@kuber/dream-rsi";
import { join, resolve } from "node:path";
import { CONSOLIDATION_MIGRATIONS, Consolidation, LinkedTenants, consolidationOperations } from "@kuber/consolidation";
import { CLOSE_MIGRATIONS, CloseService, closeOperations } from "@kuber/close";
import { sealIdentityColumns } from "./keys-admin.ts";
import { Portal } from "./portal.ts";
import { AGENT_GOVERNANCE_MIGRATIONS } from "./copilot/governance/recorder.ts";

export interface CellOptions {
  /** Application connection: must be a role without SUPERUSER or BYPASSRLS, or tenant isolation does not apply. */
  databaseUrl: string;
  /**
   * Owner connection, used only to apply migrations and grants before starting (tests, operator
   * tools). Absent in the deployed core (F14): migrations run in the one-shot migrate step
   * (`pnpm migrate`, the `migrate` Compose service) and the core, with its own role, only checks
   * that every migration is applied, refusing to start otherwise.
   */
  migrationUrl?: string;
  /** Application role name to grant privileges to after migrating (with migrationUrl). */
  appRole?: string;
  /**
   * System connection (outbox relay, catch-up reads): a role in kuber_system_scope that sees every
   * tenant. Tenant requests never use it. Defaults to the owner connection (development only).
   */
  systemDatabaseUrl?: string;
  /** System login role to create or update while migrating, and grant system scope to (with migrationUrl). */
  systemRole?: { name: string; password?: string };
  cellId?: string;
  bus?: "memory" | { natsUrl: string; caFile?: string; retentionDays?: number; token?: string; maxDeliver?: number };
  /** Tenant partitions (lanes) per module consumer; default KUBER_BUS_PARTITIONS or 8 (F09). */
  busPartitions?: number;
  policyDir: string;
  /** Key management service holding the master key(s). Required: there is no unencrypted mode. */
  kms: Kms;
  /** Rows written before encryption: "reject" (default) or "allow" while migrating. */
  legacy?: LegacyPolicy;
  clock?: () => string;
  poolSize?: number;
  /** Optional LLM step in classification; without it unmatched transactions go to suspense. */
  classifier?: LlmClassifier;
  /** Passkey relying party and development sign-in (identity module). Defaults suit local development. */
  identity?: Partial<IdentityOptions>;
  /** Dream-RSI output: evidence reports (default <repo>/requirements/evidence) and routing artifacts (default <repo>/agent/artifacts). */
  dream?: { evidenceDir?: string; artifactsDir?: string };
}

const SCHEMAS = ["es", "agent", "reporting", "ops", "keys", "evidence", "channels", "identity", "mdm", "dream", "consolidation", "close"];
const ident = (role: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`invalid role name ${role}`); return role; };

/** Every SQL migration of the cell, in order. */
export const CELL_MIGRATIONS = [...EVENTSTORE_MIGRATIONS, ...LIFECYCLE_MIGRATIONS, ...AGENT_MIGRATIONS, ...REPORTING_MIGRATIONS, ...OPS_MIGRATIONS, ...EVIDENCE_MIGRATIONS, ...CHANNELS_MIGRATIONS, ...IDENTITY_MIGRATIONS, ...PARTY_MIGRATIONS,
  // Copilot governance (TAGOF TOL-05, AGT-07): the turn index next to the sealed AgentTurnRecorded events.
  ...AGENT_GOVERNANCE_MIGRATIONS,
  // Dream-RSI (design 7.2): autonomy tuning, outcomes, proposals.
  ...DREAM_MIGRATIONS,
  // Group consolidation (FIN-GRP-01..04).
  ...CONSOLIDATION_MIGRATIONS,
  // Period close (FIN-CLS-01..04).
  ...CLOSE_MIGRATIONS];

/** Migration ids a started cell requires: the SQL migrations and the data migrations run after them. */
export const requiredMigrationIds = (): string[] => [...CELL_MIGRATIONS.map((m) => m.id), IDENTITY_SEAL_MIGRATION];

/**
 * Check, with the runtime role, that every migration is applied (F14: the core holds no owner
 * credentials and cannot migrate). Throws with the pending ids and how to apply them.
 */
export async function assertMigrated(sql: Sql): Promise<void> {
  const [t] = await sql<{ exists: boolean }[]>`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`;
  const done = t?.exists ? new Set((await sql<{ id: string }[]>`SELECT id FROM public.schema_migrations`).map((r) => r.id)) : new Set<string>();
  const pending = requiredMigrationIds().filter((id) => !done.has(id));
  if (pending.length) {
    throw new Error(`database migrations are pending (${pending.length}: ${pending.slice(0, 5).join(", ")}${pending.length > 5 ? ", ..." : ""}); `
      + "this process has no migration credentials: run the migrate step as the owner first "
      + "(`./kuber up migrate`, or MIGRATION_URL=<owner url> pnpm migrate), or pass migrationUrl");
  }
}

/**
 * Apply every module's migrations as the owner, then grant the application role its privileges
 * and, if given, create or update the system role and grant it system scope.
 */
export async function migrateCell(ownerUrl: string, appRole?: string, systemRole?: CellOptions["systemRole"]) {
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(owner, CELL_MIGRATIONS);
    if (appRole) {
      await owner.unsafe(appGrants(ident(appRole), SCHEMAS));
      await owner.unsafe(channelsGrants(ident(appRole)));
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
      await owner.unsafe(channelsGrants(name));
    }
  } finally { await owner.end(); }
}

/** Data migrations that need keys, run as the owner after the SQL migrations. */
export async function sealWithOwner(ownerUrl: string, keyring: Keyring): Promise<void> {
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
  try { await sealIdentityColumns(owner, keyring); } finally { await owner.end(); }
}

export class Cell {
  /** Module handlers by consumer name (plaintext envelopes), for dead-letter retry. */
  consumers: Record<string, (e: Envelope) => Promise<void>> = {};
  deadLetters!: DeadLetterStore;
  /** FIN-OPS-02: the financial incident register. */
  incidents!: Incidents;
  /** Party master (FIN-MDM-03): vendors and customers, bank-detail changes and payment holds. */
  parties!: PartyMaster;
  /** Role model v2: what customers, suppliers, investors and guests may read, filtered at this boundary. */
  portal!: Portal;
  /** Dream-RSI (design 7.2): offline policy runs, proposals and their approval. */
  dream!: DreamService;
  /** Group consolidation (FIN-GRP-01..04): register, intercompany, eliminations, group close, linked tenants. */
  consolidation!: Consolidation;
  /** Period close (FIN-CLS-01..04): checklist, substantiation, certified close, reopen and restatement. */
  periodClose!: CloseService;

  private constructor(
    public readonly cellId: string, public readonly sql: Sql, private readonly systemSql: Sql, public readonly store: EventStore, public readonly bus: Bus,
    public readonly relay: OutboxRelay, public readonly gl: GeneralLedger, public readonly channels: Channels,
    public readonly agent: Agent, public readonly reporting: Reporting, public readonly policies: PolicyEngine,
    public readonly ops: Operations, public readonly keyring: Keyring, public readonly evidence: EvidenceService,
    public readonly identity: Identity,
  ) {}

  static async start(o: CellOptions): Promise<Cell> {
    const cellId = o.cellId ?? "local";
    if (o.migrationUrl) await migrateCell(o.migrationUrl, o.appRole, o.systemRole);
    else if (o.systemRole) console.warn("WARNING: systemRole is ignored without migrationUrl; the migrate step creates the system role");
    const sql = postgres(o.databaseUrl, { max: o.poolSize ?? 10, onnotice: () => undefined });
    const [r] = await sql<{ bypass: boolean; system: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass, pg_has_role(current_user, ${SYSTEM_SCOPE_ROLE}, 'MEMBER') AS system
      FROM pg_roles WHERE rolname = current_user`;
    if (r?.bypass) console.warn("WARNING: the application role bypasses row-level security; tenant isolation is not enforced by the database");
    else if (r?.system) { await sql.end(); throw new Error(`the application role is a member of ${SYSTEM_SCOPE_ROLE}: tenant requests could read every tenant`); }
    if (!o.migrationUrl) {
      try { await assertMigrated(sql); } catch (e) { await sql.end(); throw e; }
    }
    if (!o.systemDatabaseUrl) console.warn("WARNING: no systemDatabaseUrl; system work (relay, catch-up reads) runs as the owner or application connection");
    const systemSql = postgres(o.systemDatabaseUrl ?? o.migrationUrl ?? o.databaseUrl, { max: 3, onnotice: () => undefined });
    const keyring = new Keyring(sql, o.kms);
    // Data migrations that need keys: seal identity display names stored before they were encrypted.
    if (o.migrationUrl) await sealWithOwner(o.migrationUrl, keyring);
    const store = new EventStore(sql, cellId, { keyring, legacy: o.legacy ?? "reject" }, systemSql);
    const partitions = o.busPartitions ?? busPartitions();
    // Exhausted deliveries (on any lane) are recorded in es.dead_letters under the module's name (see `ops dead-letters`).
    const deadLetters = new DeadLetterStore(store);
    const onDeadLetter = (d: { consumer: string; env: Envelope; error: unknown; attempts: number }) => deadLetters.record(d.consumer, d.env, d.attempts, d.error);
    const bus: Bus = !o.bus || o.bus === "memory" ? new MemoryBus(3, partitions, onDeadLetter)
      : await NatsBus.connect(o.bus.natsUrl, cellId, { caFile: o.bus.caFile, retentionDays: o.bus.retentionDays, token: o.bus.token, partitions, maxDeliver: o.bus.maxDeliver, onDeadLetter });
    const relay = new OutboxRelay(systemSql, (subject, env) => bus.publish(subject, env));
    const policies = PolicyEngine.fromDir(o.policyDir);
    // Memberships, passkeys and the authorization guard every operation passes through (F01/F02).
    // It also guards the agent's decisions and channel submissions at the module boundary.
    const identity = new Identity(store, policies, { rpId: "localhost", origins: ["http://localhost:3000"], ...o.identity });
    // Parties are master data of the GL: a journal may not name another legal entity's party (FIN-MDM-01).
    const parties = new PartyMaster(store, identity, policies, o.clock);
    // FIN-OPS-03: the kill switch stops queued autonomous postings at the GL, too.
    const gl = new GeneralLedger(store, { partyEntities: (t, ids, tx) => parties.entities(t, ids, tx), autonomyGate: (t, b) => identity.autonomyHalted(t, b) });
    const channels = new Channels(store, identity);
    const agent = new Agent(sql, store, policies, o.clock, o.classifier, identity);
    const reporting = new Reporting(sql, store);
    // Payments to a party with an unreleased bank-detail change are held (POL-501), in plans and in drafts.
    agent.paymentHolds = (t, ids, tx) => parties.holds(t, ids, tx);
    const opsServices: Services = { gl, reporting, agent, policies, parties, singlePasskeyPeople: (t) => identity.singlePasskeyPeople(t) };
    const ops = new Operations(sql, store, opsServices, o.clock, identity);
    // Evidence records re-verify the approval's device signature offline (design 14.4/16.4).
    const evidence = new EvidenceService(store, (t, env, sig) => identity.verifyStoredSignature(t, env, sig));
    // FIN-MDM-04: an authority change invalidates approvals that relied on it, in the same transaction.
    identity.onAuthorityChange((t, change, tx) => ops.invalidateApprovals(t, change, tx).then(() => undefined));

    const s = (module: string, type: string) => `kuber.${cellId}.${module}.${type}.*`;
    // The broker carries sealed payloads; decrypt just before the module's handler runs.
    const opened = (h: (e: Envelope) => Promise<void>) => async (e: Envelope) => h(await openEnvelope(keyring, e, o.legacy ?? "reject"));
    await bus.subscribe({ name: "gl", filter: [s("agent", "PostingRequested"), s("agent", "CorrectionRequested"), s("agent", "ProvisionalConfirmed")], handler: opened(gl.handler) });
    await bus.subscribe({ name: "agent", filter: [s("channels", "TransactionExtracted"), s("gl", "BookOpened"), s("gl", "AccountAdded"),
      s("gl", "JournalPosted"), s("gl", "JournalReversed"), s("gl", "PostingRejected")], handler: opened(agent.handler) });
    await bus.subscribe({ name: "evidence", filter: [s("gl", "JournalPosted"), s("gl", "PeriodLocked")], handler: opened(evidence.handler) });
    await bus.subscribe({ name: "reporting", filter: [s("gl", "BookOpened"), s("gl", "AccountAdded"), s("gl", "AccountControlsChanged"), s("gl", "JournalPosted"), s("gl", "JournalConfirmed")], handler: opened(reporting.handler) });
    const cell = new Cell(cellId, sql, systemSql, store, bus, relay, gl, channels, agent, reporting, policies, ops, keyring, evidence, identity);
    cell.consumers = { gl: gl.handler, agent: agent.handler, evidence: evidence.handler, reporting: reporting.handler };
    cell.deadLetters = deadLetters;
    cell.incidents = new Incidents(store, identity);
    cell.parties = parties;
    cell.portal = new Portal(cell);
    // Role model v2: legacy role values (owner, approver, preparer, member) become the new roles, once
    // (idempotent; each change is a MemberRoleChanged event with the reason "role model v2").
    await identity.migrateRoleModel();
    const repo = resolve(o.policyDir, "..");
    cell.dream = new DreamService({ store, policies, guard: identity, agent, optIn: (t, tx) => identity.optimisationOptIn(t, tx),
      clock: o.clock ?? (() => new Date().toISOString().slice(0, 10)),
      evidenceDir: o.dream?.evidenceDir ?? join(repo, "requirements", "evidence"), artifactsDir: o.dream?.artifactsDir ?? join(repo, "agent", "artifacts") });
    // Group consolidation: its operations and their register/close actions go through the ops service.
    const consolidation = new Consolidation({ store, gl, reporting, ops, clock: o.clock ?? (() => new Date().toISOString().slice(0, 10)),
      partyEntities: (t, ids) => parties.entities(t, ids),
      guard: { authorize: (t, p, a, sc, tx) => identity.authorize(t, p, a as never, sc, tx), member: (t, p) => identity.member(t, p) } });
    consolidation.links = new LinkedTenants(consolidation);
    ops.register(consolidationOperations(consolidation));
    ops.registerExtension("consolidation", consolidation.extension);
    cell.consolidation = consolidation;
    // Period close: its operations and checklist/substantiation/close actions go through the ops service;
    // the `close` operation's hard close waits for a certified close in books that keep a checklist.
    const close = new CloseService({ store, gl, reporting, ops, agent, policies, clock: o.clock ?? (() => new Date().toISOString().slice(0, 10)),
      guard: { authorize: (t, p, a, sc, tx) => identity.authorize(t, p, a as never, sc, tx), member: (t, p) => identity.member(t, p) },
      intercompanyActive: async (t, b) => {
        for (const g of await consolidation.groups(t)) {
          const st = await consolidation.group(t, g.groupId);
          const entity = st.entities.find((e) => e.bookId === b);
          if (entity && st.icLinks.some((l) => l.entityId === entity.entityId || l.counterpartyEntityId === entity.entityId)) return true;
        }
        return false;
      } });
    ops.register(closeOperations(close));
    ops.registerExtension("close", close.extension);
    opsServices.closeGate = (t, b, periodEnd) => close.gate(t, b, periodEnd);
    cell.periodClose = close;
    return cell;
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
    await this.gl.flushSnapshots();
    await this.bus.close();
    await this.sql.end({ timeout: 5 });
    await this.systemSql.end({ timeout: 5 });
  }
}
