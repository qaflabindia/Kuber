/** Production entry point: one cell process with the NATS bus and the outbox relay. */
import { readFileSync } from "node:fs";
import { Cell } from "./cell.ts";
import { LocalFileKms } from "@kuber/crypto";
import { buildServer } from "./server.ts";
import { Copilot } from "./copilot/index.ts";
import { ExternalTools, parseServers } from "./copilot/external.ts";
import { providerFromEnv } from "./copilot/provider.ts";
import { parseGrants } from "./mcp.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing environment variable ${k}`);
  return v;
};

/**
 * Transport security. With KUBER_REQUIRE_TLS=true the core refuses to start unless every link it
 * opens or serves is TLS with certificate verification: fail closed, not warn.
 */
const requireTls = process.env.KUBER_REQUIRE_TLS === "true";
const httpsCfg = process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE
  ? { cert: readFileSync(process.env.TLS_CERT_FILE), key: readFileSync(process.env.TLS_KEY_FILE) } : undefined;
if (requireTls) {
  const problems = [
    !/[?&]sslmode=verify-full\b/.test(env("DATABASE_URL")) && "DATABASE_URL must use sslmode=verify-full",
    !/[?&]sslmode=verify-full\b/.test(process.env.MIGRATION_URL ?? "?sslmode=verify-full") && "MIGRATION_URL must use sslmode=verify-full",
    !env("NATS_URL", "").startsWith("tls://") && "NATS_URL must be tls://",
    !httpsCfg && "TLS_CERT_FILE and TLS_KEY_FILE are required to serve HTTPS",
  ].filter(Boolean);
  if (problems.length) { console.error(`KUBER_REQUIRE_TLS: refusing to start:\n  ${problems.join("\n  ")}`); process.exit(1); }
}

const cell = await Cell.start({
  databaseUrl: env("DATABASE_URL"),
  migrationUrl: process.env.MIGRATION_URL,
  appRole: process.env.APP_ROLE,
  cellId: env("CELL_ID", "local"),
  bus: { natsUrl: env("NATS_URL", "nats://localhost:4222"), caFile: process.env.NATS_TLS_CA, token: process.env.NATS_TOKEN, retentionDays: Number(env("KUBER_BUS_RETENTION_DAYS", "7")) },
  policyDir: env("POLICY_DIR", "./policies"),
  // No unencrypted mode: without a master key the core does not start.
  kms: LocalFileKms.load(env("KUBER_MASTER_KEY_FILE"), { strictPermissions: process.env.KUBER_KEY_FILE_STRICT !== "false" }),
  legacy: process.env.KUBER_LEGACY_PLAINTEXT === "allow" ? "allow" : "reject",
  poolSize: Number(env("DB_POOL", "20")),
});
const relay = cell.relay.run();
const clock = () => new Date().toISOString().slice(0, 10);
const external = new ExternalTools(parseServers(process.env.KUBER_MCP_SERVERS));
const copilot = new Copilot(cell, providerFromEnv(), external, clock);
const mcpGrants = parseGrants(process.env.KUBER_MCP_TOKENS);
const app = buildServer(cell, { copilot, mcpGrants, clock, https: httpsCfg });
console.log(`copilot: ${copilot.engine}; MCP server: ${mcpGrants.size ? `/mcp (${mcpGrants.size} token(s))` : "off (set KUBER_MCP_TOKENS)"}`);
await app.listen({ port: Number(env("PORT", "8080")), host: "0.0.0.0" });
console.log(`kuber core: cell ${cell.cellId} listening (${httpsCfg ? "https" : "http"}; data encrypted with ${cell.keyring.kms.name} KMS)`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log("shutting down");
  await app.close();
  cell.relay.stop();
  await relay;
  await cell.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
