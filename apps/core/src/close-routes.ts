/**
 * Period close routes (FIN-CLS-01..04), registered by buildServer behind the same signed request
 * authentication. Task completion, substantiation, certification, reopening and restatement are
 * ops plans: these routes simulate them, and the plan is committed through
 * POST /v1/tenants/:tenant/plans/:id/commit like any other. certify_close, reopen_period and
 * restate are period operations (gate human): the commit is a signed command (the committer's
 * passkey signs the exact plan), and the identity guard admits only a superuser as approver.
 *
 *   GET  /books/:book/close                                    checklists of the book, closes, overdue tasks
 *   POST /books/:book/close/checklists                         create a period's checklist (superuser or controller)
 *   GET  /books/:book/close/closes[/:closeId[/reproduce]]      certified closes (withdrawn ones stay retrievable)
 *   GET  /books/:book/close/restatements[/:id]                 restated comparative versions with their bridges
 *   POST /books/:book/close/restatements                       plan a restatement
 *   POST /books/:book/close/documents                          register an evidence document's SHA-256
 *   GET  /books/:book/close/evidence/:kind?periodEnd=           the current reference to cite (schedule_reconciliation, suspense_roll_forward)
 *   GET  /books/:book/close/:periodEnd                         status: checklist, substantiation, completeness, closes
 *   POST /books/:book/close/:periodEnd/tasks/:taskId/assign     change owner or deadline (superuser or controller)
 *   POST /books/:book/close/:periodEnd/tasks/:taskId/complete   plan complete_close_task (the owner)
 *   POST /books/:book/close/:periodEnd/substantiations/:accountId  plan approve_substantiation (the preparer)
 *   POST /books/:book/close/:periodEnd/certify                 plan certify_close
 *   POST /books/:book/close/:periodEnd/reopen                  plan reopen_period
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CloseEvidenceRef, IsoDate } from "@kuber/contracts";
import type { Action, Member } from "@kuber/identity";
import { CloseError } from "@kuber/close";
import type { Cell } from "./cell.ts";

type Who = (req: FastifyRequest, action: Action, scope?: { book?: string; allBooks?: boolean }) => Promise<{ tenant: string; principal: string; member: Member }>;
type B = { Params: { tenant: string; book: string } };
type BP = { Params: { tenant: string; book: string; periodEnd: string } };
type BPT = { Params: { tenant: string; book: string; periodEnd: string; taskId: string } };
type BPA = { Params: { tenant: string; book: string; periodEnd: string; accountId: string } };
type BI = { Params: { tenant: string; book: string; id: string } };

const period = (s: string) => { const r = IsoDate.safeParse(s); if (!r.success) throw new CloseError("bad_date", `bad period end ${s}`, 400); return r.data; };

export function registerCloseRoutes(app: FastifyInstance, cell: Cell, who: Who) {
  const c = () => cell.periodClose;
  /** Membership and book scope here; the role (prepare vs read) and maker-checker in the ops guard. */
  const plan = async (req: FastifyRequest<{ Params: { tenant: string; book: string } }>, op: string, input: unknown) => {
    const { tenant, principal } = await who(req, "read");
    return cell.ops.plan(tenant, req.params.book, principal, op, input);
  };

  app.get<B>("/v1/tenants/:tenant/books/:book/close", async (req) => {
    const { tenant } = await who(req, "read");
    const [checklists, closes, overdue] = await Promise.all([c().checklists(tenant, req.params.book), c().closes(tenant, req.params.book), c().overdue(tenant, req.params.book)]);
    return { checklists, closes, overdue, bankReconciliationService: c().evidence.has("bank_reconciliation") };
  });
  app.post<B>("/v1/tenants/:tenant/books/:book/close/checklists", async (req, reply) => {
    const { tenant, principal } = await who(req, "read");               // plan.approve.period: the service authorizes
    const b = z.object({ periodEnd: IsoDate, periodStart: IsoDate.optional(), owners: z.record(z.string(), z.string()).optional(), defaultOwner: z.string().optional(),
      deadlines: z.record(z.string(), IsoDate).optional() }).parse(req.body);
    return reply.code(201).send(await c().createChecklist(tenant, req.params.book, principal, b));
  });
  app.get<B>("/v1/tenants/:tenant/books/:book/close/closes", async (req) => c().closes((await who(req, "read")).tenant, req.params.book));
  app.get<BI>("/v1/tenants/:tenant/books/:book/close/closes/:id", async (req) => {
    const { tenant } = await who(req, "read");
    const r = await c().getClose(tenant, req.params.id);
    if (!r || r.bookId !== req.params.book) throw new CloseError("no_close", `no close ${req.params.id} in book ${req.params.book}`, 404);
    return r;
  });
  app.get<BI>("/v1/tenants/:tenant/books/:book/close/closes/:id/reproduce", async (req) => {
    const { tenant } = await who(req, "read");
    const r = await c().getClose(tenant, req.params.id);
    if (!r || r.bookId !== req.params.book) throw new CloseError("no_close", `no close ${req.params.id} in book ${req.params.book}`, 404);
    return c().reproduce(tenant, req.params.id);
  });
  app.get<B>("/v1/tenants/:tenant/books/:book/close/restatements", async (req) => c().restatements((await who(req, "read")).tenant, req.params.book));
  app.get<BI>("/v1/tenants/:tenant/books/:book/close/restatements/:id", async (req) => {
    const { tenant } = await who(req, "read");
    const r = await c().getRestatement(tenant, req.params.id);
    if (!r || r.bookId !== req.params.book) throw new CloseError("no_restatement", `no restatement ${req.params.id} in book ${req.params.book}`, 404);
    return r;
  });
  app.post<B>("/v1/tenants/:tenant/books/:book/close/restatements", async (req) => plan(req, "restate", req.body ?? {}));
  app.post<B>("/v1/tenants/:tenant/books/:book/close/documents", async (req, reply) => {
    const { tenant, principal } = await who(req, "read");               // plan.prepare: the service authorizes
    const b = z.object({ name: z.string().min(1).max(300), contentBase64: z.string().max(7_000_000).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      periodEnd: IsoDate.optional() }).parse(req.body);
    return reply.code(201).send(await c().registerDocument(tenant, req.params.book, principal, b));
  });
  app.get<{ Params: { tenant: string; book: string; kind: string } }>("/v1/tenants/:tenant/books/:book/close/evidence/:kind", async (req) => {
    const { tenant } = await who(req, "read");
    const q = z.object({ periodEnd: IsoDate }).parse(req.query);
    const cl = await c().checklist(tenant, req.params.book, q.periodEnd);
    if (!cl) throw new CloseError("no_checklist", `no close checklist for ${q.periodEnd}`, 404);
    if (req.params.kind === "schedule_reconciliation") { const e = await c().scheduleEvidence(tenant, req.params.book, q.periodEnd); return { ref: e.ref, reconciled: e.reconciled, rows: e.rows }; }
    if (req.params.kind === "suspense_roll_forward") { const e = await c().suspenseEvidence(tenant, req.params.book, cl.periodStart, q.periodEnd); return { ref: e.ref, balanced: e.balanced, rollForward: e.rollForward }; }
    throw new CloseError("no_builder", `Kuber computes schedule_reconciliation and suspense_roll_forward references; a ${req.params.kind} reference comes from its own module`, 404);
  });
  app.get<BP>("/v1/tenants/:tenant/books/:book/close/:periodEnd", async (req) => c().status((await who(req, "read")).tenant, req.params.book, period(req.params.periodEnd)));
  app.post<BPT>("/v1/tenants/:tenant/books/:book/close/:periodEnd/tasks/:taskId/assign", async (req) => {
    const { tenant, principal } = await who(req, "read");               // plan.approve.period: the service authorizes
    const b = z.object({ owner: z.string().optional(), deadline: IsoDate.optional() }).refine((x) => x.owner || x.deadline, "give owner and/or deadline").parse(req.body);
    return c().assignTask(tenant, req.params.book, principal, period(req.params.periodEnd), req.params.taskId, b);
  });
  app.post<BPT>("/v1/tenants/:tenant/books/:book/close/:periodEnd/tasks/:taskId/complete", async (req) => {
    const b = z.object({ evidence: z.array(CloseEvidenceRef).max(20).default([]), note: z.string().max(500).optional() }).parse(req.body ?? {});
    return plan(req, "complete_close_task", { periodEnd: period(req.params.periodEnd), taskId: req.params.taskId, ...b });
  });
  app.post<BPA>("/v1/tenants/:tenant/books/:book/close/:periodEnd/substantiations/:accountId", async (req) =>
    plan(req, "approve_substantiation", { ...(req.body as object ?? {}), periodEnd: period(req.params.periodEnd), accountId: req.params.accountId }));
  app.post<BP>("/v1/tenants/:tenant/books/:book/close/:periodEnd/certify", async (req) => plan(req, "certify_close", { periodEnd: period(req.params.periodEnd) }));
  app.post<BP>("/v1/tenants/:tenant/books/:book/close/:periodEnd/reopen", async (req) => {
    const b = z.object({ reason: z.string().min(10).max(1000) }).parse(req.body);
    return plan(req, "reopen_period", { periodEnd: period(req.params.periodEnd), reason: b.reason });
  });
}
