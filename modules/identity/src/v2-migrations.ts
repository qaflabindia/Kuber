/**
 * Role model v2 (implementation design 6.3, decided 25 September 2026): the schema half.
 *
 *   identity.members      role takes the twelve role names (plus agent); the principal's prefix is
 *                         the role or a legacy alias of it (owner/approver → superuser,
 *                         preparer/member → staff); party_id binds Customer and Supplier
 *                         memberships to one party of the party master (mdm)
 *   identity.enrolments   the same for invitations
 *   identity.shares       time-limited shares of a certified snapshot or a report with a guest
 *
 * Legacy role VALUES are still accepted by the constraint so this migration can run before the
 * data migration (Identity.migrateRoleModel), which rewrites them to the new names, idempotently,
 * recording a MemberRoleChanged event with the reason "role model v2" for each member. New rows are
 * always written with the new names.
 */
import type { Migration } from "@kuber/eventstore";
import { rlsForTables } from "./fin-migrations.ts";

const NEW_ROLES = ["superuser", "admin", "system_owner", "controller", "treasurer", "staff", "auditor", "customer", "supplier", "investor", "guest", "agent"];
const LEGACY_ROLES = ["owner", "approver", "preparer", "member"];
const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");

/** The invariant as SQL: the principal's prefix is the role or a legacy alias of it. */
const PREFIX_RULE = `(split_part(principal, ':', 1) = role
    OR (split_part(principal, ':', 1) IN ('owner','approver') AND role = 'superuser')
    OR (split_part(principal, ':', 1) IN ('preparer','member') AND role = 'staff'))`;

export const IDENTITY_V2_MIGRATIONS: Migration[] = [{
  id: "identity-005-role-model-v2",
  sql: `
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'identity.members'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%role%' LOOP
    EXECUTE format('ALTER TABLE identity.members DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE identity.members ADD COLUMN party_id TEXT;
ALTER TABLE identity.members ADD CONSTRAINT members_role_v2 CHECK (role IN (${list([...NEW_ROLES, ...LEGACY_ROLES])}));
ALTER TABLE identity.members ADD CONSTRAINT members_prefix_v2 CHECK ${PREFIX_RULE};
ALTER TABLE identity.members ADD CONSTRAINT members_party_bound CHECK ((role IN ('customer','supplier')) = (party_id IS NOT NULL));
ALTER TABLE identity.enrolments ADD COLUMN party_id TEXT;
CREATE TABLE identity.shares (
  tenant_id TEXT NOT NULL, share_id TEXT NOT NULL, grantee TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('snapshot','report')), item_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, granted_by TEXT NOT NULL, granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by TEXT, revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, share_id));
CREATE INDEX shares_grantee ON identity.shares (tenant_id, grantee) WHERE revoked_at IS NULL;
` + rlsForTables("identity", ["shares"]),
}];
