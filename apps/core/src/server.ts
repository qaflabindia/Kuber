/**
 * Core HTTP API. Commands are validated at the edge with Zod, then handed to the owning module.
 * Ingestion is asynchronous (202 Accepted): results arrive as events and read models.
 *
 * Authentication (F01): identity headers are not trusted. The backend-for-frontend signs every
 * request with a short-lived assertion (@kuber/auth: HMAC over method, path, body hash, tenant,
 * principal, time and nonce, keyed by CORE_AUTH_SECRET); requests that are unsigned, altered,
 * stale or replayed are refused with 401 before any handler runs. The asserted principal must
 * then be an active member of the tenant (identity module), and each route names the action it
 * performs, checked against the member's role and book scope (F02); operations additionally pass
 * the ops guard (maker-checker). Passkey ceremonies run here too: the core holds the credentials.
 */
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { AUTH_HEADER, AuthError, ReplayCache, authKey, verifyRequest, type Claims } from "@kuber/auth";
import { AccessDenied, IdentityError, inScope, type Action, type Member } from "@kuber/identity";
import { z, ZodError } from "zod";
import { Account, IsoDate, Principal, parseAmount, uuid, type Line } from "@kuber/contracts";
import { CommandConflict, ConcurrencyError } from "@kuber/eventstore";
import { DomainError, type BookCommand } from "@kuber/gl";
import { AgentError } from "@kuber/agent";
import { OpsError } from "@kuber/ops";
import { StaleReportError, type ReportBasis, type ReportOptions } from "@kuber/reporting";
import { IngestionError } from "@kuber/channels";
import type { Cell } from "./cell.ts";
import { Copilot } from "./copilot/index.ts";
import { HELP } from "./copilot/router.ts";
import { registerMcp } from "./mcp.ts";
import type { Who } from "./tools.ts";

export interface ServerOptions {
  copilot?: Copilot; mcpGrants?: Map<string, Who>; clock?: () => string; https?: { key: Buffer; cert: Buffer };
  /** Shared secret with the BFF (CORE_AUTH_SECRET). Without it every /v1 request is refused. */
  auth?: { secret: string | Buffer; issuers?: string[] };
}

/** A client's idempotency key: opaque, bounded, printable. */
const CommandKey = z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/, "printable ASCII, no spaces");

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

  // ---------------------------------------------------------------- authentication (F01)
  const key = opts.auth ? authKey(opts.auth.secret) : null;
  const replay = new ReplayCache();
  const rawBodies = new WeakMap<FastifyRequest, Buffer>(), claimsOf = new WeakMap<FastifyRequest, Claims>();
  const signed = (url: string) => url.startsWith("/v1/");
  // Keep the exact body bytes: the assertion covers their hash, not a re-serialization.
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (!signed(req.url)) return payload;
    const chunks: Buffer[] = [];
    for await (const c of payload) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    rawBodies.set(req, raw);
    const again = Readable.from([raw]) as Readable & { receivedEncodedLength?: number };
    again.receivedEncodedLength = raw.length;
    return again;
  });
  app.addHook("preHandler", async (req) => {
    if (!signed(req.url)) return;
    if (!key) throw new AuthError("unauthenticated", "core request authentication is not configured (CORE_AUTH_SECRET)");
    const c = verifyRequest(key, replay, { header: req.headers[AUTH_HEADER], method: req.method, path: req.url, body: rawBodies.get(req) ?? null, issuers: opts.auth?.issuers });
    const tenant = (req.params as { tenant?: string }).tenant;
    if (tenant === undefined || c.tenant !== tenant) throw new AccessDenied("the assertion is for another workspace");
    claimsOf.set(req, c);
  });
  const pruner = setInterval(() => replay.prune(), 60_000);
  pruner.unref();
  app.addHook("onClose", async () => clearInterval(pruner));

  /**
   * The authenticated principal, authorized for `action`: an active member whose role allows it,
   * within book scope (the route's :book unless given; `allBooks` for tenant-wide resources).
   */
  const who = async (req: FastifyRequest, action: Action, scope: { book?: string; allBooks?: boolean } = {}) => {
    const c = claimsOf.get(req);
    if (!c?.tenant) throw new AuthError("unauthenticated", "request is not authenticated");
    if (!c.principal) throw new AuthError("unauthenticated", "this request needs a signed-in person");
    const principal = Principal.parse(c.principal);
    const book = scope.book ?? (req.params as { book?: string }).book;
    const member = await cell.identity.authorize(c.tenant, principal, action, { ...scope, ...(book !== undefined ? { book } : {}) });
    return { tenant: c.tenant, principal, member };
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return reply.code(401).send({ error: err.code, message: err.message });
    if (err instanceof AccessDenied) return reply.code(403).send({ error: "forbidden", message: err.message });
    if (err instanceof IdentityError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof DomainError) return reply.code(422).send({ error: err.code, message: err.message });
    if (err instanceof AgentError) return reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.code, message: err.message });
    if (err instanceof IngestionError) return reply.code(422).send({ error: err.code, message: err.message, detail: err.detail });
    if (err instanceof OpsError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ConcurrencyError) return reply.code(409).send({ error: "conflict", message: err.message });
    if (err instanceof StaleReportError) return reply.code(409).send({ error: err.code, message: err.message, basis: err.basis });
    if (err instanceof CommandConflict) return reply.code(409).send({ error: "idempotency_conflict", message: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) console.error(err);
    return reply.code(status).send({ error: status >= 500 ? "internal" : "bad_request", message: status >= 500 ? "internal error" : (err as Error).message });
  });

  app.get("/healthz", async () => ({ ok: true, cell: cell.cellId }));
  app.get("/readyz", async () => { await cell.sql`SELECT 1`; return { ok: true }; });

  type P = { Params: { tenant: string; book: string } };

  app.post<P>("/v1/tenants/:tenant/books", async (req, reply) => {
    const { tenant, principal } = await who(req, "book.open", { allBooks: true });
    const b = z.object({ bookId: z.string(), entityId: z.string(), entityType: z.enum(["individual", "household", "freelancer", "company"]) }).parse(req.body);
    const ev = await cell.gl.openBook(tenant, b.bookId, b.entityId, b.entityType, principal);
    return reply.code(201).send({ events: ev.map((e) => e.type) });
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/accounts", async (req, reply) => {
    const { tenant, principal } = await who(req, "account.add");
    const account = Account.parse(req.body);
    await cell.gl.execute(tenant, req.params.book, { kind: "AddAccount", account }, { principal });
    return reply.code(201).send({ accountId: account.accountId });
  });

  // Journal-creating commands are idempotent when the client names them (F04): an Idempotency-Key
  // header or a commandId in the body. A retry with the same key and request returns the first
  // result (Idempotent-Replayed: true) without posting again; the same key for a different request is 409.
  const postOnce = async (req: FastifyRequest<P>, reply: FastifyReply, scope: string, principal: string, body: { commandId?: string },
                          cmd: Extract<BookCommand, { kind: "PostJournal" }>) => {
    const tenant = req.params.tenant, book = req.params.book;
    const header = req.headers["idempotency-key"];
    const key = CommandKey.optional().parse(typeof header === "string" ? header : undefined);
    if (key && body.commandId && key !== body.commandId) throw Object.assign(new Error("Idempotency-Key and commandId differ"), { statusCode: 400 });
    const commandId = key ?? body.commandId;
    const shape = (ev: { data: unknown }[]) => ({ journalId: cmd.journalId, seq: (ev[0]?.data as { seq?: number } | undefined)?.seq });
    if (!commandId) return reply.code(201).send(shape(await cell.gl.execute(tenant, book, cmd, { principal })));
    // The journal id is incidental to the request, so it is left out of what must match.
    const { journalId: _incidental, ...request } = cmd;
    const r = await cell.gl.executeOnce(tenant, book, { scope, commandId, request: { principal, ...request } }, cmd, { principal }, shape);
    return reply.code(201).header("idempotent-replayed", String(r.replayed)).send(r.result);
  };

  app.post<P>("/v1/tenants/:tenant/books/:book/journals", async (req, reply) => {
    const { principal } = await who(req, "journal.post");
    const b = z.object({ txnDate: IsoDate, narration: z.string().min(1), voucherType: z.string().default("journal"), lines: z.array(ApiLine).min(2),
      commandId: CommandKey.optional() }).parse(req.body);
    return postOnce(req, reply, "journals", principal, b, { kind: "PostJournal", journalId: uuid(), txnDate: b.txnDate, narration: b.narration,
      voucherType: b.voucherType, lines: b.lines.map(toLine), autonomy: "human" });
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/opening-balances", async (req, reply) => {
    const { tenant, principal } = await who(req, "journal.post");
    const b = z.object({ accountId: z.string(), amount: z.string(), asOf: IsoDate, commandId: CommandKey.optional() }).parse(req.body);
    const st = await cell.gl.state(tenant, req.params.book);
    const acc = st.accounts.get(b.accountId);
    if (!acc) throw new DomainError("no_account", `unknown account ${b.accountId}`);
    const p = parseAmount(b.amount), signed = acc.nature === "asset" ? p : -p;
    return postOnce(req, reply, "opening-balances", principal, b, { kind: "PostJournal", journalId: uuid(), txnDate: b.asOf,
      narration: `Opening balance declared: ${b.accountId}`, voucherType: "opening", autonomy: "human",
      lines: [{ accountId: b.accountId, amount: signed.toString(), dimensions: {} }, { accountId: "OPENING", amount: (-signed).toString(), dimensions: {} }] });
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/locks", async (req, reply) => {
    const { tenant, principal } = await who(req, "period.lock");
    const b = z.object({ periodEnd: IsoDate, level: z.enum(["soft", "hard"]) }).parse(req.body);
    await cell.gl.execute(tenant, req.params.book, { kind: "LockPeriod", ...b }, { principal });
    return reply.code(201).send({ locked: b });
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/statements", async (req, reply) => {
    const { tenant, principal } = await who(req, "capture");
    const b = typeof req.body === "string" ? { csv: req.body } : z.object({ csv: z.string(),
      declared: z.object({ opening: z.string(), closing: z.string(), debits: z.string(), credits: z.string(), count: z.number().int() }).partial().optional(),
      allowUnreconciled: z.boolean().optional() }).parse(req.body);
    const instrument = (req.query as { instrument?: string }).instrument ?? "BANK";
    const r = await cell.channels.submitStatement(tenant, req.params.book, b.csv, principal, { instrument, declared: b.declared, allowUnreconciled: b.allowUnreconciled });
    return reply.code(r.duplicate ? 200 : 202).send(r);
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/chat", async (req, reply) => {
    const { tenant, principal } = await who(req, "capture");
    const b = z.object({ text: z.string().min(1).max(500), on: IsoDate.optional() }).parse(req.body);
    const r = await cell.channels.submitChat(tenant, req.params.book, b.text, principal, b.on ?? today());
    if (!r) return reply.code(422).send({ error: "not_understood", message: "Could not read an amount and direction from that text." });
    return reply.code(202).send(r);
  });

  type T = { Params: { tenant: string; id: string } };
  // Open-work lists are keyset pages (F11): ?limit=&after= (plans: &before=); the next cursor is in x-next-cursor.
  type PageQ = { limit?: string; after?: string; before?: string; book?: string };
  const pageOf = (q: PageQ) => ({ limit: q.limit !== undefined && Number.isFinite(Number(q.limit)) ? Number(q.limit) : undefined, after: q.after || undefined });
  // A book-scoped member lists one of their books (?book=, or their only book); others may list all.
  const listBook = (member: Member, book: string | undefined) => {
    if (member.books === null) return book || undefined;
    const b = book || (member.books.length === 1 ? member.books[0] : undefined);
    if (!b || !inScope(member, b)) throw new AccessDenied(`choose one of your books: ${member.books.join(", ")}`);
    return b;
  };
  app.get<P>("/v1/tenants/:tenant/drafts", async (req, reply) => {
    const q = req.query as PageQ;
    const { tenant, member } = await who(req, "read");
    const p = await cell.agent.queuePage(tenant, { ...pageOf(q), bookId: listBook(member, q.book) });
    if (p.next) reply.header("x-next-cursor", p.next);
    return p.items;
  });
  app.get<P>("/v1/tenants/:tenant/books/:book/attention", async (req) => {
    const { tenant, member } = await who(req, "read");
    const tenantWide = member.books === null;
    const [d, ratifications, plans] = await Promise.all([cell.agent.queueCounts(tenant, tenantWide ? undefined : req.params.book),
      tenantWide ? cell.agent.openRatificationCount(tenant) : Promise.resolve(0), cell.ops.pendingCount(tenant, req.params.book)]);
    return { drafts: d.open, awaitingApproval: d.awaitingApproval, ratifications, plans };
  });
  // Decisions on one draft or match review: a book-scoped member only within their books.
  const itemInScope = async (tenant: string, member: Member, table: "drafts" | "match_reviews", id: string) => {
    if (member.books === null) return;
    const [r] = await cell.store.tenantTx(tenant, (tx) => table === "drafts"
      ? tx<{ book_id: string }[]>`SELECT book_id FROM agent.drafts WHERE tenant_id = ${tenant} AND draft_id = ${id}`
      : tx<{ book_id: string }[]>`SELECT book_id FROM agent.match_reviews WHERE tenant_id = ${tenant} AND review_id = ${id}`);
    if (!r || !inScope(member, r.book_id)) throw new AccessDenied(`${id} is outside your books`);
  };
  const draftInScope = (tenant: string, member: Member, id: string) => itemInScope(tenant, member, "drafts", id);
  app.post<T>("/v1/tenants/:tenant/drafts/:id/approve", async (req, reply) => {
    const { tenant, principal, member } = await who(req, "draft.decide");
    await draftInScope(tenant, member, req.params.id);
    const b = z.object({ accountId: z.string().optional() }).parse(req.body ?? {});
    return reply.code(202).send(await cell.agent.approveDraft(tenant, req.params.id, principal, b.accountId));
  });
  app.post<T>("/v1/tenants/:tenant/drafts/:id/reject", async (req, reply) => {
    const { tenant, principal, member } = await who(req, "draft.decide");
    await draftInScope(tenant, member, req.params.id);
    const b = z.object({ reason: z.string().min(1) }).parse(req.body);
    await cell.agent.rejectDraft(tenant, req.params.id, principal, b.reason);
    return reply.code(204).send();
  });
  // Source originals (F18): the retained, sealed upload behind a signal, with its hash re-verified.
  app.get<T>("/v1/tenants/:tenant/signals/:id/original", async (req, reply) => {
    const { tenant } = await who(req, "read", { allBooks: true });              // auditors may read originals
    const o = await cell.channels.original(tenant, req.params.id);
    return o ? reply.send(o) : reply.code(404).send({ error: "not_found", message: `no signal ${req.params.id}` });
  });
  // Statement lines that may be a provisional entry already in the books: a person links or separates them.
  app.get<P>("/v1/tenants/:tenant/match-reviews", async (req) => {
    const { tenant, member } = await who(req, "read");
    return (await cell.agent.openMatchReviews(tenant)).filter((r) => inScope(member, r.book_id));
  });
  app.post<T>("/v1/tenants/:tenant/match-reviews/:id/resolve", async (req, reply) => {
    const { tenant, principal, member } = await who(req, "draft.decide");      // linking a line to a posted entry is a review decision
    await itemInScope(tenant, member, "match_reviews", req.params.id);
    const b = z.object({ journalId: z.string().nullable() }).parse(req.body);
    return reply.code(202).send(await cell.agent.resolveMatch(tenant, req.params.id, principal, b.journalId));
  });
  // Evidence (design 14.7): look up by any id or hash a record cites, or fetch one record.
  app.get<{ Params: { tenant: string }; Querystring: { q?: string } }>("/v1/tenants/:tenant/evidence", async (req, reply) => {
    const { tenant } = await who(req, "read", { allBooks: true });
    const q = z.string().min(1).max(200).parse(req.query.q);
    return reply.send(await cell.evidence.find(tenant, q));
  });
  app.get<T>("/v1/tenants/:tenant/evidence/:id", async (req, reply) => {
    const { tenant } = await who(req, "read", { allBooks: true });
    const e = await cell.evidence.get(tenant, req.params.id);
    return e ? reply.send(e) : reply.code(404).send({ error: "not_found", message: `no evidence ${req.params.id}` });
  });
  app.get<P>("/v1/tenants/:tenant/ratifications", async (req, reply) => {
    const { tenant } = await who(req, "read", { allBooks: true });
    const p = await cell.agent.ratificationsPage(tenant, pageOf(req.query as PageQ));
    if (p.next) reply.header("x-next-cursor", p.next);
    return p.items;
  });
  app.post<T>("/v1/tenants/:tenant/journals/:id/ratify", async (req, reply) => {
    const { tenant, principal } = await who(req, "journal.ratify", { allBooks: true });
    await cell.agent.ratify(tenant, req.params.id, principal);
    return reply.code(204).send();
  });
  app.post<T>("/v1/tenants/:tenant/journals/:id/correct", async (req, reply) => {
    const { tenant, principal } = await who(req, "journal.ratify", { allBooks: true });
    const b = z.object({ toAccount: z.string(), learn: z.boolean().default(false) }).parse(req.body);
    return reply.code(202).send(await cell.agent.correct(tenant, req.params.id, b.toAccount, principal, { learn: b.learn }));
  });
  app.post<P>("/v1/tenants/:tenant/rules", async (req, reply) => {
    const { tenant, principal } = await who(req, "rules.manage", { allBooks: true });
    const b = z.object({ pattern: z.string().min(2), accountId: z.string() }).parse(req.body);
    await cell.agent.addRule(tenant, b.pattern, b.accountId, principal);
    return reply.code(201).send(b);
  });

  const money = (s: { title: string; rows: { label: string; amount: bigint; accountId?: string; section?: string }[]; totals: Record<string, bigint>; basis?: ReportBasis }) => ({
    title: s.title, rows: s.rows.map((r) => ({ label: r.label, amount: r.amount.toString(), ...(r.accountId ? { accountId: r.accountId } : {}), ...(r.section ? { section: r.section } : {}) })),
    totals: Object.fromEntries(Object.entries(s.totals).map(([k, v]) => [k, v.toString()])), unit: "paise", ...(s.basis ? { basis: s.basis } : {}),
  });
  type R = { Params: { tenant: string; book: string }; Querystring: { asOf?: string; from?: string; to?: string; account?: string; fresh?: string; timeoutMs?: string } };
  // Report dates are calendar dates too (F08): an impossible one is a 400, not a database error.
  const dates = (q: unknown) => z.object({ asOf: IsoDate.optional(), from: IsoDate.optional(), to: IsoDate.optional() }).parse(q);
  // ?fresh=require refuses a projection that is behind the ledger (409 with the basis); ?fresh=wait waits up to timeoutMs (max 30 s).
  const fresh = (req: FastifyRequest<R>): ReportOptions => {
    const q = z.object({ fresh: z.enum(["any", "require", "wait"]).optional(), timeoutMs: z.coerce.number().int().min(0).max(30_000).optional() }).parse(req.query);
    return { freshness: q.fresh ?? "any", timeoutMs: q.timeoutMs ?? 5_000 };
  };
  const reader = async (req: FastifyRequest) => (await who(req, "read")).tenant;
  app.get<R>("/v1/tenants/:tenant/books/:book/reports/trial-balance", async (req) => money(await cell.reporting.trialBalance(await reader(req), req.params.book, dates(req.query).asOf ?? null, fresh(req))));
  app.get<R>("/v1/tenants/:tenant/books/:book/reports/profit-and-loss", async (req) => { const t = await reader(req); const q = dates(req.query); return money(await cell.reporting.profitAndLoss(t, req.params.book, q.from ?? null, q.to ?? null, fresh(req))); });
  app.get<R>("/v1/tenants/:tenant/books/:book/reports/balance-sheet", async (req) => money(await cell.reporting.balanceSheet(await reader(req), req.params.book, dates(req.query).asOf ?? null, fresh(req))));
  app.get<R>("/v1/tenants/:tenant/books/:book/reports/statement-of-affairs", async (req) => {
    const t = await reader(req);
    const q = z.object({ from: IsoDate, to: IsoDate }).parse(req.query);
    return money(await cell.reporting.statementOfAffairs(t, req.params.book, q.from, q.to, 0n, 0n, fresh(req)));
  });
  app.get<R>("/v1/tenants/:tenant/books/:book/accounts/:account/lines", async (req, reply) => {
    const { account } = req.params as unknown as { account: string };
    const t = await reader(req);
    const q = dates(req.query);
    const p = await cell.reporting.drillPage(t, req.params.book, account, q.from ?? null, q.to ?? null, pageOf(req.query as PageQ));
    if (p.next) reply.header("x-next-cursor", p.next);
    return p.items;
  });
  app.get<P>("/v1/tenants/:tenant/books", async (req) => {
    const { tenant, member } = await who(req, "read");
    return (await cell.reporting.books(tenant) as unknown as { book_id: string }[]).filter((b) => inScope(member, b.book_id));
  });
  app.get<P>("/v1/tenants/:tenant/books/:book/accounts", async (req) => cell.reporting.accounts((await who(req, "read")).tenant, req.params.book));
  app.get<R>("/v1/tenants/:tenant/books/:book/journals", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 20);
    return cell.reporting.recentJournals((await who(req, "read")).tenant, req.params.book, Number.isFinite(limit) ? limit : 20);
  });
  // ------------------------------------------------------------ copilot and MCP
  app.get<P>("/v1/tenants/:tenant/copilot", async (req) => { await who(req, "read"); return { engine: copilot.engine, suggestions: HELP }; });
  app.post<P>("/v1/tenants/:tenant/books/:book/copilot", async (req) => {
    const { tenant, principal } = await who(req, "copilot");
    const b = z.object({ text: z.string().min(1).max(2000), history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(20).default([]) }).parse(req.body);
    return copilot.ask({ tenant, book: req.params.book, principal }, b.text, b.history);
  });
  if (opts.mcpGrants?.size) registerMcp(app, cell, opts.mcpGrants);

  // ------------------------------------------------------------ identity: passkeys and members
  // Ceremonies are signed by the BFF without a principal (nobody is signed in yet); the passkey
  // itself is verified here against the credentials the core holds.
  const ceremony = (req: FastifyRequest) => {
    const c = claimsOf.get(req);
    if (!c?.tenant) throw new AuthError("unauthenticated", "request is not authenticated");
    return c.tenant;
  };
  const Json = z.record(z.string(), z.unknown());
  app.post<P>("/v1/tenants/:tenant/identity/registration/options", async (req) => {
    const b = z.object({ displayName: z.string().min(2).max(80), enrolment: z.string().min(16).max(128).optional() }).parse(req.body);
    return cell.identity.registrationOptions(ceremony(req), b);
  });
  app.post<P>("/v1/tenants/:tenant/identity/registration/verify", async (req, reply) => {
    const b = z.object({ displayName: z.string().min(2).max(80), enrolment: z.string().min(16).max(128).optional(), response: Json }).parse(req.body);
    return reply.code(201).send(await cell.identity.register(ceremony(req), { ...b, response: b.response as never }));
  });
  app.post<P>("/v1/tenants/:tenant/identity/authentication/options", async (req) => cell.identity.authenticationOptions(ceremony(req)));
  app.post<P>("/v1/tenants/:tenant/identity/authentication/verify", async (req) => {
    const b = z.object({ response: Json }).parse(req.body);
    return cell.identity.authenticate(ceremony(req), { response: b.response as never });
  });
  app.post<P>("/v1/tenants/:tenant/identity/dev-signin", async (req) => {
    const b = z.object({ name: z.string().min(2).max(80) }).parse(req.body);
    return cell.identity.devSignIn(ceremony(req), b.name);
  });
  app.get<P>("/v1/tenants/:tenant/me", async (req) => (await who(req, "read")).member);
  app.get<P>("/v1/tenants/:tenant/members", async (req) => { const { tenant } = await who(req, "members.read", { allBooks: true }); return cell.identity.members(tenant); });
  app.post<P>("/v1/tenants/:tenant/members/invitations", async (req, reply) => {
    const { tenant, principal } = await who(req, "members.manage", { allBooks: true });
    const b = z.object({ role: z.enum(["owner", "controller", "preparer", "approver", "auditor", "member"]), displayName: z.string().min(2).max(80),
      books: z.array(z.string().min(1)).min(1).nullable().default(null), ttlHours: z.number().int().min(1).max(24 * 14).optional() }).parse(req.body);
    return reply.code(201).send(await cell.identity.invite(tenant, principal, b));
  });
  app.post<{ Params: { tenant: string; principal: string } }>("/v1/tenants/:tenant/members/:principal/revoke", async (req, reply) => {
    const { tenant, principal } = await who(req, "members.manage", { allBooks: true });
    await cell.identity.revoke(tenant, principal, req.params.principal);
    return reply.code(204).send();
  });
  app.get<P>("/v1/tenants/:tenant/settings/separation", async (req) => cell.identity.settings((await who(req, "read")).tenant));
  app.put<P>("/v1/tenants/:tenant/settings/separation", async (req) => {
    const { tenant, principal } = await who(req, "settings.manage", { allBooks: true });
    const b = z.object({ soloOwner: z.boolean(), sodLimitPaise: z.string().regex(/^\d+$/).nullable() }).parse(req.body);
    return cell.identity.setSettings(tenant, principal, b);
  });

  // ------------------------------------------------------------ operations: simulate, then commit
  app.get<P>("/v1/tenants/:tenant/ops", async (req) => { await who(req, "read"); return cell.ops.list(); });
  app.post<{ Params: { tenant: string; book: string; op: string } }>("/v1/tenants/:tenant/books/:book/ops/:op", async (req) => {
    // Membership and book here; role (prepare vs read) in the ops guard.
    const { tenant, principal } = await who(req, "read");
    return cell.ops.plan(tenant, req.params.book, principal, req.params.op, req.body ?? {});
  });
  app.get<P>("/v1/tenants/:tenant/books/:book/plans", async (req, reply) => {
    const { tenant } = await who(req, "read"); const q = req.query as PageQ;
    const p = await cell.ops.pendingPage(tenant, req.params.book, { limit: pageOf(q).limit, before: q.before || undefined });
    if (p.next) reply.header("x-next-cursor", p.next);
    return p.items;
  });
  app.get<T>("/v1/tenants/:tenant/plans/:id", async (req) => {
    const { tenant, member } = await who(req, "read");
    const p = await cell.ops.get(tenant, req.params.id);
    if (!inScope(member, p.bookId)) throw new AccessDenied(`plan ${req.params.id} is outside your books`);
    return p;
  });
  app.post<T>("/v1/tenants/:tenant/plans/:id/commit", async (req, reply) => {
    const { tenant, principal } = await who(req, "read");          // role, book and maker-checker: ops guard
    const b = z.object({ hash: z.string().length(64) }).parse(req.body);
    const r = await cell.ops.commit(tenant, req.params.id, principal, b.hash);
    return reply.code(r.status === "committed" ? 200 : 202).send(r);
  });
  app.post<T>("/v1/tenants/:tenant/plans/:id/discard", async (req) => { const { tenant, principal } = await who(req, "read"); return cell.ops.discard(tenant, req.params.id, principal); });

  app.get<P>("/v1/tenants/:tenant/books/:book/verify", async (req) => {
    const broken = await cell.gl.verify((await who(req, "read")).tenant, req.params.book);
    return { intact: broken === null, firstBrokenJournal: broken };
  });

  return app;
}
