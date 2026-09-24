import { tenantRlsFor, type Migration } from "@kuber/eventstore";

/** The agent module's own schema. Only the agent module reads or writes these tables. */
export const AGENT_MIGRATIONS: Migration[] = [{
  id: "agent-001",
  sql: `
CREATE SCHEMA IF NOT EXISTS agent;
CREATE TABLE agent.parties (
  tenant_id TEXT NOT NULL, party_id TEXT NOT NULL, name TEXT NOT NULL, confirmed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, party_id));
CREATE TABLE agent.rules (
  rule_id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, pattern TEXT NOT NULL, account_id TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX rules_tenant ON agent.rules (tenant_id, rule_id DESC);
CREATE TABLE agent.party_accounts (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, party_id TEXT NOT NULL, account_id TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, book_id, party_id, account_id));
CREATE TABLE agent.journal_index (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, journal_id TEXT NOT NULL, principal TEXT NOT NULL,
  party_id TEXT, counter_account TEXT, instrument TEXT, amount TEXT, txn_date DATE NOT NULL,
  provisional BOOLEAN NOT NULL, confirmed BOOLEAN NOT NULL DEFAULT false, reversed BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, journal_id));
CREATE INDEX journal_provisional ON agent.journal_index (tenant_id, book_id, instrument, amount) WHERE provisional AND NOT confirmed AND NOT reversed;
CREATE TABLE agent.drafts (
  tenant_id TEXT NOT NULL, draft_id TEXT NOT NULL, txn_id TEXT NOT NULL, book_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','awaiting_approval','posted','rejected')),
  proposal JSONB NOT NULL, decision JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by TEXT, resolved_at TIMESTAMPTZ, PRIMARY KEY (tenant_id, draft_id));
CREATE TABLE agent.ratifications (
  tenant_id TEXT NOT NULL, request_id TEXT NOT NULL, journal_id TEXT NOT NULL, txn_id TEXT NOT NULL, due_by DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','ratified','corrected')), narration TEXT NOT NULL,
  resolved_by TEXT, resolved_at TIMESTAMPTZ, PRIMARY KEY (tenant_id, request_id));
CREATE TABLE agent.accounts (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, account_id TEXT NOT NULL, nature TEXT NOT NULL, is_cash_like BOOLEAN NOT NULL,
  PRIMARY KEY (tenant_id, book_id, account_id));
CREATE TABLE agent.overrides (
  tenant_id TEXT NOT NULL, key TEXT NOT NULL, max_level TEXT NOT NULL, until DATE NOT NULL, reason TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key));
` + tenantRlsFor("agent"),
}, {
  id: "agent-002-sealed-columns",
  // Names, patterns, narrations and draft proposals are stored sealed; rules are found by a keyed
  // blind index of the pattern instead of the pattern itself.
  sql: `ALTER TABLE agent.rules ADD COLUMN pattern_idx TEXT;
CREATE INDEX rules_pattern_idx ON agent.rules (tenant_id, pattern_idx);`,
}, {
  id: "agent-003-account-names",
  // Sealed account name, shown to the LLM classifier. Rows projected before this migration keep ''
  // and the classifier falls back to the account id.
  sql: `ALTER TABLE agent.accounts ADD COLUMN name TEXT NOT NULL DEFAULT '';`,
}, {
  id: "agent-scale-001-open-work-indexes",
  // Open drafts and ratifications are read as keyset pages in queue order (F11): the partial
  // indexes hold only open work, so a page costs its own size, not the tenant's history.
  sql: `
CREATE INDEX IF NOT EXISTS drafts_open_page ON agent.drafts (tenant_id, created_at, draft_id) WHERE status IN ('queued','awaiting_approval');
CREATE INDEX IF NOT EXISTS drafts_open_book_page ON agent.drafts (tenant_id, book_id, created_at, draft_id) WHERE status IN ('queued','awaiting_approval');
CREATE INDEX IF NOT EXISTS ratifications_open_page ON agent.ratifications (tenant_id, due_by, request_id) WHERE status = 'open';`,
}];
