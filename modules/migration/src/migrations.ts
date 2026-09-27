import { tenantRlsFor, type Migration } from "@kuber/eventstore";

/**
 * Query side of the migration module (FIN-MIG-01..03). The facts are in the sealed project stream
 * `<tenant>/migration/<projectId>`; these tables are written in the same transaction as those events.
 * Every table is tenant-scoped with row-level security. Anything that can name a person or carry
 * bank details is sealed with the tenant's key: source originals and parsed extracts, source names
 * in the mapping and provenance, decisions, comparisons. Amounts, dates, account ids and document
 * numbers stay readable for reconciliation.
 */
export const MIGRATION_MIGRATIONS: Migration[] = [{
  id: "migration-001",
  sql: `
CREATE SCHEMA IF NOT EXISTS migration;
CREATE TABLE migration.projects (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, book_id TEXT NOT NULL,
  source_system TEXT NOT NULL CHECK (source_system IN ('tally','zoho','csv')), cutoff DATE NOT NULL, scope JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','live','closed')),
  -- which system is the book of record (authority switch, FIN-MIG-02): the source until the signed go-live
  book_of_record TEXT NOT NULL DEFAULT 'source' CHECK (book_of_record IN ('source','kuber')), go_live DATE,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, project_id));
CREATE UNIQUE INDEX projects_one_open ON migration.projects (tenant_id, book_id) WHERE status = 'open';
-- original: the uploaded text, sealed; extract: the parsed records (names, bank details), sealed.
CREATE TABLE migration.files (
  tenant_id TEXT NOT NULL, file_id TEXT NOT NULL, project_id TEXT NOT NULL, file_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('source','delta','comparison')), as_of DATE, byte_length INT NOT NULL,
  counts JSONB NOT NULL, problems INT NOT NULL, name TEXT NOT NULL, original TEXT NOT NULL, extract TEXT NOT NULL,
  uploaded_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, file_id));
CREATE UNIQUE INDEX files_once ON migration.files (tenant_id, project_id, file_hash, purpose);
-- source_idx: keyed index of the source ledger id; detail: sealed source name, group, nature, suggestion.
CREATE TABLE migration.mappings (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, source_idx TEXT NOT NULL, detail TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('suggested','approved')), account_id TEXT, party_id TEXT, new_account JSONB,
  suggested_account_id TEXT, score NUMERIC(4,2), approved_by TEXT, approved_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, project_id, source_idx));
CREATE TABLE migration.loads (
  tenant_id TEXT NOT NULL, load_id TEXT NOT NULL, project_id TEXT NOT NULL, book_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rehearsal','target')), seq INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','voided')), journal_ids JSONB NOT NULL, content_hash TEXT NOT NULL, reconciled BOOLEAN NOT NULL,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  void_method TEXT CHECK (void_method IN ('discard_book','reversing_entries')), voided_by TEXT, voided_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, load_id));
CREATE UNIQUE INDEX loads_one_target ON migration.loads (tenant_id, book_id) WHERE status = 'active' AND kind = 'target';
CREATE UNIQUE INDEX loads_seq ON migration.loads (tenant_id, project_id, seq);
-- Rehearsal books: load-only (FIN-MIG-03): no operation with an effect outside Kuber runs in them.
CREATE TABLE migration.rehearsal_books (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, project_id TEXT NOT NULL, load_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','discarded')), PRIMARY KEY (tenant_id, book_id));
-- Provenance of every loaded record: source system, file hash, source id (sealed; source_idx keyed), row.
CREATE TABLE migration.records (
  tenant_id TEXT NOT NULL, record_id TEXT NOT NULL, project_id TEXT NOT NULL, load_id TEXT NOT NULL, book_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('account','party','opening_line','open_item','voucher','schedule')),
  target_id TEXT NOT NULL, source_system TEXT NOT NULL, file_hash TEXT NOT NULL, source_row INT NOT NULL,
  source_idx TEXT NOT NULL, source TEXT NOT NULL, content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','voided')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, record_id));
CREATE UNIQUE INDEX records_once ON migration.records (tenant_id, load_id, kind, source_idx, target_id);
CREATE INDEX records_load ON migration.records (tenant_id, load_id, kind);
-- The migrated subledger: open receivables and payables at the cut-off. Never posted to the GL.
CREATE TABLE migration.open_items (
  tenant_id TEXT NOT NULL, item_id TEXT NOT NULL, project_id TEXT NOT NULL, load_id TEXT NOT NULL, book_id TEXT NOT NULL,
  party_id TEXT NOT NULL, account_id TEXT NOT NULL, doc_no TEXT NOT NULL, doc_date DATE NOT NULL, due_date DATE,
  amount_paise NUMERIC(22,0) NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('receivable','payable')), on_account BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','voided')), PRIMARY KEY (tenant_id, item_id));
CREATE INDEX open_items_load ON migration.open_items (tenant_id, load_id, status);
-- Documents and payments the source system already issued outside (FIN-MIG-03): Kuber records them
-- and never issues them again.
CREATE TABLE migration.external_documents (
  tenant_id TEXT NOT NULL, source_system TEXT NOT NULL, doc_kind TEXT NOT NULL CHECK (doc_kind IN ('invoice','bill','payment','receipt')),
  doc_no TEXT NOT NULL, project_id TEXT NOT NULL, doc_date DATE NOT NULL, amount_paise NUMERIC(22,0) NOT NULL, source_idx TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, source_system, doc_kind, doc_no));
CREATE TABLE migration.decisions (
  tenant_id TEXT NOT NULL, decision_id TEXT NOT NULL, project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('authority','fallback','golive')), detail TEXT NOT NULL,
  principal TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, decision_id));
CREATE TABLE migration.comparisons (
  tenant_id TEXT NOT NULL, comparison_id TEXT NOT NULL, project_id TEXT NOT NULL, load_id TEXT NOT NULL,
  period_from DATE NOT NULL, period_to DATE NOT NULL, content_hash TEXT NOT NULL, body TEXT NOT NULL, explanations TEXT NOT NULL,
  differences INT NOT NULL, open_differences INT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, comparison_id));
` + tenantRlsFor("migration"),
}];

/** Retention (apps/core keys-admin): every migration table is purged on crypto-shred; history is in the sealed stream. */
export const MIGRATION_TABLES = ["migration.projects", "migration.files", "migration.mappings", "migration.loads", "migration.rehearsal_books", "migration.records",
  "migration.open_items", "migration.external_documents", "migration.decisions", "migration.comparisons"] as const;

export const fileOriginalCtx = (fileId: string) => `migration.files.original|${fileId}`;
export const fileExtractCtx = (fileId: string) => `migration.files.extract|${fileId}`;
export const fileNameCtx = (fileId: string) => `migration.files.name|${fileId}`;
export const mappingDetailCtx = (projectId: string, sourceIdx: string) => `migration.mappings.detail|${projectId}|${sourceIdx}`;
export const recordSourceCtx = (recordId: string) => `migration.records.source|${recordId}`;
export const decisionDetailCtx = (decisionId: string) => `migration.decisions.detail|${decisionId}`;
export const comparisonBodyCtx = (comparisonId: string) => `migration.comparisons.body|${comparisonId}`;
export const comparisonExplanationsCtx = (comparisonId: string) => `migration.comparisons.explanations|${comparisonId}`;
