/** Production entry point: one cell process with the NATS bus and the outbox relay. */
import { readFileSync } from "node:fs";
import { Cell } from "./cell.ts";
import { LocalFileKms } from "@kuber/crypto";
import { buildServer } from "./server.ts";
import { Copilot } from "./copilot/index.ts";
import { ExternalTools, parseServers } from "./copilot/external.ts";
import { providerFromEnv } from "./copilot/provider.ts";
import { PROCESSING_ENV, createGovernance, processingFromEnv } from "./copilot/governance/index.ts";
import { reasonerFromEnv } from "./copilot/reasoner.ts";
import { bridgeReasoner } from "./copilot/reasoner-bridge.ts";
import { parseGrants } from "./mcp.ts";
import { classifierFromEnv } from "./llm-classifier.ts";
import { replayStoreFromEnv } from "@kuber/auth/valkey";

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
    !/[?&]sslmode=verify-full\b/.test(process.env.SYSTEM_DATABASE_URL ?? "?sslmode=verify-full") && "SYSTEM_DATABASE_URL must use sslmode=verify-full",
    !env("NATS_URL", "").startsWith("tls://") && "NATS_URL must be tls://",
    !!process.env.VALKEY_URL && !/^(rediss|valkeys):\/\//.test(process.env.VALKEY_URL) && "VALKEY_URL must be rediss:// (TLS)",
    !httpsCfg && "TLS_CERT_FILE and TLS_KEY_FILE are required to serve HTTPS",
  ].filter(Boolean);
  if (problems.length) { console.error(`KUBER_REQUIRE_TLS: refusing to start:\n  ${problems.join("\n  ")}`); process.exit(1); }
}

/**
 * Identity (F01). The BFF signs every request with CORE_AUTH_SECRET (or the file named by
 * CORE_AUTH_SECRET_FILE); without it the core would authenticate nobody, so it does not start.
 * Development sign-in needs KUBER_DEV_SIGNIN=true and is refused when NODE_ENV=production.
 */
const coreAuthSecret = process.env.CORE_AUTH_SECRET_FILE ? readFileSync(process.env.CORE_AUTH_SECRET_FILE, "utf8").trim() : process.env.CORE_AUTH_SECRET;
if (!coreAuthSecret || coreAuthSecret.length < 32) {
  console.error("refusing to start: CORE_AUTH_SECRET (or CORE_AUTH_SECRET_FILE) must hold a secret of at least 32 characters shared with the web tier; run ./scripts/secure-setup.sh");
  process.exit(1);
}
const devSignIn = process.env.KUBER_DEV_SIGNIN === "true";
if (devSignIn && process.env.NODE_ENV === "production") {
  console.error("refusing to start: KUBER_DEV_SIGNIN=true is for development only and is not allowed with NODE_ENV=production");
  process.exit(1);
}
const origins = env("WEBAUTHN_ORIGIN", "http://localhost:3000").split(",").map((o) => o.trim()).filter(Boolean);
const rpId = env("WEBAUTHN_RP_ID", new URL(origins[0]!).hostname);

/**
 * TAGOF Domain 12 / GEN-04: sending book data to a model needs a recorded processing decision
 * (KUBER_LLM_PROCESSING_APPROVED=<approver>:<YYYY-MM-DD>:<data-location>). A malformed record is a
 * configuration error: refuse to start rather than guess. Absent, every model path stays off.
 */
const processing = processingFromEnv();
if (!processing.ok && processing.configured) { console.error(`refusing to start: ${processing.reason}`); process.exit(1); }

const classifier = classifierFromEnv();
const cell = await Cell.start({
  databaseUrl: env("DATABASE_URL"),
  migrationUrl: process.env.MIGRATION_URL,
  appRole: process.env.APP_ROLE,
  systemDatabaseUrl: process.env.SYSTEM_DATABASE_URL,
  systemRole: process.env.SYSTEM_ROLE ? { name: process.env.SYSTEM_ROLE, password: process.env.SYSTEM_DB_PASSWORD } : undefined,
  cellId: env("CELL_ID", "local"),
  bus: { natsUrl: env("NATS_URL", "nats://localhost:4222"), caFile: process.env.NATS_TLS_CA, token: process.env.NATS_TOKEN, retentionDays: Number(env("KUBER_BUS_RETENTION_DAYS", "7")) },
  policyDir: env("POLICY_DIR", "./policies"),
  // No unencrypted mode: without a master key the core does not start.
  kms: LocalFileKms.load(env("KUBER_MASTER_KEY_FILE"), { strictPermissions: process.env.KUBER_KEY_FILE_STRICT !== "false" }),
  legacy: process.env.KUBER_LEGACY_PLAINTEXT === "allow" ? "allow" : "reject",
  poolSize: Number(env("DB_POOL", "20")),
  classifier,
  identity: { rpId, origins, rpName: env("WEBAUTHN_RP_NAME", "Kuber"), devSignIn },
});
const relay = cell.relay.run();
const clock = () => new Date().toISOString().slice(0, 10);
const external = new ExternalTools(parseServers(process.env.KUBER_MCP_SERVERS));

const mcpGrants = parseGrants(process.env.KUBER_MCP_TOKENS);
// Replay protection shared by every core instance (Valkey) when VALKEY_URL is set; otherwise in-process.
const replay = replayStoreFromEnv();
// The governance layer loads only hash-locked prompts, register and patterns (agent/prompts.lock.json): refuse to start otherwise.
const governance = createGovernance(cell);
// Model steps go to the Python DSPy middleware (AGENT_MW_URL); a direct provider only outside production (agent design 7.1).
const mw = process.env[PROCESSING_ENV] ? reasonerFromEnv() : null;   // no recorded processing decision: rules only (TAGOF Domain 12)
const copilot = new Copilot(cell, mw ? bridgeReasoner(mw) : null, external, clock, governance);
console.log(`copilot: ${mw ? `reasoner ${mw.name}` : "rules only (no AGENT_MW_URL)"}`);
const app = buildServer(cell, { copilot, mcpGrants, clock, https: httpsCfg, auth: { secret: coreAuthSecret, replay }, governance });
console.log(`classifier: ${classifier ? classifier.name : "rules, history and keywords (set KUBER_LLM_CLASSIFY=on for the LLM step)"}`);
console.log(`replay protection: ${replay.kind === "valkey" ? "shared (Valkey)" : "in-process (single instance)"}`);
console.log(`sign-in: passkeys (relying party ${rpId}, origins ${origins.join(", ")})${devSignIn ? "; DEVELOPMENT SIGN-IN ENABLED (KUBER_DEV_SIGNIN=true): anyone can claim an empty workspace by name" : ""}`);
console.log(`model processing (${PROCESSING_ENV}): ${processing.ok ? `approved by ${processing.approval.approver} on ${processing.approval.date}, data location ${processing.approval.location}` : "not approved; no book data is sent to a model"}`);
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
  await replay.close?.();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
