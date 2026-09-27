import { tenantRlsFor, type Migration } from "@kuber/eventstore";

/**
 * Query side of the bank module (FIN-CASH-01..03). The facts are sealed events in
 * `<tenant>/bank/<book>/<bankAccountId>` and the agent's transaction streams; these tables are what
 * the module reads, written in the same transaction as those events. Tenant row-level security on
 * every table. Sealed with the tenant key: account numbers and IFSC (`bank`), statement originals of
 * held files, narrations (`detail`), exception resolutions. Blind indexes find an account from a
 * statement's number without plaintext.
 */
export const BANK_MIGRATIONS: Migration[] = [{
  id: "bank-001",
  sql: `
CREATE SCHEMA IF NOT EXISTS bank;
-- FIN-CASH-01: the book's own bank accounts. bank: sealed {accountNumber, ifsc}; masked: display only.
CREATE TABLE bank.accounts (
  tenant_id TEXT NOT NULL, bank_account_id TEXT NOT NULL, book_id TEXT NOT NULL, gl_account_id TEXT NOT NULL,
  bank_name TEXT NOT NULL, bank TEXT NOT NULL, account_idx TEXT NOT NULL, ifsc_idx TEXT NOT NULL, masked TEXT NOT NULL, last4 TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'INR'), opening_date DATE NOT NULL, stale_days INT NOT NULL, fee_tolerance NUMERIC(22,0) NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  registered_by TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, bank_account_id));
CREATE UNIQUE INDEX accounts_gl ON bank.accounts (tenant_id, book_id, gl_account_id) WHERE status = 'active';
CREATE UNIQUE INDEX accounts_number ON bank.accounts (tenant_id, book_id, account_idx) WHERE status = 'active';
-- FIN-CASH-01: every statement file, verified or held. original: sealed bytes of a HELD file (a
-- verified file's original is the channels signal, signal_id; '' here). problems: why it is held (no identifiers).
CREATE TABLE bank.statements (
  tenant_id TEXT NOT NULL, statement_id TEXT NOT NULL, book_id TEXT NOT NULL, bank_account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified','held')), provenance TEXT NOT NULL CHECK (provenance IN ('uploaded','authenticated')),
  identity TEXT NOT NULL CHECK (identity IN ('proven','mismatch','missing')),
  period_from DATE NOT NULL, period_to DATE NOT NULL, opening NUMERIC(22,0), closing NUMERIC(22,0),
  content_hash TEXT NOT NULL, parser TEXT NOT NULL, rows INT NOT NULL, accepted INT NOT NULL, duplicates INT NOT NULL, skipped INT NOT NULL,
  signal_id TEXT, original TEXT NOT NULL DEFAULT '', problems JSONB NOT NULL, uploaded_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, statement_id));
CREATE INDEX statements_account ON bank.statements (tenant_id, bank_account_id, period_from);
-- Row lineage: every data row of every statement, with its transaction identity (the channels
-- per-line identity, shared by overlapping files) and signed amount (+ = money in).
CREATE TABLE bank.statement_rows (
  tenant_id TEXT NOT NULL, statement_id TEXT NOT NULL, row_no INT NOT NULL, txn_id TEXT, txn_date DATE,
  amount NUMERIC(22,0) NOT NULL, disposition TEXT NOT NULL, reason TEXT,
  PRIMARY KEY (tenant_id, statement_id, row_no));
CREATE INDEX statement_rows_txn ON bank.statement_rows (tenant_id, txn_id);
-- FIN-CASH-02: statement lines of registered accounts as the agent processed them (in its
-- transaction). origin_journal: the journal the agent posts for the line when it is new.
CREATE TABLE bank.lines (
  tenant_id TEXT NOT NULL, txn_id TEXT NOT NULL, book_id TEXT NOT NULL, gl_account_id TEXT NOT NULL,
  txn_date DATE NOT NULL, amount NUMERIC(22,0) NOT NULL, origin_journal TEXT NOT NULL, detail TEXT NOT NULL,
  noted_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, txn_id));
CREATE INDEX lines_account ON bank.lines (tenant_id, book_id, gl_account_id, txn_date);
-- FIN-CASH-02: which book entries a statement line settles (explicit links; a line posted as new
-- is linked to its origin journal implicitly). amount: signed part of the entry's bank line.
CREATE TABLE bank.clearings (
  tenant_id TEXT NOT NULL, txn_id TEXT NOT NULL, journal_id TEXT NOT NULL, book_id TEXT NOT NULL, gl_account_id TEXT NOT NULL,
  txn_date DATE NOT NULL, amount NUMERIC(22,0) NOT NULL, kind TEXT NOT NULL, basis TEXT NOT NULL,
  cleared_by TEXT NOT NULL, cleared_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, txn_id, journal_id));
CREATE INDEX clearings_account ON bank.clearings (tenant_id, book_id, gl_account_id);
-- The common exception record (CFO requirements §2). resolution: sealed.
CREATE TABLE bank.exceptions (
  tenant_id TEXT NOT NULL, case_id TEXT NOT NULL, book_id TEXT NOT NULL, bank_account_id TEXT, requirement TEXT NOT NULL,
  source_id TEXT NOT NULL, cause TEXT NOT NULL, amount NUMERIC(22,0), period TEXT, owner TEXT NOT NULL,
  hold TEXT NOT NULL CHECK (hold IN ('import','certification','none')), due_by DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')), resolution TEXT NOT NULL DEFAULT '', resolved_by TEXT, resolved_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, case_id));
CREATE INDEX exceptions_open ON bank.exceptions (tenant_id, book_id, detected_at) WHERE status = 'open';
-- FIN-CASH-03: certified reconciliations. The certified body is a reporting.snapshots row (snapshot_id).
CREATE TABLE bank.reconciliations (
  tenant_id TEXT NOT NULL, reconciliation_id TEXT NOT NULL, book_id TEXT NOT NULL, bank_account_id TEXT NOT NULL,
  period_from DATE NOT NULL, period_end DATE NOT NULL, version INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('certified','withdrawn')), snapshot_id TEXT NOT NULL, content_hash TEXT NOT NULL, rec_hash TEXT NOT NULL,
  statement_hashes JSONB NOT NULL, ledger_seq INT NOT NULL, ledger_hash TEXT, prepared_by TEXT NOT NULL, certified_by TEXT NOT NULL, plan_id TEXT NOT NULL,
  certified_at TIMESTAMPTZ NOT NULL DEFAULT now(), withdrawn_at TIMESTAMPTZ, withdrawn_reason TEXT,
  PRIMARY KEY (tenant_id, reconciliation_id));
CREATE UNIQUE INDEX reconciliations_version ON bank.reconciliations (tenant_id, bank_account_id, period_end, version);
CREATE UNIQUE INDEX reconciliations_one_certified ON bank.reconciliations (tenant_id, bank_account_id, period_end) WHERE status = 'certified';
` + tenantRlsFor("bank"),
}];

/** Retention (apps/core keys-admin): every bank table is purged on crypto-shred; the facts are in sealed streams. */
export const BANK_TABLES = ["bank.accounts", "bank.statements", "bank.statement_rows", "bank.lines", "bank.clearings", "bank.exceptions", "bank.reconciliations"] as const;

export const bankDetailsCtx = (bankAccountId: string) => `bank.accounts.bank|${bankAccountId}`;
export const statementOriginalCtx = (statementId: string) => `bank.statements.original|${statementId}`;
export const lineDetailCtx = (txnId: string) => `bank.lines.detail|${txnId}`;
export const exceptionResolutionCtx = (caseId: string) => `bank.exceptions.resolution|${caseId}`;
