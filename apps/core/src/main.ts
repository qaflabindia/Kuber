/** Production entry point: one cell process with the NATS bus and the outbox relay. */
import { Cell } from "./cell.ts";
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

const cell = await Cell.start({
  databaseUrl: env("DATABASE_URL"),
  migrationUrl: process.env.MIGRATION_URL,
  appRole: process.env.APP_ROLE,
  cellId: env("CELL_ID", "local"),
  bus: { natsUrl: env("NATS_URL", "nats://localhost:4222") },
  policyDir: env("POLICY_DIR", "./policies"),
  poolSize: Number(env("DB_POOL", "20")),
});
const relay = cell.relay.run();
const clock = () => new Date().toISOString().slice(0, 10);
const external = new ExternalTools(parseServers(process.env.KUBER_MCP_SERVERS));
const copilot = new Copilot(cell, providerFromEnv(), external, clock);
const mcpGrants = parseGrants(process.env.KUBER_MCP_TOKENS);
const app = buildServer(cell, { copilot, mcpGrants, clock });
console.log(`copilot: ${copilot.engine}; MCP server: ${mcpGrants.size ? `/mcp (${mcpGrants.size} token(s))` : "off (set KUBER_MCP_TOKENS)"}`);
await app.listen({ port: Number(env("PORT", "8080")), host: "0.0.0.0" });
console.log(`kuber core: cell ${cell.cellId} listening`);

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
