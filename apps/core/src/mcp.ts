/**
 * Kuber as an MCP server (Streamable HTTP, stateless). External agents authenticate with a bearer
 * token that maps to one tenant, one book and an agent principal. An agent principal can simulate
 * anything and commit only what policy lets agents do; everything else waits for a person.
 *
 * KUBER_MCP_TOKENS='{"<token>": {"tenant": "laksh-personal", "book": "main", "principal": "agent:claude-desktop"}}'
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Cell } from "./cell.ts";
import { kuberTools, type Who } from "./tools.ts";

const Grant = z.object({ tenant: z.string().min(1), book: z.string().min(1), principal: z.string().regex(/^agent:[\w.@-]+$/, "MCP principals must be agent:<name>") });
const digest = (s: string) => createHash("sha256").update(s).digest();

export function parseGrants(json: string | undefined): Map<string, Who> {
  if (!json) return new Map();
  const raw = z.record(z.string().min(24, "tokens must be at least 24 characters"), Grant).parse(JSON.parse(json));
  return new Map(Object.entries(raw).map(([t, g]) => [digest(t).toString("hex"), g]));
}

/** Constant-time lookup: compare digests so neither token length nor prefix leaks through timing. */
function authenticate(grants: Map<string, Who>, header: string | undefined): Who | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return null;
  const d = digest(m[1]!.trim());
  for (const [k, who] of grants) if (timingSafeEqual(Buffer.from(k, "hex"), d)) return who;
  return null;
}

export function mcpServer(cell: Cell, who: Who): Server {
  const server = new Server({ name: "kuber", version: "0.1.0" }, {
    capabilities: { tools: {} },
    instructions: "Kuber keeps double-entry books. Every change is simulated first: call a kuber_* operation to get a plan, show the user its checks and effects, and call kuber_commit only with the plan's planId and hash. Period operations (close, carry forward, allocate, rebalance) and anything above policy limits wait for a person in Kuber; say so rather than retrying. Amounts are rupees in inputs and paise in raw data. Use kuber_accounts for account ids.",
  });
  const tools = kuberTools(cell, who);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema as never,
      annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = tools.find((x) => x.name === req.params.name);
    if (!t) return { isError: true, content: [{ type: "text", text: `Unknown tool ${req.params.name}` }] };
    try {
      const r = await t.run((req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text: r.text }], structuredContent: (r.plan ?? r.data ?? {}) as Record<string, unknown> };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
    }
  });
  return server;
}

export function registerMcp(app: FastifyInstance, cell: Cell, grants: Map<string, Who>) {
  app.post("/mcp", async (req, reply) => {
    const who = authenticate(grants, req.headers.authorization);
    if (!who) return reply.code(401).header("www-authenticate", 'Bearer realm="kuber"').send({ error: "unauthorized", message: "MCP needs a Kuber agent token" });
    const server = mcpServer(cell, who);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless; use POST" }, id: null };
  app.get("/mcp", async (_req, reply) => reply.code(405).send(notAllowed));
  app.delete("/mcp", async (_req, reply) => reply.code(405).send(notAllowed));
}
