/**
 * Key and ciphertext administration. Runs with the database owner role: the application role
 * cannot rewrite events, re-wrap keys or shred (see appGrants).
 *
 *   encryptLegacy  seal rows written before encryption existed, then build their link chains
 *   reencrypt      re-seal everything still under a retired data-key version, then drop that key
 *   shred          delete a tenant's keys and purge its readable projections (crypto-shredding)
 *   verify         link chains, deep digest check, and a count of anything still plaintext
 */
import type { Sql, TransactionSql } from "postgres";
import { isToken, type Keyring, type TenantKeys } from "@kuber/crypto";
import { GENESIS_LINK, eventContext, isSealed, linkOf, sealEvent, type EventStore } from "@kuber/eventstore";
import { narrationCtx } from "@kuber/reporting";
import { accountNameCtx, matchReviewCtx, provisionalSourceCtx } from "@kuber/agent";
import { signalDetailCtx, signalOriginalCtx } from "@kuber/channels";

interface SealedColumn {
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
  { table: "agent.provisional_sources", column: "detail", kind: "text", keyCols: ["txn_id"], ctx: (r) => provisionalSourceCtx(r.txn_id!) },
  { table: "agent.match_reviews", column: "detail", kind: "text", keyCols: ["review_id"], ctx: (r) => matchReviewCtx(r.review_id!) },
  { table: "channels.signals", column: "original", kind: "text", keyCols: ["signal_id"], ctx: (r) => signalOriginalCtx(r.signal_id!) },
  { table: "channels.signals", column: "detail", kind: "text", keyCols: ["signal_id"], ctx: (r) => signalDetailCtx(r.signal_id!) },
];

/** Tables holding readable projections of a tenant's data, purged when the tenant is shredded. */
const PROJECTION_TABLES = ["reporting.lines", "reporting.daily", "reporting.accounts", "reporting.checkpoints",
  "agent.parties", "agent.rules", "agent.party_accounts", "agent.journal_index", "agent.drafts", "agent.ratifications",
  "agent.accounts", "agent.overrides", "agent.provisional_sources", "agent.match_reviews", "reporting.confirmations",
  "channels.signals", "ops.plans", "es.outbox", "es.snapshots"];

const tokenOf = (kind: "text" | "json", v: unknown): string | null =>
  kind === "text" ? (isToken(v) ? v : null) : (isToken((v as { $c?: unknown } | null)?.$c) ? (v as { $c: string }).$c : null);

export class KeyAdmin {
  /**
   * `graceMs`: a retired data key is dropped only after this long, so every running core process
   * (which caches keys for up to a minute) has switched to the new version first.
   */
  constructor(private owner: Sql, private keyring: Keyring, private store: EventStore, private graceMs = 5 * 60_000) {}

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
          SELECT global_position::text, event_id, type, stream_id, data FROM es.events WHERE tenant_id = ${tenant} ORDER BY global_position FOR UPDATE`;
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
    for (const c of SEALED_COLUMNS) {
      await this.sys(async (t) => {
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
      });
    }
    return n;
  }

  /** Re-seal everything under retired data-key versions with the active one, then drop those keys. */
  async reencrypt(tenant: string): Promise<{ events: number; columns: number; dropped: number[]; kept: string[] }> {
    this.keyring.invalidate(tenant);
    const keys = await this.keyring.forTenant(tenant);
    let events = 0;
    await this.sys(async (t) => {
      const rows = await t<{ global_position: string; event_id: string; type: string; stream_id: string; data: unknown; digest: string }[]>`
        SELECT global_position::text, event_id, type, stream_id, data, digest FROM es.events WHERE tenant_id = ${tenant} ORDER BY global_position FOR UPDATE`;
      for (const r of rows) {
        if (!isSealed(r.data) || keys.versionOf(r.data.$c) === keys.activeVersion) continue;
        const ctx = eventContext(r.event_id, r.type, r.stream_id);
        const inner = keys.openJson<{ s: string; d: unknown }>(r.data.$c, ctx);   // same salt: digest and links unchanged
        const sealed = { $c: keys.sealJson(inner, ctx) };
        await t`UPDATE es.events SET data = ${t.json(sealed as never)} WHERE global_position = ${r.global_position}`;
        await t`UPDATE es.outbox SET envelope = jsonb_set(envelope, '{data}', ${t.json(sealed as never)}) WHERE global_position = ${r.global_position}`;
        events++;
      }
    });
    const columns = await this.sealColumns(tenant, keys, "rotate");
    const dropped = await this.dropRetired(tenant);
    this.keyring.invalidate(tenant);
    return { events, columns, ...dropped };
  }

  /** Drop retired data keys that are past the grace period and provably unused by any ciphertext. */
  async dropRetired(tenant: string): Promise<{ dropped: number[]; kept: string[] }> {
    const status = await this.keyring.status();
    const mine = status.keys.filter((k) => k.tenant_id === tenant && k.purpose === "data");
    const active = mine.find((k) => k.state === "active");
    const retired = mine.filter((k) => k.state === "retired").map((k) => k.version);
    const rotatedAt = await this.sys(async (t) => (await t<{ at: Date }[]>`
      SELECT created_at AS at FROM keys.tenant_keys WHERE tenant_id = ${tenant} AND purpose = 'data' AND version = ${active?.version ?? 0}`)[0]?.at);
    const dropped: number[] = [], kept: string[] = [];
    for (const v of retired) {
      const uses = await this.countVersion(tenant, v);
      if (uses > 0) { kept.push(`v${v}: still used by ${uses} value(s); run reencrypt again`); continue; }
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

  /** How many stored values of a tenant are sealed with a given data-key version. */
  private async countVersion(tenant: string, v: number): Promise<number> {
    const prefix = `kb1.${v}.%`;
    return this.sys(async (t) => {
      let n = (await t<{ n: number }[]>`SELECT count(*)::int AS n FROM es.events WHERE tenant_id = ${tenant} AND data->>'$c' LIKE ${prefix}`)[0]!.n;
      n += (await t<{ n: number }[]>`SELECT count(*)::int AS n FROM es.outbox WHERE tenant_id = ${tenant} AND envelope->'data'->>'$c' LIKE ${prefix}`)[0]!.n;
      for (const c of SEALED_COLUMNS) {
        const expr = c.kind === "text" ? c.column : `${c.column}->>'$c'`;
        n += ((await t.unsafe(`SELECT count(*)::int AS n FROM ${c.table} WHERE tenant_id = $1 AND ${expr} LIKE $2`, [tenant, prefix])) as { n: number }[])[0]!.n;
      }
      return n;
    });
  }

  /** Crypto-shred a tenant: keys gone, readable projections purged. Sealed events remain as an unreadable, verifiable record. */
  async shred(tenant: string, by: string, reason: string) {
    await this.keyring.shred(tenant, by, reason);
    let purged = 0;
    await this.sys(async (t) => {
      for (const table of PROJECTION_TABLES) purged += (await t.unsafe(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenant])).count;
    });
    return { purged };
  }

  async verify(deep = true) {
    const storage = await this.store.verifyStorage({ deep });
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
    return { ...storage, plaintext };
  }
}
