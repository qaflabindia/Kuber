/**
 * Key and ciphertext administration. Runs with the database owner role: the application role
 * cannot rewrite events, re-wrap keys or shred (see appGrants).
 *
 *   encryptLegacy  seal rows written before encryption existed, then build their link chains
 *   reencrypt      re-seal everything still under a retired data-key version, then drop that key
 *   dropRetired    drop a retired data key only when no retained ciphertext needs it, including
 *                  envelopes already published to the broker and still inside its retention window
 *   shred          delete a tenant's keys and purge every readable copy of its data (crypto-shredding)
 *   verify         link chains, deep digest check, anything still plaintext, anything still readable
 *                  for a shredded tenant, and tenant tables missing from the retention inventory
 *
 * Where a tenant's ciphertext or derived plaintext is retained, and what the key lifecycle does:
 *   es.events               sealed; re-sealed on rotation; unreadable (structure verifiable) after shred
 *   es.outbox (unpublished) sealed; re-sealed on rotation, so the relay publishes under the new key
 *   es.outbox (published)   the copy the broker holds: kept as sealed until the bus retention window
 *                           (or a recorded bus purge) has passed, then pruned; it pins its key version
 *   broker (JetStream)      same ciphertext as the published outbox row; expires after max_age
 *   es.snapshots            derived cache: dropped (not re-sealed) when under a retired version
 *   SEALED_COLUMNS          sealed module columns; re-sealed on rotation
 *   RETENTION "purge"       readable projections (amounts, dates, ids, evidence balances, dead-letter
 *                           errors): deleted on shred, rebuildable from events while keys exist
 *   backups                 hold wrapped keys + ciphertext as of the backup; see README "Backups and erasure"
 */
import type { Sql, TransactionSql } from "postgres";
import { isToken, type Keyring, type TenantKeys } from "@kuber/crypto";
import { GENESIS_LINK, eventContext, isSealed, linkOf, sealEvent, type EventStore } from "@kuber/eventstore";
import { narrationCtx, snapshotCtx } from "@kuber/reporting";
import { accountNameCtx, matchReviewCtx, provisionalSourceCtx } from "@kuber/agent";
import { signalDetailCtx, signalOriginalCtx } from "@kuber/channels";
import { IDENTITY_SEAL_MIGRATION, accessReviewNoteCtx, autonomyReasonCtx, enrolmentNameCtx, memberNameCtx, relatedPartyNoteCtx } from "@kuber/identity";
import { incidentDetailCtx } from "@kuber/ops";
import { bankChangeCtx, partyDetailCtx } from "@kuber/gl";

export interface SealedColumn {
  table: string; column: string; kind: "text" | "json"; keyCols: string[];
  ctx: (row: Record<string, string>) => string;
}

/** Every sealed column outside the event store, with the context its ciphertext is bound to. */
export const SEALED_COLUMNS: SealedColumn[] = [
  { table: "agent.parties", column: "name", kind: "text", keyCols: ["party_id"], ctx: (r) => `agent.parties.name|${r.party_id}` },
  { table: "agent.ratifications", column: "narration", kind: "text", keyCols: ["request_id"], ctx: (r) => `agent.ratifications.narration|${r.request_id}` },
  { table: "agent.drafts", column: "proposal", kind: "json", keyCols: ["draft_id"], ctx: (r) => `agent.drafts.proposal|${r.draft_id}` },
  { table: "agent.accounts", column: "name", kind: "text", keyCols: ["book_id", "account_id"], ctx: (r) => accountNameCtx(r.book_id!, r.account_id!) },
  { table: "agent.rules", column: "pattern", kind: "text", keyCols: ["rule_id", "pattern_idx"], ctx: (r) => `agent.rules.pattern|${r.pattern_idx}` },
  { table: "reporting.lines", column: "narration", kind: "text", keyCols: ["journal_id", "line_no"], ctx: (r) => narrationCtx(r.journal_id!) },
  { table: "ops.plans", column: "plan", kind: "json", keyCols: ["plan_id"], ctx: (r) => `ops.plans.plan|${r.plan_id}` },
  { table: "ops.plans", column: "actions", kind: "json", keyCols: ["plan_id"], ctx: (r) => `ops.plans.actions|${r.plan_id}` },
  { table: "ops.schedules", column: "definition", kind: "json", keyCols: ["schedule_id"], ctx: (r) => `ops.schedules.definition|${r.schedule_id}` },
  { table: "agent.provisional_sources", column: "detail", kind: "text", keyCols: ["txn_id"], ctx: (r) => provisionalSourceCtx(r.txn_id!) },
  { table: "agent.match_reviews", column: "detail", kind: "text", keyCols: ["review_id"], ctx: (r) => matchReviewCtx(r.review_id!) },
  { table: "channels.signals", column: "original", kind: "text", keyCols: ["signal_id"], ctx: (r) => signalOriginalCtx(r.signal_id!) },
  { table: "channels.signals", column: "detail", kind: "text", keyCols: ["signal_id"], ctx: (r) => signalDetailCtx(r.signal_id!) },
  { table: "reporting.snapshots", column: "body", kind: "text", keyCols: ["snapshot_id"], ctx: (r) => snapshotCtx(r.snapshot_id!) },
  // Personal data in the identity schema: the names people and invitations are shown by.
  { table: "identity.members", column: "display_name", kind: "text", keyCols: ["principal"], ctx: (r) => memberNameCtx(r.principal!) },
  { table: "identity.enrolments", column: "display_name", kind: "text", keyCols: ["token_hash"], ctx: (r) => enrolmentNameCtx(r.token_hash!) },
  // Finance controls (FIN-MDM-04/05, FIN-OPS-02/03): free-text notes and reasons, incident details.
  { table: "identity.related_parties", column: "note", kind: "text", keyCols: ["principal", "party_id"], ctx: (r) => relatedPartyNoteCtx(r.principal!, r.party_id!) },
  { table: "identity.access_reviews", column: "note", kind: "text", keyCols: ["item_id"], ctx: (r) => accessReviewNoteCtx(r.item_id!) },
  { table: "identity.autonomy_switches", column: "reason", kind: "text", keyCols: ["book_id", "scope"], ctx: (r) => autonomyReasonCtx(r.book_id!, r.scope ?? "autonomy") },
  { table: "ops.incidents", column: "detail", kind: "text", keyCols: ["incident_id"], ctx: (r) => incidentDetailCtx(r.incident_id!) },
  // Party master (FIN-MDM-03): names, terms and tax status history; beneficiary bank details.
  { table: "mdm.parties", column: "detail", kind: "text", keyCols: ["party_id"], ctx: (r) => partyDetailCtx(r.party_id!) },
  { table: "mdm.bank_changes", column: "bank", kind: "text", keyCols: ["change_id"], ctx: (r) => bankChangeCtx(r.change_id!) },
];

/**
 * Retention inventory: every table with a tenant_id column and what erasure does with it.
 *   purge    readable or derived data (or ciphertext with no retention value): deleted on shred
 *   sealed   the sealed event history: kept, unreadable without keys, link chains still verify
 *   keys     key material: deleted by the keyring on shred
 *   tombstone the erasure record itself
 * verify() reports any tenant table missing here, so a new table cannot silently escape erasure.
 */
export const RETENTION: Record<string, "purge" | "sealed" | "keys" | "tombstone"> = {
  "reporting.lines": "purge", "reporting.daily": "purge", "reporting.accounts": "purge", "reporting.checkpoints": "purge",
  "reporting.snapshots": "purge",
  "agent.parties": "purge", "agent.rules": "purge", "agent.party_accounts": "purge", "agent.journal_index": "purge",
  "agent.drafts": "purge", "agent.ratifications": "purge", "agent.accounts": "purge", "agent.overrides": "purge",
  "agent.provisional_sources": "purge", "agent.match_reviews": "purge", "reporting.confirmations": "purge",
  "channels.signals": "purge",
  "ops.plans": "purge", "ops.schedules": "purge", "ops.schedule_occurrences": "purge", "agent.suspense_items": "purge",
  // Identity (members, passkeys, invitation codes, separation settings): personal data with no
  // value once the tenant's books are unreadable. Credentials before members (foreign key).
  "identity.credentials": "purge", "identity.enrolments": "purge", "identity.members": "purge", "identity.settings": "purge",
  "identity.sessions": "purge", "identity.signing_requests": "purge",
  // Finance controls: authority matrix, delegations, conflicts, access reviews, kill switch, plan
  // approvals and the incident register. Their history is in the sealed event streams.
  "identity.authority_settings": "purge", "identity.authority_bands": "purge", "identity.delegations": "purge",
  "identity.related_parties": "purge", "identity.access_reviews": "purge", "identity.autonomy_switches": "purge",
  "ops.plan_approvals": "purge", "ops.incidents": "purge",
  "mdm.parties": "purge", "mdm.bank_changes": "purge", "mdm.reviews": "purge",
  "evidence.balances": "purge", "evidence.records": "purge", "evidence.lookup": "purge",
  "es.outbox": "purge", "es.snapshots": "purge", "es.dead_letters": "purge", "es.commands": "purge", "es.verify_checkpoints": "purge",
  "es.events": "sealed", "keys.tenant_keys": "keys", "keys.shredded": "tombstone",
};
export const PROJECTION_TABLES = Object.keys(RETENTION).filter((t) => RETENTION[t] === "purge");

const DAY = 86_400_000;

/**
 * Delete published outbox rows the broker no longer holds: published before the retention window
 * (or before the last recorded bus purge). Unpublished rows are never touched.
 */
export async function pruneOutbox(owner: Sql, busRetentionMs: number, tenant?: string): Promise<number> {
  return owner.begin(async (t) => (await t`
    DELETE FROM es.outbox WHERE published_at IS NOT NULL ${tenant ? t`AND tenant_id = ${tenant}` : t``}
      AND published_at < GREATEST(now() - make_interval(secs => ${busRetentionMs / 1000}),
                                  COALESCE((SELECT max(purged_at) FROM es.bus_purges), '-infinity'))`).count) as Promise<number>;
}

export interface KeyAdminOptions {
  /** How long the broker retains messages (JetStream max_age; KUBER_BUS_RETENTION_DAYS). Default 7 days. */
  busRetentionMs?: number;
}

const tokenOf = (kind: "text" | "json", v: unknown): string | null =>
  kind === "text" ? (isToken(v) ? v : null) : (isToken((v as { $c?: unknown } | null)?.$c) ? (v as { $c: string }).$c : null);

/**
 * Seal one column's values for one tenant, in `t` (a transaction that sees the tenant's rows).
 * mode "legacy": seal plaintext values; mode "rotate": re-seal values under a non-active key version.
 */
async function sealColumnRows(t: TransactionSql, c: SealedColumn, tenant: string, keys: TenantKeys, mode: "legacy" | "rotate"): Promise<number> {
  let n = 0;
  const rows = await t.unsafe(`SELECT ${[...new Set([...c.keyCols, c.column])].join(", ")} FROM ${c.table} WHERE tenant_id = $1 FOR UPDATE`, [tenant]) as Record<string, unknown>[];
  for (const r of rows) {
    const tok = tokenOf(c.kind, r[c.column]);
    let plain: string | null = null;
    const extra: Record<string, string> = {};
    if (mode === "legacy" && !tok && r[c.column] !== "") {   // '' is "not recorded", not data
      plain = c.kind === "text" ? String(r[c.column]) : JSON.stringify(r[c.column]);
      if (c.table === "agent.rules") extra.pattern_idx = keys.index("rule", plain);   // legacy rules get their blind index
    } else if (mode === "rotate" && tok && keys.versionOf(tok) !== keys.activeVersion) {
      plain = keys.openText(tok, c.ctx(r as Record<string, string>));
    }
    if (plain === null) continue;
    const ctx = c.ctx({ ...(r as Record<string, string>), ...extra });
    const sealed = keys.seal(plain, ctx);
    const value = c.kind === "text" ? sealed : { $c: sealed };
    const where = c.keyCols.filter((k) => k !== "pattern_idx").map((k, i) => `${k} = $${i + 3}`).join(" AND ");
    const sets = [`${c.column} = $1`, ...Object.keys(extra).map((k) => `${k} = '${extra[k]!.replace(/'/g, "")}'`)].join(", ");
    await t.unsafe(`UPDATE ${c.table} SET ${sets} WHERE tenant_id = $2 AND ${where}`,
      // jsonb parameters are serialised by the driver: pass the object, not a JSON string.
      [value, tenant, ...c.keyCols.filter((k) => k !== "pattern_idx").map((k) => r[k] as string)] as never[]);
    n++;
  }
  return n;
}

/**
 * A data migration that seals the plaintext values of `columns` for every tenant with rows in them,
 * once: recorded in schema_migrations under `id` like the SQL migrations, under the same kind of
 * advisory lock so concurrent starts do it once. Runs with the owner connection (system scope).
 * Crypto-shredded tenants are skipped (their rows are purged, not sealed). Returns values sealed.
 */
export async function sealColumnsOnce(owner: Sql, keyring: Keyring, id: string, columns: SealedColumn[]): Promise<number> {
  const [done] = await owner`SELECT 1 FROM public.schema_migrations WHERE id = ${id}`;
  if (done) return 0;
  // Keys first, outside the transaction: the keyring may share the owner's (single-connection) pool.
  const shredded = new Set((await owner<{ tenant_id: string }[]>`SELECT tenant_id FROM keys.shredded`).map((r) => r.tenant_id));
  const keys = new Map<string, TenantKeys>();
  for (const c of columns) {
    for (const r of await owner.unsafe(`SELECT DISTINCT tenant_id FROM ${c.table}`) as { tenant_id: string }[]) {
      if (!shredded.has(r.tenant_id) && !keys.has(r.tenant_id)) keys.set(r.tenant_id, await keyring.forTenant(r.tenant_id));
    }
  }
  return owner.begin(async (t) => {
    await t`SELECT pg_advisory_xact_lock(7337003)`;
    const [again] = await t`SELECT 1 FROM public.schema_migrations WHERE id = ${id}`;
    if (again) return 0;
    let n = 0;
    for (const c of columns) {
      const tenants = (await t.unsafe(`SELECT DISTINCT tenant_id FROM ${c.table} ORDER BY 1`) as { tenant_id: string }[]).map((r) => r.tenant_id);
      for (const tenant of tenants) {
        if (shredded.has(tenant)) continue;
        const k = keys.get(tenant);
        // A tenant whose first rows arrived after the key pass: left for the next `keys encrypt-legacy`.
        if (k) n += await sealColumnRows(t, c, tenant, k, "legacy");
      }
    }
    await t`INSERT INTO public.schema_migrations (id) VALUES (${id})`;
    return n;
  }) as Promise<number>;
}

/** Identity's personal columns, sealed once on upgrade (IDENTITY_SEAL_MIGRATION). */
export const IDENTITY_SEALED_COLUMNS = () => SEALED_COLUMNS.filter((c) => c.table.startsWith("identity."));
export const sealIdentityColumns = (owner: Sql, keyring: Keyring) => sealColumnsOnce(owner, keyring, IDENTITY_SEAL_MIGRATION, IDENTITY_SEALED_COLUMNS());

export class KeyAdmin {
  /**
   * `graceMs`: a retired data key is dropped only after this long, so every running core process
   * (which caches keys for up to a minute) has switched to the new version first.
   */
  private busRetentionMs: number;
  constructor(private owner: Sql, private keyring: Keyring, private store: EventStore, private graceMs = 5 * 60_000, opts: KeyAdminOptions = {}) {
    this.busRetentionMs = opts.busRetentionMs ?? 7 * DAY;
  }

  private sys<T>(fn: (t: TransactionSql) => Promise<T>) {
    return this.owner.begin(async (t) => {
      await t`SELECT set_config('kuber.maintenance', 'reseal', true)`;         // see es.guard_change()
      return fn(t);
    }) as Promise<T>;
  }

  private async tenants(): Promise<string[]> {
    const shredded = new Set((await this.sys((t) => t<{ tenant_id: string }[]>`SELECT tenant_id FROM keys.shredded`)).map((r) => r.tenant_id));
    const rows = await this.sys((t) => t<{ tenant_id: string }[]>`SELECT DISTINCT tenant_id FROM es.events`);
    return rows.map((r) => r.tenant_id).filter((x) => !shredded.has(x));
  }

  /** Seal every plaintext event, outbox payload and sensitive column; rebuild link chains. */
  async encryptLegacy(): Promise<{ events: number; columns: number; streams: number }> {
    let events = 0, columns = 0;
    const touched = new Set<string>();
    for (const tenant of await this.tenants()) {
      const keys = await this.keyring.forTenant(tenant);
      await this.sys(async (t) => {
        const rows = await t<{ global_position: string; event_id: string; type: string; stream_id: string; data: unknown }[]>`
          SELECT global_position::text, event_id, type, stream_id, data FROM es.events WHERE tenant_id = ${tenant} ORDER BY es.events.global_position FOR UPDATE`;
        for (const r of rows) {
          if (isSealed(r.data)) continue;
          const { sealed, digest } = sealEvent(keys, r.event_id, r.type, r.stream_id, r.data);
          await t`UPDATE es.events SET data = ${t.json(sealed as never)}, digest = ${digest} WHERE global_position = ${r.global_position}`;
          await t`UPDATE es.outbox SET envelope = jsonb_set(envelope, '{data}', ${t.json(sealed as never)}) WHERE global_position = ${r.global_position}`;
          touched.add(r.stream_id); events++;
        }
      });
      columns += await this.sealColumns(tenant, keys, "legacy");
    }
    for (const s of touched) await this.relink(s);
    return { events, columns, streams: touched.size };
  }

  /** Recompute a stream's link chain from its stored digests. */
  private async relink(streamId: string) {
    await this.sys(async (t) => {
      const rows = await t<{ global_position: string; stream_version: number; digest: string }[]>`
        SELECT global_position::text, stream_version, digest FROM es.events WHERE stream_id = ${streamId} ORDER BY stream_version FOR UPDATE`;
      let prev = GENESIS_LINK;
      for (const r of rows) {
        const link = linkOf(prev, r.digest, streamId, r.stream_version);
        await t`UPDATE es.events SET link = ${link} WHERE global_position = ${r.global_position}`;
        prev = link;
      }
    });
  }

  /** mode "legacy": seal plaintext values; mode "rotate": re-seal values under a non-active key version. */
  private async sealColumns(tenant: string, keys: TenantKeys, mode: "legacy" | "rotate"): Promise<number> {
    let n = 0;
    for (const c of SEALED_COLUMNS) n += await this.sys((t) => sealColumnRows(t, c, tenant, keys, mode));
    return n;
  }

  /** Re-seal everything under retired data-key versions with the active one, then drop those keys. */
  async reencrypt(tenant: string): Promise<{ events: number; columns: number; dropped: number[]; kept: string[] }> {
    this.keyring.invalidate(tenant);
    const keys = await this.keyring.forTenant(tenant);
    let events = 0;
    await this.sys(async (t) => {
      const rows = await t<{ global_position: string; event_id: string; type: string; stream_id: string; data: unknown; digest: string }[]>`
        SELECT global_position::text, event_id, type, stream_id, data, digest FROM es.events WHERE tenant_id = ${tenant} ORDER BY es.events.global_position FOR UPDATE`;
      for (const r of rows) {
        if (!isSealed(r.data) || keys.versionOf(r.data.$c) === keys.activeVersion) continue;
        const ctx = eventContext(r.event_id, r.type, r.stream_id);
        const inner = keys.openJson<{ s: string; d: unknown }>(r.data.$c, ctx);   // same salt: digest and links unchanged
        const sealed = { $c: keys.sealJson(inner, ctx) };
        await t`UPDATE es.events SET data = ${t.json(sealed as never)} WHERE global_position = ${r.global_position}`;
        // Only rows not yet published: a published row is the copy the broker holds, and keeps its
        // ciphertext (and so its key version) until it has expired from the broker (pruneOutbox).
        await t`UPDATE es.outbox SET envelope = jsonb_set(envelope, '{data}', ${t.json(sealed as never)})
                WHERE global_position = ${r.global_position} AND published_at IS NULL`;
        events++;
      }
      // Snapshots are a cache derived from events: drop those under an old key rather than re-seal them.
      await t`DELETE FROM es.snapshots WHERE tenant_id = ${tenant} AND state::text ~ ${`"kb1\\.(?!${keys.activeVersion}\\.)[0-9]+\\.`}`;
    });
    const columns = await this.sealColumns(tenant, keys, "rotate");
    const dropped = await this.dropRetired(tenant);
    this.keyring.invalidate(tenant);
    return { events, columns, ...dropped };
  }

  /**
   * Drop retired data keys that are past the grace period and provably unneeded: no stored
   * ciphertext uses them, and no envelope sealed with them can still be delivered by the broker.
   */
  async dropRetired(tenant: string): Promise<{ dropped: number[]; kept: string[] }> {
    const status = await this.keyring.status();
    const mine = status.keys.filter((k) => k.tenant_id === tenant && k.purpose === "data");
    const active = mine.find((k) => k.state === "active");
    const retired = mine.filter((k) => k.state === "retired").map((k) => k.version);
    const rotatedAt = await this.sys(async (t) => (await t<{ at: Date }[]>`
      SELECT created_at AS at FROM keys.tenant_keys WHERE tenant_id = ${tenant} AND purpose = 'data' AND version = ${active?.version ?? 0}`)[0]?.at);
    if (retired.length) await pruneOutbox(this.owner, this.busRetentionMs, tenant);
    const dropped: number[] = [], kept: string[] = [];
    for (const v of retired) {
      const uses = await this.usage(tenant, v);
      const { published, publishedUntil, ...stored } = uses;
      const n = Object.values(stored).reduce((a, b) => a + b, 0);
      if (n > 0) {
        kept.push(`v${v}: still used by ${n} stored value(s) (${Object.entries(stored).filter(([, c]) => c).map(([k, c]) => `${k}: ${c}`).join(", ")}); run reencrypt again`);
        continue;
      }
      if (published > 0) {
        kept.push(`v${v}: ${published} envelope(s) sealed with it were published to the broker and may still be delivered or replayed; ` +
          `droppable after ${publishedUntil} (bus retention ${Math.round(this.busRetentionMs / DAY * 10) / 10} d), or after purge-bus`);
        continue;
      }
      if (!rotatedAt || Date.now() - rotatedAt.getTime() < this.graceMs) {
        kept.push(`v${v}: rotated less than ${Math.round(this.graceMs / 60000)} min ago; running processes may still write with it. Run again later.`);
        continue;
      }
      await this.sys((t) => t`DELETE FROM keys.tenant_keys WHERE tenant_id = ${tenant} AND purpose = 'data' AND state = 'retired' AND version = ${v}`);
      dropped.push(v);
    }
    this.keyring.invalidate(tenant);
    return { dropped, kept };
  }

  /** Where a tenant's values sealed with data-key version `v` are retained. */
  async usage(tenant: string, v: number): Promise<Record<string, number> & { published: number; publishedUntil: string | null }> {
    const prefix = `kb1.${v}.%`;
    return this.sys(async (t) => {
      const out: Record<string, number> = {};
      out["es.events"] = (await t<{ n: number }[]>`SELECT count(*)::int AS n FROM es.events WHERE tenant_id = ${tenant} AND data->>'$c' LIKE ${prefix}`)[0]!.n;
      out["es.outbox"] = (await t<{ n: number }[]>`SELECT count(*)::int AS n FROM es.outbox WHERE tenant_id = ${tenant} AND published_at IS NULL AND envelope->'data'->>'$c' LIKE ${prefix}`)[0]!.n;
      out["es.snapshots"] = (await t<{ n: number }[]>`SELECT count(*)::int AS n FROM es.snapshots WHERE tenant_id = ${tenant} AND state::text LIKE ${`%"kb1.${v}.%`}`)[0]!.n;
      for (const c of SEALED_COLUMNS) {
        const expr = c.kind === "text" ? c.column : `${c.column}->>'$c'`;
        out[`${c.table}.${c.column}`] = ((await t.unsafe(`SELECT count(*)::int AS n FROM ${c.table} WHERE tenant_id = $1 AND ${expr} LIKE $2`, [tenant, prefix])) as { n: number }[])[0]!.n;
      }
      // Published copies still inside the broker's retention (older ones were pruned just before).
      const [p] = await t<{ n: number; until: Date | null }[]>`
        SELECT count(*)::int AS n, max(published_at) + make_interval(secs => ${this.busRetentionMs / 1000}) AS until
        FROM es.outbox WHERE tenant_id = ${tenant} AND published_at IS NOT NULL AND envelope->'data'->>'$c' LIKE ${prefix}`;
      return Object.assign(out, { published: p!.n, publishedUntil: p!.until?.toISOString() ?? null });
    });
  }

  /** Record that the broker was purged: envelopes published before now exist nowhere but the outbox. */
  async recordBusPurge(by: string) {
    await this.sys((t) => t`INSERT INTO es.bus_purges (purged_at, purged_by) VALUES (clock_timestamp(), ${by})`);
  }

  pruneOutbox(tenant?: string) { return pruneOutbox(this.owner, this.busRetentionMs, tenant); }

  /**
   * Crypto-shred a tenant: keys gone (tombstone recorded, which also fences new events), then every
   * readable copy purged. Sealed events remain as an unreadable, verifiable record.
   */
  async shred(tenant: string, by: string, reason: string) {
    await this.keyring.shred(tenant, by, reason);
    return { purged: await this.purge(tenant) };
  }

  /** Delete a shredded tenant's rows from every purge table (idempotent). */
  async purge(tenant: string): Promise<Record<string, number>> {
    const purged: Record<string, number> = {};
    await this.sys(async (t) => {
      const [s] = await t`SELECT 1 FROM keys.shredded WHERE tenant_id = ${tenant}`;
      if (!s) throw new Error(`tenant ${tenant} is not shredded`);
      for (const table of PROJECTION_TABLES) {
        const n = (await t.unsafe(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenant])).count;
        if (n) purged[table] = n;
      }
    });
    return purged;
  }

  /**
   * Purge again for every shredded tenant: run after the key-cache TTL (a process holding cached
   * keys may still have projected an in-flight event) and after any restore.
   */
  async purgeShredded(): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    const rows = await this.sys((t) => t<{ tenant_id: string }[]>`SELECT tenant_id FROM keys.shredded ORDER BY tenant_id`);
    for (const r of rows) out[r.tenant_id] = await this.purge(r.tenant_id);
    return out;
  }

  /**
   * Re-apply erasures from a ledger kept outside the database (restore from a backup taken before
   * a shred brings the tenant's keys back): shred again where the tombstone is missing, purge all.
   */
  async reapplyShreds(entries: { tenant: string; by: string; reason: string }[]) {
    const reshredded: string[] = [];
    const have = new Set((await this.sys((t) => t<{ tenant_id: string }[]>`SELECT tenant_id FROM keys.shredded`)).map((r) => r.tenant_id));
    for (const e of entries) {
      if (have.has(e.tenant)) continue;
      await this.keyring.shred(e.tenant, e.by, `${e.reason} (re-applied after restore)`);
      have.add(e.tenant); reshredded.push(e.tenant);
    }
    // A backup may also predate the tombstone's purge while keeping the tombstone: purge everything again.
    await this.sys(async (t) => { for (const e of entries) await t`DELETE FROM keys.tenant_keys WHERE tenant_id = ${e.tenant}`; });
    return { reshredded, purged: await this.purgeShredded() };
  }

  /**
   * After erasure: for each shredded tenant, anything still readable or restorable (keys, rows in
   * purge tables, plaintext events). Plus tenant tables absent from RETENTION.
   */
  async erasureReport(): Promise<{ residue: Record<string, Record<string, number>>; unclassified: string[] }> {
    return this.sys(async (t) => {
      const tables = (await t<{ t: string }[]>`
        SELECT table_schema || '.' || table_name AS t FROM information_schema.columns
        WHERE column_name = 'tenant_id' AND table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_name NOT IN (SELECT viewname FROM pg_views) ORDER BY 1`).map((r) => r.t);
      const unclassified = tables.filter((x) => !RETENTION[x]);
      const residue: Record<string, Record<string, number>> = {};
      const shredded = (await t<{ tenant_id: string }[]>`SELECT tenant_id FROM keys.shredded`).map((r) => r.tenant_id);
      for (const tenant of shredded) {
        const found: Record<string, number> = {};
        for (const table of [...PROJECTION_TABLES, ...unclassified, "keys.tenant_keys"]) {
          const [r] = await t.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenant]) as { n: number }[];
          if (r!.n) found[table] = r!.n;
        }
        const [p] = await t<{ n: number }[]>`SELECT count(*)::int AS n FROM es.events WHERE tenant_id = ${tenant} AND NOT (data ? '$c')`;
        if (p!.n) found["es.events (plaintext)"] = p!.n;
        if (Object.keys(found).length) residue[tenant] = found;
      }
      return { residue, unclassified };
    });
  }

  /**
   * Storage and erasure checks. Full by default (every stream from its first event);
   * `incremental` resumes each stream at its verified checkpoint; `record` moves checkpoints
   * forward for streams that verified cleanly.
   */
  async verify(deep = true, opts: { incremental?: boolean; record?: boolean } = {}) {
    const storage = await this.store.verifyStorage({ deep, ...opts });
    const plaintext: Record<string, number> = {};
    await this.sys(async (t) => {
      const [e] = await t<{ n: number }[]>`SELECT count(*)::int AS n FROM es.events WHERE NOT (data ? '$c')`;
      if (e!.n) plaintext["es.events.data"] = e!.n;
      for (const c of SEALED_COLUMNS) {
        const q = c.kind === "text" ? `SELECT count(*)::int AS n FROM ${c.table} WHERE ${c.column} NOT LIKE 'kb1.%' AND ${c.column} <> ''`
          : `SELECT count(*)::int AS n FROM ${c.table} WHERE NOT (${c.column} ? '$c')`;
        const [r] = await t.unsafe(q) as { n: number }[];
        if (r!.n) plaintext[`${c.table}.${c.column}`] = r!.n;
      }
    });
    return { ...storage, plaintext, ...(await this.erasureReport()) };
  }
}
