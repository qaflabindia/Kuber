import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Cell } from "@kuber/core";
import { MemoryKms } from "@kuber/crypto";
import { systemGrants } from "@kuber/eventstore";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const POLICY_DIR = join(ROOT, "policies");
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://kuber@localhost:5433/postgres";

export const APP_ROLE = "kuber_app";
export const SYSTEM_ROLE = "kuber_system";
const SYSTEM_PASSWORD = process.env.TEST_SYSTEM_DB_PASSWORD ?? SYSTEM_ROLE;

/**
 * A fresh database per test file, dropped afterwards. `ownerUrl` runs migrations; `url` is the
 * application role, which is neither superuser nor BYPASSRLS so row-level security applies.
 */
export async function freshDatabase(): Promise<{ url: string; ownerUrl: string; systemUrl: string; drop: () => Promise<void> }> {
  const name = `kuber_test_${randomBytes(4).toString("hex")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${(process.env.TEST_APP_DB_PASSWORD ?? APP_ROLE).replace(/'/g, "")}' NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL);                      // keep credentials and ?sslmode=… of the admin URL
  u.pathname = `/${name}`;
  const ownerUrl = u.toString();
  // Same credentials as deploy/postgres-init.sql, so tests run against the Docker Postgres too.
  const app = new URL(ownerUrl); app.username = APP_ROLE; app.password = process.env.TEST_APP_DB_PASSWORD ?? APP_ROLE;
  const url = app.toString();
  // The system role is created by migrateCell (Cell.start with systemRole).
  const sys = new URL(ownerUrl); sys.username = SYSTEM_ROLE; sys.password = SYSTEM_PASSWORD;
  const systemUrl = sys.toString();
  return {
    url, ownerUrl, systemUrl,
    drop: async () => {
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Create (or reuse) the system login role and grant it system scope on `schemas`, as migrateCell does. */
export async function grantSystemRole(owner: postgres.Sql, schemas: string[]) {
  await owner.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_ROLE}') THEN
    CREATE ROLE ${SYSTEM_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  await owner.unsafe(`ALTER ROLE ${SYSTEM_ROLE} PASSWORD '${SYSTEM_PASSWORD.replace(/'/g, "")}'`);
  await owner.unsafe(systemGrants(SYSTEM_ROLE, schemas));
}

export async function startCell(clockDate: { value: string }, extra: Partial<Parameters<typeof Cell.start>[0]> = {}) {
  const db = await freshDatabase();
  const cell = await Cell.start({ databaseUrl: db.url, migrationUrl: db.ownerUrl, appRole: APP_ROLE, policyDir: POLICY_DIR,
    systemDatabaseUrl: db.systemUrl, systemRole: { name: SYSTEM_ROLE, password: SYSTEM_PASSWORD },
    clock: () => clockDate.value, kms: new MemoryKms(), ...extra });
  return { cell, db, stop: async () => { await cell.close(); await db.drop(); } };
}
