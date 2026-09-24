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
 */
import postgres from "postgres";
import { EventStore } from "@kuber/eventstore";
import { PolicyEngine } from "@kuber/policy";
import { Identity, isRole } from "@kuber/identity";

const [cmd, tenant, principal, ...rest] = process.argv.slice(2);
const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const url = process.env.DATABASE_URL;
if (!url || !cmd || !tenant) {
  console.error("usage: identity-cli invite <tenant> <role:name> [--books a,b] [--hours 72] | members <tenant> | revoke <tenant> <role:name>   (needs DATABASE_URL)");
  process.exit(2);
}
const sql = postgres(url, { max: 1, onnotice: () => undefined });
const id = new Identity(new EventStore(sql, "cli"), PolicyEngine.fromDir(process.env.POLICY_DIR ?? "./policies"), { rpId: "localhost", origins: [] });
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
