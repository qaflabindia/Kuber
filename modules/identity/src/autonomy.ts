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
 *
 * AGT-09 adds a second, independent scope, `copilot`: it halts the model-driven copilot (the core
 * falls back to its rules and read-only answers) without touching autonomous posting, and the
 * autonomy scope does not halt the copilot. The copilot scope needs `agent.system` (System Owner;
 * until the role model defines it, autonomy.manage: see agent-actions.ts).
 */
import type { TransactionSql } from "postgres";
import { Principal } from "@kuber/contracts";
import type { EventStore } from "@kuber/eventstore";
import type { IdentityHost } from "./authority.ts";
import { autonomyReasonCtx } from "./fin-migrations.ts";
import { authorizeNamed } from "./agent-actions.ts";

const actorOf = (by: string) => (Principal.safeParse(by).success ? by : `system:${by.replace(/[^\w.@-]+/g, ".").replace(/^\.+|\.+$/g, "") || "unknown"}`);

export const SWITCH_SCOPES = ["autonomy", "copilot"] as const;
export type SwitchScope = (typeof SWITCH_SCOPES)[number];
export interface AutonomySwitchState { book: string | null; scope: SwitchScope; halted: boolean; reason: string; setBy: string; setAt: string }

export class AutonomySwitch {
  constructor(private store: EventStore, private host: IdentityHost) {}

  /** Halt (`halted` true) or resume autonomous posting for the tenant (`book` null) or one book. */
  async set(tenant: string, by: string, s: { book?: string | null; halted: boolean; reason: string; scope?: SwitchScope }): Promise<AutonomySwitchState[]> {
    const reason = s.reason.trim();
    if (reason.length < 3) throw this.host.error("bad_reason", "give a reason");
    const scope = s.scope ?? "autonomy";
    if (!SWITCH_SCOPES.includes(scope)) throw this.host.error("bad_scope", `scope must be one of ${SWITCH_SCOPES.join(", ")}`);
    const book = s.book ?? null, key = book ?? "*";
    const keys = await this.store.keys(tenant);
    await this.store.tenantTx(tenant, async (tx) => {
      const where = book === null ? { allBooks: true } : { book };
      await authorizeNamed(scope === "copilot" ? "agent.system" : "autonomy.manage", (a) => this.host.authorize(tenant, by, a, where, tx));
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"identity:" + tenant}, 0))`;
      await tx`INSERT INTO identity.autonomy_switches (tenant_id, book_id, scope, halted, reason, set_by)
        VALUES (${tenant}, ${key}, ${scope}, ${s.halted}, ${keys.seal(reason, autonomyReasonCtx(key, scope))}, ${by})
        ON CONFLICT (tenant_id, book_id, scope) DO UPDATE SET halted = EXCLUDED.halted, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()`;
      await this.store.append("identity", tenant, { streamId: `${tenant}/identity`, expected: "any",
        events: [{ type: s.halted ? "AutonomyHalted" : "AutonomyResumed", data: { bookId: book, reason, ...(scope === "autonomy" ? {} : { scope }) } }] }, { principal: actorOf(by) }, tx);
    });
    return this.status(tenant);
  }

  async status(tenant: string): Promise<AutonomySwitchState[]> {
    const keys = await this.store.keys(tenant);
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ book_id: string; scope: SwitchScope; halted: boolean; reason: string; set_by: string; set_at: Date }[]>`
      SELECT book_id, scope, halted, reason, set_by, set_at FROM identity.autonomy_switches WHERE tenant_id = ${tenant} ORDER BY scope, book_id`);
    return rows.map((r) => ({ book: r.book_id === "*" ? null : r.book_id, scope: r.scope, halted: r.halted, reason: keys.openText(r.reason, autonomyReasonCtx(r.book_id, r.scope)),
      setBy: r.set_by, setAt: r.set_at.toISOString() }));
  }

  /** Is autonomous action (scope 'autonomy', default) or the copilot halted for this book (by its own switch or the tenant's)? */
  async halted(tenant: string, book: string, tx?: TransactionSql, scope: SwitchScope = "autonomy"): Promise<boolean> {
    const q = (t: TransactionSql) => t<{ n: number }[]>`SELECT count(*)::int AS n FROM identity.autonomy_switches
      WHERE tenant_id = ${tenant} AND book_id IN ('*', ${book}) AND scope = ${scope} AND halted`;
    const [r] = tx ? await q(tx) : await this.store.tenantTx(tenant, q);
    return (r?.n ?? 0) > 0;
  }
}
