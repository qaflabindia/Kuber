/**
 * Operator commands for keys and ciphertext. Run with the database OWNER connection.
 *
 *   keys init <file>                  create a master key file (mode 0600); refuses to overwrite
 *   keys status                       master keys, tenant key versions, shredded tenants
 *   keys verify                       link chains, deep digests, anything still plaintext
 *   keys encrypt-legacy               seal data written before encryption (one-time migration)
 *   keys rotate-master                add a new master key, re-wrap every tenant key under it
 *   keys retire-master <kekId>        remove an old master key once nothing is wrapped with it
 *   keys rotate-tenant <tenant>       new data key for a tenant and re-encrypt under it
 *   keys drop-retired <tenant>        drop retired data keys (after a 5-minute grace, if unused)
 *   keys shred <tenant> --reason "…"  crypto-shred a tenant (irreversible)
 *   keys purge-bus                    drop broker messages (events live in PostgreSQL)
 *   keys backup-encrypt | backup-decrypt   stdin to stdout (used by scripts/backup.sh, restore.sh)
 *
 * Environment: KUBER_MASTER_KEY_FILE, MIGRATION_URL (owner), NATS_URL (purge-bus only).
 */
import postgres from "postgres";
import { pipeline } from "node:stream/promises";
import { LocalFileKms, Keyring, decryptStream, encryptStream } from "@kuber/crypto";
import { EventStore } from "@kuber/eventstore";
import { purgeKuberStreams } from "@kuber/bus";
import { KeyAdmin } from "./keys-admin.ts";
import { migrateCell } from "./cell.ts";

const [cmd, ...args] = process.argv.slice(2);
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (cmd === "init") {
  const file = args[0] ?? need("KUBER_MASTER_KEY_FILE");
  const id = LocalFileKms.create(file);
  console.log(`created ${file} with master key ${id} (mode 0600). Back this file up separately from database backups:\nwithout it the data cannot be decrypted; with it and a backup, it can.`);
  process.exit(0);
}

if (cmd === "backup-encrypt" || cmd === "backup-decrypt") {
  // stdin -> stdout; no database connection. Used by scripts/backup.sh and scripts/restore.sh.
  const k = LocalFileKms.load(need("KUBER_MASTER_KEY_FILE"), { strictPermissions: process.env.KUBER_KEY_FILE_STRICT !== "false" });
  const t = cmd === "backup-encrypt" ? await encryptStream(k, "backup") : decryptStream(k);
  await pipeline(process.stdin, t, process.stdout);
  process.exit(0);
}

const kms = LocalFileKms.load(need("KUBER_MASTER_KEY_FILE"), { strictPermissions: process.env.KUBER_KEY_FILE_STRICT !== "false" });
// Bring the schema up to date first (encrypt-legacy may run before the new core has ever started).
await migrateCell(need("MIGRATION_URL"), process.env.APP_ROLE);
const sql = postgres(need("MIGRATION_URL"), { max: 2, onnotice: () => undefined });
const keyring = new Keyring(sql, kms, 0);
const store = new EventStore(sql, "admin", { keyring, legacy: "allow" });
const admin = new KeyAdmin(sql, keyring, store);

try {
  switch (cmd) {
    case "status": {
      const s = await keyring.status(), usage = await keyring.kekUsage();
      console.log(`KMS ${kms.name}; active master key ${kms.activeKekId()}`);
      for (const id of kms.kekIds()) console.log(`  ${id}${id === kms.activeKekId() ? " (active)" : ""}: wraps ${usage[id] ?? 0} tenant key(s)`);
      for (const k of s.keys) console.log(`  tenant ${k.tenant_id} ${k.purpose} v${k.version} ${k.state} under ${k.kek_id}`);
      for (const x of s.shredded) console.log(`  SHREDDED ${x.tenant_id} at ${x.shredded_at.toISOString()} (${x.reason})`);
      break;
    }
    case "verify": {
      const v = await admin.verify(true);
      console.log(`${v.events} events in ${v.streams} streams`);
      console.log(v.problems.length ? `PROBLEMS:\n  ${v.problems.join("\n  ")}` : "link chains intact; every digest matches its decrypted payload");
      console.log(Object.keys(v.plaintext).length ? `STILL PLAINTEXT: ${JSON.stringify(v.plaintext)} (run: keys encrypt-legacy)` : "no plaintext in events or sealed columns");
      process.exitCode = v.problems.length || Object.keys(v.plaintext).length ? 1 : 0;
      break;
    }
    case "encrypt-legacy": console.log(await admin.encryptLegacy()); break;
    case "rotate-master": {
      const id = kms.addKek();
      console.log(`new master key ${id}; re-wrapped ${await keyring.rewrapAll()} tenant key(s). Retire the old key with: keys retire-master <id>`);
      break;
    }
    case "retire-master": {
      const id = args[0]; if (!id) throw new Error("usage: keys retire-master <kekId>");
      const used = (await keyring.kekUsage())[id] ?? 0;
      if (used) throw new Error(`${id} still wraps ${used} key(s); run rotate-master first`);
      kms.removeKek(id); console.log(`removed ${id}. Backups taken before its retirement need an old copy of the key file.`);
      break;
    }
    case "rotate-tenant": {
      const t = args[0]; if (!t) throw new Error("usage: keys rotate-tenant <tenant>");
      const v = await keyring.rotateTenant(t);
      console.log(`tenant ${t} now writes with data key v${v}`, await admin.reencrypt(t));
      break;
    }
    case "drop-retired": {
      const t = args[0]; if (!t) throw new Error("usage: keys drop-retired <tenant>");
      console.log(await admin.dropRetired(t));
      break;
    }
    case "shred": {
      const t = args[0], reason = flag("--reason");
      if (!t || !reason) throw new Error('usage: keys shred <tenant> --reason "why"');
      if (flag("--confirm") !== t) throw new Error(`irreversible. Repeat the tenant to confirm: keys shred ${t} --reason "${reason}" --confirm ${t}`);
      console.log(`shredded ${t}`, await admin.shred(t, process.env.USER ? `operator:${process.env.USER}` : "operator", reason));
      break;
    }
    case "purge-bus": console.log("purged", await purgeKuberStreams(need("NATS_URL"), process.env.NATS_TLS_CA, process.env.NATS_TOKEN)); break;
    default:
      console.error("commands: init, status, verify, encrypt-legacy, rotate-master, retire-master, rotate-tenant, drop-retired, shred, purge-bus");
      process.exitCode = 2;
  }
} finally {
  await sql.end();
}
