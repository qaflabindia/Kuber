/**
 * Legacy migration routes (FIN-MIG-01..03, design 16.7), registered by buildServer behind the same
 * signed request authentication. Each route names its action for the project's book (who); the
 * migration service checks the principal again inside every write's transaction (identity guard).
 *
 *   GET  /migrations                                  projects in books the member may see
 *   POST /migrations                                  create {bookId, sourceSystem, cutoff, scope?, projectId?}
 *   GET  /migrations/:p                               project, files, inventory, mapping summary, loads, decisions, comparisons
 *   GET  /migrations/:p/inventory
 *   POST /migrations/:p/files                         upload {name, content, encoding?, purpose?, asOf?} (parsed, retained sealed)
 *   GET  /migrations/:p/files | /files/:file/original
 *   GET  /migrations/:p/mapping                       POST /mapping/approve {rows?, acceptSuggested?}
 *   GET  /migrations/:p/plan                          the load plan and its blocking problems
 *   POST /migrations/:p/rehearse                      load into an isolated rehearsal book and reconcile
 *   POST /migrations/:p/load                          load the target book (pre-cutover)
 *   POST /migrations/:p/delta                         import vouchers after the cut-off {loadId?, asOf?} (idempotent)
 *   GET  /migrations/:p/loads[/:load/{reconciliation,provenance,open-items}]
 *   POST /migrations/:p/loads/:load/rollback          pre-cutover rollback {reason}
 *   GET  /migrations/:p/coverage?asOf=                bank statement coverage from the cut-off
 *   GET|POST /migrations/:p/decisions                 authority (system of record per process) and fallback operators
 *   POST /migrations/:p/comparisons {from, to}        parallel-run comparison; GET /comparisons/:c; POST /comparisons/:c/explain
 *   GET  /migrations/:p/go-live/:comparison           what would be signed (checklist, summary)
 *   POST /migrations/:p/go-live {comparisonId, assertion?}   signed by a superuser's passkey (migration.golive)
 *   GET  /migrations/:p/recovery | /external-documents
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { Id, IsoDate, type CommandSignature, type SignedAction } from "@kuber/contracts";
import { inScope, type Action, type Member, type SigningIntent } from "@kuber/identity";
import { EXPLANATION_CATEGORIES, INVENTORY, MigrationError } from "@kuber/migration";
import type { Cell } from "./cell.ts";
import { goLiveIntent } from "./signing.ts";

type AttestFor = (req: FastifyRequest, tenant: string, principal: string, assertion: unknown, intent: () => Promise<SigningIntent>) =>
  Promise<((tx: TransactionSql) => Promise<CommandSignature>) | null>;
type SignatureRequired = (reply: FastifyReply, action: SignedAction, reason: string) => unknown;
type Who = (req: FastifyRequest, action: Action, scope?: { book?: string; allBooks?: boolean }) => Promise<{ tenant: string; principal: string; member: Member }>;
type TP = { Params: { tenant: string } };
type PP = { Params: { tenant: string; project: string } };
type PX = { Params: { tenant: string; project: string; id: string } };
const NewAccount = z.object({ accountId: Id, name: z.string().min(1).max(120), nature: z.enum(["asset", "liability", "equity", "income", "expense"]), isCashLike: z.boolean().default(false) });

export function registerMigrationRoutes(app: FastifyInstance, cell: Cell, who: Who, attestFor: AttestFor, signatureRequired: SignatureRequired,
                                        Assertion: z.ZodType<Record<string, unknown> | undefined>) {
  const m = cell.migration;
  /** The project (404 if none) and the member, authorized for `action` in its book. */
  const project = async (req: FastifyRequest<PP | PX>, action: Action) => {
    const p = await m.project(req.params.tenant, req.params.project);
    if (!p) throw new MigrationError("no_project", `no migration project ${req.params.project}`, 404);
    const w = await who(req, action, { book: p.bookId });
    return { ...w, p };
  };

  app.get<TP>("/v1/tenants/:tenant/migrations", async (req) => {
    const { tenant, member } = await who(req, "read");
    return (await m.projects(tenant)).filter((p) => inScope(member, p.bookId));
  });
  app.post<TP>("/v1/tenants/:tenant/migrations", async (req, reply) => {
    const b = z.object({ projectId: Id.optional(), bookId: Id, sourceSystem: z.enum(["tally", "zoho", "csv"]), cutoff: IsoDate,
      scope: z.array(z.enum(INVENTORY)).min(1).optional() }).parse(req.body);
    const { tenant, principal } = await who(req, "migration.manage", { book: b.bookId });
    return reply.code(201).send(await m.createProject(tenant, principal, b));
  });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project", async (req) => { const { tenant, p } = await project(req, "read"); return m.view(tenant, p.projectId); });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project/inventory", async (req) => { const { tenant, p } = await project(req, "read"); return m.inventory(tenant, p.projectId); });
  app.post<PP>("/v1/tenants/:tenant/migrations/:project/files", async (req, reply) => {
    const { tenant, principal, p } = await project(req, "migration.manage");
    const b = z.object({ name: z.string().min(1).max(200), content: z.string().min(1), encoding: z.enum(["utf8", "base64"]).optional(),
      purpose: z.enum(["source", "delta", "comparison"]).optional(), asOf: IsoDate.optional() }).parse(req.body);
    const r = await m.importFile(tenant, principal, p.projectId, b);
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project/files", async (req) => { const { tenant, p } = await project(req, "read"); return m.files(tenant, p.projectId); });
  app.get<PX>("/v1/tenants/:tenant/migrations/:project/files/:id/original", async (req, reply) => {
    const { tenant, p } = await project(req, "read");
    const o = await m.original(tenant, p.projectId, req.params.id);
    return o ? o : reply.code(404).send({ error: "not_found", message: `no file ${req.params.id}` });
  });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project/mapping", async (req) => { const { tenant, p } = await project(req, "read"); return m.mapping(tenant, p.projectId); });
  app.post<PP>("/v1/tenants/:tenant/migrations/:project/mapping/approve", async (req) => {
    const { tenant, principal, p } = await project(req, "migration.manage");
    const b = z.object({ rows: z.array(z.object({ sourceKey: z.string().min(1).max(300), accountId: Id.optional(), newAccount: NewAccount.optional(), partyId: Id.optional() })
      .refine((r) => !!r.accountId !== !!r.newAccount, "give accountId or newAccount")).max(5000).optional(),
      acceptSuggested: z.union([z.literal(true), z.array(z.string().min(1).max(300)).max(5000)]).optional() })
      .refine((x) => x.rows?.length || x.acceptSuggested, "give rows or acceptSuggested").parse(req.body);
    return m.approveMapping(tenant, principal, p.projectId, b);
  });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project/plan", async (req) => { const { tenant, p } = await project(req, "read"); return m.planView(await m.plan(tenant, p.projectId)); });
  app.post<PP>("/v1/tenants/:tenant/migrations/:project/rehearse", async (req, reply) => {
    const { tenant, principal, p } = await project(req, "migration.manage");
    return reply.code(201).send(await m.rehearse(tenant, principal, p.projectId));
  });
  app.post<PP>("/v1/tenants/:tenant/migrations/:project/load", async (req, reply) => {
    const { tenant, principal, p } = await project(req, "migration.manage");
    return reply.code(201).send(await m.load(tenant, principal, p.projectId));
  });
  app.post<PP>("/v1/tenants/:tenant/migrations/:project/delta", async (req) => {
    const { tenant, principal, p } = await project(req, "migration.manage");
    const b = z.object({ loadId: Id.optional(), asOf: IsoDate.optional() }).parse(req.body ?? {});
    return m.delta(tenant, principal, p.projectId, b);
  });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project/loads", async (req) => { const { tenant, p } = await project(req, "read"); return m.loads(tenant, p.projectId); });
  app.get<PX>("/v1/tenants/:tenant/migrations/:project/loads/:id/reconciliation", async (req) => { const { tenant, p } = await project(req, "read"); return m.reconciliation(tenant, p.projectId, req.params.id); });
  app.get<PX>("/v1/tenants/:tenant/migrations/:project/loads/:id/provenance", async (req) => {
    const { tenant, p } = await project(req, "read");
    const q = z.object({ kind: z.enum(["account", "party", "opening_line", "open_item", "voucher", "schedule"]).optional(), limit: z.coerce.number().int().min(1).max(10000).optional() }).parse(req.query);
    return m.provenance(tenant, p.projectId, req.params.id, q);
  });
  app.get<PX>("/v1/tenants/:tenant/migrations/:project/loads/:id/open-items", async (req) => { const { tenant, p } = await project(req, "read"); return m.openItems(tenant, p.projectId, req.params.id); });
  app.post<PX>("/v1/tenants/:tenant/migrations/:project/loads/:id/rollback", async (req) => {
    const { tenant, principal, p } = await project(req, "migration.manage");
    const b = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    return m.rollback(tenant, principal, p.projectId, { loadId: req.params.id, reason: b.reason });
  });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project/coverage", async (req) => {
    const { tenant, p } = await project(req, "read");
    const q = z.object({ asOf: IsoDate.optional(), toleranceDays: z.coerce.number().int().min(0).max(60).optional() }).parse(req.query);
    return m.coverage(tenant, p.projectId, q);
  });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project/decisions", async (req) => { const { tenant, p } = await project(req, "read"); return m.decisions(tenant, p.projectId); });
  app.post<PP>("/v1/tenants/:tenant/migrations/:project/decisions", async (req, reply) => {
    const { tenant, principal, p } = await project(req, "migration.manage");
    const b = z.object({ kind: z.enum(["authority", "fallback"]), processes: z.array(z.record(z.string(), z.string().max(200))).min(1).max(50),
      note: z.string().max(2000).optional(), until: IsoDate.optional() }).parse(req.body);
    return reply.code(201).send(await m.recordDecision(tenant, principal, p.projectId, b));
  });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project/comparisons", async (req) => { const { tenant, p } = await project(req, "read"); return m.comparisons(tenant, p.projectId); });
  app.post<PP>("/v1/tenants/:tenant/migrations/:project/comparisons", async (req, reply) => {
    const { tenant, principal, p } = await project(req, "migration.manage");
    const b = z.object({ from: IsoDate, to: IsoDate, loadId: Id.optional() }).parse(req.body);
    return reply.code(201).send(await m.compare(tenant, principal, p.projectId, b));
  });
  app.get<PX>("/v1/tenants/:tenant/migrations/:project/comparisons/:id", async (req) => { const { tenant, p } = await project(req, "read"); return m.comparison(tenant, p.projectId, req.params.id); });
  app.post<PX>("/v1/tenants/:tenant/migrations/:project/comparisons/:id/explain", async (req) => {
    const { tenant, principal, p } = await project(req, "migration.manage");
    const b = z.object({ key: z.string().min(1).max(300), category: z.enum(EXPLANATION_CATEGORIES), note: z.string().min(3).max(2000) }).parse(req.body);
    return m.explain(tenant, principal, p.projectId, req.params.id, b);
  });
  app.get<PX>("/v1/tenants/:tenant/migrations/:project/go-live/:id", async (req) => { const { tenant, p } = await project(req, "read"); return m.goLiveIntent(tenant, p.projectId, req.params.id); });
  app.post<PP>("/v1/tenants/:tenant/migrations/:project/go-live", async (req, reply) => {
    const { tenant, principal, p } = await project(req, "authority.manage");
    const b = z.object({ comparisonId: Id, assertion: Assertion }).parse(req.body);
    const intent = await goLiveIntent(cell, tenant, p.projectId, b.comparisonId);
    const attest = await attestFor(req, tenant, principal, b.assertion, async () => intent);
    if (!attest) return signatureRequired(reply, "migration.golive", "going live: the cut-over decision");
    return m.goLive(tenant, principal, p.projectId, b.comparisonId, intent, attest);
  });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project/recovery", async (req) => { const { tenant, p } = await project(req, "read"); return m.recovery(tenant, p.projectId); });
  app.get<PP>("/v1/tenants/:tenant/migrations/:project/external-documents", async (req) => { const { tenant, p } = await project(req, "read"); return m.externalDocuments(tenant, p.projectId); });
}
