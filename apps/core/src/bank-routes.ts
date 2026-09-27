/**
 * Cash and bank routes (FIN-CASH-01..03), registered by buildServer behind the same signed request
 * authentication. Under /v1/tenants/:tenant/books/:book/bank:
 *
 *   GET  /accounts                               registered bank accounts (numbers masked)
 *   POST /accounts                               register one (bank.manage)
 *   GET  /statements[?account=]                  statement files, verified or held
 *   POST /statements                             import a statement (capture): { bankAccountId, csv, statementAccount, ... }
 *   GET  /statements/:id                         one statement: row lineage, retained original (re-hashed)
 *   GET  /coverage?account=&from=&to=            statement periods, gaps, overlaps
 *   GET  /reconciliations?account=               certified (and withdrawn) reconciliations
 *   GET  /reconciliations/:account?periodEnd=&periodFrom=   the reconciliation statement now
 *   POST /reconciliations                        prepare: plans certify_bank_reconciliation (the preparer is recorded)
 *   POST /certify                                certify: commit that plan; ALWAYS a passkey-signed command
 *   GET  /reconciliations/:account/:id/verify    snapshot verifies and figures still hold
 *   POST /matches/:review/resolve                settle a bank match review (draft.decide)
 *   GET  /exceptions?status=                     the bank exception queue
 *   POST /exceptions/:id/resolve                 close one with its resolution evidence (bank.manage)
 *   POST /stale                                  raise exceptions for stale timing items (bank.manage)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { Id, IsoDate, type CommandSignature, type SignedAction } from "@kuber/contracts";
import type { Action, Member, SigningIntent } from "@kuber/identity";
import { OpsError } from "@kuber/ops";
import type { Cell } from "./cell.ts";
import { planIntent } from "./signing.ts";

type AttestFor = (req: FastifyRequest, tenant: string, principal: string, assertion: unknown, intent: () => Promise<SigningIntent>) =>
  Promise<((tx: TransactionSql) => Promise<CommandSignature>) | null>;
type SignatureRequired = (reply: FastifyReply, action: SignedAction, reason: string) => unknown;
type Who = (req: FastifyRequest, action: Action, scope?: { book?: string; allBooks?: boolean }) => Promise<{ tenant: string; principal: string; member: Member }>;
type TB = { Params: { tenant: string; book: string } };
type TBI = { Params: { tenant: string; book: string; id: string } };
type TBA = { Params: { tenant: string; book: string; account: string } };
type TBAI = { Params: { tenant: string; book: string; account: string; id: string } };
const Paise = z.string().regex(/^\d{1,12}$/, "whole paise");
const Period = z.object({ bankAccountId: Id, periodEnd: IsoDate, periodFrom: IsoDate.optional() });

export function registerBankRoutes(app: FastifyInstance, cell: Cell, who: Who, attestFor: AttestFor, signatureRequired: SignatureRequired,
                                   Assertion: z.ZodType<Record<string, unknown> | undefined>) {
  const b = cell.bank;
  const base = "/v1/tenants/:tenant/books/:book/bank";

  app.get<TB>(`${base}/accounts`, async (req) => b.accounts((await who(req, "read")).tenant, req.params.book));
  app.post<TB>(`${base}/accounts`, async (req, reply) => {
    const { tenant, principal } = await who(req, "bank.manage");
    const i = z.object({ bankAccountId: Id, glAccountId: Id, bankName: z.string().min(1).max(200), accountNumber: z.string().regex(/^[0-9]{6,20}$/),
      ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/), openingDate: IsoDate, staleDays: z.number().int().min(1).max(3650).optional(),
      feeTolerancePaise: Paise.optional() }).parse(req.body);
    return reply.code(201).send(await b.registerAccount(tenant, req.params.book, principal, i));
  });

  app.get<TB>(`${base}/statements`, async (req) => {
    const t = (await who(req, "read")).tenant;
    return b.statements(t, req.params.book, z.object({ account: Id.optional() }).parse(req.query).account);
  });
  app.post<TB>(`${base}/statements`, async (req, reply) => {
    const { tenant, principal } = await who(req, "capture");
    const Amount = z.string().max(24);
    const i = z.object({ bankAccountId: Id, csv: z.string().min(1).max(4 * 1024 * 1024),
      statementAccount: z.object({ accountNumber: z.string().max(40).optional(), ifsc: z.string().max(20).optional() }).optional(),
      periodFrom: IsoDate.optional(), periodTo: IsoDate.optional(),
      declared: z.object({ opening: Amount.optional(), closing: Amount.optional(), debits: Amount.optional(), credits: Amount.optional(), count: z.number().int().nonnegative().optional() }).optional(),
      provenance: z.enum(["uploaded", "authenticated"]).optional(), feedSignature: z.string().max(2000).optional() }).parse(req.body);
    const r = await b.importStatement(tenant, req.params.book, principal, i);
    // A held statement was retained with an exception, and none of its lines were submitted.
    return reply.code(r.duplicate ? 200 : r.status === "held" ? 202 : 201).send(r);
  });
  app.get<TBI>(`${base}/statements/:id`, async (req) => {
    const t = (await who(req, "read")).tenant;
    const s = await b.statement(t, req.params.id);
    if (!s || s.bookId !== req.params.book) return { error: "not_found" };
    return s;
  });
  app.get<TB>(`${base}/coverage`, async (req) => {
    const t = (await who(req, "read")).tenant;
    const q = z.object({ account: Id, from: IsoDate.optional(), to: IsoDate.optional() }).parse(req.query);
    return b.coverage(t, req.params.book, q.account, { from: q.from, to: q.to });
  });

  app.get<TB>(`${base}/reconciliations`, async (req) => {
    const t = (await who(req, "read")).tenant;
    return b.reconciliations(t, req.params.book, z.object({ account: Id.optional() }).parse(req.query).account);
  });
  app.get<TBA>(`${base}/reconciliations/:account`, async (req) => {
    const t = (await who(req, "read")).tenant;
    const q = z.object({ periodEnd: IsoDate, periodFrom: IsoDate.optional() }).parse(req.query);
    return b.reconciliation(t, req.params.book, req.params.account, q.periodEnd, q.periodFrom);
  });
  app.get<TBAI>(`${base}/reconciliations/:account/:id/verify`, async (req) => b.verifyCertification((await who(req, "read")).tenant, req.params.book, req.params.id));
  // Prepare: a certify plan; the ops guard checks plan.prepare, the operation records the preparer.
  app.post<TB>(`${base}/reconciliations`, async (req, reply) => {
    const { tenant, principal } = await who(req, "read");
    return reply.code(201).send(await cell.ops.plan(tenant, req.params.book, principal, "certify_bank_reconciliation", Period.parse(req.body)));
  });
  // Certify: always a signed command (design 16.4); the certifier's passkey signs this exact plan.
  app.post<TB>(`${base}/certify`, async (req, reply) => {
    const { tenant, principal } = await who(req, "read");
    const i = z.object({ planId: z.string().min(1), hash: z.string().length(64), assertion: Assertion }).parse(req.body);
    const plan = await cell.ops.get(tenant, i.planId);
    if (plan.op !== "certify_bank_reconciliation" || plan.bookId !== req.params.book) throw new OpsError("not_a_certification", `${i.planId} is not a bank reconciliation certification of ${req.params.book}`, 400);
    const approvedBy = plan.status === "proposed" ? await cell.ops.activeApprover(tenant, plan.planId, i.hash, principal) : null;
    let attest: Awaited<ReturnType<AttestFor>> = null;
    if (plan.status === "proposed" && !approvedBy) {
      await cell.identity.check({ step: "commit", tenant, book: plan.bookId, principal, op: { name: plan.op, kind: plan.kind, gate: plan.gate }, plan });
      attest = await attestFor(req, tenant, principal, i.assertion, () => planIntent(cell, tenant, i.planId, i.hash, "plan.commit"));
      if (!attest) return signatureRequired(reply, "plan.commit", "certifying a bank reconciliation");
    }
    const r = await cell.ops.commit(tenant, i.planId, principal, i.hash, attest ? { attest } : {});
    return reply.code(r.status === "committed" ? 200 : 202).send(r);
  });

  app.post<TBI>(`${base}/matches/:id/resolve`, async (req) => {
    const { tenant, principal } = await who(req, "draft.decide");
    const i = z.object({ journalIds: z.array(Id).min(1).max(50).optional(), fee: z.object({ amountPaise: Paise, accountId: Id }).optional(), returnOf: Id.optional() })
      .refine((x) => x.journalIds || x.returnOf, "give journalIds or returnOf").parse(req.body);
    return cell.agent.resolveSettlement(tenant, req.params.id, principal, i);
  });

  app.get<TB>(`${base}/exceptions`, async (req) => {
    const t = (await who(req, "read")).tenant;
    return b.exceptions(t, req.params.book, z.object({ status: z.enum(["open", "resolved"]).optional() }).parse(req.query));
  });
  app.post<TBI>(`${base}/exceptions/:id/resolve`, async (req) => {
    const { tenant, principal } = await who(req, "bank.manage");
    return b.resolveException(tenant, req.params.book, req.params.id, principal, z.object({ resolution: z.string().min(3).max(2000) }).parse(req.body).resolution);
  });
  app.post<TB>(`${base}/stale`, async (req) => {
    const { tenant, principal } = await who(req, "bank.manage");
    const i = z.object({ bankAccountId: Id, asOf: IsoDate }).parse(req.body);
    return b.scanStale(tenant, req.params.book, i.bankAccountId, i.asOf, principal);
  });
}
