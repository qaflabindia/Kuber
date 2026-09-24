/**
 * Operator commands for identity (run with the database reachable, as the keys CLI is):
 *
 *   invite <tenant> <role:name> [--books a,b] [--hours 72]   one-time enrolment code for a passkey
 *   members <tenant>                                          list members
 *   revoke <tenant> <role:name>                               revoke a member
 *
 * Existing installations: workspaces created before passkeys have data but no members, so nobody
 * can claim them by signing up. Issue the owner an invitation that keeps their principal, e.g.
 *   ./kuber run --rm --entrypoint "npx tsx apps/core/src/identity-cli.ts" tools invite laksh owner:laksh
 * and enter it on the sign-in page under "Create a passkey" → "Invitation code".
 *
 * Needs DATABASE_URL and KUBER_MASTER_KEY_FILE: display names are sealed with the tenant's key and
 * every change is recorded as a sealed event in the tenant's identity stream.
 */
import postgres from "postgres";
import { EventStore } from "@kuber/eventstore";
import { Keyring, LocalFileKms } from "@kuber/crypto";
import { PolicyEngine } from "@kuber/policy";
import { Identity, isRole } from "@kuber/identity";
import { invalidateApprovals } from "@kuber/ops";

const [cmd, tenant, principal, ...rest] = process.argv.slice(2);
const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const url = process.env.DATABASE_URL, keyFile = process.env.KUBER_MASTER_KEY_FILE;
if (!url || !keyFile || !cmd || !tenant) {
  console.error("usage: identity-cli invite <tenant> <role:name> [--books a,b] [--hours 72] | members <tenant> | revoke <tenant> <role:name>   (needs DATABASE_URL and KUBER_MASTER_KEY_FILE)");
  process.exit(2);
}
const sql = postgres(url, { max: 1, onnotice: () => undefined });
const keyring = new Keyring(sql, LocalFileKms.load(keyFile, { strictPermissions: process.env.KUBER_KEY_FILE_STRICT !== "false" }));
const store = new EventStore(sql, "cli", { keyring });
const id = new Identity(store, PolicyEngine.fromDir(process.env.POLICY_DIR ?? "./policies"), { rpId: "localhost", origins: [] });
// FIN-MDM-04: a removal here also invalidates the member's approvals and makes their saved plans stale.
id.onAuthorityChange((t, change, tx) => invalidateApprovals(store, t, change, tx).then(() => undefined));
try {
  if (cmd === "members") console.table(await id.members(tenant));
  else if (cmd === "revoke" && principal) { await id.revoke(tenant, "operator:cli", principal); console.log(`revoked ${principal}`); }
  else if (cmd === "invite" && principal) {
    const role = principal.split(":")[0]!;
    if (!isRole(role)) throw new Error(`unknown role ${role}`);
    const books = flag("books")?.split(",").map((b) => b.trim()).filter(Boolean) ?? null;
    const r = await id.invite(tenant, "operator:cli", { role, principal, displayName: principal.split(":")[1]!, books, ttlHours: Number(flag("hours") ?? 72) });
    console.log(`workspace: ${tenant}\nprincipal: ${r.principal}\ncode:      ${r.token}\nexpires:   ${r.expiresAt}`);
  } else throw new Error(`unknown command ${cmd}`);
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
finally { await sql.end(); }
