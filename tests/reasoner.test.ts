/**
 * MiddlewareReasoner against a local fake HTTPS middleware: KH1 signing (verified with packages/auth
 * under the agent-mw audience), the processing header, CA trust, timeouts and typed error mapping.
 * Plus reasonerFromEnv and the tests-only DirectAnthropicReasoner.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authKey, ReplayCache, verifyRequest, type Claims } from "@kuber/auth";
import {
  DirectAnthropicReasoner, MiddlewareReasoner, ReasonerError, reasonerFromEnv, maskNarration,
  type ReasonerErrorKind,
} from "../apps/core/src/copilot/reasoner.ts";
import type { LlmProvider } from "../apps/core/src/copilot/provider.ts";

const SECRET = "m".repeat(48);
const RECORD = "system_owner:asha:2026-09-01:us";
const CTX = { tenant: "t-1", principal: "agent:copilot" };
const CATALOGUE = [
  { name: "kuber_accounts", description: "Chart of accounts", input_schema: { type: "object" } },
  { name: "kuber_pnl", description: "Profit and loss", input_schema: { type: "object" } },
];
const META = { program: "next_step", artifactId: null, artifactHash: null, model: "fake/m", tokensIn: 10, tokensOut: 3, ms: 5 };

let dir = "", ca = "", server: Server, url = "";
const key = authKey(SECRET);
const replay = new ReplayCache();
let handler: (req: IncomingMessage, body: string, res: ServerResponse) => void = () => {};
const seen: { claims?: Claims; error?: string; headers: IncomingMessage["headers"]; body: string; path: string }[] = [];

const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kuber-mw-"));
  const o = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "ext.cnf"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
  o("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
  o("req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=Kuber test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.crt");
  o("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "srv.key");
  o("req", "-new", "-key", "srv.key", "-subj", "/CN=agent-mw", "-out", "srv.csr");
  o("x509", "-req", "-in", "srv.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", "ext.cnf", "-out", "srv.crt");
  ca = readFileSync(join(dir, "ca.crt"), "utf8");
  server = createServer({ key: readFileSync(join(dir, "srv.key")), cert: readFileSync(join(dir, "srv.crt")) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const rec: (typeof seen)[number] = { headers: req.headers, body, path: req.url ?? "" };
      try {
        rec.claims = verifyRequest(key, replay, { header: req.headers["x-kuber-auth"], method: req.method ?? "", path: req.url ?? "", body,
          audience: "kuber-agent-mw", issuers: ["kuber-core"] });
      } catch (e) { rec.error = (e as { code?: string }).code ?? String(e); }
      seen.push(rec);
      if (rec.error) return json(res, 401, { error: rec.error });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `https://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => server ? server.close(() => r()) : r());
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const client = (over: Partial<ConstructorParameters<typeof MiddlewareReasoner>[0]> = {}) =>
  new MiddlewareReasoner({ url, secret: SECRET, ca, timeoutMs: 2000, processingRecord: RECORD, ...over });

async function failure(p: Promise<unknown>): Promise<ReasonerError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ReasonerError); return e as ReasonerError; }
  throw new Error("expected a ReasonerError");
}

const nsInput = { request: "Chart of accounts please", history: [], catalogue: CATALOGUE, priorSteps: [] };

describe("MiddlewareReasoner", () => {
  it("signs every request (KH1, agent-mw audience) and sends the processing record", async () => {
    handler = (_req, _body, res) => json(res, 200, { action: "tool", tool: "kuber_accounts", args: {}, meta: META });
    const r = await client().nextStep({ ...CTX, session: "s".repeat(20) }, nsInput);
    expect(r).toEqual({ action: "tool", tool: "kuber_accounts", args: {}, meta: META });
    const last = seen.at(-1)!;
    expect(last.error).toBeUndefined();
    expect(last.claims).toMatchObject({ tenant: "t-1", principal: "agent:copilot", sid: "s".repeat(20), method: "POST", path: "/v1/next-step", iss: "kuber-core", aud: "kuber-agent-mw" });
    expect(last.claims!.exp - last.claims!.iat).toBeLessThanOrEqual(60_000);
    expect(last.headers["x-kuber-processing-approval"]).toBe(RECORD);
    expect(String(last.headers["x-kuber-auth"])).toMatch(/^KH1 [\w-]+\.[\w-]+$/);
    expect(JSON.parse(last.body)).toEqual({ request: "Chart of accounts please", history: [], catalogue: CATALOGUE, prior_steps: [] });
  });

  it("each request has a fresh nonce: the same call twice is accepted twice", async () => {
    handler = (_req, _body, res) => json(res, 200, { action: "final", draft: "Done.", meta: META });
    await client().nextStep(CTX, nsInput);
    await client().nextStep(CTX, nsInput);
    expect(seen.slice(-2).every((s) => !s.error)).toBe(true);
  });

  it("a request signed with another secret is refused and mapped to unauthorized", async () => {
    const e = await failure(client({ secret: "x".repeat(40) }).nextStep(CTX, nsInput));
    expect(e.kind).toBe("unauthorized");
    expect(e.code).toBe("bad_signature");
  });

  it("never sends kuber_commit and rejects a tool outside the catalogue sent", async () => {
    handler = (_req, _body, res) => json(res, 200, { action: "tool", tool: "kuber_trial_balance", args: {}, meta: META });
    const e = await failure(client().nextStep(CTX, { ...nsInput, catalogue: [...CATALOGUE, { name: "kuber_commit", description: "", input_schema: {} }] }));
    expect(e.kind).toBe("rejected");
    expect(e.code).toBe("tool_not_in_catalogue");
    expect(JSON.parse(seen.at(-1)!.body).catalogue.map((t: { name: string }) => t.name)).toEqual(["kuber_accounts", "kuber_pnl"]);
  });

  it("parses compose and classify, masking narration digits before sending", async () => {
    handler = (req, _body, res) => req.url === "/v1/compose"
      ? json(res, 200, { answer: "The books show ₹1,30,206.50.", facts: ["BANK ₹1,30,206.50"], inferences: [], opinions: [], grounding: { ok: true, ungrounded: [] }, meta: { ...META, program: "compose" } })
      : json(res, 200, { accountId: "RENT", confidence: 0.8, reasons: ["rent"], meta: { ...META, program: "classify" } });
    const c = await client().compose(CTX, { request: "bank?", toolOutputs: [{ tool: "kuber_balance", output: "BANK ₹1,30,206.50" }] });
    expect(c.answer).toContain("₹1,30,206.50");
    expect(c.meta.program).toBe("compose");
    const k = await client().classify(CTX, { line: { narration: "NEFT 1234567890 RENT", direction: "out", magnitude: "10k_1l" }, chart: [{ id: "RENT", name: "Rent" }] });
    expect(k.accountId).toBe("RENT");
    expect(JSON.parse(seen.at(-1)!.body).line.narration).toBe("NEFT ########## RENT");
    expect(maskNarration("a 123 b 4567")).toBe("a 123 b ####");
  });

  it("rejects a classification outside the chart sent", async () => {
    handler = (_req, _body, res) => json(res, 200, { accountId: "SUSPENSE", confidence: 0.8, reasons: [], meta: META });
    const e = await failure(client().classify(CTX, { line: { narration: "x", direction: "in", magnitude: "lt_1k" }, chart: [{ id: "RENT", name: "Rent" }] }));
    expect(e.kind).toBe("rejected");
  });

  it("times out on a slow middleware", async () => {
    handler = (_req, _body, res) => { setTimeout(() => { if (!res.destroyed) json(res, 200, { action: "final", draft: "late", meta: META }); }, 1500); };
    const t0 = Date.now();
    const e = await failure(client({ timeoutMs: 300 }).nextStep(CTX, nsInput));
    expect(e.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1400);
  });

  const cases: [number, Record<string, unknown>, ReasonerErrorKind][] = [
    [503, { error: "processing_not_approved", detail: "not set" }, "processing_not_approved"],
    [503, { error: "model_not_configured" }, "unavailable"],
    [503, { error: "artifact_not_approved" }, "unavailable"],
    [422, { error: "tool_not_in_catalogue", tool: "x", meta: META }, "rejected"],
    [422, { error: "ungrounded_figures", ungrounded: ["₹5"], meta: META }, "rejected"],
    [422, { error: "invalid_request", errors: [] }, "invalid_request"],
    [429, { error: "rate_limited" }, "rate_limited"],
    [502, { error: "model_error" }, "model_error"],
    [504, { error: "model_timeout" }, "timeout"],
    [500, { error: "boom" }, "unavailable"],
  ];
  for (const [status, body, kind] of cases) {
    it(`maps ${status} ${String(body.error)} to ${kind}`, async () => {
      handler = (_req, _body, res) => json(res, status, body);
      const e = await failure(client().nextStep(CTX, nsInput));
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expect(e.code).toBe(body.error);
      if (body.meta) expect(e.detail.meta).toEqual(META);
    });
  }

  it("maps a non-JSON or off-contract 200 to bad_response", async () => {
    handler = (_req, _body, res) => { res.writeHead(200); res.end("<html>"); };
    expect((await failure(client().nextStep(CTX, nsInput))).kind).toBe("bad_response");
    handler = (_req, _body, res) => json(res, 200, { action: "tool", tool: "kuber_accounts" });
    expect((await failure(client().nextStep(CTX, nsInput))).kind).toBe("bad_response");
  });

  it("refuses a server certificate not issued by the Kuber CA", async () => {
    const e = await failure(client({ ca: undefined }).nextStep(CTX, nsInput));
    expect(e.kind).toBe("network");
  });

  it("maps a refused connection to network", async () => {
    const e = await failure(new MiddlewareReasoner({ url: "https://127.0.0.1:1", secret: SECRET, ca, processingRecord: RECORD }).nextStep(CTX, nsInput));
    expect(e.kind).toBe("network");
  });

  it("does not call the middleware without a processing record", async () => {
    const before = seen.length;
    const e = await failure(client({ processingRecord: () => { throw new ReasonerError("processing_not_approved", "no record"); } }).nextStep(CTX, nsInput));
    expect(e.kind).toBe("processing_not_approved");
    expect(seen.length).toBe(before);
  });

  it("requires https and a 32-character secret", () => {
    expect(() => new MiddlewareReasoner({ url: "http://agent-mw:8443", secret: SECRET })).toThrow(/https/);
    expect(() => new MiddlewareReasoner({ url, secret: "short" })).toThrow();
  });
});

describe("reasonerFromEnv", () => {
  it("AGENT_MW_URL selects the middleware", () => {
    const r = reasonerFromEnv({ AGENT_MW_URL: "https://agent-mw:8443", AGENT_MW_SECRET: SECRET, NODE_ENV: "production", ANTHROPIC_API_KEY: "k", KUBER_LLM_MODEL: "m" });
    expect(r).toBeInstanceOf(MiddlewareReasoner);
    expect(r!.name).toBe("agent-mw:agent-mw:8443");
  });
  it("AGENT_MW_URL without a secret is rules only", () => {
    expect(reasonerFromEnv({ AGENT_MW_URL: "https://agent-mw:8443" })).toBeNull();
  });
  it("a direct key outside production gives the direct reasoner", () => {
    const r = reasonerFromEnv({ NODE_ENV: "test", ANTHROPIC_API_KEY: "k", KUBER_LLM_MODEL: "claude-x", KUBER_LLM_PROCESSING_APPROVED: RECORD });
    expect(r).toBeInstanceOf(DirectAnthropicReasoner);
  });
  it("never the direct reasoner in production, and null with nothing configured", () => {
    expect(reasonerFromEnv({ NODE_ENV: "production", ANTHROPIC_API_KEY: "k", KUBER_LLM_MODEL: "claude-x" })).toBeNull();
    expect(reasonerFromEnv({})).toBeNull();
  });
});

describe("DirectAnthropicReasoner (tests/dev only)", () => {
  const provider = (content: Awaited<ReturnType<LlmProvider["turn"]>>["content"]): LlmProvider =>
    ({ name: "anthropic:fake", turn: async () => ({ stop: content.some((b) => b.type === "tool_use") ? "tool_use" : "end", content }) });
  it("maps a tool_use to a tool decision and refuses tools outside the catalogue", async () => {
    const ok = await new DirectAnthropicReasoner(provider([{ type: "tool_use", id: "1", name: "kuber_pnl", input: { from: "2026-09-01" } }])).nextStep(CTX, nsInput);
    expect(ok).toMatchObject({ action: "tool", tool: "kuber_pnl", args: { from: "2026-09-01" }, meta: { program: "next_step", model: "anthropic:fake", artifactId: null } });
    const e = await failure(new DirectAnthropicReasoner(provider([{ type: "tool_use", id: "1", name: "kuber_commit", input: {} }])).nextStep(CTX, nsInput));
    expect(e.kind).toBe("rejected");
  });
  it("maps text to a final draft and composes from JSON", async () => {
    expect(await new DirectAnthropicReasoner(provider([{ type: "text", text: "Done." }])).nextStep(CTX, nsInput)).toMatchObject({ action: "final", draft: "Done." });
    const c = await new DirectAnthropicReasoner(provider([{ type: "text", text: '{"facts":["a"],"inferences":[],"opinions":[],"answer":"The books show ₹5."}' }]))
      .compose(CTX, { request: "q", toolOutputs: [{ tool: "t", output: "₹5" }] });
    expect(c).toMatchObject({ answer: "The books show ₹5.", facts: ["a"], meta: { program: "compose" } });
  });
});
