/**
 * FIN-OPS-03: the autonomy kill switch. An owner or controller (autonomy.manage) halts autonomous
 * posting for the whole tenant or one book, immediately:
 *
 *   - the agent classifies new transactions as before but every decision is capped at L1: a draft
 *     for a person, never a posting (Agent reads `autonomyHalted` through its module guard);
 *   - posting requests the agent already queued at L3/L4 but the GL has not executed are refused
 *     by the GL (autonomyGate) and come back to the agent, which turns them into drafts for review;
 *   - an agent can no longer commit an ops plan: it waits for a person (Operations.commit).
 *
 * Halting and resuming are identity events (actor and reason) in the tenant's identity stream.
 */
import type { TransactionSql } from "postgres";
import { Principal } from "@kuber/contracts";
import type { EventStore } from "@kuber/eventstore";
import type { IdentityHost } from "./authority.ts";
import { autonomyReasonCtx } from "./fin-migrations.ts";

const actorOf = (by: string) => (Principal.safeParse(by).success ? by : `system:${by.replace(/[^\w.@-]+/g, ".").replace(/^\.+|\.+$/g, "") || "unknown"}`);

export interface AutonomySwitchState { book: string | null; halted: boolean; reason: string; setBy: string; setAt: string }

export class AutonomySwitch {
  constructor(private store: EventStore, private host: IdentityHost) {}

  /** Halt (`halted` true) or resume autonomous posting for the tenant (`book` null) or one book. */
  async set(tenant: string, by: string, s: { book?: string | null; halted: boolean; reason: string }): Promise<AutonomySwitchState[]> {
    const reason = s.reason.trim();
    if (reason.length < 3) throw this.host.error("bad_reason", "give a reason");
    const book = s.book ?? null, key = book ?? "*";
    const keys = await this.store.keys(tenant);
    await this.store.tenantTx(tenant, async (tx) => {
      await this.host.authorize(tenant, by, "autonomy.manage", book === null ? { allBooks: true } : { book }, tx);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"identity:" + tenant}, 0))`;
      await tx`INSERT INTO identity.autonomy_switches (tenant_id, book_id, halted, reason, set_by)
        VALUES (${tenant}, ${key}, ${s.halted}, ${keys.seal(reason, autonomyReasonCtx(key))}, ${by})
        ON CONFLICT (tenant_id, book_id) DO UPDATE SET halted = EXCLUDED.halted, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()`;
      await this.store.append("identity", tenant, { streamId: `${tenant}/identity`, expected: "any",
        events: [{ type: s.halted ? "AutonomyHalted" : "AutonomyResumed", data: { bookId: book, reason } }] }, { principal: actorOf(by) }, tx);
    });
    return this.status(tenant);
  }

  async status(tenant: string): Promise<AutonomySwitchState[]> {
    const keys = await this.store.keys(tenant);
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ book_id: string; halted: boolean; reason: string; set_by: string; set_at: Date }[]>`
      SELECT book_id, halted, reason, set_by, set_at FROM identity.autonomy_switches WHERE tenant_id = ${tenant} ORDER BY book_id`);
    return rows.map((r) => ({ book: r.book_id === "*" ? null : r.book_id, halted: r.halted, reason: keys.openText(r.reason, autonomyReasonCtx(r.book_id)),
      setBy: r.set_by, setAt: r.set_at.toISOString() }));
  }

  /** Is autonomous action halted for this book (by its own switch or the tenant's)? */
  async halted(tenant: string, book: string, tx?: TransactionSql): Promise<boolean> {
    const q = (t: TransactionSql) => t<{ n: number }[]>`SELECT count(*)::int AS n FROM identity.autonomy_switches
      WHERE tenant_id = ${tenant} AND book_id IN ('*', ${book}) AND halted`;
    const [r] = tx ? await q(tx) : await this.store.tenantTx(tenant, q);
    return (r?.n ?? 0) > 0;
  }
}
