/**
 * Reporting module: read models projected from GL events, and the statements built on them
 * (design section 8). Amounts are summed as NUMERIC in PostgreSQL and returned as bigint.
 * Every figure can be drilled through to its journal lines.
 */
import type { Sql, TransactionSql } from "postgres";
import { formatINR, type Envelope, type EventData } from "@kuber/contracts";
import { once, tenantRlsFor, type EventStore, type Migration } from "@kuber/eventstore";

export const REPORTING_MIGRATIONS: Migration[] = [{
  id: "reporting-001",
  sql: `
CREATE SCHEMA IF NOT EXISTS reporting;
CREATE TABLE reporting.accounts (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL, nature TEXT NOT NULL,
  parent_id TEXT, taxonomy_tag TEXT, PRIMARY KEY (tenant_id, book_id, account_id));
CREATE TABLE reporting.lines (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, journal_id TEXT NOT NULL, line_no INT NOT NULL, seq INT NOT NULL,
  txn_date DATE NOT NULL, account_id TEXT NOT NULL, amount NUMERIC(22,0) NOT NULL, party_id TEXT, dimensions JSONB NOT NULL,
  narration TEXT NOT NULL, provisional BOOLEAN NOT NULL, reverses TEXT, principal TEXT NOT NULL,
  PRIMARY KEY (tenant_id, journal_id, line_no));
CREATE INDEX lines_book_account ON reporting.lines (tenant_id, book_id, account_id, txn_date);
CREATE TABLE reporting.checkpoints (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, seq INT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (tenant_id, book_id));
` + tenantRlsFor("reporting"),
}, {
  id: "reporting-002-daily-balances",
  sql: `
-- One row per account per day: statements aggregate days, not journal lines.
CREATE TABLE reporting.daily (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, account_id TEXT NOT NULL, txn_date DATE NOT NULL,
  net NUMERIC(22,0) NOT NULL DEFAULT 0, dr NUMERIC(22,0) NOT NULL DEFAULT 0, cr NUMERIC(22,0) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, book_id, account_id, txn_date));
INSERT INTO reporting.daily
  SELECT tenant_id, book_id, account_id, txn_date, SUM(amount),
         COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0), COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0)
  FROM reporting.lines GROUP BY 1, 2, 3, 4;
ALTER TABLE reporting.daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.daily
  USING (current_setting('kuber.role', true) = 'system' OR tenant_id = current_setting('kuber.tenant', true))
  WITH CHECK (current_setting('kuber.role', true) = 'system' OR tenant_id = current_setting('kuber.tenant', true));
`,
}, {
  id: "reporting-003-voucher-type",
  sql: `
-- Closing vouchers move the year's income and expenses into retained surplus; income-statement
-- reports add them back so a closed year still shows what it earned and spent.
ALTER TABLE reporting.lines ADD COLUMN voucher_type TEXT NOT NULL DEFAULT 'journal';
CREATE INDEX lines_closing ON reporting.lines (tenant_id, book_id, txn_date) WHERE voucher_type = 'closing';
`,
}];

export interface Row { label: string; amount: bigint; accountId?: string; section?: string }
export interface Statement { title: string; rows: Row[]; totals: Record<string, bigint> }

export function renderText(s: Statement): string {
  const w = Math.max(24, ...s.rows.map((r) => r.label.length), ...Object.keys(s.totals).map((k) => k.length));
  const line = "-".repeat(w + 20);
  return [s.title, line, ...s.rows.map((r) => `${r.label.padEnd(w)} ${formatINR(r.amount).padStart(19)}`), line,
    ...Object.entries(s.totals).map(([k, v]) => `${k.padEnd(w)} ${formatINR(v).padStart(19)}`)].join("\n");
}

export class Reporting {
  constructor(private sql: Sql, private store: EventStore) {}

  handler = async (env: Envelope): Promise<void> => {
    if (!["BookOpened", "AccountAdded", "JournalPosted"].includes(env.type)) return;
    await once(this.store, "reporting", env, (tx) => this.project(tx, env));
  };

  private async project(tx: TransactionSql, env: Envelope) {
    const t = env.meta.tenantId;
    if (env.type === "BookOpened" || env.type === "AccountAdded") {
      const bookId = (env.data as { bookId: string }).bookId;
      const accs = env.type === "BookOpened" ? (env.data as EventData<"BookOpened">).accounts : [(env.data as EventData<"AccountAdded">).account];
      for (const a of accs) {
        await tx`INSERT INTO reporting.accounts VALUES (${t}, ${bookId}, ${a.accountId}, ${a.name}, ${a.nature}, ${a.parentId ?? null}, ${a.taxonomyTag ?? null})
                 ON CONFLICT DO NOTHING`;
      }
      return;
    }
    const d = env.data as EventData<"JournalPosted">;
    let i = 0;
    for (const l of d.lines) {
      i++;
      const ins = await tx`INSERT INTO reporting.lines VALUES (${t}, ${d.bookId}, ${d.journalId}, ${i}, ${d.seq}, ${d.txnDate}, ${l.accountId},
               ${l.amount}, ${l.partyId ?? null}, ${tx.json(l.dimensions as never)}, ${d.narration}, ${d.provisional}, ${d.reverses ?? null},
               ${env.meta.principal}, ${d.voucherType ?? "journal"}) ON CONFLICT DO NOTHING RETURNING 1`;
      if (!ins.length) continue;
      const amt = BigInt(l.amount);
      await tx`INSERT INTO reporting.daily VALUES (${t}, ${d.bookId}, ${l.accountId}, ${d.txnDate}, ${l.amount},
               ${(amt > 0n ? amt : 0n).toString()}, ${(amt < 0n ? -amt : 0n).toString()})
               ON CONFLICT (tenant_id, book_id, account_id, txn_date) DO UPDATE SET
                 net = reporting.daily.net + EXCLUDED.net, dr = reporting.daily.dr + EXCLUDED.dr, cr = reporting.daily.cr + EXCLUDED.cr`;
    }
    await tx`INSERT INTO reporting.checkpoints VALUES (${t}, ${d.bookId}, ${d.seq}, ${d.hash})
             ON CONFLICT (tenant_id, book_id) DO UPDATE SET seq = EXCLUDED.seq, hash = EXCLUDED.hash
             WHERE reporting.checkpoints.seq < EXCLUDED.seq`;
  }

  /** Balances per account (children rolled into their own rows; parents shown separately by the caller if needed). */
  async balances(tenantId: string, bookId: string, from: string | null, to: string | null) {
    return this.store.tenantTx(tenantId, async (tx) => {
      const rows = await tx<{ account_id: string; name: string; nature: string; bal: string; dr: string; cr: string }[]>`
        SELECT a.account_id, a.name, a.nature,
               COALESCE(SUM(l.net), 0)::text AS bal, COALESCE(SUM(l.dr), 0)::text AS dr, COALESCE(SUM(l.cr), 0)::text AS cr
        FROM reporting.accounts a
        LEFT JOIN reporting.daily l ON l.tenant_id = a.tenant_id AND l.book_id = a.book_id AND l.account_id = a.account_id
          AND (${from}::date IS NULL OR l.txn_date >= ${from}::date) AND (${to}::date IS NULL OR l.txn_date <= ${to}::date)
        WHERE a.tenant_id = ${tenantId} AND a.book_id = ${bookId}
        GROUP BY a.account_id, a.name, a.nature ORDER BY a.nature, a.account_id`;
      return rows.map((r) => ({ ...r, bal: BigInt(r.bal), dr: BigInt(r.dr), cr: BigInt(r.cr) }));
    });
  }

  async trialBalance(tenantId: string, bookId: string, asOf: string | null = null): Promise<Statement> {
    const b = await this.balances(tenantId, bookId, null, asOf);
    let dr = 0n, cr = 0n;
    const rows: Row[] = [];
    for (const a of b) {
      if (a.bal === 0n) continue;
      rows.push({ label: `${a.account_id}  ${a.name}  (${a.bal > 0n ? "Dr" : "Cr"})`, amount: a.bal > 0n ? a.bal : -a.bal, accountId: a.account_id, section: a.bal > 0n ? "Dr" : "Cr" });
      if (a.bal > 0n) dr += a.bal; else cr -= a.bal;
    }
    return { title: `Trial balance as of ${asOf ?? "today"}`, rows, totals: { "Total debits": dr, "Total credits": cr, "Difference (must be 0)": dr - cr } };
  }

  async profitAndLoss(tenantId: string, bookId: string, from: string | null, to: string | null): Promise<Statement> {
    const closing = await this.closingNet(tenantId, bookId, from, to);
    const b = (await this.balances(tenantId, bookId, from, to)).map((a) => ({ ...a, bal: a.bal - (closing.get(a.account_id) ?? 0n) }));
    const inc = b.filter((a) => a.nature === "income" && a.bal !== 0n);
    const exp = b.filter((a) => a.nature === "expense" && a.bal !== 0n);
    const ti = inc.reduce((s, a) => s - a.bal, 0n), te = exp.reduce((s, a) => s + a.bal, 0n);
    return { title: `Profit and loss ${from ?? "start"} to ${to ?? "today"}`,
      rows: [...inc.map((a) => ({ label: `Income: ${a.name}`, amount: -a.bal, accountId: a.account_id, section: "income" })), ...exp.map((a) => ({ label: `Expense: ${a.name}`, amount: a.bal, accountId: a.account_id, section: "expense" }))],
      totals: { "Total income": ti, "Total expenses": te, "Surplus / (deficit)": ti - te } };
  }

  async balanceSheet(tenantId: string, bookId: string, asOf: string | null = null): Promise<Statement> {
    const b = await this.balances(tenantId, bookId, null, asOf);
    const pick = (n: string) => b.filter((a) => a.nature === n && a.bal !== 0n);
    const assets = pick("asset"), liabs = pick("liability"), eq = pick("equity");
    const surplus = -b.filter((a) => a.nature === "income" || a.nature === "expense").reduce((s, a) => s + a.bal, 0n);
    const ta = assets.reduce((s, a) => s + a.bal, 0n), tl = liabs.reduce((s, a) => s - a.bal, 0n);
    const te = eq.reduce((s, a) => s - a.bal, 0n) + surplus;
    return { title: `Balance sheet as of ${asOf ?? "today"}`,
      rows: [...assets.map((a) => ({ label: `Asset: ${a.name}`, amount: a.bal, accountId: a.account_id, section: "asset" })), ...liabs.map((a) => ({ label: `Liability: ${a.name}`, amount: -a.bal, accountId: a.account_id, section: "liability" })),
        ...eq.map((a) => ({ label: `Equity: ${a.name}`, amount: -a.bal, accountId: a.account_id, section: "equity" })), { label: "Equity: Surplus to date", amount: surplus, section: "equity" }],
      totals: { "Total assets": ta, "Total liabilities": tl, "Total equity": te, "Assets - liabilities - equity (must be 0)": ta - tl - te } };
  }

  /** Profit from incomplete records: change in net assets adjusted for drawings and new capital. */
  async statementOfAffairs(tenantId: string, bookId: string, d1: string, d2: string, drawings = 0n, introduced = 0n): Promise<Statement> {
    const cap = async (on: string) => {
      const b = await this.balances(tenantId, bookId, null, on);
      const a = b.filter((x) => x.nature === "asset").reduce((s, x) => s + x.bal, 0n);
      const l = -b.filter((x) => x.nature === "liability").reduce((s, x) => s + x.bal, 0n);
      return { a, l, c: a - l };
    };
    const x = await cap(d1), y = await cap(d2);
    return { title: `Statement of affairs ${d1} to ${d2}`,
      rows: [{ label: `Assets on ${d1}`, amount: x.a }, { label: `Liabilities on ${d1}`, amount: x.l }, { label: `Capital on ${d1}`, amount: x.c },
        { label: `Assets on ${d2}`, amount: y.a }, { label: `Liabilities on ${d2}`, amount: y.l }, { label: `Capital on ${d2}`, amount: y.c },
        { label: "Add: drawings", amount: drawings }, { label: "Less: capital introduced", amount: introduced }],
      totals: { "Profit / (loss) for the period": y.c - x.c + drawings - introduced } };
  }

  /** Net of closing vouchers per account in a range, so income statements can add them back. */
  async closingNet(tenantId: string, bookId: string, from: string | null, to: string | null): Promise<Map<string, bigint>> {
    const rows = await this.store.tenantTx(tenantId, (tx) => tx<{ account_id: string; net: string }[]>`
      SELECT account_id, SUM(amount)::text AS net FROM reporting.lines
      WHERE tenant_id = ${tenantId} AND book_id = ${bookId} AND voucher_type = 'closing'
        AND (${from}::date IS NULL OR txn_date >= ${from}::date) AND (${to}::date IS NULL OR txn_date <= ${to}::date)
      GROUP BY account_id`);
    return new Map(rows.map((r) => [r.account_id, BigInt(r.net)]));
  }

  /** Monthly movement per account nature (closing vouchers excluded), for trends and run-rate. */
  async monthly(tenantId: string, bookId: string, from: string, to: string) {
    const rows = await this.store.tenantTx(tenantId, (tx) => tx<{ month: string; nature: string; account_id: string; net: string }[]>`
      SELECT to_char(date_trunc('month', l.txn_date), 'YYYY-MM') AS month, a.nature, l.account_id, SUM(l.amount)::text AS net
      FROM reporting.lines l JOIN reporting.accounts a ON a.tenant_id = l.tenant_id AND a.book_id = l.book_id AND a.account_id = l.account_id
      WHERE l.tenant_id = ${tenantId} AND l.book_id = ${bookId} AND l.voucher_type <> 'closing'
        AND l.txn_date >= ${from}::date AND l.txn_date <= ${to}::date
      GROUP BY 1, 2, 3 ORDER BY 1`);
    return rows.map((r) => ({ ...r, net: BigInt(r.net) }));
  }

  /** Last date with any posting, and the projection checkpoint (for freshness checks). */
  async position(tenantId: string, bookId: string) {
    const [r] = await this.store.tenantTx(tenantId, (tx) => tx<{ last_date: string | null; seq: number | null }[]>`
      SELECT (SELECT max(txn_date)::text FROM reporting.lines WHERE tenant_id = ${tenantId} AND book_id = ${bookId}) AS last_date,
             (SELECT seq FROM reporting.checkpoints WHERE tenant_id = ${tenantId} AND book_id = ${bookId}) AS seq`);
    return { lastDate: r?.last_date ?? null, seq: r?.seq ?? 0 };
  }

  /** Books this tenant has, with the entity type inferred from the chart. */
  async books(tenantId: string) {
    return this.store.tenantTx(tenantId, (tx) => tx`
      SELECT book_id, count(*)::int AS accounts FROM reporting.accounts WHERE tenant_id = ${tenantId} GROUP BY book_id ORDER BY book_id`);
  }

  /** The chart of accounts with current balances (natural sign applied by the caller). */
  async accounts(tenantId: string, bookId: string) {
    return this.store.tenantTx(tenantId, (tx) => tx`
      SELECT a.account_id, a.name, a.nature, a.parent_id, a.taxonomy_tag, COALESCE(SUM(d.net), 0)::text AS balance
      FROM reporting.accounts a
      LEFT JOIN reporting.daily d ON d.tenant_id = a.tenant_id AND d.book_id = a.book_id AND d.account_id = a.account_id
      WHERE a.tenant_id = ${tenantId} AND a.book_id = ${bookId}
      GROUP BY a.account_id, a.name, a.nature, a.parent_id, a.taxonomy_tag ORDER BY a.nature, a.account_id`);
  }

  /** Most recent journals with their lines, newest first. */
  async recentJournals(tenantId: string, bookId: string, limit = 20) {
    return this.store.tenantTx(tenantId, (tx) => tx`
      SELECT journal_id, max(seq) AS seq, max(txn_date)::text AS txn_date, max(narration) AS narration,
             bool_or(provisional) AS provisional, max(reverses) AS reverses, max(principal) AS principal,
             json_agg(json_build_object('accountId', account_id, 'amount', amount::text, 'partyId', party_id) ORDER BY line_no) AS lines
      FROM reporting.lines WHERE tenant_id = ${tenantId} AND book_id = ${bookId}
      GROUP BY journal_id ORDER BY max(seq) DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`);
  }

  /** Drill-through: the journal lines behind an account balance. */
  async drill(tenantId: string, bookId: string, accountId: string, from: string | null = null, to: string | null = null) {
    return this.store.tenantTx(tenantId, (tx) => tx`
      SELECT journal_id, seq, txn_date::text, amount::text, party_id, narration, provisional, reverses, principal
      FROM reporting.lines WHERE tenant_id = ${tenantId} AND book_id = ${bookId} AND account_id = ${accountId}
        AND (${from}::date IS NULL OR txn_date >= ${from}::date) AND (${to}::date IS NULL OR txn_date <= ${to}::date)
      ORDER BY txn_date, seq, line_no`);
  }
}
