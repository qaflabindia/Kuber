import { tenantRlsFor, type Migration } from "@kuber/eventstore";

/**
 * Query side of the close module (FIN-CLS-01..04). The facts are the sealed events of stream
 * `<tenant>/close/<book>/<periodEnd>`; these tables are what the module reads, written in the same
 * transaction as those events. Every table is tenant-scoped with row-level security. Bodies with
 * figures and free text are sealed with the tenant's key (`body`, `name`). Dates are ISO text
 * (YYYY-MM-DD, validated before they arrive), so the ledger and the database never disagree on a period.
 */
export const CLOSE_MIGRATIONS: Migration[] = [{
  id: "close-001",
  sql: `
CREATE SCHEMA IF NOT EXISTS close;
-- FIN-CLS-01: one checklist per book and period.
CREATE TABLE close.checklists (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, period_end TEXT NOT NULL, period_start TEXT NOT NULL,
  template_version TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, book_id, period_end));
CREATE TABLE close.tasks (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, period_end TEXT NOT NULL, task_id TEXT NOT NULL,
  area TEXT NOT NULL, title TEXT NOT NULL, owner TEXT, deadline TEXT NOT NULL, depends_on JSONB NOT NULL,
  evidence_kinds JSONB NOT NULL, applicable BOOLEAN NOT NULL, na_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','done','not_applicable')),
  evidence JSONB NOT NULL DEFAULT '[]', completed_by TEXT, reviewed_by TEXT, completed_at TIMESTAMPTZ, plan_id TEXT,
  withdrawn_reason TEXT,
  PRIMARY KEY (tenant_id, book_id, period_end, task_id));
CREATE INDEX tasks_open ON close.tasks (tenant_id, book_id, deadline) WHERE status = 'open';
-- FIN-CLS-02: one current substantiation per account and period; a withdrawn one stays (history).
CREATE TABLE close.substantiations (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, period_end TEXT NOT NULL, account_id TEXT NOT NULL, version INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved','withdrawn')), gl_balance NUMERIC(22,0) NOT NULL, hash TEXT NOT NULL,
  body TEXT NOT NULL, prepared_by TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  plan_id TEXT NOT NULL, withdrawn_reason TEXT, withdrawn_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, book_id, period_end, account_id, version));
CREATE UNIQUE INDEX substantiations_current ON close.substantiations (tenant_id, book_id, period_end, account_id) WHERE status = 'approved';
-- FIN-CLS-03: certified closes, versioned per period; a withdrawn close stays retrievable.
CREATE TABLE close.closes (
  tenant_id TEXT NOT NULL, close_id TEXT NOT NULL, book_id TEXT NOT NULL, period_end TEXT NOT NULL, version INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('certified','withdrawn')), basis_seq INT NOT NULL, close_seq INT NOT NULL,
  content_hash TEXT NOT NULL, population_hash TEXT NOT NULL, body TEXT NOT NULL,
  certified_by TEXT NOT NULL, certified_at TIMESTAMPTZ NOT NULL DEFAULT now(), plan_id TEXT NOT NULL,
  withdrawn_by TEXT, withdrawn_at TIMESTAMPTZ, withdrawn_reason TEXT,
  PRIMARY KEY (tenant_id, close_id));
CREATE UNIQUE INDEX closes_version ON close.closes (tenant_id, book_id, period_end, version);
CREATE UNIQUE INDEX closes_current ON close.closes (tenant_id, book_id, period_end) WHERE status = 'certified';
-- Evidence documents: the content hash only (the document stays wherever it is kept).
CREATE TABLE close.documents (
  tenant_id TEXT NOT NULL, document_id TEXT NOT NULL, book_id TEXT NOT NULL, sha256 TEXT NOT NULL, name TEXT NOT NULL,
  period_end TEXT, registered_by TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id));
-- FIN-CLS-04: restated comparative versions; the original certified close is never changed.
CREATE TABLE close.restatements (
  tenant_id TEXT NOT NULL, restatement_id TEXT NOT NULL, book_id TEXT NOT NULL, comparative_period_end TEXT NOT NULL,
  version INT NOT NULL, supersedes_close_id TEXT NOT NULL, journal_id TEXT NOT NULL, bridge_hash TEXT NOT NULL, body TEXT NOT NULL,
  approved_by TEXT NOT NULL, plan_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, restatement_id));
CREATE UNIQUE INDEX restatements_version ON close.restatements (tenant_id, book_id, comparative_period_end, version);
` + tenantRlsFor("close"),
}];

export const substantiationCtx = (book: string, period: string, account: string, version: number) => `close.substantiations.body|${book}|${period}|${account}|${version}`;
export const closeBodyCtx = (closeId: string) => `close.closes.body|${closeId}`;
export const documentNameCtx = (documentId: string) => `close.documents.name|${documentId}`;
export const restatementCtx = (id: string) => `close.restatements.body|${id}`;
export const closeStream = (tenant: string, book: string, periodEnd: string) => `${tenant}/close/${book}/${periodEnd}`;
