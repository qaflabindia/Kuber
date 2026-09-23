/**
 * Core HTTP API. Commands are validated at the edge with Zod, then handed to the owning module.
 * Ingestion is asynchronous (202 Accepted): results arrive as events and read models.
 *
 * Authentication, phase 0: the SvelteKit backend-for-frontend terminates passkey sign-in and
 * forwards `x-kuber-tenant` and `x-kuber-principal` over mutual TLS. This server trusts those
 * headers only from the BFF; signed high-risk commands (section 16.4) are verified there.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { Account, IsoDate, Principal, parseAmount, uuid, type Line } from "@kuber/contracts";
import { ConcurrencyError } from "@kuber/eventstore";
import { DomainError } from "@kuber/gl";
import { AgentError } from "@kuber/agent";
import { OpsError } from "@kuber/ops";
import type { Cell } from "./cell.ts";
import { Copilot } from "./copilot/index.ts";
import { HELP } from "./copilot/router.ts";
import { registerMcp } from "./mcp.ts";
import type { Who } from "./tools.ts";

export interface ServerOptions { copilot?: Copilot; mcpGrants?: Map<string, Who>; clock?: () => string; https?: { key: Buffer; cert: Buffer } }

const today = () => new Date().toISOString().slice(0, 10);

const ApiLine = z.object({
  accountId: z.string(), debit: z.string().optional(), credit: z.string().optional(),
  partyId: z.string().optional(), dimensions: z.record(z.string(), z.string()).optional(),
}).refine((l) => !!l.debit !== !!l.credit, "each line needs exactly one of debit or credit");

const toLine = (l: z.infer<typeof ApiLine>): Line => ({
  accountId: l.accountId, amount: (l.debit ? parseAmount(l.debit) : -parseAmount(l.credit!)).toString(),
  ...(l.partyId ? { partyId: l.partyId } : {}), dimensions: l.dimensions ?? {},
});

export function buildServer(cell: Cell, opts: ServerOptions = {}): FastifyInstance {
  // Fastify's overloads differ for http and https; the instance API used below is the same.
  const app = (opts.https
    ? Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, https: { ...opts.https, minVersion: "TLSv1.2" } })
    : Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 })) as unknown as FastifyInstance;
  const clock = opts.clock ?? (() => new Date().toISOString().slice(0, 10));
  const copilot = opts.copilot ?? new Copilot(cell, null, null, clock);
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_req, body, done) => done(null, body));

  const who = (req: FastifyRequest<{ Params: { tenant: string } }>) => {
    const tenant = req.headers["x-kuber-tenant"], principal = req.headers["x-kuber-principal"];
    if (typeof tenant !== "string" || tenant !== req.params.tenant) throw Object.assign(new Error("tenant header missing or does not match the path"), { statusCode: 403 });
    return { tenant, principal: Principal.parse(principal) };
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof DomainError) return reply.code(422).send({ error: err.code, message: err.message });
    if (err instanceof AgentError) return reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.code, message: err.message });
    if (err instanceof OpsError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ConcurrencyError) return reply.code(409).send({ error: "conflict", message: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) console.error(err);
    return reply.code(status).send({ error: status >= 500 ? "internal" : "bad_request", message: status >= 500 ? "internal error" : (err as Error).message });
  });

  app.get("/healthz", async () => ({ ok: true, cell: cell.cellId }));
  app.get("/readyz", async () => { await cell.sql`SELECT 1`; return { ok: true }; });

  type P = { Params: { tenant: string; book: string } };

  app.post<P>("/v1/tenants/:tenant/books", async (req, reply) => {
    const { tenant, principal } = who(req);
    const b = z.object({ bookId: z.string(), entityId: z.string(), entityType: z.enum(["individual", "household", "freelancer", "company"]) }).parse(req.body);
    const ev = await cell.gl.openBook(tenant, b.bookId, b.entityId, b.entityType, principal);
    return reply.code(201).send({ events: ev.map((e) => e.type) });
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/accounts", async (req, reply) => {
    const { tenant, principal } = who(req);
    const account = Account.parse(req.body);
    await cell.gl.execute(tenant, req.params.book, { kind: "AddAccount", account }, { principal });
    return reply.code(201).send({ accountId: account.accountId });
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/journals", async (req, reply) => {
    const { tenant, principal } = who(req);
    const b = z.object({ txnDate: IsoDate, narration: z.string().min(1), voucherType: z.string().default("journal"), lines: z.array(ApiLine).min(2) }).parse(req.body);
    const journalId = uuid();
    const ev = await cell.gl.execute(tenant, req.params.book, { kind: "PostJournal", journalId, txnDate: b.txnDate, narration: b.narration,
      voucherType: b.voucherType, lines: b.lines.map(toLine), autonomy: "human" }, { principal });
    return reply.code(201).send({ journalId, seq: (ev[0]?.data as { seq?: number } | undefined)?.seq });
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/opening-balances", async (req, reply) => {
    const { tenant, principal } = who(req);
    const b = z.object({ accountId: z.string(), amount: z.string(), asOf: IsoDate }).parse(req.body);
    const st = await cell.gl.state(tenant, req.params.book);
    const acc = st.accounts.get(b.accountId);
    if (!acc) throw new DomainError("no_account", `unknown account ${b.accountId}`);
    const p = parseAmount(b.amount), signed = acc.nature === "asset" ? p : -p;
    const journalId = uuid();
    await cell.gl.execute(tenant, req.params.book, { kind: "PostJournal", journalId, txnDate: b.asOf, narration: `Opening balance declared: ${b.accountId}`,
      voucherType: "opening", autonomy: "human",
      lines: [{ accountId: b.accountId, amount: signed.toString(), dimensions: {} }, { accountId: "OPENING", amount: (-signed).toString(), dimensions: {} }] }, { principal });
    return reply.code(201).send({ journalId });
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/locks", async (req, reply) => {
    const { tenant, principal } = who(req);
    const b = z.object({ periodEnd: IsoDate, level: z.enum(["soft", "hard"]) }).parse(req.body);
    await cell.gl.execute(tenant, req.params.book, { kind: "LockPeriod", ...b }, { principal });
    return reply.code(201).send({ locked: b });
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/statements", async (req, reply) => {
    const { tenant, principal } = who(req);
    const csv = typeof req.body === "string" ? req.body : z.object({ csv: z.string() }).parse(req.body).csv;
    const instrument = (req.query as { instrument?: string }).instrument ?? "BANK";
    const r = await cell.channels.submitStatement(tenant, req.params.book, csv, principal, instrument);
    return reply.code(r.duplicate ? 200 : 202).send(r);
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/chat", async (req, reply) => {
    const { tenant, principal } = who(req);
    const b = z.object({ text: z.string().min(1).max(500), on: IsoDate.optional() }).parse(req.body);
    const r = await cell.channels.submitChat(tenant, req.params.book, b.text, principal, b.on ?? today());
    if (!r) return reply.code(422).send({ error: "not_understood", message: "Could not read an amount and direction from that text." });
    return reply.code(202).send(r);
  });

  type T = { Params: { tenant: string; id: string } };
  app.get<P>("/v1/tenants/:tenant/drafts", async (req) => { const { tenant } = who(req); return cell.agent.queue(tenant); });
  app.post<T>("/v1/tenants/:tenant/drafts/:id/approve", async (req, reply) => {
    const { tenant, principal } = who(req);
    const b = z.object({ accountId: z.string().optional() }).parse(req.body ?? {});
    return reply.code(202).send(await cell.agent.approveDraft(tenant, req.params.id, principal, b.accountId));
  });
  app.post<T>("/v1/tenants/:tenant/drafts/:id/reject", async (req, reply) => {
    const { tenant, principal } = who(req);
    const b = z.object({ reason: z.string().min(1) }).parse(req.body);
    await cell.agent.rejectDraft(tenant, req.params.id, principal, b.reason);
    return reply.code(204).send();
  });
  // Evidence (design 14.7): look up by any id or hash a record cites, or fetch one record.
  app.get<{ Params: { tenant: string }; Querystring: { q?: string } }>("/v1/tenants/:tenant/evidence", async (req, reply) => {
    const { tenant } = who(req);
    const q = z.string().min(1).max(200).parse(req.query.q);
    return reply.send(await cell.evidence.find(tenant, q));
  });
  app.get<T>("/v1/tenants/:tenant/evidence/:id", async (req, reply) => {
    const { tenant } = who(req);
    const e = await cell.evidence.get(tenant, req.params.id);
    return e ? reply.send(e) : reply.code(404).send({ error: "not_found", message: `no evidence ${req.params.id}` });
  });
  app.get<P>("/v1/tenants/:tenant/ratifications", async (req) => { const { tenant } = who(req); return cell.agent.openRatifications(tenant); });
  app.post<T>("/v1/tenants/:tenant/journals/:id/ratify", async (req, reply) => {
    const { tenant, principal } = who(req);
    await cell.agent.ratify(tenant, req.params.id, principal);
    return reply.code(204).send();
  });
  app.post<T>("/v1/tenants/:tenant/journals/:id/correct", async (req, reply) => {
    const { tenant, principal } = who(req);
    const b = z.object({ toAccount: z.string(), learn: z.boolean().default(false) }).parse(req.body);
    return reply.code(202).send(await cell.agent.correct(tenant, req.params.id, b.toAccount, principal, { learn: b.learn }));
  });
  app.post<P>("/v1/tenants/:tenant/rules", async (req, reply) => {
    const { tenant, principal } = who(req);
    const b = z.object({ pattern: z.string().min(2), accountId: z.string() }).parse(req.body);
    await cell.agent.addRule(tenant, b.pattern, b.accountId, principal);
    return reply.code(201).send(b);
  });

  const money = (s: { title: string; rows: { label: string; amount: bigint; accountId?: string; section?: string }[]; totals: Record<string, bigint> }) => ({
    title: s.title, rows: s.rows.map((r) => ({ label: r.label, amount: r.amount.toString(), ...(r.accountId ? { accountId: r.accountId } : {}), ...(r.section ? { section: r.section } : {}) })),
    totals: Object.fromEntries(Object.entries(s.totals).map(([k, v]) => [k, v.toString()])), unit: "paise",
  });
  type R = { Params: { tenant: string; book: string }; Querystring: { asOf?: string; from?: string; to?: string; account?: string } };
  app.get<R>("/v1/tenants/:tenant/books/:book/reports/trial-balance", async (req) => money(await cell.reporting.trialBalance(who(req).tenant, req.params.book, req.query.asOf ?? null)));
  app.get<R>("/v1/tenants/:tenant/books/:book/reports/profit-and-loss", async (req) => money(await cell.reporting.profitAndLoss(who(req).tenant, req.params.book, req.query.from ?? null, req.query.to ?? null)));
  app.get<R>("/v1/tenants/:tenant/books/:book/reports/balance-sheet", async (req) => money(await cell.reporting.balanceSheet(who(req).tenant, req.params.book, req.query.asOf ?? null)));
  app.get<R>("/v1/tenants/:tenant/books/:book/reports/statement-of-affairs", async (req) => {
    const q = z.object({ from: IsoDate, to: IsoDate }).parse(req.query);
    return money(await cell.reporting.statementOfAffairs(who(req).tenant, req.params.book, q.from, q.to));
  });
  app.get<R>("/v1/tenants/:tenant/books/:book/accounts/:account/lines", async (req) => {
    const { account } = req.params as unknown as { account: string };
    return cell.reporting.drill(who(req).tenant, req.params.book, account, req.query.from ?? null, req.query.to ?? null);
  });
  app.get<P>("/v1/tenants/:tenant/books", async (req) => cell.reporting.books(who(req).tenant));
  app.get<P>("/v1/tenants/:tenant/books/:book/accounts", async (req) => cell.reporting.accounts(who(req).tenant, req.params.book));
  app.get<R>("/v1/tenants/:tenant/books/:book/journals", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 20);
    return cell.reporting.recentJournals(who(req).tenant, req.params.book, Number.isFinite(limit) ? limit : 20);
  });
  // ------------------------------------------------------------ copilot and MCP
  app.get<P>("/v1/tenants/:tenant/copilot", async (req) => { who(req); return { engine: copilot.engine, suggestions: HELP }; });
  app.post<P>("/v1/tenants/:tenant/books/:book/copilot", async (req) => {
    const { tenant, principal } = who(req);
    const b = z.object({ text: z.string().min(1).max(2000), history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(20).default([]) }).parse(req.body);
    return copilot.ask({ tenant, book: req.params.book, principal }, b.text, b.history);
  });
  if (opts.mcpGrants?.size) registerMcp(app, cell, opts.mcpGrants);

  // ------------------------------------------------------------ operations: simulate, then commit
  app.get<P>("/v1/tenants/:tenant/ops", async (req) => { who(req); return cell.ops.list(); });
  app.post<{ Params: { tenant: string; book: string; op: string } }>("/v1/tenants/:tenant/books/:book/ops/:op", async (req) => {
    const { tenant, principal } = who(req);
    return cell.ops.plan(tenant, req.params.book, principal, req.params.op, req.body ?? {});
  });
  app.get<P>("/v1/tenants/:tenant/books/:book/plans", async (req) => { const { tenant } = who(req); return cell.ops.pending(tenant, req.params.book); });
  app.get<T>("/v1/tenants/:tenant/plans/:id", async (req) => { const { tenant } = who(req); return cell.ops.get(tenant, req.params.id); });
  app.post<T>("/v1/tenants/:tenant/plans/:id/commit", async (req, reply) => {
    const { tenant, principal } = who(req);
    const b = z.object({ hash: z.string().length(64) }).parse(req.body);
    const r = await cell.ops.commit(tenant, req.params.id, principal, b.hash);
    return reply.code(r.status === "committed" ? 200 : 202).send(r);
  });
  app.post<T>("/v1/tenants/:tenant/plans/:id/discard", async (req) => { const { tenant, principal } = who(req); return cell.ops.discard(tenant, req.params.id, principal); });

  app.get<P>("/v1/tenants/:tenant/books/:book/verify", async (req) => {
    const broken = await cell.gl.verify(who(req).tenant, req.params.book);
    return { intact: broken === null, firstBrokenJournal: broken };
  });

  return app;
}
