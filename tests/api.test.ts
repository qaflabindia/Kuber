/** HTTP API contract: validation at the edge, tenant header enforcement, error mapping, async ingestion. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type Cell } from "@kuber/core";
import { startCell } from "./helpers.ts";

let cell: Cell, app: FastifyInstance, stop: () => Promise<void>;
const H = { "x-kuber-tenant": "acme", "x-kuber-principal": "owner:ravi" };

beforeAll(async () => {
  ({ cell, stop } = await startCell({ value: "2026-10-25" }));
  app = buildServer(cell);
});
afterAll(async () => { await app.close(); await stop(); });

describe("core API", () => {
  it("opens a book and rejects a second open of the same book", async () => {
    const body = { bookId: "gl", entityId: "acme", entityType: "company" };
    expect((await app.inject({ method: "POST", url: "/v1/tenants/acme/books", headers: H, payload: body })).statusCode).toBe(201);
    const again = await app.inject({ method: "POST", url: "/v1/tenants/acme/books", headers: H, payload: body });
    expect(again.statusCode).toBe(422);
    expect(again.json().error).toBe("book_exists");
  });

  it("refuses a request whose tenant header does not match the path", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tenants/acme/drafts", headers: { ...H, "x-kuber-tenant": "other" } });
    expect(r.statusCode).toBe(403);
  });

  it("refuses an unknown principal format", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tenants/acme/drafts", headers: { ...H, "x-kuber-principal": "root" } });
    expect(r.statusCode).toBe(400);
  });

  it("posts a balanced manual journal and refuses an unbalanced one", async () => {
    const ok = await app.inject({ method: "POST", url: "/v1/tenants/acme/books/gl/journals", headers: H, payload: {
      txnDate: "2026-10-01", narration: "Capital introduced",
      lines: [{ accountId: "BANK", debit: "10,00,000" }, { accountId: "CAPITAL", credit: "10,00,000" }] } });
    expect(ok.statusCode).toBe(201);
    const bad = await app.inject({ method: "POST", url: "/v1/tenants/acme/books/gl/journals", headers: H, payload: {
      txnDate: "2026-10-01", narration: "oops", lines: [{ accountId: "BANK", debit: "100" }, { accountId: "CAPITAL", credit: "99" }] } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe("unbalanced");
  });

  it("accepts a statement asynchronously and exposes the resulting drafts and reports", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/tenants/acme/books/gl/statements", headers: { ...H, "content-type": "text/csv" },
      payload: "Date,Narration,Withdrawal Amt,Deposit Amt\n02/10/2026,UPI/DR/1/AWS/aws@axisbank,3480.50,\n" });
    expect(r.statusCode).toBe(202);
    await cell.settle();
    const drafts = (await app.inject({ method: "GET", url: "/v1/tenants/acme/drafts", headers: H })).json();
    expect(drafts).toHaveLength(1);
    const appr = await app.inject({ method: "POST", url: `/v1/tenants/acme/drafts/${drafts[0].draft_id}/approve`, headers: H, payload: {} });
    expect(appr.statusCode).toBe(202);
    await cell.settle();
    const tb = (await app.inject({ method: "GET", url: "/v1/tenants/acme/books/gl/reports/trial-balance", headers: H })).json();
    expect(tb.totals["Difference (must be 0)"]).toBe("0");
    expect(tb.unit).toBe("paise");
    const v = (await app.inject({ method: "GET", url: "/v1/tenants/acme/books/gl/verify", headers: H })).json();
    expect(v.intact).toBe(true);
  });

  it("explains a chat line it cannot read", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/tenants/acme/books/gl/chat", headers: H, payload: { text: "how am I doing?" } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("not_understood");
  });

  it("reports health and readiness", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).json().ok).toBe(true);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });
});
