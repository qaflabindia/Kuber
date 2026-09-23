/**
 * Database-role separation (design 17.4): tenant request roles cannot set system scope; relay and
 * system reads use a separate role; an attempted cross-tenant read or write is denied, and a
 * denied write is logged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import { Cell, type Cell as CellT } from "@kuber/core";
import { MemoryKms } from "@kuber/crypto";
import { ROLE_SCOPED_POLICIES_SQL, SYSTEM_SCOPE_ROLE, once } from "@kuber/eventstore";
import { APP_ROLE, POLICY_DIR, SYSTEM_ROLE, startCell } from "./helpers.ts";

const clock = { value: "2026-10-25" };
let cell: CellT, stop: () => Promise<void>, db: { url: string; ownerUrl: string; systemUrl: string };
let app: Sql, sys: Sql, owner: Sql;
let tables: string[];

beforeAll(async () => {
  ({ cell, stop, db } = await startCell(clock));
  for (const t of ["alpha", "beta"]) await cell.gl.openBook(t, "main", t, "freelancer", `owner:${t}`);
  await cell.settle();
  app = postgres(db.url, { max: 1, onnotice: () => undefined });
  sys = postgres(db.systemUrl, { max: 1, onnotice: () => undefined });
  owner = postgres(db.ownerUrl, { max: 1, onnotice: () => undefined });
  tables = (await owner<{ t: string }[]>`
    SELECT DISTINCT schemaname || '.' || tablename AS t FROM pg_policies WHERE policyname <> 'system_scope' ORDER BY 1`).map((r) => r.t);
});
afterAll(async () => { await app.end(); await sys.end(); await owner.end(); await stop(); });

const count = (sql: Sql, table: string, setup: (tx: postgres.TransactionSql) => Promise<unknown>) =>
  sql.begin(async (tx) => { await setup(tx); return (await tx.unsafe(`SELECT count(DISTINCT tenant_id)::int AS n FROM ${table}`))[0]!.n as number; });

describe("database-role separation", () => {
  it("no policy grants system scope by session setting any more", async () => {
    const [r] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_policies WHERE qual LIKE '%kuber.role%' OR with_check LIKE '%kuber.role%'`;
    expect(r!.n).toBe(0);
    expect(tables.length).toBeGreaterThan(10);
    const withSystem = await owner<{ t: string }[]>`SELECT schemaname || '.' || tablename AS t FROM pg_policies WHERE policyname = 'system_scope'`;
    expect(new Set(withSystem.map((r) => r.t))).toEqual(new Set(tables));
  });

  it("only the system role is a member of system scope", async () => {
    const member = async (role: string) =>
      (await owner<{ m: boolean }[]>`SELECT pg_has_role(${role}, ${SYSTEM_SCOPE_ROLE}, 'MEMBER') AS m`)[0]!.m;
    expect(await member(APP_ROLE)).toBe(false);
    expect(await member(SYSTEM_ROLE)).toBe(true);
  });

  it("the tenant role sees one tenant, and setting kuber.role = 'system' changes nothing", async () => {
    for (const t of tables) {
      expect(await count(app, t, (tx) => tx`SELECT set_config('kuber.role', 'system', true)`), t).toBe(0);
      expect(await count(app, t, (tx) => tx`SELECT set_config('kuber.tenant', 'alpha', true)`), t).toBeLessThanOrEqual(1);
    }
    expect(await count(app, "es.events", (tx) => tx`SELECT set_config('kuber.tenant', 'alpha', true)`)).toBe(1);
  });

  it("the system role sees every tenant but still cannot rewrite events or keys", async () => {
    expect(await count(sys, "es.events", async () => undefined)).toBe(2);
    await expect(sys`UPDATE es.events SET type = type WHERE false`).rejects.toThrow(/permission denied/);
    await expect(sys`UPDATE keys.tenant_keys SET state = state WHERE false`).rejects.toThrow(/permission denied/);
  });

  it("denies and logs a write into another tenant's rows", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(cell.store.tenantTx("alpha", (tx) =>
        tx`INSERT INTO agent.accounts (tenant_id, book_id, account_id, nature, is_cash_like) VALUES ('beta', 'main', 'X', 'expense', false)`))
        .rejects.toThrow(/row-level security/);
      const entry = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(entry).toMatchObject({ security: "rls_denied", tenant: "alpha", table: "accounts" });
    } finally { log.mockRestore(); }
  });

  it("event handlers run in the event's tenant scope, not system scope", async () => {
    const [env] = await cell.store.readStream("alpha", "alpha/book/main");
    const seen = await once(cell.store, "isolation-probe", env!, async (tx) =>
      (await tx`SELECT count(DISTINCT tenant_id)::int AS n FROM es.events`)[0]!.n as number);
    expect(seen).toBe(1);
  });

  it("converts policies written before es-003 (an existing database)", async () => {
    const old = "current_setting('kuber.role', true) = 'system' OR tenant_id = current_setting('kuber.tenant', true)";
    await owner.begin(async (t) => {
      await t.unsafe(`DROP POLICY system_scope ON agent.accounts; ALTER POLICY tenant_isolation ON agent.accounts USING (${old}) WITH CHECK (${old})`);
      await t.unsafe(`DROP POLICY system_scope ON reporting.daily; ALTER POLICY tenant_isolation ON reporting.daily USING (${old}) WITH CHECK (${old})`);
    });
    expect(await count(app, "agent.accounts", (tx) => tx`SELECT set_config('kuber.role', 'system', true)`)).toBe(2);   // the old hole
    await owner.unsafe(ROLE_SCOPED_POLICIES_SQL);
    await owner.unsafe(ROLE_SCOPED_POLICIES_SQL);                                                           // idempotent
    expect(await count(app, "agent.accounts", (tx) => tx`SELECT set_config('kuber.role', 'system', true)`)).toBe(0);
    expect(await count(sys, "agent.accounts", async () => undefined)).toBe(2);
    const [r] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_policies WHERE qual LIKE '%kuber.role%'`;
    expect(r!.n).toBe(0);
  });

  it("refuses to start with a tenant role that is a member of system scope", async () => {
    await owner.unsafe(`GRANT ${SYSTEM_SCOPE_ROLE} TO ${APP_ROLE}`);
    try {
      // without appRole, migrateCell does not revoke the membership, so the start-up check must catch it
      await expect(Cell.start({ databaseUrl: db.url, migrationUrl: db.ownerUrl, systemDatabaseUrl: db.systemUrl,
        policyDir: POLICY_DIR, kms: new MemoryKms() })).rejects.toThrow(/member of kuber_system_scope/);
    } finally { await owner.unsafe(`REVOKE ${SYSTEM_SCOPE_ROLE} FROM ${APP_ROLE}`); }
  });
});
