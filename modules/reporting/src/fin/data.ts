/**
 * What statements and metrics read (FIN-RPT-01/02). One interface, two sources: the reporting
 * projection inside one REPEATABLE READ snapshot (so every figure of an output comes from the same
 * ledger position), and an in-memory ledger (golden books for metric tests). The evaluators are
 * written once against this interface, so a report, its export and a metric test compute alike.
 *
 * Journal-level reads aggregate per (journal, account) BEFORE anything is summed across journals,
 * so a journal with several lines on one side can never be counted twice (no line-by-line joins).
 */
import type { TransactionSql } from "postgres";
import type { AccountInfo } from "./mapping.ts";

export interface JournalAgg { journalId: string; txnDate: string; seq: number; accountId: string; amount: bigint }
export interface LedgerData {
  accounts(): Promise<AccountInfo[]>;
  /** Net amount per account over lines dated from..to (null: unbounded), closing vouchers optionally excluded. */
  sums(from: string | null, to: string | null, opts?: { excludeClosing?: boolean }): Promise<Map<string, bigint>>;
  /** Net amount per (journal, account) for journals dated from..to (closing vouchers excluded) that touch any of `touching`. */
  journals(from: string, to: string, touching: string[]): Promise<JournalAgg[]>;
  /** Balance per (account, party) on `to`. */
  partyBalances(accountIds: string[], to: string): Promise<{ accountId: string; partyId: string | null; amount: bigint }[]>;
  /** Date of the first posting, or null for an empty book. */
  firstDate(): Promise<string | null>;
  /** Provisional (unconfirmed) journals dated from..to. */
  provisionalCount(from: string, to: string): Promise<number>;
  /** Journals after ledger position `seq` dated on or before `to`: a certification at `seq` no longer describes the period. */
  laterPostings(seq: number, to: string): Promise<number>;
}

// ---------------------------------------------------------------- the reporting projection
export class SqlLedgerData implements LedgerData {
  constructor(private tx: TransactionSql, private tenantId: string, private bookId: string) {}
  private cache = new Map<string, Promise<unknown>>();
  private memo<T>(k: string, f: () => Promise<T>): Promise<T> {
    if (!this.cache.has(k)) this.cache.set(k, f());
    return this.cache.get(k) as Promise<T>;
  }

  accounts() {
    return this.memo("accounts", async () => (await this.tx<{ account_id: string; name: string; nature: string; parent_id: string | null; taxonomy_tag: string | null }[]>`
      SELECT account_id, name, nature, parent_id, taxonomy_tag FROM reporting.accounts WHERE tenant_id = ${this.tenantId} AND book_id = ${this.bookId}
      ORDER BY account_id`).map((r) => ({ accountId: r.account_id, name: r.name, nature: r.nature, parentId: r.parent_id, taxonomyTag: r.taxonomy_tag })));
  }

  sums(from: string | null, to: string | null, opts: { excludeClosing?: boolean } = {}) {
    return this.memo(`sums|${from}|${to}|${!!opts.excludeClosing}`, async () => {
      const t = this.tenantId, b = this.bookId;
      const rows = await this.tx<{ account_id: string; net: string }[]>`
        SELECT account_id, SUM(net)::text AS net FROM (
          SELECT account_id, net FROM reporting.daily WHERE tenant_id = ${t} AND book_id = ${b}
            AND (${from}::date IS NULL OR txn_date >= ${from}::date) AND (${to}::date IS NULL OR txn_date <= ${to}::date)
          ${opts.excludeClosing ? this.tx`UNION ALL
          SELECT account_id, -amount FROM reporting.lines WHERE tenant_id = ${t} AND book_id = ${b} AND voucher_type = 'closing'
            AND (${from}::date IS NULL OR txn_date >= ${from}::date) AND (${to}::date IS NULL OR txn_date <= ${to}::date)` : this.tx``}
        ) x GROUP BY account_id`;
      return new Map(rows.map((r) => [r.account_id, BigInt(r.net)]));
    });
  }

  journals(from: string, to: string, touching: string[]) {
    return this.memo(`journals|${from}|${to}|${[...touching].sort().join(",")}`, async () => {
      if (!touching.length) return [];
      const t = this.tenantId, b = this.bookId;
      const rows = await this.tx<{ journal_id: string; txn_date: string; seq: number; account_id: string; net: string }[]>`
        WITH j AS MATERIALIZED (
          SELECT DISTINCT journal_id FROM reporting.lines WHERE tenant_id = ${t} AND book_id = ${b} AND account_id = ANY(${touching})
            AND txn_date >= ${from}::date AND txn_date <= ${to}::date AND voucher_type <> 'closing')
        SELECT l.journal_id, min(l.txn_date)::text AS txn_date, min(l.seq) AS seq, l.account_id, SUM(l.amount)::text AS net
        FROM reporting.lines l JOIN j ON j.journal_id = l.journal_id
        WHERE l.tenant_id = ${t} AND l.book_id = ${b}
        GROUP BY l.journal_id, l.account_id ORDER BY min(l.seq), l.journal_id, l.account_id`;
      return rows.map((r) => ({ journalId: r.journal_id, txnDate: r.txn_date, seq: r.seq, accountId: r.account_id, amount: BigInt(r.net) }));
    });
  }

  async partyBalances(accountIds: string[], to: string) {
    if (!accountIds.length) return [];
    const rows = await this.tx<{ account_id: string; party_id: string | null; net: string }[]>`
      SELECT account_id, party_id, SUM(amount)::text AS net FROM reporting.lines
      WHERE tenant_id = ${this.tenantId} AND book_id = ${this.bookId} AND account_id = ANY(${accountIds}) AND txn_date <= ${to}::date
      GROUP BY account_id, party_id ORDER BY account_id, party_id NULLS LAST`;
    return rows.map((r) => ({ accountId: r.account_id, partyId: r.party_id, amount: BigInt(r.net) }));
  }

  firstDate() {
    return this.memo("first", async () => {
      const [r] = await this.tx<{ d: string | null }[]>`SELECT min(txn_date)::text AS d FROM reporting.daily WHERE tenant_id = ${this.tenantId} AND book_id = ${this.bookId}`;
      return r?.d ?? null;
    });
  }

  async provisionalCount(from: string, to: string) {
    const [r] = await this.tx<{ n: number }[]>`
      SELECT count(DISTINCT journal_id)::int AS n FROM reporting.lines WHERE tenant_id = ${this.tenantId} AND book_id = ${this.bookId}
        AND provisional AND txn_date >= ${from}::date AND txn_date <= ${to}::date`;
    return r?.n ?? 0;
  }

  async laterPostings(seq: number, to: string) {
    const [r] = await this.tx<{ n: number }[]>`
      SELECT count(DISTINCT journal_id)::int AS n FROM reporting.lines WHERE tenant_id = ${this.tenantId} AND book_id = ${this.bookId}
        AND seq > ${seq} AND txn_date <= ${to}::date`;
    return r?.n ?? 0;
  }
}

// ---------------------------------------------------------------- in-memory ledger (golden books)
export interface LedgerFixture {
  accounts: AccountInfo[];
  journals: { journalId: string; date: string; voucherType?: string; provisional?: boolean; lines: { accountId: string; amount: string; partyId?: string }[] }[];
}

export class MemoryLedgerData implements LedgerData {
  constructor(private f: LedgerFixture) {
    for (const j of f.journals) {
      const net = j.lines.reduce((a, l) => a + BigInt(l.amount), 0n);
      if (net !== 0n) throw new Error(`fixture journal ${j.journalId} does not balance (${net})`);
    }
  }
  private lines() {
    return this.f.journals.flatMap((j, i) => j.lines.map((l) => ({ ...l, journalId: j.journalId, date: j.date, seq: i + 1, voucherType: j.voucherType ?? "journal", provisional: !!j.provisional })));
  }
  async accounts() { return this.f.accounts; }
  async sums(from: string | null, to: string | null, opts: { excludeClosing?: boolean } = {}) {
    const m = new Map<string, bigint>();
    for (const l of this.lines()) {
      if ((from && l.date < from) || (to && l.date > to) || (opts.excludeClosing && l.voucherType === "closing")) continue;
      m.set(l.accountId, (m.get(l.accountId) ?? 0n) + BigInt(l.amount));
    }
    return m;
  }
  async journals(from: string, to: string, touching: string[]) {
    const set = new Set(touching), out: JournalAgg[] = [];
    this.f.journals.forEach((j, i) => {
      if (j.date < from || j.date > to || (j.voucherType ?? "journal") === "closing" || !j.lines.some((l) => set.has(l.accountId))) return;
      const per = new Map<string, bigint>();
      for (const l of j.lines) per.set(l.accountId, (per.get(l.accountId) ?? 0n) + BigInt(l.amount));
      for (const [accountId, amount] of [...per].sort((a, b) => a[0].localeCompare(b[0]))) out.push({ journalId: j.journalId, txnDate: j.date, seq: i + 1, accountId, amount });
    });
    return out;
  }
  async partyBalances(accountIds: string[], to: string) {
    const set = new Set(accountIds), m = new Map<string, { accountId: string; partyId: string | null; amount: bigint }>();
    for (const l of this.lines()) {
      if (!set.has(l.accountId) || l.date > to) continue;
      const k = `${l.accountId}|${l.partyId ?? ""}`;
      const cur = m.get(k) ?? { accountId: l.accountId, partyId: l.partyId ?? null, amount: 0n };
      cur.amount += BigInt(l.amount); m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => a.accountId.localeCompare(b.accountId) || (a.partyId ?? "~").localeCompare(b.partyId ?? "~"));
  }
  async firstDate() { return this.f.journals.reduce<string | null>((a, j) => (a === null || j.date < a ? j.date : a), null); }
  async provisionalCount(from: string, to: string) { return this.f.journals.filter((j) => j.provisional && j.date >= from && j.date <= to).length; }
  async laterPostings(seq: number, to: string) { return this.f.journals.filter((j, i) => i + 1 > seq && j.date <= to).length; }
}
