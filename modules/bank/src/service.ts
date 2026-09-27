/**
 * The bank module (FIN-CASH-01..03): the book's own bank accounts, statement integrity, settlement
 * clearing for the agent's matching, exceptions, and certified bank reconciliations.
 *
 * FIN-CASH-01 statement integrity. A statement file is imported against a registered account:
 *   - account identity: the number (and IFSC) printed on the statement, compared by keyed blind
 *     index with the registered account (never stored in clear);
 *   - arithmetic: opening plus signed movements equals closing (running balance, or declared
 *     opening/closing), no ambiguous row (both debit and credit), no row outside the period;
 *   - coverage: the balance where it meets or overlaps an earlier statement must agree (a missing
 *     row between files shows here), and gaps between statements are exceptions;
 *   - provenance: uploaded (a person's file) or authenticated (a bank feed; none is configured yet).
 * A statement that fails is HELD: its original is retained sealed, nothing is submitted, and an
 * exception (hold "import") is raised. A verified statement's lines go through the channels
 * module (retained original, per-line identity, so overlapping files add only unique movements)
 * and the row lineage is kept in bank.statement_rows.
 *
 * FIN-CASH-02 clearing: this service is the agent's ClearingHook (see @kuber/agent settlement.ts).
 * FIN-CASH-03 reconciliation: `reconciliation` computes the statement (reconcile.ts); certification
 * is the ops operation certify_bank_reconciliation, whose commit runs `certify` (the `bank` ext
 * action) under the book lock: independent certifier, unchanged inputs, zero difference, then a
 * certified snapshot (reporting.snapshots) with the input statement hashes and the ledger position.
 * A later posting into a certified period withdraws the certification (bus consumer "bank").
 *
 * Every write passes the identity guard (module guard) inside its own transaction.
 */
import type { TransactionSql } from "postgres";
import { canonical, isIsoDate, journalIdForRequest, principalRole, sha256, stableId, type Envelope, type EventData, type Line, type RawTxn } from "@kuber/contracts";
import { DENY_ALL_GUARD, once, type EventStore, type ModuleGuard, type NewEvent } from "@kuber/eventstore";
import { bookStream, type GeneralLedger } from "@kuber/gl";
import { STATEMENT_PARSER, parseBankStatement, type Channels, type DeclaredTotals } from "@kuber/channels";
import type { Clearing, ClearingHook, PriorLine, SettlementContext, SettlementLeg } from "@kuber/agent";
import type { Reporting } from "@kuber/reporting";
import { bankDetailsCtx, exceptionResolutionCtx, lineDetailCtx, statementOriginalCtx } from "./migrations.ts";
import { bankJournals, coverage, dayAfter, dayBefore, reconcile, settle, type Link, type Reconciliation, type StatementInfo } from "./reconcile.ts";

export class BankError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

/** An authenticated bank feed (FIN-CASH-01 provenance). None exists yet: authenticated imports are refused. */
export interface BankFeed { verify(payload: { csv: string; signature: string }): Promise<boolean> }

export interface BankDeps {
  store: EventStore; gl: GeneralLedger; channels: Channels; reporting: Reporting;
  guard?: ModuleGuard;
  /** Is `later` the same person as `earlier` (identity, following role re-keying)? */
  samePerson: (tenant: string, earlier: string, later: string) => Promise<boolean>;
  /** A party master name, for counterparty evidence; null when unknown. */
  partyName?: (tenant: string, partyId: string) => Promise<string | null>;
  clock: () => string;
  feed?: BankFeed;
}

export interface BankAccount {
  bankAccountId: string; bookId: string; glAccountId: string; bankName: string; masked: string; last4: string; currency: "INR";
  openingDate: string; staleDays: number; feeTolerancePaise: string; status: string; registeredBy: string;
}
export interface RegisterInput {
  bankAccountId: string; glAccountId: string; bankName: string; accountNumber: string; ifsc: string;
  /** First day the account is reconciled from: earlier book entries are in the first statement's opening balance. */
  openingDate: string; staleDays?: number; feeTolerancePaise?: string;
}
export interface ImportInput {
  bankAccountId: string; csv: string;
  /** What the statement itself says it is for: its account number and/or IFSC. */
  statementAccount?: { accountNumber?: string; ifsc?: string };
  periodFrom?: string; periodTo?: string; declared?: DeclaredTotals;
  provenance?: "uploaded" | "authenticated"; feedSignature?: string;
}
export interface ImportResult {
  statementId: string; bankAccountId: string; status: "verified" | "held"; provenance: "uploaded" | "authenticated"; identity: "proven" | "mismatch" | "missing";
  periodFrom: string; periodTo: string; opening: string | null; closing: string | null; contentHash: string;
  rows: number; accepted: number; duplicates: number; skipped: number; signalId: string | null; problems: string[]; duplicate: boolean; exceptions: string[];
}
export interface BankException {
  caseId: string; bookId: string; bankAccountId: string | null; requirement: string; sourceId: string; cause: string; amount: string | null; period: string | null;
  owner: string; hold: string; dueBy: string; status: string; resolution: string | null; resolvedBy: string | null; detectedAt: string;
}

const CERTIFIERS = new Set(["superuser", "controller", "treasurer"]);
export const PREPARERS = new Set(["treasurer", "controller", "staff"]);
const SYSTEM = "system:bank";
const OWNER = "Unassigned — Treasurer";
const WINDOW_DAYS = 90;
const normNumber = (s: string) => s.replace(/\D/g, "").replace(/^0+/, "");
const accountStream = (t: string, book: string, id: string) => `${t}/bank/${book}/${id}`;
const exceptionStream = (t: string, book: string) => `${t}/bank-exceptions/${book}`;
const origin = (t: string) => (txnId: string) => journalIdForRequest(t, `req-${txnId}`);
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ID = /^[A-Za-z0-9_.:@+-]{1,64}$/;

export class BankService implements ClearingHook {
  private readonly guard: ModuleGuard;
  constructor(private d: BankDeps) { this.guard = d.guard ?? DENY_ALL_GUARD; }

  // ------------------------------------------------------------------ FIN-CASH-01: the account register
  /** Register one of the book's own bank accounts; the number and IFSC are sealed, shown masked. Needs bank.manage. */
  async registerAccount(tenant: string, book: string, principal: string, i: RegisterInput): Promise<BankAccount> {
    if (!ID.test(i.bankAccountId)) throw new BankError("bad_request", "bank account id: letters, digits and _.:@+- (up to 64)", 400);
    if (!/^[0-9]{6,20}$/.test(i.accountNumber)) throw new BankError("bad_request", "account number: 6 to 20 digits", 400);
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(i.ifsc)) throw new BankError("bad_request", "not an IFSC code", 400);
    if (!isIsoDate(i.openingDate)) throw new BankError("bad_request", `opening date ${i.openingDate} is not a real calendar date (YYYY-MM-DD)`, 400);
    const staleDays = i.staleDays ?? WINDOW_DAYS;
    if (!Number.isInteger(staleDays) || staleDays < 1 || staleDays > 3650) throw new BankError("bad_request", "staleDays: 1 to 3650", 400);
    const fee = i.feeTolerancePaise ?? "0";
    if (!/^\d{1,12}$/.test(fee)) throw new BankError("bad_request", "feeTolerancePaise: a non-negative integer of paise", 400);
    const state = await this.d.gl.state(tenant, book);
    if (!state.exists) throw new BankError("no_book", `book ${book} does not exist`, 404);
    const gl = state.accounts.get(i.glAccountId);
    if (!gl || gl.nature !== "asset" || !gl.isCashLike) throw new BankError("not_bank_account", `${i.glAccountId} is not a cash-like asset account of ${book}`, 422);
    if (state.closed.has(i.glAccountId)) throw new BankError("account_closed", `${i.glAccountId} is closed`, 422);
    const keys = await this.d.store.keys(tenant);
    const number = normNumber(i.accountNumber);
    const accountIdx = keys.index("bank-account", number), ifscIdx = keys.index("bank-ifsc", i.ifsc);
    const last4 = number.slice(-4), masked = `${"X".repeat(Math.max(number.length - 4, 2))}${last4}`;
    return this.d.store.tenantTx(tenant, async (tx) => {
      await this.guard.permit(tenant, principal, "bank.manage", { book }, tx);
      const clash = await tx`SELECT bank_account_id FROM bank.accounts WHERE tenant_id = ${tenant} AND status = 'active'
        AND (bank_account_id = ${i.bankAccountId} OR (book_id = ${book} AND (gl_account_id = ${i.glAccountId} OR account_idx = ${accountIdx})))`;
      if (clash.length) throw new BankError("already_registered", `the id, the GL account ${i.glAccountId} or this account number is already registered`);
      await tx`INSERT INTO bank.accounts (tenant_id, bank_account_id, book_id, gl_account_id, bank_name, bank, account_idx, ifsc_idx, masked, last4, currency,
                 opening_date, stale_days, fee_tolerance, registered_by)
               VALUES (${tenant}, ${i.bankAccountId}, ${book}, ${i.glAccountId}, ${i.bankName}, ${keys.sealJson({ accountNumber: i.accountNumber, ifsc: i.ifsc }, bankDetailsCtx(i.bankAccountId))},
                 ${accountIdx}, ${ifscIdx}, ${masked}, ${last4}, 'INR', ${i.openingDate}, ${staleDays}, ${fee}, ${principal})`;
      await this.backfill(tx, tenant, book, i.glAccountId);
      await this.d.store.append("bank", tenant, { streamId: accountStream(tenant, book, i.bankAccountId), expected: "no_stream", events: [{ type: "BankAccountRegistered",
        data: { bankAccountId: i.bankAccountId, bookId: book, glAccountId: i.glAccountId, bankName: i.bankName, accountNumber: i.accountNumber, ifsc: i.ifsc, masked,
          accountIdx, currency: "INR", staleDays, feeTolerancePaise: fee } }] }, { principal }, tx);
      return (await this.accountIn(tx, tenant, i.bankAccountId))!;
    });
  }

  /**
   * Statement lines the agent processed before the account was registered: journals it posted from
   * an authoritative line (source <tenant>/txn/<id>) are that line's own entry, and provisional
   * journals a line confirmed are settled by it. Without this they would look uncleared.
   */
  private async backfill(tx: TransactionSql, tenant: string, book: string, gl: string) {
    const keys = await this.d.store.keys(tenant);
    const amountOn = (lines: Line[]) => lines.filter((l) => l.accountId === gl).reduce((a, l) => a + BigInt(l.amount), 0n);
    const posted = new Map<string, EventData<"JournalPosted">>();
    for (const e of await this.d.store.readStream(tenant, bookStream(tenant, book), 0, tx)) {
      if (e.type === "JournalPosted") {
        const d = e.data as EventData<"JournalPosted">;
        posted.set(d.journalId, d);
        const src = d.source?.stream;
        if (!src?.startsWith(`${tenant}/txn/`) || d.provisional || amountOn(d.lines) === 0n) continue;
        const txnId = src.slice(`${tenant}/txn/`.length);
        await tx`INSERT INTO bank.lines (tenant_id, txn_id, book_id, gl_account_id, txn_date, amount, origin_journal, detail)
                 VALUES (${tenant}, ${txnId}, ${book}, ${gl}, ${d.txnDate}, ${amountOn(d.lines).toString()}, ${d.journalId},
                         ${keys.sealJson({ narration: d.narration, reference: null, hint: null }, lineDetailCtx(txnId))}) ON CONFLICT DO NOTHING`;
      } else if (e.type === "JournalConfirmed") {
        const d = e.data as EventData<"JournalConfirmed">;
        const j = posted.get(d.journalId);
        if (!j || !d.source.startsWith(`${tenant}/txn/`) || amountOn(j.lines) === 0n) continue;
        const txnId = d.source.slice(`${tenant}/txn/`.length), amount = amountOn(j.lines).toString();
        await tx`INSERT INTO bank.lines (tenant_id, txn_id, book_id, gl_account_id, txn_date, amount, origin_journal, detail)
                 VALUES (${tenant}, ${txnId}, ${book}, ${gl}, ${j.txnDate}, ${amount}, ${journalIdForRequest(tenant, `req-${txnId}`)},
                         ${keys.sealJson({ narration: j.narration, reference: null, hint: null }, lineDetailCtx(txnId))}) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO bank.clearings (tenant_id, txn_id, journal_id, book_id, gl_account_id, txn_date, amount, kind, basis, cleared_by)
                 VALUES (${tenant}, ${txnId}, ${d.journalId}, ${book}, ${gl}, ${j.txnDate}, ${amount}, 'one_to_one', ${d.basis ?? "reference"}, ${SYSTEM}) ON CONFLICT DO NOTHING`;
      }
    }
  }

  async accounts(tenant: string, book?: string): Promise<BankAccount[]> {
    return this.d.store.tenantTx(tenant, async (tx) => (await tx<AccountRow[]>`
      SELECT bank_account_id, book_id, gl_account_id, bank_name, masked, last4, currency, opening_date::text AS opening_date, stale_days, fee_tolerance::text AS fee_tolerance, status, registered_by FROM bank.accounts WHERE tenant_id = ${tenant} ${book ? tx`AND book_id = ${book}` : tx``} ORDER BY book_id, bank_account_id`).map(toAccount));
  }

  async account(tenant: string, bankAccountId: string): Promise<BankAccount | null> {
    return this.d.store.tenantTx(tenant, (tx) => this.accountIn(tx, tenant, bankAccountId));
  }

  private async accountIn(tx: TransactionSql, tenant: string, bankAccountId: string): Promise<BankAccount | null> {
    const [r] = await tx<AccountRow[]>`SELECT bank_account_id, book_id, gl_account_id, bank_name, masked, last4, currency, opening_date::text AS opening_date, stale_days, fee_tolerance::text AS fee_tolerance, status, registered_by FROM bank.accounts WHERE tenant_id = ${tenant} AND bank_account_id = ${bankAccountId}`;
    return r ? toAccount(r) : null;
  }

  private async requireAccount(tenant: string, book: string, bankAccountId: string): Promise<BankAccount> {
    const a = await this.account(tenant, bankAccountId);
    if (!a || a.bookId !== book) throw new BankError("no_bank_account", `no bank account ${bankAccountId} in book ${book}`, 404);
    if (a.status !== "active") throw new BankError("account_closed", `bank account ${bankAccountId} is closed`, 422);
    return a;
  }

  // ------------------------------------------------------------------ FIN-CASH-01: statement import
  async importStatement(tenant: string, book: string, principal: string, i: ImportInput): Promise<ImportResult> {
    await this.guard.permit(tenant, principal, "capture", { book });
    const acct = await this.requireAccount(tenant, book, i.bankAccountId);
    const provenance = i.provenance ?? "uploaded";
    if (provenance === "authenticated") {
      if (!this.d.feed) throw new BankError("feed_unavailable", "no authenticated bank feed is configured: statements are imported as uploaded files", 422);
      if (!i.feedSignature || !(await this.d.feed.verify({ csv: i.csv, signature: i.feedSignature }))) throw new BankError("feed_unverified", "the feed signature does not verify", 422);
    }
    for (const [k, v] of [["periodFrom", i.periodFrom], ["periodTo", i.periodTo]] as const) {
      if (v !== undefined && !isIsoDate(v)) throw new BankError("bad_request", `${k} ${v} is not a real calendar date (YYYY-MM-DD)`, 400);
    }
    let parsed: ReturnType<typeof parseBankStatement>;
    try { parsed = parseBankStatement(i.csv, acct.glAccountId, i.declared ?? {}); }
    catch (e) { throw new BankError("unreadable", `statement cannot be read: ${e instanceof Error ? e.message : String(e)}`, 422); }
    const keys = await this.d.store.keys(tenant);
    const contentHash = sha256(i.csv);
    const problems: string[] = [];

    // account identity
    const [row] = await this.d.store.tenantTx(tenant, (tx) => tx<{ account_idx: string; ifsc_idx: string }[]>`
      SELECT account_idx, ifsc_idx FROM bank.accounts WHERE tenant_id = ${tenant} AND bank_account_id = ${acct.bankAccountId}`);
    const sa = i.statementAccount ?? {};
    let identity: ImportResult["identity"] = "missing";
    if (sa.accountNumber) {
      const numberOk = keys.index("bank-account", normNumber(sa.accountNumber)) === row!.account_idx;
      const ifscOk = !sa.ifsc || keys.index("bank-ifsc", sa.ifsc.trim().toUpperCase()) === row!.ifsc_idx;
      identity = numberOk && ifscOk ? "proven" : "mismatch";
    } else if (sa.ifsc) identity = "mismatch";
    if (identity === "missing") problems.push("account identity not proven: give the account number printed on the statement");
    if (identity === "mismatch") problems.push(`the statement's account number or IFSC is not that of ${acct.bankAccountId} (${acct.masked})`);

    // arithmetic: opening + signed movements = closing, and every row accounted for
    const c = parsed.controls;
    if (c.status === "mismatch") problems.push(...c.problems);
    if (c.opening === undefined || c.closing === undefined) problems.push("opening and closing balances cannot be proven: the file has no running balance and none were declared");
    for (const s of parsed.skipped) if (s.reason !== "no amount") problems.push(`row ${s.row}: ${s.reason === "both debit and credit present" ? "ambiguous debit/credit" : s.reason}`);
    const dates = parsed.txns.map((t) => t.txnDate).sort();
    const periodFrom = i.periodFrom ?? dates[0], periodTo = i.periodTo ?? dates.at(-1);
    if (!periodFrom || !periodTo) throw new BankError("bad_request", "the statement has no movements: give its period (periodFrom, periodTo)", 400);
    if (periodFrom > periodTo) problems.push(`period ${periodFrom}..${periodTo} ends before it starts`);
    const outside = parsed.txns.filter((t) => t.txnDate < periodFrom || t.txnDate > periodTo).map((t) => t.sourceRow);
    if (outside.length) problems.push(`row(s) ${outside.join(", ")} fall outside the statement period ${periodFrom}..${periodTo}`);
    const opening = c.opening !== undefined ? BigInt(c.opening) : null, closing = c.closing !== undefined ? BigInt(c.closing) : null;

    // rows (lineage) before submission: date and signed amount per data row
    const byRow = new Map(parsed.txns.map((t) => [t.sourceRow!, t]));
    const rowsOut = Array.from({ length: parsed.rows }, (_, k) => {
      const t = byRow.get(k + 1);
      return { rowNo: k + 1, txnDate: t?.txnDate ?? null, amount: t ? BigInt(t.amount) * (t.direction === "in" ? 1n : -1n) : 0n,
        reason: parsed.skipped.find((s) => s.row === k + 1)?.reason ?? null };
    });

    // coverage continuity with the account's verified statements (a missing row between files shows here)
    const existing = await this.statementInfo(tenant, acct.bankAccountId);
    if (opening !== null && closing !== null && !problems.length) {
      const mine: StatementInfo = { statementId: "new", status: "verified", provenance, identity, periodFrom, periodTo, opening, closing, contentHash,
        rows: rowsOut.map((r) => ({ rowNo: r.rowNo, txnId: null, txnDate: r.txnDate, amount: r.amount })) };
      for (const s of existing.filter((x) => x.status === "verified" && x.opening !== null && x.contentHash !== contentHash)) {
        if (s.periodTo < dayBefore(periodFrom) || dayBefore(s.periodFrom) > periodTo) continue;      // neither touching nor overlapping
        const b = dayBefore(s.periodFrom > periodFrom ? s.periodFrom : periodFrom);
        const ours = balanceOf(mine, b), theirs = balanceOf(s, b);
        if (ours !== null && theirs !== null && ours !== theirs)
          problems.push(`balance on ${b} is ${ours} by this statement but ${theirs} by statement ${s.statementId} (${s.periodFrom}..${s.periodTo}): a row is missing or wrong`);
      }
    }
    const status: ImportResult["status"] = problems.length ? "held" : "verified";
    const statementId = sha256(`${book}|${acct.bankAccountId}|${contentHash}|${canonical({ sa: { n: sa.accountNumber ? keys.index("bank-account", normNumber(sa.accountNumber)) : null, i: sa.ifsc ?? null },
      periodFrom, periodTo, declared: i.declared ?? null, provenance })}`).slice(0, 32);
    const prior = existing.find((s) => s.statementId === statementId);
    if (prior) return { ...(await this.statementResult(tenant, statementId))!, duplicate: true };

    let submitted: Awaited<ReturnType<Channels["submitStatement"]>> | null = null;
    if (status === "verified") submitted = await this.d.channels.submitStatement(tenant, book, i.csv, principal, { instrument: acct.glAccountId, declared: i.declared });
    const txnOf = new Map((submitted?.dispositions ?? []).map((x) => [x.row, x]));
    const accepted = submitted?.accepted ?? 0, duplicates = submitted?.duplicates ?? 0, skipped = submitted?.skipped ?? parsed.skipped.length;

    return this.d.store.tenantTx(tenant, async (tx) => {
      await this.guard.permit(tenant, principal, "capture", { book }, tx);
      const ins = await tx`INSERT INTO bank.statements (tenant_id, statement_id, book_id, bank_account_id, status, provenance, identity, period_from, period_to,
                   opening, closing, content_hash, parser, rows, accepted, duplicates, skipped, signal_id, original, problems, uploaded_by)
                 VALUES (${tenant}, ${statementId}, ${book}, ${acct.bankAccountId}, ${status}, ${provenance}, ${identity}, ${periodFrom}, ${periodTo},
                   ${opening?.toString() ?? null}, ${closing?.toString() ?? null}, ${contentHash}, ${STATEMENT_PARSER}, ${parsed.rows}, ${accepted}, ${duplicates}, ${skipped},
                   ${submitted?.signalId ?? null}, ${status === "held" ? keys.seal(i.csv, statementOriginalCtx(statementId)) : ""}, ${tx.json(problems as never)}, ${principal})
                 ON CONFLICT DO NOTHING RETURNING 1`;
      if (!ins.length) return { ...(await this.statementResultIn(tx, tenant, statementId))!, duplicate: true };
      for (const r of rowsOut) {
        const disp = txnOf.get(r.rowNo);
        await tx`INSERT INTO bank.statement_rows (tenant_id, statement_id, row_no, txn_id, txn_date, amount, disposition, reason)
                 VALUES (${tenant}, ${statementId}, ${r.rowNo}, ${disp?.txnId ?? null}, ${r.txnDate}, ${r.amount.toString()},
                   ${disp?.disposition ?? (status === "held" ? "held" : "skipped")}, ${r.reason})`;
      }
      const events: NewEvent[] = [{ type: "BankStatementImported", data: { statementId, bookId: book, bankAccountId: acct.bankAccountId, status, provenance, periodFrom, periodTo,
        opening: opening?.toString() ?? null, closing: closing?.toString() ?? null, contentHash, rows: parsed.rows, accepted, duplicates, skipped,
        signalId: submitted?.signalId ?? null, identity, problems } }];
      await this.d.store.append("bank", tenant, { streamId: accountStream(tenant, book, acct.bankAccountId), expected: "any", events }, { principal }, tx);
      const exceptions: string[] = [];
      if (status === "held") {
        exceptions.push(await this.raise(tx, tenant, { bookId: book, bankAccountId: acct.bankAccountId, requirement: "FIN-CASH-01", sourceId: statementId,
          cause: `statement held: ${problems.join("; ")}`, amount: null, period: `${periodFrom}..${periodTo}`, hold: "import", key: `held/${statementId}` }, principal));
      } else {
        // gaps in the account's coverage from its opening date to the latest statement
        const all = [...existing, { statementId, status: "verified" as const, provenance, identity, periodFrom, periodTo, opening, closing, contentHash, rows: [] }];
        const last = all.filter((s) => s.status === "verified").map((s) => s.periodTo).sort().at(-1)!;
        for (const g of coverage(all, acct.openingDate, last).gaps) {
          exceptions.push(await this.raise(tx, tenant, { bookId: book, bankAccountId: acct.bankAccountId, requirement: "FIN-CASH-01", sourceId: statementId,
            cause: `no statement covers ${g.from}..${g.to}`, amount: null, period: `${g.from}..${g.to}`, hold: "certification", key: `gap/${acct.bankAccountId}/${g.from}/${g.to}` }, principal));
        }
        // new movements dated inside a certified period withdraw its certification
        const firstNew = rowsOut.filter((r) => txnOf.get(r.rowNo)?.disposition === "accepted" && r.txnDate).map((r) => r.txnDate!).sort()[0];
        if (firstNew) await this.withdrawFrom(tx, tenant, book, acct.bankAccountId, firstNew, 2_147_483_647,
          `statement ${statementId} adds movements from ${firstNew} into a certified period`, { statementId });
      }
      return { statementId, bankAccountId: acct.bankAccountId, status, provenance, identity, periodFrom, periodTo, opening: opening?.toString() ?? null, closing: closing?.toString() ?? null,
        contentHash, rows: parsed.rows, accepted, duplicates, skipped, signalId: submitted?.signalId ?? null, problems, duplicate: false, exceptions: exceptions.filter(Boolean) };
    });
  }

  private async statementResult(tenant: string, statementId: string) {
    return this.d.store.tenantTx(tenant, (tx) => this.statementResultIn(tx, tenant, statementId));
  }

  private async statementResultIn(tx: TransactionSql, tenant: string, statementId: string): Promise<Omit<ImportResult, "duplicate"> | null> {
    const [s] = await tx<StatementRow[]>`SELECT statement_id, book_id, bank_account_id, status, provenance, identity, period_from::text AS period_from, period_to::text AS period_to, opening::text AS opening, closing::text AS closing, content_hash, parser, rows, accepted, duplicates, skipped, signal_id, original, problems, uploaded_by, created_at FROM bank.statements WHERE tenant_id = ${tenant} AND statement_id = ${statementId}`;
    if (!s) return null;
    const ex = await tx<{ case_id: string }[]>`SELECT case_id FROM bank.exceptions WHERE tenant_id = ${tenant} AND source_id = ${statementId} ORDER BY case_id`;
    return { statementId, bankAccountId: s.bank_account_id, status: s.status, provenance: s.provenance, identity: s.identity, periodFrom: s.period_from, periodTo: s.period_to,
      opening: s.opening, closing: s.closing, contentHash: s.content_hash, rows: s.rows, accepted: s.accepted, duplicates: s.duplicates, skipped: s.skipped,
      signalId: s.signal_id, problems: s.problems, exceptions: ex.map((e) => e.case_id) };
  }

  /** Statements of a book (optionally one account), newest period first, without originals. */
  async statements(tenant: string, book: string, bankAccountId?: string) {
    return this.d.store.tenantTx(tenant, async (tx) => (await tx<StatementRow[]>`
      SELECT statement_id, book_id, bank_account_id, status, provenance, identity, period_from::text AS period_from, period_to::text AS period_to, opening::text AS opening, closing::text AS closing, content_hash, parser, rows, accepted, duplicates, skipped, signal_id, original, problems, uploaded_by, created_at FROM bank.statements WHERE tenant_id = ${tenant} AND book_id = ${book} ${bankAccountId ? tx`AND bank_account_id = ${bankAccountId}` : tx``}
      ORDER BY bank_account_id, period_from DESC, created_at DESC`).map((s) => ({
        statementId: s.statement_id, bankAccountId: s.bank_account_id, status: s.status, provenance: s.provenance, identity: s.identity,
        periodFrom: s.period_from, periodTo: s.period_to, opening: s.opening, closing: s.closing, contentHash: s.content_hash, parser: s.parser,
        rows: s.rows, accepted: s.accepted, duplicates: s.duplicates, skipped: s.skipped, signalId: s.signal_id, problems: s.problems,
        uploadedBy: s.uploaded_by, createdAt: s.created_at.toISOString() })));
  }

  /** One statement with its row lineage, and its retained original (re-hashed). */
  async statement(tenant: string, statementId: string) {
    const keys = await this.d.store.keys(tenant);
    const r = await this.d.store.tenantTx(tenant, async (tx) => {
      const [s] = await tx<StatementRow[]>`SELECT statement_id, book_id, bank_account_id, status, provenance, identity, period_from::text AS period_from, period_to::text AS period_to, opening::text AS opening, closing::text AS closing, content_hash, parser, rows, accepted, duplicates, skipped, signal_id, original, problems, uploaded_by, created_at FROM bank.statements WHERE tenant_id = ${tenant} AND statement_id = ${statementId}`;
      if (!s) return null;
      const rows = await tx<{ row_no: number; txn_id: string | null; txn_date: string | null; amount: string; disposition: string; reason: string | null }[]>`
        SELECT row_no, txn_id, txn_date::text AS txn_date, amount::text AS amount, disposition, reason FROM bank.statement_rows
        WHERE tenant_id = ${tenant} AND statement_id = ${statementId} ORDER BY row_no`;
      return { s, rows };
    });
    if (!r) return null;
    const content = r.s.original ? keys.openText(r.s.original, statementOriginalCtx(statementId))
      : r.s.signal_id ? (await this.d.channels.original(tenant, r.s.signal_id))?.content ?? null : null;
    return { ...(await this.statementResult(tenant, statementId))!, bookId: r.s.book_id, uploadedBy: r.s.uploaded_by,
      original: content === null ? null : { content, verified: sha256(content) === r.s.content_hash },
      lineage: r.rows.map((x) => ({ row: x.row_no, txnId: x.txn_id, txnDate: x.txn_date, amount: x.amount, disposition: x.disposition, reason: x.reason })) };
  }

  /** Statements of an account with their rows, for coverage and balances. */
  async statementInfo(tenant: string, bankAccountId: string, tx?: TransactionSql): Promise<StatementInfo[]> {
    const q = async (t: TransactionSql) => {
      const ss = await t<StatementRow[]>`SELECT statement_id, book_id, bank_account_id, status, provenance, identity, period_from::text AS period_from, period_to::text AS period_to, opening::text AS opening, closing::text AS closing, content_hash, parser, rows, accepted, duplicates, skipped, signal_id, original, problems, uploaded_by, created_at FROM bank.statements WHERE tenant_id = ${tenant} AND bank_account_id = ${bankAccountId} ORDER BY period_from, created_at`;
      const rows = ss.length ? await t<{ statement_id: string; row_no: number; txn_id: string | null; txn_date: string | null; amount: string }[]>`
        SELECT statement_id, row_no, txn_id, txn_date::text AS txn_date, amount::text AS amount FROM bank.statement_rows
        WHERE tenant_id = ${tenant} AND statement_id IN ${t(ss.map((s) => s.statement_id))} ORDER BY statement_id, row_no` : [];
      return ss.map((s): StatementInfo => ({ statementId: s.statement_id, status: s.status, provenance: s.provenance, identity: s.identity,
        periodFrom: s.period_from, periodTo: s.period_to, opening: s.opening === null ? null : BigInt(s.opening), closing: s.closing === null ? null : BigInt(s.closing),
        contentHash: s.content_hash, createdAt: s.created_at.toISOString(),
        rows: rows.filter((r) => r.statement_id === s.statement_id).map((r) => ({ rowNo: r.row_no, txnId: r.txn_id, txnDate: r.txn_date, amount: BigInt(r.amount) })) }));
    };
    return tx ? q(tx) : this.d.store.tenantTx(tenant, q);
  }

  /** Coverage of an account: its statement periods, gaps and overlaps from the opening date (or `from`) to `to` (default: the last statement). */
  async coverage(tenant: string, book: string, bankAccountId: string, range: { from?: string; to?: string } = {}) {
    const acct = await this.requireAccount(tenant, book, bankAccountId);
    const infos = await this.statementInfo(tenant, bankAccountId);
    const to = range.to ?? infos.filter((s) => s.status === "verified").map((s) => s.periodTo).sort().at(-1) ?? acct.openingDate;
    const from = range.from ?? acct.openingDate;
    for (const [k, v] of [["from", from], ["to", to]] as const) if (!isIsoDate(v)) throw new BankError("bad_request", `${k} ${v} is not a real calendar date`, 400);
    return { bankAccountId, masked: acct.masked, openingDate: acct.openingDate, ...coverage(infos, from, to),
      periods: infos.map((s) => ({ statementId: s.statementId, status: s.status, provenance: s.provenance, periodFrom: s.periodFrom, periodTo: s.periodTo,
        opening: s.opening?.toString() ?? null, closing: s.closing?.toString() ?? null, contentHash: s.contentHash })) };
  }

  // ------------------------------------------------------------------ FIN-CASH-03: the reconciliation statement
  /**
   * The reconciliation of one account at `periodEnd`. `periodFrom` defaults to the day after the
   * last certified period end before it, or the account's opening date.
   */
  async reconciliation(tenant: string, book: string, bankAccountId: string, periodEnd: string, periodFrom?: string): Promise<Reconciliation> {
    if (!isIsoDate(periodEnd)) throw new BankError("bad_request", `period end ${periodEnd} is not a real calendar date (YYYY-MM-DD)`, 400);
    if (periodFrom !== undefined && !isIsoDate(periodFrom)) throw new BankError("bad_request", `period start ${periodFrom} is not a real calendar date (YYYY-MM-DD)`, 400);
    const acct = await this.requireAccount(tenant, book, bankAccountId);
    const state = await this.d.gl.state(tenant, book);
    const keys = await this.d.store.keys(tenant);
    const { explicit, statements, narrations, lastEnd } = await this.d.store.tenantTx(tenant, async (tx) => {
      const statements = await this.statementInfo(tenant, bankAccountId, tx);
      const explicit = await this.links(tx, tenant, book, acct.glAccountId);
      const lines = await tx<{ txn_id: string; detail: string }[]>`SELECT txn_id, detail FROM bank.lines WHERE tenant_id = ${tenant} AND book_id = ${book} AND gl_account_id = ${acct.glAccountId}`;
      const narrations = new Map(lines.map((l) => [l.txn_id, keys.openJson<{ narration: string }>(l.detail, lineDetailCtx(l.txn_id)).narration]));
      const [last] = await tx<{ period_end: string }[]>`SELECT max(period_end)::text AS period_end FROM bank.reconciliations
        WHERE tenant_id = ${tenant} AND bank_account_id = ${bankAccountId} AND status = 'certified' AND period_end < ${periodEnd}`;
      return { explicit, statements, narrations, lastEnd: last?.period_end ?? null };
    });
    const from = periodFrom ?? (lastEnd && dayAfter(lastEnd) > acct.openingDate ? dayAfter(lastEnd) : acct.openingDate);
    if (from > periodEnd) throw new BankError("bad_request", `period ${from}..${periodEnd} ends before it starts`, 400);
    return reconcile({ bookId: book, account: { bankAccountId, glAccountId: acct.glAccountId, masked: acct.masked, openingDate: acct.openingDate, staleDays: acct.staleDays },
      periodFrom: from, periodEnd, journals: bankJournals(state, acct.glAccountId), statements, explicit, origin: origin(tenant), narrations,
      ledger: { seq: state.seq, hash: state.seq ? state.lastHash : null } });
  }

  private async links(tx: TransactionSql, tenant: string, book: string, gl: string): Promise<Link[]> {
    return (await tx<{ txn_id: string; journal_id: string; amount: string }[]>`
      SELECT txn_id, journal_id, amount::text AS amount FROM bank.clearings WHERE tenant_id = ${tenant} AND book_id = ${book} AND gl_account_id = ${gl}
      ORDER BY txn_id, journal_id`).map((r) => ({ txnId: r.txn_id, journalId: r.journal_id, amount: BigInt(r.amount) }));
  }

  /**
   * The `bank` ext action of certify_bank_reconciliation, in the ops commit's transaction under the
   * book lock (nothing can post meanwhile). The certifier is the recorded approver or the committer:
   * a superuser, controller or treasurer who is not the preparer. The reconciliation is computed
   * again and must be exactly the one prepared (same hash: same statements, links and ledger
   * position) and certifiable. Stores the certified snapshot and raises exceptions for stale items.
   */
  async certify(tx: TransactionSql, ctx: { tenant: string; book: string; principal: string; approvedBy: string | null; planId: string },
                p: { bankAccountId: string; periodFrom: string; periodEnd: string; hash: string; preparedBy: string }): Promise<string> {
    const certifier = ctx.approvedBy ?? ctx.principal;
    if (!CERTIFIERS.has(principalRole(certifier))) throw new BankError("forbidden", `${certifier} may not certify a bank reconciliation: a superuser, controller or treasurer certifies`, 403);
    if (await this.d.samePerson(ctx.tenant, p.preparedBy, certifier))
      throw new BankError("not_independent", `${certifier} prepared this reconciliation and may not certify it: an independent reviewer certifies (no self-certification)`, 403);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenant}/bank-rec/${p.bankAccountId}/${p.periodEnd}`}, 0))`;
    const [cur] = await tx<{ reconciliation_id: string }[]>`SELECT reconciliation_id FROM bank.reconciliations
      WHERE tenant_id = ${ctx.tenant} AND bank_account_id = ${p.bankAccountId} AND period_end = ${p.periodEnd} AND status = 'certified' FOR UPDATE`;
    if (cur) throw new BankError("already_certified", `${p.bankAccountId} is already certified to ${p.periodEnd} (${cur.reconciliation_id}); nothing was applied`);
    const rec = await this.reconciliation(ctx.tenant, ctx.book, p.bankAccountId, p.periodEnd, p.periodFrom);
    if (rec.hash !== p.hash) throw new BankError("changed", "the reconciliation changed since it was prepared (statements, matches or ledger): prepare it again");
    if (!rec.certifiable) throw new BankError("not_certifiable", `cannot certify: ${rec.problems.join("; ")}`, 422);
    const [v] = await tx<{ n: number }[]>`SELECT COALESCE(max(version), 0)::int AS n FROM bank.reconciliations
      WHERE tenant_id = ${ctx.tenant} AND bank_account_id = ${p.bankAccountId} AND period_end = ${p.periodEnd}`;
    const version = v!.n + 1;
    const reconciliationId = stableId("bank-rec", `${ctx.tenant}/${p.bankAccountId}/${p.periodEnd}/${version}`);
    const statementHashes = rec.statements.filter((s) => s.status === "verified").map((s) => s.contentHash);
    const money = (label: string, amount: string | null, section: string) => ({ label, amount: amount ?? "0", section });
    const snap = await this.d.reporting.storeSnapshot(tx, { tenantId: ctx.tenant, bookId: ctx.book, kind: "bank-reconciliation",
      params: { asOf: p.periodEnd, from: p.periodFrom, bankAccountId: p.bankAccountId, reconciliationHash: rec.hash, statementHashes,
        preparedBy: p.preparedBy, certifiedBy: certifier, coverage: rec.coverage, reconciliation: rec },
      seq: rec.ledger.seq, ledgerHash: rec.ledger.hash, takenBy: certifier,
      statement: { title: `Bank reconciliation ${p.bankAccountId} (${rec.masked}) ${p.periodFrom}..${p.periodEnd}`,
        rows: [money("Balance per bank statement", rec.bankBalance, "bank"),
          ...rec.outstandingPayments.map((x) => money(`Outstanding payment ${x.txnDate} ${x.journalId} (${x.ageDays} days)`, x.amount, "timing")),
          ...rec.depositsInTransit.map((x) => money(`Deposit in transit ${x.txnDate} ${x.journalId} (${x.ageDays} days)`, x.amount, "timing")),
          money("Adjusted bank balance", rec.adjustedBank, "bank"), money("Balance per books", rec.bookBalance, "book"), money("Adjusted book balance", rec.adjustedBook, "book")],
        totals: { difference: rec.difference ?? "0", outstandingItems: String(rec.outstandingCount) } } });
    await tx`INSERT INTO bank.reconciliations (tenant_id, reconciliation_id, book_id, bank_account_id, period_from, period_end, version, status, snapshot_id,
               content_hash, rec_hash, statement_hashes, ledger_seq, ledger_hash, prepared_by, certified_by, plan_id)
             VALUES (${ctx.tenant}, ${reconciliationId}, ${ctx.book}, ${p.bankAccountId}, ${p.periodFrom}, ${p.periodEnd}, ${version}, 'certified', ${snap.snapshotId},
               ${snap.contentHash}, ${rec.hash}, ${tx.json(statementHashes as never)}, ${rec.ledger.seq}, ${rec.ledger.hash}, ${p.preparedBy}, ${certifier}, ${ctx.planId})`;
    await this.d.store.append("bank", ctx.tenant, { streamId: accountStream(ctx.tenant, ctx.book, p.bankAccountId), expected: "any", events: [{ type: "BankReconciliationCertified",
      data: { reconciliationId, bookId: ctx.book, bankAccountId: p.bankAccountId, periodFrom: p.periodFrom, periodEnd: p.periodEnd, version, snapshotId: snap.snapshotId,
        contentHash: snap.contentHash, statementHashes, ledgerSeq: rec.ledger.seq, ledgerHash: rec.ledger.hash, preparedBy: p.preparedBy, certifiedBy: certifier, planId: ctx.planId } }] },
      { principal: ctx.principal, commandId: ctx.planId }, tx);
    await this.raiseStale(tx, ctx.tenant, rec, ctx.principal);
    return `certified ${p.bankAccountId} to ${p.periodEnd} (v${version}, snapshot ${snap.snapshotId})`;
  }

  /** Certified (and withdrawn) reconciliations, newest first. */
  async reconciliations(tenant: string, book: string, bankAccountId?: string) {
    return this.d.store.tenantTx(tenant, async (tx) => (await tx<RecRow[]>`
      SELECT reconciliation_id, bank_account_id, period_from::text AS period_from, period_end::text AS period_end, version, status, snapshot_id, content_hash, rec_hash,
             statement_hashes, ledger_seq, ledger_hash, prepared_by, certified_by, plan_id, certified_at, withdrawn_at, withdrawn_reason
      FROM bank.reconciliations WHERE tenant_id = ${tenant} AND book_id = ${book} ${bankAccountId ? tx`AND bank_account_id = ${bankAccountId}` : tx``}
      ORDER BY period_end DESC, version DESC`).map((r) => ({
        reconciliationId: r.reconciliation_id, bankAccountId: r.bank_account_id, periodFrom: r.period_from, periodEnd: r.period_end, version: r.version, status: r.status,
        snapshotId: r.snapshot_id, contentHash: r.content_hash, reconciliationHash: r.rec_hash, statementHashes: r.statement_hashes, ledgerSeq: r.ledger_seq, ledgerHash: r.ledger_hash,
        preparedBy: r.prepared_by, certifiedBy: r.certified_by, planId: r.plan_id, certifiedAt: r.certified_at.toISOString(),
        withdrawnAt: r.withdrawn_at?.toISOString() ?? null, withdrawnReason: r.withdrawn_reason })));
  }

  /**
   * Is a certification still what it certified? The snapshot verifies (sealed body, content hash)
   * and the reconciliation recomputed at its period today has the certified figures.
   */
  async verifyCertification(tenant: string, book: string, reconciliationId: string) {
    const [r] = (await this.reconciliations(tenant, book)).filter((x) => x.reconciliationId === reconciliationId);
    if (!r) throw new BankError("not_found", `no reconciliation ${reconciliationId}`, 404);
    const snap = await this.d.reporting.getSnapshot(tenant, r.snapshotId);
    const now = await this.reconciliation(tenant, book, r.bankAccountId, r.periodEnd, r.periodFrom);
    const certified = (snap?.params as { reconciliation?: Reconciliation } | undefined)?.reconciliation;
    const same = !!certified && certified.bankBalance === now.bankBalance && certified.bookBalance === now.bookBalance && certified.difference === now.difference
      && canonical(certified.outstandingPayments.map((x) => [x.journalId, x.amount])) === canonical(now.outstandingPayments.map((x) => [x.journalId, x.amount]))
      && canonical(certified.depositsInTransit.map((x) => [x.journalId, x.amount])) === canonical(now.depositsInTransit.map((x) => [x.journalId, x.amount]));
    return { reconciliationId, status: r.status, snapshotVerified: !!snap?.verified, figuresUnchanged: same, now };
  }

  private async withdrawFrom(tx: TransactionSql, tenant: string, book: string, bankAccountId: string, fromDate: string, seq: number, reason: string,
                             cause: { journalId?: string; statementId?: string }, principal = SYSTEM) {
    const recs = await tx<{ reconciliation_id: string; period_end: string }[]>`
      UPDATE bank.reconciliations SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = ${reason}
      WHERE tenant_id = ${tenant} AND bank_account_id = ${bankAccountId} AND status = 'certified' AND period_end >= ${fromDate} AND ledger_seq < ${seq}
      RETURNING reconciliation_id, period_end::text AS period_end`;
    for (const r of recs) {
      await this.d.store.append("bank", tenant, { streamId: accountStream(tenant, book, bankAccountId), expected: "any", events: [{ type: "BankReconciliationWithdrawn",
        data: { reconciliationId: r.reconciliation_id, bookId: book, bankAccountId, periodEnd: r.period_end, reason, ...cause } }] }, { principal }, tx);
      await this.raise(tx, tenant, { bookId: book, bankAccountId, requirement: "FIN-CASH-03", sourceId: r.reconciliation_id,
        cause: `certification withdrawn: ${reason}`, amount: null, period: `..${r.period_end}`, hold: "certification", key: `withdrawn/${r.reconciliation_id}` }, principal);
    }
    return recs.length;
  }

  /** Bus consumer "bank": a posting on a registered account dated inside a certified period withdraws that certification, visibly. */
  handler = async (env: Envelope): Promise<void> => {
    if (env.type !== "JournalPosted") return;
    await once(this.d.store, "bank", env, async (tx) => {
      const d = env.data as EventData<"JournalPosted">, t = env.meta.tenantId;
      const accts = await tx<{ bank_account_id: string; gl_account_id: string }[]>`
        SELECT bank_account_id, gl_account_id FROM bank.accounts WHERE tenant_id = ${t} AND book_id = ${d.bookId} AND status = 'active'`;
      for (const a of accts) {
        if (!d.lines.some((l) => l.accountId === a.gl_account_id)) continue;
        await this.withdrawFrom(tx, t, d.bookId, a.bank_account_id, d.txnDate, d.seq,
          `journal ${d.journalId} dated ${d.txnDate} was posted to ${a.gl_account_id} after certification`, { journalId: d.journalId });
      }
    });
  };

  // ------------------------------------------------------------------ exceptions (CFO §2 common exception record)
  private async raise(tx: TransactionSql, tenant: string, e: { bookId: string; bankAccountId: string | null; requirement: string; sourceId: string; cause: string;
    amount: string | null; period: string | null; hold: "import" | "certification" | "none"; key: string }, principal: string): Promise<string> {
    const caseId = stableId("bank-exception", `${tenant}/${e.key}`);
    const dueBy = addDays(this.d.clock(), 2);                                   // POL-503: within 2 business days of the statement
    const ins = await tx`INSERT INTO bank.exceptions (tenant_id, case_id, book_id, bank_account_id, requirement, source_id, cause, amount, period, owner, hold, due_by)
      VALUES (${tenant}, ${caseId}, ${e.bookId}, ${e.bankAccountId}, ${e.requirement}, ${e.sourceId}, ${e.cause}, ${e.amount}, ${e.period}, ${OWNER}, ${e.hold}, ${dueBy})
      ON CONFLICT DO NOTHING RETURNING 1`;
    if (ins.length) {
      await this.d.store.append("bank", tenant, { streamId: exceptionStream(tenant, e.bookId), expected: "any", events: [{ type: "BankExceptionRaised",
        data: { caseId, bookId: e.bookId, bankAccountId: e.bankAccountId, requirement: e.requirement, sourceId: e.sourceId, cause: e.cause, amount: e.amount,
          period: e.period, owner: OWNER, dueBy, hold: e.hold } }] }, { principal }, tx);
    }
    return caseId;
  }

  /** Stale timing items of a reconciliation become exceptions (once per item): an aged item never disappears silently. */
  private async raiseStale(tx: TransactionSql, tenant: string, rec: Reconciliation, principal: string): Promise<string[]> {
    const out: string[] = [];
    for (const x of [...rec.outstandingPayments, ...rec.depositsInTransit].filter((y) => y.stale)) {
      out.push(await this.raise(tx, tenant, { bookId: rec.bookId, bankAccountId: rec.bankAccountId, requirement: "FIN-CASH-03", sourceId: x.journalId,
        cause: `timing item ${x.journalId} of ${x.txnDate} is ${x.ageDays} days old (over ${rec.staleDays}): investigate, clear or reverse it`,
        amount: x.amount, period: `..${rec.periodEnd}`, hold: "none", key: `stale/${rec.bankAccountId}/${x.journalId}` }, principal));
    }
    return out;
  }

  /** Check an account's timing items at `asOf` and raise an exception for each stale one. Needs bank.manage. */
  async scanStale(tenant: string, book: string, bankAccountId: string, asOf: string, principal: string) {
    const rec = await this.reconciliation(tenant, book, bankAccountId, asOf);
    return this.d.store.tenantTx(tenant, async (tx) => {
      await this.guard.permit(tenant, principal, "bank.manage", { book }, tx);
      return { asOf, stale: rec.staleItems, exceptions: await this.raiseStale(tx, tenant, rec, principal) };
    });
  }

  async exceptions(tenant: string, book: string, opts: { status?: "open" | "resolved" } = {}): Promise<BankException[]> {
    const keys = await this.d.store.keys(tenant);
    return this.d.store.tenantTx(tenant, async (tx) => (await tx<ExceptionRow[]>`
      SELECT case_id, book_id, bank_account_id, requirement, source_id, cause, amount::text AS amount, period, owner, hold, due_by::text AS due, status, resolution, resolved_by, detected_at FROM bank.exceptions WHERE tenant_id = ${tenant} AND book_id = ${book} ${opts.status ? tx`AND status = ${opts.status}` : tx``}
      ORDER BY detected_at, case_id`).map((r) => ({ caseId: r.case_id, bookId: r.book_id, bankAccountId: r.bank_account_id, requirement: r.requirement, sourceId: r.source_id,
        cause: r.cause, amount: r.amount, period: r.period, owner: r.owner, hold: r.hold, dueBy: r.due, status: r.status,
        resolution: r.resolution ? keys.openText(r.resolution, exceptionResolutionCtx(r.case_id)) : null, resolvedBy: r.resolved_by, detectedAt: r.detected_at.toISOString() })));
  }

  /** Close an exception with its resolution evidence. Needs bank.manage. */
  async resolveException(tenant: string, book: string, caseId: string, principal: string, resolution: string) {
    if (resolution.trim().length < 3) throw new BankError("bad_request", "give the resolution evidence (at least 3 characters)", 400);
    const keys = await this.d.store.keys(tenant);
    return this.d.store.tenantTx(tenant, async (tx) => {
      await this.guard.permit(tenant, principal, "bank.manage", { book }, tx);
      const r = await tx`UPDATE bank.exceptions SET status = 'resolved', resolution = ${keys.seal(resolution, exceptionResolutionCtx(caseId))}, resolved_by = ${principal}, resolved_at = now()
        WHERE tenant_id = ${tenant} AND case_id = ${caseId} AND book_id = ${book} AND status = 'open' RETURNING 1`;
      if (!r.length) throw new BankError("not_open", `no open exception ${caseId} in book ${book}`);
      await this.d.store.append("bank", tenant, { streamId: exceptionStream(tenant, book), expected: "any", events: [{ type: "BankExceptionResolved",
        data: { caseId, bookId: book, resolution } }] }, { principal }, tx);
      return { caseId, status: "resolved" as const };
    });
  }

  // ------------------------------------------------------------------ FIN-CASH-02: the agent's clearing hook
  async context(tx: TransactionSql, tenant: string, book: string, instrument: string, txnId: string): Promise<(SettlementContext & { bankAccountId: string }) | null> {
    const [a] = await tx<AccountRow[]>`SELECT bank_account_id, book_id, gl_account_id, bank_name, masked, last4, currency, opening_date::text AS opening_date, stale_days, fee_tolerance::text AS fee_tolerance, status, registered_by FROM bank.accounts WHERE tenant_id = ${tenant} AND book_id = ${book} AND gl_account_id = ${instrument} AND status = 'active'`;
    if (!a) return null;
    const keys = await this.d.store.keys(tenant);
    const state = await this.d.gl.state(tenant, book);
    const journals = bankJournals(state, instrument);
    const noted = await tx<{ txn_id: string; txn_date: string; amount: string; detail: string }[]>`
      SELECT txn_id, txn_date::text AS txn_date, amount::text AS amount, detail FROM bank.lines
      WHERE tenant_id = ${tenant} AND book_id = ${book} AND gl_account_id = ${instrument} AND txn_id <> ${txnId}`;
    const explicit = await this.links(tx, tenant, book, instrument);
    const st = settle(journals, noted.map((n) => ({ txnId: n.txn_id, txnDate: n.txn_date, signed: BigInt(n.amount) })), explicit,
      { asOf: null, baseline: isoOf(a.opening_date), origin: origin(tenant) });
    const names = new Map<string, string | null>();
    const nameOf = async (p: string) => { if (!names.has(p)) names.set(p, this.d.partyName ? await this.d.partyName(tenant, p).catch(() => null) : null); return names.get(p) ?? null; };
    const legs: SettlementLeg[] = [];
    for (const l of st.legs.filter((x) => x.remaining !== 0n)) {
      const partyNames = (await Promise.all(l.j.partyIds.map(nameOf))).filter((n): n is string => !!n);
      legs.push({ journalId: l.j.journalId, txnDate: l.j.txnDate, remaining: l.remaining, narration: l.j.narration, partyName: partyNames.join(" ") || null,
        provisional: l.j.provisional, otherAccounts: l.j.otherAccounts });
    }
    const exist = new Set(journals.map((j) => j.journalId));
    const prior: PriorLine[] = noted.map((n) => {
      const det = keys.openJson<{ narration: string; reference: string | null }>(n.detail, lineDetailCtx(n.txn_id));
      const ex = explicit.filter((l) => l.txnId === n.txn_id).map((l) => l.journalId);
      const j0 = origin(tenant)(n.txn_id);
      return { txnId: n.txn_id, txnDate: n.txn_date, signed: BigInt(n.amount), narration: det.narration, reference: det.reference,
        journalIds: ex.length ? ex : exist.has(j0) ? [j0] : [] };
    });
    const own = (await tx<{ gl_account_id: string; last4: string }[]>`SELECT gl_account_id, last4 FROM bank.accounts
      WHERE tenant_id = ${tenant} AND book_id = ${book} AND status = 'active' AND gl_account_id <> ${instrument}`).map((o) => ({ glAccountId: o.gl_account_id, last4: o.last4 }));
    return { bankAccountId: a.bank_account_id, legs, prior, own, feeTolerance: BigInt(a.fee_tolerance), windowDays: WINDOW_DAYS };
  }

  async noteLine(tx: TransactionSql, tenant: string, book: string, instrument: string, txnId: string, txn: RawTxn): Promise<void> {
    const keys = await this.d.store.keys(tenant);
    const signed = BigInt(txn.amount) * (txn.direction === "in" ? 1n : -1n);
    await tx`INSERT INTO bank.lines (tenant_id, txn_id, book_id, gl_account_id, txn_date, amount, origin_journal, detail)
             VALUES (${tenant}, ${txnId}, ${book}, ${instrument}, ${txn.txnDate}, ${signed.toString()}, ${origin(tenant)(txnId)},
                     ${keys.sealJson({ narration: txn.narration, reference: txn.reference ?? null, hint: txn.counterpartyHint ?? null }, lineDetailCtx(txnId))})
             ON CONFLICT DO NOTHING`;
  }

  async record(tx: TransactionSql, tenant: string, c: Clearing): Promise<void> {
    const total = c.legs.reduce((a, l) => a + l.amount, 0n);
    const [line] = await tx<{ amount: string }[]>`SELECT amount::text AS amount FROM bank.lines WHERE tenant_id = ${tenant} AND txn_id = ${c.txnId}`;
    if (line && BigInt(line.amount) !== total) throw new BankError("not_equal", `settlement legs come to ${total}, the line is ${line.amount}`);
    for (const l of c.legs) {
      await tx`INSERT INTO bank.clearings (tenant_id, txn_id, journal_id, book_id, gl_account_id, txn_date, amount, kind, basis, cleared_by)
               VALUES (${tenant}, ${c.txnId}, ${l.journalId}, ${c.bookId}, ${c.instrument}, ${c.txnDate}, ${l.amount.toString()}, ${c.kind}, ${c.basis}, ${c.by})`;
    }
  }

  async journal(tenant: string, book: string, journalId: string) {
    const j = (await this.d.gl.state(tenant, book)).journals.get(journalId);
    return j ? { txnDate: j.txnDate, narration: j.narration, lines: j.lines } : null;
  }
}

/** Balance at the end of day `d` by one statement (null when `d` is outside it). */
function balanceOf(s: StatementInfo, d: string): bigint | null {
  if (s.opening === null || d < dayBefore(s.periodFrom) || d > s.periodTo) return null;
  return s.opening + s.rows.filter((r) => r.txnDate !== null && r.txnDate <= d).reduce((a, r) => a + r.amount, 0n);
}

interface AccountRow {
  bank_account_id: string; book_id: string; gl_account_id: string; bank_name: string; masked: string; last4: string; currency: string;
  opening_date: string | Date; stale_days: number; fee_tolerance: string; status: string; registered_by: string;
}
const isoOf = (v: string | Date) => (typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10));
const toAccount = (r: AccountRow): BankAccount => ({ bankAccountId: r.bank_account_id, bookId: r.book_id, glAccountId: r.gl_account_id, bankName: r.bank_name,
  masked: r.masked, last4: r.last4, currency: "INR", openingDate: isoOf(r.opening_date), staleDays: r.stale_days, feeTolerancePaise: String(r.fee_tolerance),
  status: r.status, registeredBy: r.registered_by });
interface StatementRow {
  statement_id: string; book_id: string; bank_account_id: string; status: "verified" | "held"; provenance: "uploaded" | "authenticated"; identity: "proven" | "mismatch" | "missing";
  period_from: string; period_to: string; opening: string | null; closing: string | null; content_hash: string; parser: string;
  rows: number; accepted: number; duplicates: number; skipped: number; signal_id: string | null; original: string; problems: string[]; uploaded_by: string; created_at: Date;
}
interface RecRow {
  reconciliation_id: string; bank_account_id: string; period_from: string; period_end: string; version: number; status: string; snapshot_id: string; content_hash: string;
  rec_hash: string; statement_hashes: string[]; ledger_seq: number; ledger_hash: string | null; prepared_by: string; certified_by: string; plan_id: string;
  certified_at: Date; withdrawn_at: Date | null; withdrawn_reason: string | null;
}
interface ExceptionRow {
  case_id: string; book_id: string; bank_account_id: string | null; requirement: string; source_id: string; cause: string; amount: string | null; period: string | null;
  owner: string; hold: string; due: string; status: string; resolution: string; resolved_by: string | null; detected_at: Date;
}
