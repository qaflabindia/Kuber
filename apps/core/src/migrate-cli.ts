/**
 * One-shot migrate step (F14): apply every migration and grant as the database OWNER, create or
 * update the system role, run the data migrations that need keys, then exit. The core itself holds
 * no owner credentials; it checks that everything here is applied and refuses to start otherwise.
 *
 *   MIGRATION_URL=postgres://owner... [APP_ROLE=kuber_app] [SYSTEM_ROLE=kuber_system SYSTEM_DB_PASSWORD=...] \
 *     KUBER_MASTER_KEY_FILE=... pnpm migrate
 *
 * Compose runs it as the `migrate` service; `core` starts only after it completes successfully.
 */
import postgres from "postgres";
import { Keyring, LocalFileKms } from "@kuber/crypto";
import { migrateCell, requiredMigrationIds, sealWithOwner } from "./cell.ts";

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`migrate: missing ${k}`); process.exit(2); } return v; };
const ownerUrl = need("MIGRATION_URL");
if (process.env.KUBER_REQUIRE_TLS === "true" && !/[?&]sslmode=verify-full\b/.test(ownerUrl)) {
  console.error("migrate: KUBER_REQUIRE_TLS: MIGRATION_URL must use sslmode=verify-full"); process.exit(1);
}
const kms = LocalFileKms.load(need("KUBER_MASTER_KEY_FILE"), { strictPermissions: process.env.KUBER_KEY_FILE_STRICT !== "false" });
const appRole = process.env.APP_ROLE || undefined;
const systemRole = process.env.SYSTEM_ROLE ? { name: process.env.SYSTEM_ROLE, password: process.env.SYSTEM_DB_PASSWORD } : undefined;

try {
  await migrateCell(ownerUrl, appRole, systemRole);
  const sql = postgres(ownerUrl, { max: 2, onnotice: () => undefined });
  try {
    await sealWithOwner(ownerUrl, new Keyring(sql, kms));
    const done = new Set((await sql<{ id: string }[]>`SELECT id FROM public.schema_migrations`).map((r) => r.id));
    const pending = requiredMigrationIds().filter((id) => !done.has(id));
    if (pending.length) throw new Error(`still pending after migrating: ${pending.join(", ")}`);
    console.log(`migrate: ${done.size} migrations applied${appRole ? `, grants for ${appRole}` : ""}${systemRole ? `, system role ${systemRole.name}` : ""}`);
  } finally { await sql.end(); }
} catch (e) {
  console.error(`migrate: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
