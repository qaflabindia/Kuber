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
 *
 * Sessions: an assertion that names a principal must carry its web session id (sid); a session
 * revoked at sign-out (POST /v1/tenants/:tenant/sessions/revoke), or bound at sign-in to a passkey
 * that has since been revoked, is refused with 401. Nonces are claimed in the ReplayStore given
 * (shared Valkey with several instances; in-process by default).
 */
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { AUTH_HEADER, AuthError, ReplayCache, ReplayStoreUnavailable, authKey, verifyRequestAsync, type Claims, type ReplayStore } from "@kuber/auth";
import { ACTIONS, AccessDenied, IdentityError, LEGACY_ALIASES, PERSON_ROLES, can, inScope, type Action, type Member, type SigningIntent } from "@kuber/identity";
import type { CommandSignature, SignedAction } from "@kuber/contracts";
import type { TransactionSql } from "postgres";
import { z, ZodError } from "zod";
import { Account, BankDetails, BookPurpose, Id, IsoDate, PartyKind, PartyTerms, Principal, TaxStatus, parseAmount, uuid, type Line } from "@kuber/contracts";
import { CommandConflict, ConcurrencyError, GuardDenied } from "@kuber/eventstore";
import { DomainError, type BookCommand } from "@kuber/gl";
import { AgentError } from "@kuber/agent";
import { IncidentError, OpsError, ScheduleError, financialYear, fiscalStart } from "@kuber/ops";
import { StaleReportError, type ReportBasis, type ReportOptions } from "@kuber/reporting";
import { IngestionError } from "@kuber/channels";
import type { Cell } from "./cell.ts";
import { Copilot } from "./copilot/index.ts";
import { HELP, HELP_GROUPS } from "./copilot/router.ts";
import { attentionCounts, journalLifecycle } from "./agent-tools.ts";
import { registerMcp } from "./mcp.ts";
import { registerFinRoutes } from "./fin-routes.ts";
import { registerPortalRoutes } from "./portal-routes.ts";
import { createGovernance, type KuberGovernance } from "./copilot/governance/index.ts";
import { registerAgentRoutes } from "./copilot/governance/routes.ts";
import { registerGroupRoutes } from "./group-routes.ts";
import { ConsolidationError } from "@kuber/consolidation";
import { MigrationError } from "@kuber/migration";
import { registerMigrationRoutes } from "./migration-routes.ts";
import { SigningRequest, actionLabel, amountReason, draftIntent, goLiveIntent, lockIntent, planIntent, ratifyIntent } from "./signing.ts";
import type { Who } from "./tools.ts";

export interface ServerOptions {
  copilot?: Copilot; mcpGrants?: Map<string, Who>; clock?: () => string; https?: { key: Buffer; cert: Buffer };
  /** The copilot's governance layer (TAGOF); created from the repository's agent/ directory when absent. */
  governance?: KuberGovernance;
  /** Shared secret with the BFF (CORE_AUTH_SECRET). Without it every /v1 request is refused. */
  auth?: { secret: string | Buffer; issuers?: string[]; replay?: ReplayStore };
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
  const replay: ReplayStore = opts.auth?.replay ?? new ReplayCache();
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
    const c = await verifyRequestAsync(key, replay, { header: req.headers[AUTH_HEADER], method: req.method, path: req.url, body: rawBodies.get(req) ?? null, issuers: opts.auth?.issuers });
    const tenant = (req.params as { tenant?: string }).tenant;
    if (tenant === undefined || c.tenant !== tenant) throw new AccessDenied("the assertion is for another workspace");
    // A signed-in person's request is made for one web session, which must not have been signed out.
    if (c.principal !== null) {
      if (!c.sid) throw new AuthError("no_session", "a signed-in request must carry its session id");
      if (!(await cell.identity.sessionActive(tenant, c.sid, c.principal))) throw new AuthError("session_revoked", "this session has been signed out");
    }
    claimsOf.set(req, c);
  });
  if (replay.prune) {
    const pruner = setInterval(() => replay.prune!(), 60_000);
    pruner.unref();
    app.addHook("onClose", async () => clearInterval(pruner));
  }

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

  // ---------------------------------------------------------------- signed commands (design 14.4, 16.4)
  /**
   * How a high-risk command is confirmed. With `assertion` (the device's passkey signature over the
   * command digest, from POST …/signing/options): a verifier the command runs in its own
   * transaction, which consumes the signing request and returns what the command's event stores.
   * Without one: only the DEVELOPMENT SIGN-IN fallback (a member with no passkey and a fresh `su`
   * claim, dev sign-in enabled), recorded as "dev-step-up", not a signature. Otherwise null: refuse.
   */
  type Attest = (tx: TransactionSql) => Promise<CommandSignature>;
  const attestFor = async (req: FastifyRequest, tenant: string, principal: string, assertion: unknown, intent: () => Promise<SigningIntent>): Promise<Attest | null> => {
    if (assertion) return cell.identity.signedCommand(tenant, principal, await intent(), assertion as never);
    const dev = await cell.identity.devAttestation(tenant, principal, claimsOf.get(req)?.su);
    return dev ? async () => dev : null;
  };
  const signatureRequired = (reply: FastifyReply, action: SignedAction, reason: string) => reply.code(403).send({ error: "step_up_required", reason, signing: { action },
    message: `Sign with your passkey to ${actionLabel[action]} (${reason}): Kuber shows exactly what you are signing first.` });
  const Assertion = z.record(z.string(), z.unknown()).optional();

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return reply.code(401).send({ error: err.code, message: err.message });
    if (err instanceof AccessDenied || err instanceof GuardDenied) return reply.code(403).send({ error: "forbidden", message: err.message });
    if (err instanceof ReplayStoreUnavailable) { console.error(err.message); return reply.code(503).send({ error: err.code, message: "request authentication is temporarily unavailable" }); }
    if (err instanceof IdentityError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof DomainError) return reply.code(422).send({ error: err.code, message: err.message });
    if (err instanceof AgentError) return reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.code, message: err.message });
    if (err instanceof IngestionError) return reply.code(422).send({ error: err.code, message: err.message, detail: err.detail });
    if (err instanceof OpsError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ConsolidationError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof MigrationError) return reply.code(err.status).send({ error: err.code, message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) });
    if (err instanceof IncidentError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ScheduleError) return reply.code(err.status).send({ error: err.code, message: err.message });
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
    const b = z.object({ bookId: z.string(), entityId: z.string(), entityType: z.enum(["individual", "household", "freelancer", "company"]),
      // FIN-MDM-01 configuration (defaults: legal entity = entityId, INR/2, April year, framework "unspecified", purpose by entity type)
      legalEntityId: z.string().min(1).optional(), framework: z.string().min(1).max(60).optional(),
      basis: z.enum(["statutory", "management", "tax", "budget", "scenario"]).optional(),
      fiscalYearStartMonth: z.number().int().min(1).max(12).optional(), purpose: BookPurpose.optional() }).parse(req.body);
    const { bookId, entityId, entityType, ...config } = b;
    const ev = await cell.gl.openBook(tenant, bookId, entityId, entityType, principal, config);
    return reply.code(201).send({ events: ev.map((e) => e.type) });
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/accounts", async (req, reply) => {
    const { tenant, principal } = await who(req, "account.add");
    const account = Account.parse(req.body);
    await cell.gl.execute(tenant, req.params.book, { kind: "AddAccount", account }, { principal });
    return reply.code(201).send({ accountId: account.accountId });
  });

  // FIN-MDM-02: close an account (no new ordinary entries), or change its statement mapping / mandatory dimensions.
  type A = { Params: { tenant: string; book: string; account: string } };
  app.post<A>("/v1/tenants/:tenant/books/:book/accounts/:account/close", async (req, reply) => {
    const { tenant, principal } = await who(req, "account.close");
    const b = z.object({ reason: z.string().min(1) }).parse(req.body);
    await cell.gl.execute(tenant, req.params.book, { kind: "CloseAccount", accountId: req.params.account, reason: b.reason }, { principal });
    return reply.code(201).send({ accountId: req.params.account, closed: true });
  });
  app.post<A>("/v1/tenants/:tenant/books/:book/accounts/:account/controls", async (req, reply) => {
    const { tenant, principal } = await who(req, "account.close");
    const b = z.object({ taxonomyTag: z.string().min(1).optional(), requiredDims: z.array(z.string().min(1)).optional(), reason: z.string().optional() }).parse(req.body);
    await cell.gl.execute(tenant, req.params.book, { kind: "ChangeAccountControls", accountId: req.params.account, ...b }, { principal });
    return reply.code(201).send({ accountId: req.params.account });
  });

  // FIN-MDM-03 party master. Tenant-wide (a party belongs to a legal entity, not a book); the module
  // checks the same rights again inside its transaction, and separation of maker and checker.
  type PP = { Params: { tenant: string; party: string } };
  type PC = { Params: { tenant: string; party: string; change: string } };
  app.post<P>("/v1/tenants/:tenant/parties", async (req, reply) => {
    const { tenant, principal } = await who(req, "party.manage", { allBooks: true });
    const b = z.object({ partyId: z.string().regex(/^[A-Za-z0-9_.:@+-]{1,200}$/), entityId: z.string().min(1), kind: PartyKind, name: z.string().min(1),
      effectiveFrom: IsoDate.optional(), terms: PartyTerms.optional(), taxStatus: TaxStatus.optional() }).parse(req.body);
    return reply.code(201).send(await cell.parties.register(tenant, principal, b));
  });
  app.get<{ Params: { tenant: string } }>("/v1/tenants/:tenant/parties/reviews", async (req) => {
    const { tenant } = await who(req, "read", { allBooks: true });
    return cell.parties.reviews(tenant);
  });
  app.get<PP & { Querystring: { asOf?: string } }>("/v1/tenants/:tenant/parties/:party", async (req, reply) => {
    const { tenant } = await who(req, "read", { allBooks: true });
    const p = await cell.parties.get(tenant, req.params.party, req.query.asOf ? IsoDate.parse(req.query.asOf) : undefined);
    if (!p) return reply.code(404).send({ error: "not_found", message: `no party ${req.params.party}` });
    const { bank, ...rest } = p;                                       // bank details are shown masked
    return { ...rest, bank: bank ? { ifsc: bank.ifsc, holderName: bank.holderName, accountNumber: `••••${bank.accountNumber.slice(-4)}` } : null };
  });
  app.post<PP>("/v1/tenants/:tenant/parties/:party/details", async (req) => {
    const { tenant, principal } = await who(req, "party.manage", { allBooks: true });
    const b = z.object({ effectiveFrom: IsoDate, name: z.string().min(1).optional(), terms: PartyTerms.optional(), taxStatus: TaxStatus.optional() }).parse(req.body);
    return cell.parties.changeDetails(tenant, principal, req.params.party, b);
  });
  app.post<PP>("/v1/tenants/:tenant/parties/:party/bank-changes", async (req, reply) => {
    const { tenant, principal } = await who(req, "party.manage", { allBooks: true });
    const b = z.object({ bank: BankDetails, effectiveFrom: IsoDate.optional(), source: z.string().max(500).optional() }).parse(req.body);
    return reply.code(201).send(await cell.parties.requestBankChange(tenant, principal, req.params.party, b));
  });
  app.post<PC>("/v1/tenants/:tenant/parties/:party/bank-changes/:change/verify", async (req) => {
    const { tenant, principal } = await who(req, "party.bank.verify", { allBooks: true });
    const b = z.object({ method: z.enum(["call_back", "penny_drop", "name_match", "document"]), reference: z.string().min(1).max(200) }).parse(req.body);
    return cell.parties.verifyBankChange(tenant, principal, req.params.party, req.params.change, b);
  });
  app.post<PC>("/v1/tenants/:tenant/parties/:party/bank-changes/:change/release", async (req) => {
    const { tenant, principal } = await who(req, "party.bank.release", { allBooks: true });
    return cell.parties.releaseBankChange(tenant, principal, req.params.party, req.params.change);
  });
  app.post<PC>("/v1/tenants/:tenant/parties/:party/bank-changes/:change/reject", async (req) => {
    const { tenant, principal } = await who(req, "party.bank.verify", { allBooks: true });
    const b = z.object({ reason: z.string().min(1) }).parse(req.body);
    return cell.parties.rejectBankChange(tenant, principal, req.params.party, req.params.change, b.reason);
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

  // A manual journal (FIN-GL-01). Control accounts only as a controlled adjustment (owner or controller,
  // party on every control line); INR only (FIN-GL-04). A refused attempt changes nothing in the book
  // and is recorded as a failed posting (PostingRejected) with its reason, listed in journal-lifecycle.
  app.post<P>("/v1/tenants/:tenant/books/:book/journals", async (req, reply) => {
    const { tenant, principal } = await who(req, "journal.post");
    const raw = (req.body ?? {}) as { commandId?: unknown };
    try {
      const b = z.object({ txnDate: IsoDate, narration: z.string().min(1), voucherType: z.string().default("journal"), lines: z.array(ApiLine).min(2),
        commandId: CommandKey.optional(), currency: z.string().optional(), controlledAdjustment: z.object({ reason: z.string().min(3) }).optional() }).parse(req.body);
      return await postOnce(req, reply, "journals", principal, b, { kind: "PostJournal", journalId: uuid(), txnDate: b.txnDate, narration: b.narration,
        voucherType: b.voucherType, lines: b.lines.map(toLine), autonomy: "human", entry: "manual",
        ...(b.currency ? { currency: b.currency } : {}), ...(b.controlledAdjustment ? { controlledAdjustment: b.controlledAdjustment } : {}) });
    } catch (e) {
      if (e instanceof DomainError || e instanceof ZodError) {
        const header = req.headers["idempotency-key"];
        const key = typeof header === "string" ? header : typeof raw.commandId === "string" ? raw.commandId : undefined;
        const reason = e instanceof DomainError ? `${e.code}: ${e.message}` : `invalid_request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
        const requestId = key && Id.safeParse(key).success ? key : `manual-${uuid()}`;
        if (Id.safeParse(req.params.book).success) {
          await cell.gl.recordRejection(tenant, req.params.book, { requestId, reason, source: "api:journals" }, { principal })
            .catch((x) => console.error("could not record a rejected posting", x));
          reply.header("x-kuber-rejection", requestId);
        }
      }
      throw e;
    }
  });

  app.post<P>("/v1/tenants/:tenant/books/:book/opening-balances", async (req, reply) => {
    const { tenant, principal } = await who(req, "journal.post");
    const b = z.object({ accountId: z.string(), amount: z.string(), asOf: IsoDate, commandId: CommandKey.optional() }).parse(req.body);
    const st = await cell.gl.state(tenant, req.params.book);
    const acc = st.accounts.get(b.accountId);
    if (!acc) throw new DomainError("no_account", `unknown account ${b.accountId}`);
    const p = parseAmount(b.amount), signed = acc.nature === "asset" ? p : -p;
    return postOnce(req, reply, "opening-balances", principal, b, { kind: "PostJournal", journalId: uuid(), txnDate: b.asOf,
      narration: `Opening balance declared: ${b.accountId}`, voucherType: "opening", autonomy: "human", entry: "manual",
      lines: [{ accountId: b.accountId, amount: signed.toString(), dimensions: {} }, { accountId: "OPENING", amount: (-signed).toString(), dimensions: {} }] });
  });

  // A direct period lock is a signed command (design 16.4); the signature is stored on PeriodLocked.
  app.post<P>("/v1/tenants/:tenant/books/:book/locks", async (req, reply) => {
    const { tenant, principal } = await who(req, "period.lock");
    const b = z.object({ periodEnd: IsoDate, level: z.enum(["soft", "hard"]), assertion: Assertion }).parse(req.body);
    const book = req.params.book;
    const attest = await attestFor(req, tenant, principal, b.assertion, async () => lockIntent(book, b.periodEnd, b.level));
    if (!attest) return signatureRequired(reply, "period.lock", "locking a period");
    await cell.gl.transact(tenant, book, async (bk) => {
      const signature = await attest(bk.tx);
      await bk.execute({ kind: "LockPeriod", periodEnd: b.periodEnd, level: b.level, signature }, { principal });
    });
    return reply.code(201).send({ locked: { periodEnd: b.periodEnd, level: b.level } });
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
    return attentionCounts(cell, tenant, req.params.book, member.books === null);
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
    const b = z.object({ accountId: z.string().optional(), assertion: Assertion }).parse(req.body ?? {});
    // Above the approval limit, approving a draft is a signed command (design 16.4).
    const intent = await draftIntent(cell, tenant, req.params.id, b.accountId);
    const reason = await amountReason(cell, tenant, intent.amount);
    let attest: Attest | null = null;
    if (reason) {
      attest = await attestFor(req, tenant, principal, b.assertion, async () => intent);
      if (!attest) return signatureRequired(reply, "draft.approve", reason);
    }
    return reply.code(202).send(await cell.agent.approveDraft(tenant, req.params.id, principal, b.accountId, undefined, undefined, attest ? { attest } : {}));
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
  app.get<P>("/v1/tenants/:tenant/match-reviews", async (req, reply) => {
    const q = req.query as PageQ;
    const { tenant, member } = await who(req, "read");
    // ?book= narrows to one book (within a book-scoped member's books); otherwise every book the member may see
    if (q.book && !inScope(member, q.book)) throw new AccessDenied(`${q.book} is outside your books`);
    const bookIds = q.book ? [q.book] : member.books ?? undefined;
    const p = await cell.agent.matchReviewsPage(tenant, { ...pageOf(q), bookIds });
    if (p.next) reply.header("x-next-cursor", p.next);
    return p.items;
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
    const b = z.object({ assertion: Assertion }).parse(req.body ?? {});
    // Above the approval limit, confirming an automatic posting is a signed command (design 16.4).
    const intent = await ratifyIntent(cell, tenant, req.params.id);
    // Fail closed: with a limit set, a posting whose amount cannot be read yet (not projected) is not ratified unsigned.
    if (!intent && (await cell.identity.settings(tenant)).sodLimitPaise !== null && (await cell.agent.openRatifications(tenant)).some((r) => r.journal_id === req.params.id))
      return reply.code(409).send({ error: "not_ready", message: "This posting is still being recorded; try again in a moment." });
    const reason = intent ? await amountReason(cell, tenant, intent.amount) : null;
    let attest: Attest | null = null;
    if (reason) {
      attest = await attestFor(req, tenant, principal, b.assertion, async () => intent!);
      if (!attest) return signatureRequired(reply, "journal.ratify", reason);
    }
    await cell.agent.ratify(tenant, req.params.id, principal, attest ? { attest } : {});
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
  app.get<P>("/v1/tenants/:tenant/copilot", async (req) => { await who(req, "read"); return { engine: copilot.engine, suggestions: HELP, groups: HELP_GROUPS }; });
  app.post<P>("/v1/tenants/:tenant/books/:book/copilot", async (req) => {
    const { tenant, principal } = await who(req, "copilot");
    const b = z.object({ text: z.string().min(1).max(2000), history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(20).default([]),
      sessionId: z.string().max(200).optional() }).parse(req.body);
    // Session memory only (AGT-04): the client's history, capped; the server keeps no conversation.
    return copilot.ask({ tenant, book: req.params.book, principal }, b.text, b.history.slice(-8), { sessionId: b.sessionId ?? null });
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
  /** The session a sign-in ceremony is about to start (optional): bound to the verified principal and passkey. */
  const startingSession = (req: FastifyRequest) => claimsOf.get(req)?.sid ?? null;
  const Json = z.record(z.string(), z.unknown());
  app.post<P>("/v1/tenants/:tenant/identity/registration/options", async (req) => {
    const b = z.object({ displayName: z.string().min(2).max(80), enrolment: z.string().min(16).max(128).optional() }).parse(req.body);
    return cell.identity.registrationOptions(ceremony(req), b);
  });
  app.post<P>("/v1/tenants/:tenant/identity/registration/verify", async (req, reply) => {
    const b = z.object({ displayName: z.string().min(2).max(80), enrolment: z.string().min(16).max(128).optional(), response: Json }).parse(req.body);
    return reply.code(201).send(await cell.identity.register(ceremony(req), { ...b, response: b.response as never, session: startingSession(req) }));
  });
  app.post<P>("/v1/tenants/:tenant/identity/authentication/options", async (req) => cell.identity.authenticationOptions(ceremony(req)));
  app.post<P>("/v1/tenants/:tenant/identity/authentication/verify", async (req) => {
    const b = z.object({ response: Json }).parse(req.body);
    return cell.identity.authenticate(ceremony(req), { response: b.response as never, session: startingSession(req) });
  });
  app.post<P>("/v1/tenants/:tenant/identity/dev-signin", async (req) => {
    const b = z.object({ name: z.string().min(2).max(80) }).parse(req.body);
    return cell.identity.devSignIn(ceremony(req), b.name, startingSession(req));
  });
  // Sign-out: revoke the session this request was signed for. No membership check: a person whose
  // membership was revoked can still end their session.
  app.post<P>("/v1/tenants/:tenant/sessions/revoke", async (req, reply) => {
    const c = claimsOf.get(req);
    if (!c?.tenant || !c.principal || !c.sid) throw new AuthError("unauthenticated", "sign-out needs a signed-in session");
    await cell.identity.revokeSession(c.tenant, c.sid, Principal.parse(c.principal));
    return reply.code(204).send();
  });
  // Passkeys: a member lists and revokes their own; an owner (members.manage) may revoke anyone's.
  app.get<P>("/v1/tenants/:tenant/me/credentials", async (req) => { const { tenant, principal } = await who(req, "self"); return cell.identity.credentials(tenant, principal); });
  app.post<{ Params: { tenant: string; id: string } }>("/v1/tenants/:tenant/credentials/:id/revoke", async (req, reply) => {
    const { tenant, principal, member } = await who(req, "self");
    const anyMember = can(member.role, "members.manage") && member.books === null;
    await cell.identity.revokeCredential(tenant, principal, req.params.id, { anyMember });
    return reply.code(204).send();
  });
  // The member and what their role allows, so surfaces show only what the core would accept.
  // `passkeys` and `warnings`: an owner or controller with a single passkey is told to register a second (design 16.4).
  app.get<P>("/v1/tenants/:tenant/me", async (req) => {
    const { tenant, principal, member } = await who(req, "self");
    return { ...member, permissions: ACTIONS.filter((a) => can(member.role, a)), ...(await cell.identity.passkeyStatus(tenant, principal)) };
  });
  app.get<P>("/v1/tenants/:tenant/members", async (req) => { const { tenant } = await who(req, "members.read", { allBooks: true }); return cell.identity.members(tenant); });
  app.post<P>("/v1/tenants/:tenant/members/invitations", async (req, reply) => {
    const { tenant, principal } = await who(req, "members.manage", { allBooks: true });
    // Role model v2 roles; a legacy name (owner, preparer, ...) stands for its role, and the new member gets the new prefix.
    // Customers and suppliers are bound to one party of the party master (partyId).
    const b = z.object({ role: z.enum([...PERSON_ROLES, ...(Object.keys(LEGACY_ALIASES) as (keyof typeof LEGACY_ALIASES)[])] as [string, ...string[]]), displayName: z.string().min(2).max(80),
      books: z.array(z.string().min(1)).min(1).nullable().default(null), ttlHours: z.number().int().min(1).max(24 * 14).optional(),
      partyId: Id.optional() }).parse(req.body) as Parameters<typeof cell.identity.invite>[2];
    return reply.code(201).send(await cell.identity.invite(tenant, principal, b));
  });
  app.post<{ Params: { tenant: string; principal: string } }>("/v1/tenants/:tenant/members/:principal/revoke", async (req, reply) => {
    const { tenant, principal } = await who(req, "members.manage", { allBooks: true });
    await cell.identity.revoke(tenant, principal, req.params.principal);
    return reply.code(204).send();
  });
  type M = { Params: { tenant: string; principal: string } };
  // A role and/or book-scope change; a role change answers with the successor principal.
  app.patch<M>("/v1/tenants/:tenant/members/:principal", async (req) => {
    const { tenant, principal } = await who(req, "members.manage", { allBooks: true });
    const b = z.object({ role: z.enum(PERSON_ROLES).optional(), books: z.array(z.string().min(1).max(64)).min(1).nullable().optional() })
      .refine((x) => x.role !== undefined || x.books !== undefined, "change role, books or both").parse(req.body);
    return cell.identity.changeMember(tenant, principal, req.params.principal, b);
  });
  // Every active member's passkeys (member management); revocation is the one route above.
  app.get<P>("/v1/tenants/:tenant/credentials", async (req) => { const { tenant } = await who(req, "members.read", { allBooks: true }); return cell.identity.credentials(tenant); });
  // Step-up: a signed-in person re-confirms with their own passkey before a sensitive approval.
  // The BFF then carries the time of that confirmation in its signed assertions (claim `su`).
  app.post<P>("/v1/tenants/:tenant/identity/stepup/options", async (req) => {
    const { tenant, principal } = await who(req, "self");
    return cell.identity.stepUpOptions(tenant, principal);
  });
  app.post<P>("/v1/tenants/:tenant/identity/stepup/verify", async (req) => {
    const { tenant, principal } = await who(req, "self");
    const b = z.union([z.object({ response: Json }), z.object({ dev: z.literal(true) })]).parse(req.body);
    return "dev" in b ? cell.identity.devStepUp(tenant, principal) : cell.identity.stepUp(tenant, principal, { response: b.response as never });
  });
  // Another passkey for the signed-in member (design 16.4: owners and controllers keep two). A member
  // who has a passkey confirms with it first (step-up, claim `su`).
  app.post<P>("/v1/tenants/:tenant/identity/passkeys/options", async (req) => {
    const { tenant, principal } = await who(req, "self");
    return cell.identity.addPasskeyOptions(tenant, principal);
  });
  app.post<P>("/v1/tenants/:tenant/identity/passkeys/verify", async (req, reply) => {
    const { tenant, principal } = await who(req, "self");
    const b = z.object({ response: Json }).parse(req.body);
    return reply.code(201).send(await cell.identity.addPasskey(tenant, principal, { response: b.response as never, stepUpAt: claimsOf.get(req)?.su }));
  });
  app.get<P>("/v1/tenants/:tenant/settings/separation", async (req) => cell.identity.settings((await who(req, "read")).tenant));
  // Separation of duties is authority (role model v2): a superuser changes it, not an admin.
  // `soloSuperuser` is the single-superuser exception; its earlier name `soloOwner` is still accepted.
  app.put<P>("/v1/tenants/:tenant/settings/separation", async (req) => {
    const { tenant, principal } = await who(req, "authority.manage", { allBooks: true });
    const b = z.object({ soloSuperuser: z.boolean().optional(), soloOwner: z.boolean().optional(), sodLimitPaise: z.string().regex(/^\d+$/).nullable(),
      requireTwoAuthenticators: z.boolean().optional() }).refine((x) => x.soloSuperuser !== undefined || x.soloOwner !== undefined, "give soloSuperuser").parse(req.body);
    return cell.identity.setSettings(tenant, principal, b);
  });

  /**
   * Signing a high-risk command, step 1 (design 14.4/16.4): the person asks to sign one command. The
   * core checks they may carry it out at all, renders the summary from the command itself, and
   * answers with WebAuthn options whose challenge is the command digest, the digest inputs and the
   * summary to show before the passkey prompt. `required: false` when this command needs no signature.
   */
  app.post<P>("/v1/tenants/:tenant/signing/options", async (req, reply) => {
    const r = SigningRequest.parse(req.body);
    let tenant: string, principal: string, intent: SigningIntent | null, reason: string | null;
    if (r.action === "plan.commit" || r.action === "plan.approve") {
      ({ tenant, principal } = await who(req, "read"));
      const plan = await cell.ops.get(tenant, r.planId);
      if (plan.status !== "proposed" || plan.kind !== "write") return { required: false, reason: null };
      const approvedBy = r.action === "plan.commit" ? await cell.ops.activeApprover(tenant, plan.planId, r.hash, principal) : null;
      if (approvedBy) return { required: false, reason: `carries out the approval by ${approvedBy}` };
      await cell.identity.check({ step: r.action === "plan.commit" ? "commit" : "approve", tenant, book: plan.bookId, principal, op: { name: plan.op, kind: plan.kind, gate: plan.gate }, plan });
      reason = await cell.identity.stepUpReason(tenant, plan);
      intent = reason ? await planIntent(cell, tenant, r.planId, r.hash, r.action) : null;
    } else if (r.action === "draft.approve") {
      let member: Member;
      ({ tenant, principal, member } = await who(req, "draft.decide"));
      await draftInScope(tenant, member, r.draftId);
      const d = await draftIntent(cell, tenant, r.draftId, r.accountId);
      reason = await amountReason(cell, tenant, d.amount);
      intent = reason ? d : null;
    } else if (r.action === "journal.ratify") {
      ({ tenant, principal } = await who(req, "journal.ratify", { allBooks: true }));
      const d = await ratifyIntent(cell, tenant, r.journalId);
      reason = d ? await amountReason(cell, tenant, d.amount) : null;
      intent = reason ? d : null;
    } else if (r.action === "migration.golive") {
      // FIN-MIG-02: a superuser signs the cut-over over the project's comparison and checklist.
      const proj = await cell.migration.project(req.params.tenant, r.projectId);
      if (!proj) return reply.code(404).send({ error: "no_project", message: `no migration project ${r.projectId}` });
      ({ tenant, principal } = await who(req, "authority.manage", { book: proj.bookId }));
      reason = "going live: the cut-over decision";
      intent = await goLiveIntent(cell, tenant, r.projectId, r.comparisonId);
    } else {
      ({ tenant, principal } = await who(req, "period.lock", { book: r.book }));
      reason = "locking a period";
      intent = lockIntent(r.book, r.periodEnd, r.level);
    }
    if (!intent) return { required: false, reason: null };
    const { amount: _amount, ...pure } = intent as SigningIntent & { amount?: bigint };
    return { required: true, reason, ...(await cell.identity.signingOptions(tenant, principal, pure)) };
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
    const b = z.object({ hash: z.string().length(64), assertion: Assertion }).parse(req.body);
    // Period operations and amounts above the approval limit are signed commands (design 14.4/16.4):
    // the committer's passkey signs this exact plan, and the signature is verified and stored with
    // PlanApproved in the commit's transaction. The guard runs first, so nobody is asked to sign a
    // plan they could not approve anyway.
    const plan = await cell.ops.get(tenant, req.params.id);
    // FIN-MDM-04: carrying out someone else's recorded approval needs no signature from the executor:
    // the approver signed when approving (POST …/approve), and ops.commit re-checks their authority.
    const approvedBy = plan.status === "proposed" && !principal.startsWith("agent:") ? await cell.ops.activeApprover(tenant, plan.planId, b.hash, principal) : null;
    let attest: Attest | null = null;
    if (plan.status === "proposed" && plan.kind === "write" && !principal.startsWith("agent:") && !approvedBy) {
      await cell.identity.check({ step: "commit", tenant, book: plan.bookId, principal, op: { name: plan.op, kind: plan.kind, gate: plan.gate }, plan });
      const reason = await cell.identity.stepUpReason(tenant, plan);
      if (reason) {
        attest = await attestFor(req, tenant, principal, b.assertion, () => planIntent(cell, tenant, req.params.id, b.hash, "plan.commit"));
        if (!attest) return signatureRequired(reply, "plan.commit", reason);
      }
    }
    const r = await cell.ops.commit(tenant, req.params.id, principal, b.hash, attest ? { attest } : {});
    return reply.code(r.status === "committed" ? 200 : 202).send(r);
  });
  app.post<T>("/v1/tenants/:tenant/plans/:id/discard", async (req) => { const { tenant, principal } = await who(req, "read"); return cell.ops.discard(tenant, req.params.id, principal); });

  // ------------------------------------------------------------ journal lifecycle (FIN-GL-01)
  // One vocabulary over every path an entry takes: draft, submitted, approved, posting, posted, failed.
  app.get<P>("/v1/tenants/:tenant/books/:book/journal-lifecycle", async (req) => {
    const { tenant } = await who(req, "read");
    return journalLifecycle(cell, tenant, req.params.book);
  });

  // ------------------------------------------------------------ schedules (FIN-GL-02/03)
  // Defined here, approved once through the schedule_approve operation (plan + commit), run by `ops run-schedules`.
  // Lines take debit/credit in rupees like /journals; a recognition total is in rupees; responses are in paise.
  const ScheduleApi = z.object({
    lines: z.array(ApiLine).min(2).optional(),
    recognition: z.object({ total: z.string() }).passthrough().optional(),
  }).passthrough();
  app.post<P>("/v1/tenants/:tenant/books/:book/schedules", async (req, reply) => {
    const { tenant, principal } = await who(req, "read");                      // plan.prepare: ops guard, in create
    const b = ScheduleApi.parse(req.body ?? {});
    const input = { ...b, ...(b.lines ? { lines: b.lines.map(toLine) } : {}),
      ...(b.recognition ? { recognition: { ...b.recognition, total: parseAmount(b.recognition.total).toString() } } : {}) };
    return reply.code(201).send(await cell.ops.schedules.create(tenant, req.params.book, principal, input));
  });
  app.get<P>("/v1/tenants/:tenant/books/:book/schedules", async (req) => cell.ops.schedules.list((await who(req, "read")).tenant, req.params.book));
  app.get<R>("/v1/tenants/:tenant/books/:book/schedules/reconciliation", async (req) =>
    cell.ops.schedules.reconciliation((await who(req, "read")).tenant, req.params.book, { to: dates(req.query).to }));
  app.get<P>("/v1/tenants/:tenant/books/:book/schedules/exceptions", async (req) => cell.ops.schedules.exceptions((await who(req, "read")).tenant, req.params.book));
  app.get<T>("/v1/tenants/:tenant/schedules/:id", async (req) => {
    const { tenant, member } = await who(req, "read");
    const v = await cell.ops.schedules.get(tenant, req.params.id);
    if (!inScope(member, v.bookId)) throw new AccessDenied(`schedule ${req.params.id} is outside your books`);
    return v;
  });
  app.post<T>("/v1/tenants/:tenant/schedules/exceptions/:id/dismiss", async (req) => {
    const { tenant, principal } = await who(req, "read");                      // plan.prepare in the book: ops guard
    const b = z.object({ note: z.string().min(3).max(500) }).parse(req.body);
    return cell.ops.schedules.dismissException(tenant, req.params.id, principal, b.note);
  });
  // Run due occurrences now (the same runner as `ops run-schedules`); postings are made as system:scheduler under each approval.
  app.post<P>("/v1/tenants/:tenant/books/:book/schedules/run", async (req) => {
    const { tenant } = await who(req, "plan.approve.period");
    const b = z.object({ asOf: IsoDate.optional() }).parse(req.body ?? {});
    return cell.ops.runSchedules(tenant, b.asOf);
  });

  // ------------------------------------------------------------ suspense (FIN-GL-05)
  app.get<R>("/v1/tenants/:tenant/books/:book/suspense/items", async (req) => {
    const t = await reader(req);
    const q = z.object({ status: z.enum(["open", "resolved"]).optional(), asOf: IsoDate.optional() }).passthrough().parse(req.query);
    return cell.agent.suspense.list(t, req.params.book, { status: q.status, asOf: q.asOf });
  });
  app.get<R>("/v1/tenants/:tenant/books/:book/suspense/roll-forward", async (req) => {
    const t = await reader(req);
    // default: the book's fiscal year to date (FIN-MDM-01 fiscal year start)
    const q = z.object({ from: IsoDate.optional(), to: IsoDate.optional() }).parse(req.query);
    const to = q.to ?? clock();
    const from = q.from ?? financialYear(to, fiscalStart(await cell.gl.state(t, req.params.book))).from;
    return cell.agent.suspense.rollForward(t, req.params.book, from, to);
  });
  app.post<T>("/v1/tenants/:tenant/suspense/items/:id/assign", async (req) => {
    const { tenant, principal } = await who(req, "draft.decide");
    const b = z.object({ owner: z.string().min(1).max(200) }).parse(req.body);
    return cell.agent.suspense.assign(tenant, req.params.id, b.owner, principal);          // book scope: module guard
  });

  app.get<P>("/v1/tenants/:tenant/books/:book/verify", async (req) => {
    const broken = await cell.gl.verify((await who(req, "read")).tenant, req.params.book);
    return { intact: broken === null, firstBrokenJournal: broken };
  });

  // ------------------------------------------------------------ finance controls (FIN-MDM-04/05, FIN-OPS-02/03)
  /** The authenticated person, no action check: for services that check a named action themselves. */
  const authn = async (req: FastifyRequest) => {
    const c = claimsOf.get(req);
    if (!c?.tenant) throw new AuthError("unauthenticated", "request is not authenticated");
    if (!c.principal) throw new AuthError("unauthenticated", "this request needs a signed-in person");
    return { tenant: c.tenant, principal: Principal.parse(c.principal) };
  };
  registerFinRoutes(app, cell, who, attestFor, signatureRequired, Assertion, authn);
  registerAgentRoutes(app, cell, opts.governance ?? createGovernance(cell), authn);
  // ------------------------------------------------------------ external roles (role model v2)
  registerPortalRoutes(app, cell, who);
  // ------------------------------------------------------------ group consolidation (FIN-GRP-01..04)
  registerGroupRoutes(app, cell, who);
  // ------------------------------------------------------------ legacy migration (FIN-MIG-01..03)
  registerMigrationRoutes(app, cell, who, attestFor, signatureRequired, Assertion);

  return app;
}
