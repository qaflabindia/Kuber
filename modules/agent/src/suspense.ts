/**
 * Suspense items (FIN-GL-05). Every journal that puts an amount in SUSPENSE opens one item-level
 * case: its source, an owner, its age and, once cleared, its resolution. Items are cleared only by a
 * suspense resolution (the `resolve_suspense` operation): the GL reverses the original on the
 * resolution date and posts its replacement, and the item records all three journals. The GL
 * refuses a balancing journal that would clear suspense without resolving items.
 *
 * Positions are by date, not by current status: an item counts as open on every day from the date
 * of its journal until its resolution date, so a report for an earlier period keeps showing the
 * position that period had, however the item was resolved later.
 */
import type { TransactionSql } from "postgres";
import { stableId, type Envelope, type EventData } from "@kuber/contracts";
import type { EventStore, Migration, ModuleGuard } from "@kuber/eventstore";
import { SUSPENSE } from "./classify.ts";
import { AgentError } from "./errors.ts";

export const SUSPENSE_MIGRATIONS: Migration[] = [{
  id: "agent-fin-001-suspense-items",
  sql: `
CREATE TABLE agent.suspense_items (
  tenant_id TEXT NOT NULL, item_id TEXT NOT NULL, book_id TEXT NOT NULL, journal_id TEXT NOT NULL,
  amount NUMERIC(22,0) NOT NULL, opened_on DATE NOT NULL, source TEXT NOT NULL, owner TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolved_on DATE, resolved_by TEXT, resolution JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id), UNIQUE (tenant_id, journal_id),
  CHECK (resolved_on IS NULL OR resolved_on >= opened_on));
CREATE INDEX suspense_items_book ON agent.suspense_items (tenant_id, book_id, opened_on);
ALTER TABLE agent.suspense_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.suspense_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent.suspense_items
  USING (tenant_id = current_setting('kuber.tenant', true)) WITH CHECK (tenant_id = current_setting('kuber.tenant', true));
CREATE POLICY system_scope ON agent.suspense_items TO kuber_system_scope USING (true) WITH CHECK (true);`,
}];

export interface SuspenseItem {
  itemId: string; bookId: string; journalId: string; amount: string; openedOn: string; source: string; owner: string | null;
  status: "open" | "resolved"; ageDays: number; resolvedOn: string | null; resolvedBy: string | null;
  resolution: { original: string; reversal: string; replacement: string | null; toAccount: string | null; note?: string; planId?: string } | null;
}

export interface RollForward {
  bookId: string; from: string; to: string;
  opening: string; additions: string; resolved: string; closing: string;
  counts: { opening: number; additions: number; resolved: number; closing: number };
  /** opening + additions − resolved = closing */
  balanced: boolean;
}

export const suspenseItemId = (tenant: string, journalId: string) => stableId("suspense-item", `${tenant}/${journalId}`);
export const suspenseStream = (tenant: string, itemId: string) => `${tenant}/suspense/${itemId}`;
const days = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000));

type Row = { item_id: string; book_id: string; journal_id: string; amount: string; opened_on: string; source: string; owner: string | null;
  status: "open" | "resolved"; resolved_on: string | null; resolved_by: string | null; resolution: SuspenseItem["resolution"] };

export class SuspenseCases {
  constructor(private store: EventStore, private guard: ModuleGuard,
              private clock: () => string,
              /** May `principal` decide for `book` (a person with draft.decide, or the approver of plan `planId`)? */
              private mayDecide: (tx: TransactionSql, tenant: string, principal: string, book: string, planId?: string) => Promise<void>) {}

  /** Projection step for JournalPosted: a journal with a suspense line opens an item (once). */
  async openFromJournal(tx: TransactionSql, env: Envelope, agentPrincipal: string) {
    const t = env.meta.tenantId;
    const d = env.data as EventData<"JournalPosted">;
    if (d.reverses) {
      // A plain reversal of the original (not through resolve_suspense, which records its own
      // resolution first) resolves the item as reversed, on the reversal's date.
      const itemId = suspenseItemId(t, d.reverses);
      const [open] = await tx<{ book_id: string; opened_on: string }[]>`SELECT book_id, opened_on::text AS opened_on FROM agent.suspense_items
        WHERE tenant_id = ${t} AND item_id = ${itemId} AND status = 'open' FOR UPDATE`;
      if (!open) return;
      const resolvedOn = d.txnDate < open.opened_on ? open.opened_on : d.txnDate;
      await tx`UPDATE agent.suspense_items SET status = 'resolved', resolved_on = ${resolvedOn}, resolved_by = ${env.meta.principal},
        resolution = ${tx.json({ original: d.reverses, reversal: d.journalId, replacement: null, toAccount: null, note: "reversed" } as never)}
        WHERE tenant_id = ${t} AND item_id = ${itemId}`;
      await this.store.append("agent", t, { streamId: suspenseStream(t, itemId), expected: "any", events: [{ type: "SuspenseItemResolved",
        data: { itemId, bookId: open.book_id, journalId: d.reverses, reversalJournalId: d.journalId, replacementJournalId: null, toAccount: null, resolvedOn, note: "reversed" } }] },
        { principal: agentPrincipal, causationId: env.eventId, correlationId: env.meta.correlationId }, tx);
      return;
    }
    if (d.replaces) return;                                        // a resolution's replacement never opens an item
    const amount = d.lines.filter((l) => l.accountId === SUSPENSE).reduce((a, l) => a + BigInt(l.amount), 0n);
    if (amount === 0n) return;
    const itemId = suspenseItemId(t, d.journalId);
    const source = d.source?.stream ?? `manual:${env.meta.principal}`;
    const owner = /^(agent|system):/.test(env.meta.principal) ? null : env.meta.principal;
    const ins = await tx`INSERT INTO agent.suspense_items (tenant_id, item_id, book_id, journal_id, amount, opened_on, source, owner, status)
      VALUES (${t}, ${itemId}, ${d.bookId}, ${d.journalId}, ${amount.toString()}, ${d.txnDate}, ${source}, ${owner}, 'open')
      ON CONFLICT DO NOTHING RETURNING 1`;
    if (!ins.length) return;
    await this.store.append("agent", t, { streamId: suspenseStream(t, itemId), expected: "any", events: [{ type: "SuspenseItemOpened",
      data: { itemId, bookId: d.bookId, journalId: d.journalId, amount: amount.toString(), openedOn: d.txnDate, source, owner } }] },
      { principal: agentPrincipal, causationId: env.eventId, correlationId: env.meta.correlationId }, tx);
  }

  private view(r: Row, asOf: string): SuspenseItem {
    const end = r.resolved_on && r.resolved_on <= asOf ? r.resolved_on : asOf;
    return { itemId: r.item_id, bookId: r.book_id, journalId: r.journal_id, amount: String(r.amount), openedOn: r.opened_on, source: r.source,
      owner: r.owner, status: r.status, ageDays: days(r.opened_on, end < r.opened_on ? r.opened_on : end), resolvedOn: r.resolved_on,
      resolvedBy: r.resolved_by, resolution: r.resolution };
  }

  private select(tx: TransactionSql) {
    return tx`item_id, book_id, journal_id, amount::text AS amount, opened_on::text AS opened_on, source, owner, status,
      resolved_on::text AS resolved_on, resolved_by, resolution`;
  }

  /** Items of a book, oldest first; age is in days to `asOf` (default today) or to the resolution. */
  async list(tenant: string, book: string, opts: { status?: "open" | "resolved"; asOf?: string } = {}): Promise<SuspenseItem[]> {
    const asOf = opts.asOf ?? this.clock();
    const rows = await this.store.tenantTx(tenant, (tx) => tx<Row[]>`
      SELECT ${this.select(tx)} FROM agent.suspense_items WHERE tenant_id = ${tenant} AND book_id = ${book}
        ${opts.status ? tx`AND status = ${opts.status}` : tx``}
      ORDER BY opened_on, item_id`);
    return rows.map((r) => this.view(r, asOf));
  }

  async get(tenant: string, itemId: string, tx?: TransactionSql): Promise<SuspenseItem | null> {
    const q = (t: TransactionSql) => t<Row[]>`SELECT ${this.select(t)} FROM agent.suspense_items WHERE tenant_id = ${tenant} AND item_id = ${itemId}`;
    const [r] = tx ? await q(tx) : await this.store.tenantTx(tenant, q);
    return r ? this.view(r, this.clock()) : null;
  }

  /** Give an item an owner (who works it). A person with draft.decide in the item's book. */
  async assign(tenant: string, itemId: string, owner: string, principal: string) {
    return this.store.tenantTx(tenant, async (tx) => {
      const [r] = await tx<{ book_id: string; status: string }[]>`SELECT book_id, status FROM agent.suspense_items WHERE tenant_id = ${tenant} AND item_id = ${itemId} FOR UPDATE`;
      if (!r) throw new AgentError("not_found", `no suspense item ${itemId}`);
      await this.guard.permit(tenant, principal, "draft.decide", { book: r.book_id }, tx);
      await tx`UPDATE agent.suspense_items SET owner = ${owner} WHERE tenant_id = ${tenant} AND item_id = ${itemId}`;
      await this.store.append("agent", tenant, { streamId: suspenseStream(tenant, itemId), expected: "any",
        events: [{ type: "SuspenseItemAssigned", data: { itemId, owner } }] }, { principal }, tx);
      return { itemId, owner };
    });
  }

  /**
   * Record a resolution, in the transaction that posted its journals (an ops plan commit, whose
   * approval authorizes it). Refuses an item that is not open or belongs to another book.
   */
  async markResolved(tx: TransactionSql, tenant: string, itemId: string, principal: string, planId: string,
                     r: { bookId: string; reversalJournalId: string; replacementJournalId: string | null; toAccount: string | null; resolvedOn: string; note?: string }) {
    const [row] = await tx<{ book_id: string; journal_id: string; status: string }[]>`
      SELECT book_id, journal_id, status FROM agent.suspense_items WHERE tenant_id = ${tenant} AND item_id = ${itemId} FOR UPDATE`;
    if (!row || row.book_id !== r.bookId) throw new AgentError("not_found", `no suspense item ${itemId} in book ${r.bookId}`);
    if (row.status !== "open") throw new AgentError("not_open", `suspense item ${itemId} is already resolved`);
    await this.mayDecide(tx, tenant, principal, row.book_id, planId);
    const resolution = { original: row.journal_id, reversal: r.reversalJournalId, replacement: r.replacementJournalId, toAccount: r.toAccount,
      ...(r.note ? { note: r.note } : {}), planId };
    await tx`UPDATE agent.suspense_items SET status = 'resolved', resolved_on = ${r.resolvedOn}, resolved_by = ${principal},
      resolution = ${tx.json(resolution as never)} WHERE tenant_id = ${tenant} AND item_id = ${itemId}`;
    await this.store.append("agent", tenant, { streamId: suspenseStream(tenant, itemId), expected: "any", events: [{ type: "SuspenseItemResolved",
      data: { itemId, bookId: r.bookId, journalId: row.journal_id, reversalJournalId: r.reversalJournalId, replacementJournalId: r.replacementJournalId,
        toAccount: r.toAccount, resolvedOn: r.resolvedOn, ...(r.note ? { note: r.note } : {}) } }] }, { principal, commandId: planId }, tx);
  }

  /**
   * Roll-forward for [from, to]: opening + additions − resolved = closing, by item dates. An item
   * resolved after `to` is still open at `to`, so re-running a past period gives the same figures.
   */
  async rollForward(tenant: string, book: string, from: string, to: string): Promise<RollForward> {
    const [r] = await this.store.tenantTx(tenant, (tx) => tx<{ o: string; on: number; a: string; an: number; r: string; rn: number; c: string; cn: number }[]>`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE opened_on < ${from} AND (resolved_on IS NULL OR resolved_on >= ${from})), 0)::text AS o,
        COUNT(*) FILTER (WHERE opened_on < ${from} AND (resolved_on IS NULL OR resolved_on >= ${from}))::int AS on,
        COALESCE(SUM(amount) FILTER (WHERE opened_on BETWEEN ${from} AND ${to}), 0)::text AS a,
        COUNT(*) FILTER (WHERE opened_on BETWEEN ${from} AND ${to})::int AS an,
        COALESCE(SUM(amount) FILTER (WHERE resolved_on BETWEEN ${from} AND ${to}), 0)::text AS r,
        COUNT(*) FILTER (WHERE resolved_on BETWEEN ${from} AND ${to})::int AS rn,
        COALESCE(SUM(amount) FILTER (WHERE opened_on <= ${to} AND (resolved_on IS NULL OR resolved_on > ${to})), 0)::text AS c,
        COUNT(*) FILTER (WHERE opened_on <= ${to} AND (resolved_on IS NULL OR resolved_on > ${to}))::int AS cn
      FROM agent.suspense_items WHERE tenant_id = ${tenant} AND book_id = ${book}`);
    const o = BigInt(r!.o), a = BigInt(r!.a), res = BigInt(r!.r), c = BigInt(r!.c);
    return { bookId: book, from, to, opening: o.toString(), additions: a.toString(), resolved: res.toString(), closing: c.toString(),
      counts: { opening: r!.on, additions: r!.an, resolved: r!.rn, closing: r!.cn }, balanced: o + a - res === c };
  }
}
