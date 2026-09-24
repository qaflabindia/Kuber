/** HTTP API contract: validation at the edge, signed-request tenant enforcement, error mapping, async ingestion. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type Cell } from "@kuber/core";
import { CORE_AUTH_SECRET, enrol, signedInject, startCell, type SignedRequest } from "./helpers.ts";

let cell: Cell, app: FastifyInstance, stop: () => Promise<void>;
let send: ReturnType<typeof signedInject>;
const H = { tenant: "acme", principal: "owner:ravi" };
const req = (method: SignedRequest["method"], url: string, payload?: unknown, extra: Partial<SignedRequest> = {}) => send({ method, url, ...H, payload, ...extra });

beforeAll(async () => {
  ({ cell, stop } = await startCell({ value: "2026-10-25" }));
  await enrol(cell, "acme", ["owner:ravi"]);
  app = buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } });
  send = signedInject(app);
});
afterAll(async () => { await app.close(); await stop(); });

describe("core API", () => {
  it("opens a book and rejects a second open of the same book", async () => {
    const body = { bookId: "gl", entityId: "acme", entityType: "company" };
    expect((await req("POST", "/v1/tenants/acme/books", body)).statusCode).toBe(201);
    const again = await req("POST", "/v1/tenants/acme/books", body);
    expect(again.statusCode).toBe(422);
    expect(again.json().error).toBe("book_exists");
  });

  it("refuses a request signed for another tenant than the path", async () => {
    const r = await req("GET", "/v1/tenants/acme/drafts", undefined, { tenant: "other" });
    expect(r.statusCode).toBe(403);
  });

  it("refuses an unknown principal format", async () => {
    const r = await req("GET", "/v1/tenants/acme/drafts", undefined, { principal: "root" });
    expect(r.statusCode).toBe(400);
  });

  it("refuses unsigned requests, whatever identity headers they carry", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tenants/acme/drafts", headers: { "x-kuber-tenant": "acme", "x-kuber-principal": "owner:ravi" } });
    expect(r.statusCode).toBe(401);
  });

  it("posts a balanced manual journal and refuses an unbalanced one", async () => {
    const ok = await req("POST", "/v1/tenants/acme/books/gl/journals", {
      txnDate: "2026-10-01", narration: "Capital introduced",
      lines: [{ accountId: "BANK", debit: "10,00,000" }, { accountId: "CAPITAL", credit: "10,00,000" }] });
    expect(ok.statusCode).toBe(201);
    const bad = await req("POST", "/v1/tenants/acme/books/gl/journals", {
      txnDate: "2026-10-01", narration: "oops", lines: [{ accountId: "BANK", debit: "100" }, { accountId: "CAPITAL", credit: "99" }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe("unbalanced");
  });

  it("accepts a statement asynchronously and exposes the resulting drafts and reports", async () => {
    const r = await req("POST", "/v1/tenants/acme/books/gl/statements",
      "Date,Narration,Withdrawal Amt,Deposit Amt\n02/10/2026,UPI/DR/1/AWS/aws@axisbank,3480.50,\n", { contentType: "text/csv" });
    expect(r.statusCode).toBe(202);
    await cell.settle();
    const drafts = (await req("GET", "/v1/tenants/acme/drafts")).json();
    expect(drafts).toHaveLength(1);
    const appr = await req("POST", `/v1/tenants/acme/drafts/${drafts[0].draft_id}/approve`, {});
    expect(appr.statusCode).toBe(202);
    await cell.settle();
    const tb = (await req("GET", "/v1/tenants/acme/books/gl/reports/trial-balance")).json();
    expect(tb.totals["Difference (must be 0)"]).toBe("0");
    expect(tb.unit).toBe("paise");
    const v = (await req("GET", "/v1/tenants/acme/books/gl/verify")).json();
    expect(v.intact).toBe(true);
  });

  it("lists books, the chart with balances, and recent journals", async () => {
    const books = (await req("GET", "/v1/tenants/acme/books")).json();
    expect(books.map((b: { book_id: string }) => b.book_id)).toContain("gl");
    const accs = (await req("GET", "/v1/tenants/acme/books/gl/accounts")).json();
    expect(accs.find((a: { account_id: string }) => a.account_id === "BANK").balance).not.toBe("0");
    const js = (await req("GET", "/v1/tenants/acme/books/gl/journals?limit=5")).json();
    expect(js.length).toBeGreaterThan(0);
    expect(js[0].lines.length).toBeGreaterThanOrEqual(2);
  });

  it("explains a chat line it cannot read", async () => {
    const r = await req("POST", "/v1/tenants/acme/books/gl/chat", { text: "how am I doing?" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("not_understood");
  });

  it("reports health and readiness", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).json().ok).toBe(true);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });
});
