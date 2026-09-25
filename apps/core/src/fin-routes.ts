/**
 * Core HTTP routes for the finance controls. Registered by buildServer, behind the same signed
 * request authentication; each route names the action it performs (who), and the services check
 * the principal again inside the write's transaction (module guard, authority service).
 *
 *   FIN-MDM-04  authority matrix, bands, delegations, related-party conflicts, approve-now-execute-later
 *   FIN-MDM-05  access and master-change review, dispositions
 *   FIN-OPS-03  autonomy kill switch, autonomous error counts
 *   FIN-OPS-02  financial incident register
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TransactionSql } from "postgres";
import type { CommandSignature, SignedAction } from "@kuber/contracts";
import type { SigningIntent } from "@kuber/identity";
import { z } from "zod";
import { AccessDenied, DELEGABLE, REVIEW_DECISIONS, inScope, type Action, type Member } from "@kuber/identity";
import { IsoDate } from "@kuber/contracts";
import type { Cell } from "./cell.ts";
import { autonomyErrors } from "./fin-ops.ts";
import { planIntent } from "./signing.ts";

/** Signed commands (see buildServer): the verifier for a command's transaction, or null when it cannot be confirmed. */
type AttestFor = (req: FastifyRequest, tenant: string, principal: string, assertion: unknown, intent: () => Promise<SigningIntent>) =>
  Promise<((tx: TransactionSql) => Promise<CommandSignature>) | null>;
type SignatureRequired = (reply: FastifyReply, action: SignedAction, reason: string) => unknown;
type Who = (req: FastifyRequest, action: Action, scope?: { book?: string; allBooks?: boolean }) => Promise<{ tenant: string; principal: string; member: Member }>;
type TP = { Params: { tenant: string } };
type TI = { Params: { tenant: string; id: string } };
const Paise = z.string().regex(/^\d{1,18}$/, "whole paise");
const Principal = z.string().regex(/^[a-z_]+:[\w.@-]+$/);
const When = z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), "a date or timestamp");

export function registerFinRoutes(app: FastifyInstance, cell: Cell, who: Who, attestFor: AttestFor, signatureRequired: SignatureRequired,
                                  Assertion: z.ZodType<Record<string, unknown> | undefined>) {
  // ------------------------------------------------------------ FIN-MDM-04 authority matrix
  app.get<TP>("/v1/tenants/:tenant/authority", async (req) => cell.identity.authority.matrix((await who(req, "members.read", { allBooks: true })).tenant));
  app.put<TP>("/v1/tenants/:tenant/authority", async (req) => {
    const { tenant, principal } = await who(req, "authority.manage", { allBooks: true });
    return cell.identity.authority.setMatrix(tenant, principal, z.object({ enabled: z.boolean() }).parse(req.body).enabled);
  });
  app.put<TP>("/v1/tenants/:tenant/authority/bands", async (req) => {
    const { tenant, principal } = await who(req, "authority.manage", { allBooks: true });
    const b = z.object({ action: z.enum(DELEGABLE as [string, ...string[]]), book: z.string().min(1).nullable().default(null), role: z.string(),
      maxPaise: Paise.nullable() }).parse(req.body);
    return cell.identity.authority.setBand(tenant, principal, b);
  });
  app.get<TP>("/v1/tenants/:tenant/delegations", async (req) => {
    const { tenant, principal, member } = await who(req, "read");
    // People see delegations they gave or hold; members.read (owners, controllers, auditors) sees all.
    return cell.identity.authority.delegations(tenant, member.books === null && ["superuser", "controller", "auditor"].includes(member.role) ? {} : { principal });
  });
  app.post<TP>("/v1/tenants/:tenant/delegations", async (req, reply) => {
    const { tenant, principal } = await who(req, "read");                     // holding the action is checked by delegate()
    const b = z.object({ grantee: Principal, action: z.enum(DELEGABLE as [string, ...string[]]), books: z.array(z.string().min(1)).min(1).nullable().default(null),
      maxPaise: Paise, validFrom: When.optional(), validTo: When }).parse(req.body);
    return reply.code(201).send(await cell.identity.authority.delegate(tenant, principal, b));
  });
  app.post<TI>("/v1/tenants/:tenant/delegations/:id/revoke", async (req, reply) => {
    const { tenant, principal } = await who(req, "read");                     // its grantor, or members.manage (checked inside)
    await cell.identity.authority.revokeDelegation(tenant, principal, req.params.id, z.object({ reason: z.string().min(3) }).parse(req.body).reason);
    return reply.code(204).send();
  });
  app.get<TP>("/v1/tenants/:tenant/conflicts", async (req) => cell.identity.authority.relatedParties((await who(req, "members.read", { allBooks: true })).tenant));
  app.post<TP>("/v1/tenants/:tenant/conflicts", async (req, reply) => {
    const { tenant, principal } = await who(req, "conflicts.manage", { allBooks: true });
    const b = z.object({ principal: Principal, partyId: z.string().min(1), note: z.string().min(3) }).parse(req.body);
    // Conflicts are keyed by the party master's ids (FIN-MDM-03), the ids journals and plans carry.
    if (!(await cell.parties.entities(tenant, [b.partyId])).has(b.partyId)) return reply.code(404).send({ error: "no_party", message: `no party ${b.partyId} in the party master` });
    await cell.identity.authority.flagRelatedParty(tenant, principal, b);
    return reply.code(204).send();
  });
  app.post<TP>("/v1/tenants/:tenant/conflicts/clear", async (req, reply) => {
    const { tenant, principal } = await who(req, "conflicts.manage", { allBooks: true });
    await cell.identity.authority.clearRelatedParty(tenant, principal, z.object({ principal: Principal, partyId: z.string().min(1), note: z.string().min(3) }).parse(req.body));
    return reply.code(204).send();
  });
  // Approve now, execute later: role, band, delegation, conflicts and maker-checker in the ops guard.
  app.post<TI>("/v1/tenants/:tenant/plans/:id/approve", async (req, reply) => {
    const { tenant, principal } = await who(req, "read");
    const { hash, assertion } = z.object({ hash: z.string().length(64), assertion: Assertion }).parse(req.body);
    // Approving is the decision: the same signed command as committing (period operations, amounts
    // above the approval limit), asked only after the guard says this person may approve at all.
    // The signature is verified and stored with PlanApprovalRecorded in the approval's transaction.
    const plan = await cell.ops.get(tenant, req.params.id);
    let attest: ((tx: TransactionSql) => Promise<CommandSignature>) | null = null;
    if (plan.status === "proposed" && plan.kind === "write") {
      await cell.identity.check({ step: "approve", tenant, book: plan.bookId, principal, op: { name: plan.op, kind: plan.kind, gate: plan.gate }, plan });
      const reason = await cell.identity.stepUpReason(tenant, plan);
      if (reason) {
        attest = await attestFor(req, tenant, principal, assertion, () => planIntent(cell, tenant, req.params.id, hash, "plan.approve"));
        if (!attest) return signatureRequired(reply, "plan.approve", reason);
      }
    }
    return cell.ops.approve(tenant, req.params.id, principal, hash, attest ? { attest } : {});
  });
  app.get<TI>("/v1/tenants/:tenant/plans/:id/approvals", async (req) => {
    const { tenant, member } = await who(req, "read");
    const p = await cell.ops.get(tenant, req.params.id);
    if (!inScope(member, p.bookId)) throw new AccessDenied(`plan ${req.params.id} is outside your books`);
    return cell.ops.approvals(tenant, req.params.id);
  });

  // ------------------------------------------------------------ FIN-MDM-05 access review
  app.get<TP>("/v1/tenants/:tenant/access-review", async (req) => {
    const { tenant } = await who(req, "members.read", { allBooks: true });
    const q = z.object({ since: IsoDate.optional(), dormantDays: z.coerce.number().int().min(1).max(3650).optional() }).parse(req.query);
    return cell.identity.accessReview.report(tenant, q);
  });
  app.post<TP>("/v1/tenants/:tenant/access-review/dispositions", async (req, reply) => {
    const { tenant, principal } = await who(req, "access.review", { allBooks: true });
    const b = z.object({ itemId: z.string().min(1).max(200), decision: z.enum(REVIEW_DECISIONS), note: z.string().min(1).max(2000) }).parse(req.body);
    return reply.code(201).send(await cell.identity.accessReview.dispose(tenant, principal, b.itemId, b));
  });

  // ------------------------------------------------------------ FIN-OPS-03 kill switch
  app.get<TP>("/v1/tenants/:tenant/autonomy", async (req) => {
    const { tenant } = await who(req, "read", { allBooks: true });
    return { switches: await cell.identity.autonomy.status(tenant), errors: await autonomyErrors(cell.store, tenant) };
  });
  const Switch = z.object({ reason: z.string().min(3).max(500), book: z.string().min(1).nullable().default(null) });
  for (const [path, halted] of [["halt", true], ["resume", false]] as const) {
    app.post<TP>(`/v1/tenants/:tenant/autonomy/${path}`, async (req) => {
      const b = Switch.parse(req.body);
      const { tenant, principal } = await who(req, "autonomy.manage", b.book ? { book: b.book } : { allBooks: true });
      return cell.identity.autonomy.set(tenant, principal, { book: b.book, halted, reason: b.reason });
    });
  }

  // ------------------------------------------------------------ FIN-OPS-02 incidents
  app.get<TP>("/v1/tenants/:tenant/incidents", async (req) => {
    const { tenant } = await who(req, "read", { allBooks: true });
    const q = z.object({ status: z.enum(["open", "contained", "closed", "unclosed"]).optional() }).parse(req.query);
    return cell.incidents.list(tenant, q);
  });
  app.get<TI>("/v1/tenants/:tenant/incidents/:id", async (req) => cell.incidents.get((await who(req, "read", { allBooks: true })).tenant, req.params.id));
  app.post<TP>("/v1/tenants/:tenant/incidents", async (req, reply) => {
    const { tenant, principal } = await who(req, "incident.manage", { allBooks: true });
    const b = z.object({ title: z.string().min(3).max(200), description: z.string().min(3).max(4000), books: z.array(z.string().min(1)).min(1),
      periods: z.array(z.string().min(1)).min(1), possibleLossPaise: Paise, duplication: z.boolean(), owner: Principal.optional() }).parse(req.body);
    return reply.code(201).send(await cell.incidents.open(tenant, principal, { ...b, owner: b.owner ?? principal }));
  });
  app.post<TI>("/v1/tenants/:tenant/incidents/:id/update", async (req) => {
    const { tenant, principal } = await who(req, "incident.manage", { allBooks: true });
    const b = z.object({ containment: z.string().min(3).max(4000).optional(), corrections: z.array(z.string().min(1)).optional(),
      owner: Principal.optional(), note: z.string().max(4000).optional() }).parse(req.body);
    return cell.incidents.update(tenant, principal, req.params.id, b);
  });
  app.post<TI>("/v1/tenants/:tenant/incidents/:id/close", async (req) => {
    const { tenant, principal } = await who(req, "incident.manage", { allBooks: true });
    const b = z.object({ reconciliationRef: z.string().min(1).max(200), note: z.string().max(4000).optional() }).parse(req.body);
    return cell.incidents.close(tenant, principal, req.params.id, b);
  });
}
