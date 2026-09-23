import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Cell } from "@kuber/core";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const POLICY_DIR = join(ROOT, "policies");
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://kuber@localhost:5433/postgres";

export const APP_ROLE = "kuber_app";

/**
 * A fresh database per test file, dropped afterwards. `ownerUrl` runs migrations; `url` is the
 * application role, which is neither superuser nor BYPASSRLS so row-level security applies.
 */
export async function freshDatabase(): Promise<{ url: string; ownerUrl: string; drop: () => Promise<void> }> {
  const name = `kuber_test_${randomBytes(4).toString("hex")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const ownerUrl = ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
  const url = ownerUrl.replace(/\/\/[^@]+@/, `//${APP_ROLE}@`);
  return {
    url, ownerUrl,
    drop: async () => {
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function startCell(clockDate: { value: string }, extra: Partial<Parameters<typeof Cell.start>[0]> = {}) {
  const db = await freshDatabase();
  const cell = await Cell.start({ databaseUrl: db.url, migrationUrl: db.ownerUrl, appRole: APP_ROLE, policyDir: POLICY_DIR,
    clock: () => clockDate.value, ...extra });
  return { cell, db, stop: async () => { await cell.close(); await db.drop(); } };
}
