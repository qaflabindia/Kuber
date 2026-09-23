/**
 * Tenant keyring: envelope encryption. Each tenant has
 *   - data keys (versioned): encrypt payloads and fields; new writes use the active version,
 *     older versions stay readable until re-encryption retires them;
 *   - one index key: keyed blind indexes for equality lookups on encrypted values.
 * Keys are stored only wrapped by the KMS master key. Deleting a tenant's keys (crypto-shredding)
 * makes every ciphertext of that tenant permanently unreadable, including copies in backups.
 */
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { CryptoError, blindIndex, openWith, parseToken, sealWith } from "./cipher.ts";
import type { Kms } from "./kms.ts";

export const KEYS_MIGRATION_SQL = `
CREATE SCHEMA IF NOT EXISTS keys;
CREATE TABLE keys.tenant_keys (
  tenant_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('data','index')), version INT NOT NULL,
  kek_id TEXT NOT NULL, wrapped TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, purpose, version));
CREATE UNIQUE INDEX tenant_keys_one_active ON keys.tenant_keys (tenant_id, purpose) WHERE state = 'active';
CREATE TABLE keys.shredded (tenant_id TEXT PRIMARY KEY, shredded_at TIMESTAMPTZ NOT NULL DEFAULT now(), shredded_by TEXT NOT NULL, reason TEXT NOT NULL);
`;

export interface TenantKeys {
  readonly tenant: string;
  readonly activeVersion: number;
  seal(plaintext: string | Buffer, context: string): string;
  open(token: string, context: string): Buffer;
  openText(token: string, context: string): string;
  sealJson(value: unknown, context: string): string;
  openJson<T = unknown>(token: string, context: string): T;
  /** Deterministic keyed index for equality lookups; reveals equality, never the value. */
  index(purpose: string, value: string): string;
  /** Key version a token was sealed with (for re-encryption). */
  versionOf(token: string): number;
}

interface Row { purpose: "data" | "index"; version: number; kek_id: string; wrapped: string; state: "active" | "retired" }

const wrapContext = (tenant: string, purpose: string, version: number) => `${purpose}|${tenant}|v${version}`;

export class Keyring {
  private cache = new Map<string, { at: number; keys: TenantKeys }>();
  constructor(private sql: Sql, readonly kms: Kms, private ttlMs = 60_000) {}

  private tx<T>(tenant: string | null, fn: (t: import("postgres").TransactionSql) => Promise<T>): Promise<T> {
    return this.sql.begin(async (t) => {
      if (tenant) await t`SELECT set_config('kuber.tenant', ${tenant}, true)`;
      else await t`SELECT set_config('kuber.role', 'system', true)`;
      return fn(t);
    }) as Promise<T>;
  }

  invalidate(tenant?: string) { if (tenant) this.cache.delete(tenant); else this.cache.clear(); }

  /** Keys for a tenant, created on first use. Throws if the tenant was crypto-shredded. */
  async forTenant(tenant: string): Promise<TenantKeys> {
    const hit = this.cache.get(tenant);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.keys;
    let rows = await this.load(tenant);
    if (!rows.some((r) => r.purpose === "data" && r.state === "active") || !rows.some((r) => r.purpose === "index")) {
      await this.create(tenant, rows);
      rows = await this.load(tenant);
    }
    const keys = await this.build(tenant, rows);
    this.cache.set(tenant, { at: Date.now(), keys });
    return keys;
  }

  private async load(tenant: string) {
    return this.tx(tenant, async (t) => {
      const [s] = await t`SELECT 1 FROM keys.shredded WHERE tenant_id = ${tenant}`;
      if (s) throw new CryptoError("shredded", `tenant ${tenant} was crypto-shredded; its data is permanently unreadable`);
      return t<Row[]>`SELECT purpose, version, kek_id, wrapped, state FROM keys.tenant_keys WHERE tenant_id = ${tenant}`;
    });
  }

  private async create(tenant: string, existing: Row[]) {
    for (const purpose of ["data", "index"] as const) {
      if (existing.some((r) => r.purpose === purpose && r.state === "active")) continue;
      const { kekId, wrapped } = await this.kms.wrap(randomBytes(32), wrapContext(tenant, purpose, 1));
      // Concurrent first use: one insert wins, the other is a no-op; both then load the winner.
      await this.tx(tenant, (t) => t`INSERT INTO keys.tenant_keys (tenant_id, purpose, version, kek_id, wrapped, state)
        VALUES (${tenant}, ${purpose}, 1, ${kekId}, ${wrapped}, 'active') ON CONFLICT DO NOTHING`);
    }
  }

  private async build(tenant: string, rows: Row[]): Promise<TenantKeys> {
    const data = new Map<number, Buffer>();
    let active = 0, indexKey: Buffer | null = null;
    for (const r of rows) {
      const k = await this.kms.unwrap(r.kek_id, r.wrapped, wrapContext(tenant, r.purpose, r.version));
      if (r.purpose === "data") { data.set(r.version, k); if (r.state === "active") active = r.version; }
      else if (r.state === "active") indexKey = k;
    }
    if (!active || !indexKey) throw new CryptoError("no_key", `tenant ${tenant} has no active keys`);
    const aad = (ctx: string) => `${tenant}|${ctx}`;
    const keyFor = (v: number) => { const k = data.get(v); if (!k) throw new CryptoError("no_key", `tenant ${tenant} has no data key v${v}`); return k; };
    const ik = indexKey;
    const seal = (pt: string | Buffer, ctx: string) => sealWith(data.get(active)!, active, pt, aad(ctx));
    const open = (tok: string, ctx: string) => openWith(keyFor(parseToken(tok).version), tok, aad(ctx));
    const keys: TenantKeys = {
      tenant, activeVersion: active, seal, open,
      openText: (tok, ctx) => open(tok, ctx).toString("utf8"),
      sealJson: (v, ctx) => seal(JSON.stringify(v), ctx),
      openJson: <T>(tok: string, ctx: string) => JSON.parse(open(tok, ctx).toString("utf8")) as T,
      index: (purpose, value) => blindIndex(ik, purpose, value),
      versionOf: (tok) => parseToken(tok).version,
    };
    return keys;
  }

  /** New data-key version for new writes; old versions keep decrypting until re-encryption. */
  async rotateTenant(tenant: string): Promise<number> {
    const v = await this.tx(tenant, async (t) => {
      const [m] = await t<{ v: number }[]>`SELECT COALESCE(MAX(version), 0)::int AS v FROM keys.tenant_keys WHERE tenant_id = ${tenant} AND purpose = 'data'`;
      return m!.v + 1;
    });
    const { kekId, wrapped } = await this.kms.wrap(randomBytes(32), wrapContext(tenant, "data", v));
    await this.tx(tenant, async (t) => {
      await t`UPDATE keys.tenant_keys SET state = 'retired' WHERE tenant_id = ${tenant} AND purpose = 'data' AND state = 'active'`;
      await t`INSERT INTO keys.tenant_keys (tenant_id, purpose, version, kek_id, wrapped, state) VALUES (${tenant}, 'data', ${v}, ${kekId}, ${wrapped}, 'active')`;
    });
    this.invalidate(tenant);
    return v;
  }

  /** Drop retired data keys no ciphertext uses any more (caller proves that by re-encrypting first). */
  async dropRetired(tenant: string, versions: number[]) {
    if (!versions.length) return 0;
    const r = await this.tx(tenant, (t) => t`DELETE FROM keys.tenant_keys WHERE tenant_id = ${tenant} AND purpose = 'data' AND state = 'retired' AND version IN ${t(versions)}`);
    this.invalidate(tenant);
    return r.count;
  }

  /** Re-wrap every tenant key under the KMS's active master key. Data is not touched. */
  async rewrapAll(): Promise<number> {
    const rows = await this.tx(null, (t) => t<(Row & { tenant_id: string })[]>`SELECT tenant_id, purpose, version, kek_id, wrapped, state FROM keys.tenant_keys`);
    let n = 0;
    for (const r of rows) {
      if (r.kek_id === this.kms.activeKekId()) continue;
      const ctx = wrapContext(r.tenant_id, r.purpose, r.version);
      const { kekId, wrapped } = await this.kms.wrap(await this.kms.unwrap(r.kek_id, r.wrapped, ctx), ctx);
      await this.tx(null, (t) => t`UPDATE keys.tenant_keys SET kek_id = ${kekId}, wrapped = ${wrapped}
        WHERE tenant_id = ${r.tenant_id} AND purpose = ${r.purpose} AND version = ${r.version}`);
      n++;
    }
    this.invalidate();
    return n;
  }

  async kekUsage(): Promise<Record<string, number>> {
    const rows = await this.tx(null, (t) => t<{ kek_id: string; n: number }[]>`SELECT kek_id, count(*)::int AS n FROM keys.tenant_keys GROUP BY kek_id`);
    return Object.fromEntries(rows.map((r) => [r.kek_id, r.n]));
  }

  /** Crypto-shred: delete every key of the tenant and record the tombstone, atomically. */
  async shred(tenant: string, by: string, reason: string) {
    await this.tx(null, async (t) => {
      await t`DELETE FROM keys.tenant_keys WHERE tenant_id = ${tenant}`;
      await t`INSERT INTO keys.shredded (tenant_id, shredded_by, reason) VALUES (${tenant}, ${by}, ${reason})`;
    });
    this.invalidate(tenant);
  }

  async status() {
    return this.tx(null, async (t) => ({
      keys: await t<{ tenant_id: string; purpose: string; version: number; kek_id: string; state: string }[]>`
        SELECT tenant_id, purpose, version, kek_id, state FROM keys.tenant_keys ORDER BY tenant_id, purpose, version`,
      shredded: await t<{ tenant_id: string; shredded_at: Date; reason: string }[]>`SELECT tenant_id, shredded_at, reason FROM keys.shredded ORDER BY tenant_id`,
    }));
  }
}
