import type { Sql } from "postgres";
import type { Migration } from "./migrations.ts";

/** Apply migrations in order, once each, under an advisory lock so concurrent starts are safe. */
export async function migrate(sql: Sql, migrations: Migration[]): Promise<string[]> {
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(7337001)`;
    await tx`CREATE TABLE IF NOT EXISTS public.schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    const done = new Set((await tx<{ id: string }[]>`SELECT id FROM public.schema_migrations`).map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await tx.unsafe(m.sql);
      await tx`INSERT INTO public.schema_migrations (id) VALUES (${m.id})`;
      applied.push(m.id);
    }
  });
  return applied;
}
