/**
 * Operator commands for identity (run with the database reachable, as the keys CLI is):
 *
 *   invite <tenant> <role:name> [--books a,b] [--hours 72] [--party P]
 *                                                             one-time enrolment code for a passkey. Roles (role model v2):
 *                                                             superuser, admin, system_owner, controller, treasurer, staff,
 *                                                             auditor, customer, supplier, investor, guest; customer and
 *                                                             supplier need --party (the party-master id they are bound to).
 *                                                             e.g. invite acme superuser:asha, invite acme customer:ravi --party C-RAVI
 *   migrate-roles                                             rewrite legacy role values (owner, approver, preparer, member)
 *                                                             to role model v2 in every tenant, idempotently (the core also
 *                                                             does this at start); prints members changed per tenant
 *   members <tenant>                                          list members
 *   revoke <tenant> <role:name>                               revoke a member
 *   recover <tenant> <role:name> --reason "…" [--hours 24] [--keep-passkeys]
 *                                                             account recovery for an EXISTING member who lost access:
 *                                                             a one-time code to register a new passkey for the same
 *                                                             principal (role, books, history kept). Audited in the
 *                                                             identity stream (RecoveryIssued, then RecoveryCompleted);
 *                                                             redeeming it revokes their other passkeys unless
 *                                                             --keep-passkeys. Owners and controllers should then
 *                                                             register a second passkey (design 16.4).
 *
 * Existing installations: workspaces created before passkeys have data but no members, so nobody
 * can claim them by signing up. Issue the owner a superuser invitation; to keep a legacy principal
 * that sealed history already names, give it as is (its prefix is an alias of the role), e.g.
 *   ./kuber run --rm --entrypoint "npx tsx apps/core/src/identity-cli.ts" tools invite laksh owner:laksh
 * (new people get new prefixes: invite laksh superuser:asha)
 * and enter it on the sign-in page under "Create a passkey" → "Invitation code".
 *
 * Needs DATABASE_URL and KUBER_MASTER_KEY_FILE: display names are sealed with the tenant's key and
 * every change is recorded as a sealed event in the tenant's identity stream.
 */
import postgres from "postgres";
import { EventStore } from "@kuber/eventstore";
import { Keyring, LocalFileKms } from "@kuber/crypto";
import { PolicyEngine } from "@kuber/policy";
import { Identity, canonicalRole, isPersonRole } from "@kuber/identity";
import { invalidateApprovals } from "@kuber/ops";

const [cmd, tenantArg, principal, ...rest] = process.argv.slice(2);
const tenant = cmd === "migrate-roles" ? "*" : tenantArg;
const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const url = process.env.DATABASE_URL, keyFile = process.env.KUBER_MASTER_KEY_FILE;
if (!url || !keyFile || !cmd || !tenant) {
  console.error("usage: identity-cli invite <tenant> <role:name> [--books a,b] [--hours 72] [--party P] | migrate-roles | members <tenant> | revoke <tenant> <role:name> | recover <tenant> <role:name> --reason \"…\" [--hours 24] [--keep-passkeys]   (needs DATABASE_URL and KUBER_MASTER_KEY_FILE)");
  process.exit(2);
}
const sql = postgres(url, { max: 1, onnotice: () => undefined });
const keyring = new Keyring(sql, LocalFileKms.load(keyFile, { strictPermissions: process.env.KUBER_KEY_FILE_STRICT !== "false" }));
// migrate-roles lists tenants: it needs a connection that sees every tenant (SYSTEM_DATABASE_URL, or an owner DATABASE_URL).
const sys = process.env.SYSTEM_DATABASE_URL ? postgres(process.env.SYSTEM_DATABASE_URL, { max: 1, onnotice: () => undefined }) : sql;
const store = new EventStore(sql, "cli", { keyring }, sys);
const id = new Identity(store, PolicyEngine.fromDir(process.env.POLICY_DIR ?? "./policies"), { rpId: "localhost", origins: [] });
// FIN-MDM-04: a removal here also invalidates the member's approvals and makes their saved plans stale.
id.onAuthorityChange((t, change, tx) => invalidateApprovals(store, t, change, tx).then(() => undefined));
try {
  if (cmd === "members") console.table(await id.members(tenant));
  else if (cmd === "migrate-roles") console.table(await id.migrateRoleModel());
  else if (cmd === "revoke" && principal) { await id.revoke(tenant, "operator:cli", principal); console.log(`revoked ${principal}`); }
  else if (cmd === "recover" && principal) {
    const reason = flag("reason");
    if (!reason) throw new Error('recover needs --reason "why this member lost access" (it is recorded in the identity audit stream)');
    const r = await id.recover(tenant, "operator:cli", principal, { reason, ttlHours: Number(flag("hours") ?? 24), revokeExisting: !rest.includes("--keep-passkeys") });
    console.log(`workspace: ${tenant}\nprincipal: ${r.principal}\ncode:      ${r.token}\nexpires:   ${r.expiresAt}\n${r.revokeExisting ? "redeeming it revokes their current passkeys" : "their current passkeys stay active"}`);
    console.log("They enter it on the sign-in page under \"Create a passkey\" -> \"Invitation code\". Recorded as RecoveryIssued in the identity stream.");
  }
  else if (cmd === "invite" && principal) {
    const role = canonicalRole(principal.split(":")[0]!);
    if (!isPersonRole(role)) throw new Error(`unknown role ${role}`);
    const books = flag("books")?.split(",").map((b) => b.trim()).filter(Boolean) ?? null;
    const r = await id.invite(tenant, "operator:cli", { role, principal, displayName: principal.split(":")[1]!, books, ttlHours: Number(flag("hours") ?? 72),
      ...(flag("party") ? { partyId: flag("party") } : {}) });
    console.log(`workspace: ${tenant}\nprincipal: ${r.principal}\nrole:      ${r.role}${r.partyId ? `\nparty:     ${r.partyId}` : ""}\ncode:      ${r.token}\nexpires:   ${r.expiresAt}`);
  } else throw new Error(`unknown command ${cmd}`);
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
finally { await sql.end(); if (sys !== sql) await sys.end(); }
