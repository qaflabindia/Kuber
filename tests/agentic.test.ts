/**
 * Agent surfaces: MCP server (real client over HTTP), the copilot's deterministic router, and the
 * copilot's model loop with a scripted provider. No surface can commit what needs a person.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { uuid } from "@kuber/contracts";
import { Copilot, amountIn, buildServer, dateIn, parseGrants, route, type Cell, type LlmProvider, type Turn } from "@kuber/core";
import { ROOT, startCell } from "./helpers.ts";

const T = "laksh", B = "main", OWNER = "owner:laksh";
const TOKEN = "test-token-0123456789abcdefghij";
const clock = { value: "2026-11-05" };
let cell: Cell, app: FastifyInstance, stop: () => Promise<void>, url: string;

beforeAll(async () => {
  ({ cell, stop } = await startCell(clock));
  await cell.gl.openBook(T, B, "laksh", "freelancer", OWNER);
  await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: "Opening BANK", voucherType: "opening",
    lines: [{ accountId: "BANK", amount: "12500000", dimensions: {} }, { accountId: "OPENING", amount: "-12500000", dimensions: {} }] }, { principal: OWNER });
  await cell.channels.submitStatement(T, B, readFileSync(join(ROOT, "samples", "hdfc_2026_10.csv"), "utf8"), OWNER);
  await cell.settle();
  app = buildServer(cell, { clock: () => clock.value, mcpGrants: parseGrants(JSON.stringify({ [TOKEN]: { tenant: T, book: B, principal: "agent:claude-desktop" } })) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`;
});
afterAll(async () => { await app.close(); await stop(); });

async function mcp(token = TOKEN) {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

describe("MCP server", () => {
  it("rejects a missing or wrong token", async () => {
    await expect(mcp("wrong-token-0123456789abcdefghij")).rejects.toThrow();
    expect(() => parseGrants(JSON.stringify({ short: { tenant: T, book: B, principal: "agent:x" } }))).toThrow(/24 characters/);
    expect(() => parseGrants(JSON.stringify({ [TOKEN]: { tenant: T, book: B, principal: "owner:x" } }))).toThrow(/agent/);
  });

  it("lists every operation as a tool with a JSON schema", async () => {
    const c = await mcp();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    for (const op of ["record", "post", "balance", "reconcile", "allocate", "rebalance", "report", "close", "carry_forward", "simulate", "dashboard"]) expect(names).toContain(`kuber_${op}`);
    expect(names).toEqual(expect.arrayContaining(["kuber_accounts", "kuber_commit", "kuber_plans"]));
    expect(tools.find((t) => t.name === "kuber_dashboard")!.annotations?.readOnlyHint).toBe(true);
    expect((tools.find((t) => t.name === "kuber_record")!.inputSchema as { properties: object }).properties).toHaveProperty("amount");
    await c.close();
  });

  it("an external agent records a small entry itself, but a close waits for a person", async () => {
    const c = await mcp();
    const r = await c.callTool({ name: "kuber_record", arguments: { narration: "Courier", amount: 120, direction: "out", account: "BIZEXP", via: "CASH", date: "2026-10-09" } });
    const plan = r.structuredContent as { planId: string; hash: string; needsPerson: boolean };
    expect(plan.needsPerson).toBe(false);
    expect(text(await c.callTool({ name: "kuber_commit", arguments: { planId: plan.planId, hash: plan.hash } }))).toMatch(/^Committed/);

    const close = await c.callTool({ name: "kuber_close", arguments: { periodEnd: "2026-10-31" } });
    expect(text(close)).toMatch(/BLOCKED|blocking/);
    const cp = close.structuredContent as { planId: string; hash: string };
    const res = await c.callTool({ name: "kuber_commit", arguments: { planId: cp.planId, hash: cp.hash } });
    expect(res.isError).toBe(true);                                             // blocked plans cannot be committed by anyone
    await c.close();
  });

  it("reads the dashboard and reports tool errors as errors", async () => {
    const c = await mcp();
    expect(text(await c.callTool({ name: "kuber_dashboard", arguments: {} }))).toMatch(/Cash/);
    const bad = await c.callTool({ name: "kuber_record", arguments: { narration: "x", amount: -5 } });
    expect(bad.isError).toBe(true);
    await c.close();
  });
});

describe("copilot, deterministic router", () => {
  const accts = ["BANK", "CASH", "INVEST", "BIZEXP", "LIVING"];
  it("parses Indian amounts and dates exactly", () => {
    expect(amountIn("1.2 lakh")).toBe("120000");
    expect(amountIn("90k")).toBe("90000");
    expect(amountIn("₹1,30,206.50")).toBe("130206.50");
    expect(dateIn("close FY 2026-27", "2026-11-05")).toBe("2027-03-31");
    expect(dateIn("close Oct 2026", "2026-11-05")).toBe("2026-10-31");
    expect(dateIn("as of 31 Oct 2026", "2026-11-05")).toBe("2026-10-31");
  });
  it("routes each operation", () => {
    const op = (t: string) => { const r = route(t, "2026-11-05", accts); return r.kind === "op" ? r.intents[0] : r.kind; };
    expect(op("Show my position")).toMatchObject({ op: "dashboard" });
    expect(op("Reconcile bank to 1,30,206.50 as of 31 Oct 2026")).toMatchObject({ op: "reconcile", input: { account: "BANK", statementBalance: "130206.50", asOf: "2026-10-31" } });
    expect(op("rebalance bank 40 invest 60")).toMatchObject({ op: "rebalance", input: { targets: [{ account: "BANK", pct: "40" }, { account: "INVEST", pct: "60" }] } });
    expect(op("Allocate BIZEXP 60 BIZEXP:Chennai 40 BIZEXP:Bengaluru")).toMatchObject({ op: "allocate", input: { from: "BIZEXP", to: [{ weight: "60", dimensions: { costCentre: "Chennai" } }, { weight: "40" }] } });
    expect(op("What if rent goes up 15000 a month")).toMatchObject({ op: "simulate", input: { monthlyChange: { expenses: "15000" } } });
    expect(op("Close FY 2026-27")).toMatchObject({ op: "close", input: { periodEnd: "2027-03-31" } });
    expect(op("Paid 450 to the plumber in cash")).toBe("chat");
    expect(op("tell me a joke")).toBe("help");
  });
  it("answers with plan cards, created as the copilot, never committed", async () => {
    const r = await new Copilot(cell, null, null, () => clock.value).ask({ tenant: T, book: B, principal: OWNER }, "Reconcile bank to 1,30,206.50 as of 31 Oct 2026");
    expect(r.cards[0]!.op).toBe("reconcile");
    expect(r.cards[0]!.createdBy).toBe("agent:copilot");
    expect(r.cards[0]!.status).toBe("proposed");
  });
});

describe("copilot, model loop", () => {
  it("plans through tools, cannot see kuber_commit, and returns the plans as cards", async () => {
    const seen: string[][] = [];
    const script: Turn[] = [
      { stop: "tool_use", content: [{ type: "tool_use", id: "t1", name: "kuber_accounts", input: {} }] },
      { stop: "tool_use", content: [{ type: "tool_use", id: "t2", name: "kuber_record", input: { narration: "Printer ink", amount: "1,499", direction: "out", account: "BIZEXP", via: "BANK", date: "2026-11-02" } }] },
      { stop: "end", content: [{ type: "text", text: "I've prepared the entry; it is waiting for your approval." }] },
    ];
    const fake: LlmProvider = { name: "fake", turn: async (_s, _m, tools) => { seen.push(tools.map((t) => t.name)); return script.shift()!; } };
    const seq = (await cell.gl.state(T, B)).seq;
    const r = await new Copilot(cell, fake, null, () => clock.value).ask({ tenant: T, book: B, principal: OWNER }, "Record printer ink 1499 from bank");
    expect(seen[0]).not.toContain("kuber_commit");
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.journals[0]!.lines[0]).toMatchObject({ accountId: "BIZEXP", amount: "149900" });
    expect(r.trace.map((t) => t.tool)).toEqual(["kuber_accounts", "kuber_record"]);
    expect((await cell.gl.state(T, B)).seq).toBe(seq);                          // nothing posted by the copilot
    expect(r.reply).toMatch(/approval/);
  });
});
