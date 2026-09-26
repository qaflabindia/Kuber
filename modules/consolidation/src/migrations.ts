import { tenantRlsFor, type Migration } from "@kuber/eventstore";

/**
 * Query side of the consolidation module. The facts are in sealed event streams (group register,
 * group closes, disputes, links); these tables are what the module reads and lists, written in the
 * same transaction as those events. Every table is tenant-scoped with row-level security.
 * Free text and figures are sealed with the tenant's key (`detail`, `body`, `note`, `name`).
 */
export const CONSOLIDATION_MIGRATIONS: Migration[] = [{
  id: "consolidation-001",
  sql: `
CREATE SCHEMA IF NOT EXISTS consolidation;
CREATE TABLE consolidation.groups (
  tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, book_id TEXT NOT NULL, parent_entity_id TEXT NOT NULL,
  name TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, group_id));
CREATE UNIQUE INDEX groups_book ON consolidation.groups (tenant_id, book_id);
-- FIN-GRP-01: a party of entity_id's party master is the group entity counterparty_entity_id.
CREATE TABLE consolidation.ic_links (
  tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, entity_id TEXT NOT NULL, party_id TEXT NOT NULL,
  counterparty_entity_id TEXT NOT NULL, plan_id TEXT NOT NULL, PRIMARY KEY (tenant_id, group_id, entity_id, party_id));
-- FIN-GRP-02: disputes need both sides' positions (bilateral resolution).
CREATE TABLE consolidation.disputes (
  tenant_id TEXT NOT NULL, dispute_id TEXT NOT NULL, group_id TEXT NOT NULL, item_key TEXT NOT NULL,
  sender_entity_id TEXT NOT NULL, receiver_entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved')), agreed_paise NUMERIC(22,0),
  detail TEXT NOT NULL, opened_by TEXT NOT NULL, opened_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, dispute_id));
CREATE UNIQUE INDEX disputes_one_open ON consolidation.disputes (tenant_id, group_id, item_key) WHERE status = 'open';
CREATE TABLE consolidation.dispute_positions (
  tenant_id TEXT NOT NULL, dispute_id TEXT NOT NULL, entity_id TEXT NOT NULL, principal TEXT NOT NULL,
  agreed_paise NUMERIC(22,0) NOT NULL, note TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dispute_id, entity_id));
-- FIN-GRP-03: committed consolidation runs; the active run per group is the one the consolidation book holds.
CREATE TABLE consolidation.runs (
  tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, group_id TEXT NOT NULL, period_end DATE NOT NULL, version INT NOT NULL,
  input_hash TEXT NOT NULL, register_version INT NOT NULL, plan_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded')), journals JSONB NOT NULL, stock TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, run_id));
CREATE UNIQUE INDEX runs_version ON consolidation.runs (tenant_id, group_id, period_end, version);
-- FIN-GRP-04: certified group closes; a correction is a new version linked to the previous one.
CREATE TABLE consolidation.snapshots (
  tenant_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, group_id TEXT NOT NULL, period_end DATE NOT NULL, version INT NOT NULL,
  content_hash TEXT NOT NULL, previous_snapshot_id TEXT, run_id TEXT NOT NULL, body TEXT NOT NULL,
  taken_by TEXT NOT NULL, taken_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, snapshot_id));
CREATE UNIQUE INDEX snapshots_version ON consolidation.snapshots (tenant_id, group_id, period_end, version);
-- Linked tenants (design 6.4): the consent record, one row in each tenant.
CREATE TABLE consolidation.links (
  tenant_id TEXT NOT NULL, link_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('group','subsidiary')),
  group_tenant TEXT NOT NULL, subsidiary_tenant TEXT NOT NULL, group_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','active','revoked')),
  requested_by TEXT NOT NULL, accepted_by TEXT, revoked_by TEXT, revoke_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(), accepted_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, link_id));
-- Certified packs a linked subsidiary published to this (group) tenant. body: sealed with the group's
-- key, around a token sealed with a key derived from the subsidiary's keyring (unreadable once it is shredded).
CREATE TABLE consolidation.linked_packs (
  tenant_id TEXT NOT NULL, pack_id TEXT NOT NULL, link_id TEXT NOT NULL, entity_id TEXT NOT NULL, source_tenant TEXT NOT NULL,
  period_end DATE NOT NULL, pack_hash TEXT NOT NULL, prev_pack_hash TEXT NOT NULL, body TEXT NOT NULL,
  published_by TEXT NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, pack_id));
CREATE INDEX linked_packs_entity ON consolidation.linked_packs (tenant_id, entity_id, period_end, published_at DESC);
` + tenantRlsFor("consolidation"),
}];

/** Retention (apps/core keys-admin): every consolidation table is purged on crypto-shred; history is in sealed streams. */
export const CONSOLIDATION_TABLES = ["consolidation.groups", "consolidation.ic_links", "consolidation.disputes", "consolidation.dispute_positions",
  "consolidation.runs", "consolidation.snapshots", "consolidation.links", "consolidation.linked_packs"] as const;

export const groupNameCtx = (groupId: string) => `consolidation.groups.name|${groupId}`;
export const disputeDetailCtx = (disputeId: string) => `consolidation.disputes.detail|${disputeId}`;
export const positionNoteCtx = (disputeId: string, entityId: string) => `consolidation.dispute_positions.note|${disputeId}|${entityId}`;
export const runStockCtx = (runId: string) => `consolidation.runs.stock|${runId}`;
export const groupSnapshotCtx = (snapshotId: string) => `consolidation.snapshots.body|${snapshotId}`;
export const linkedPackCtx = (packId: string) => `consolidation.linked_packs.body|${packId}`;
