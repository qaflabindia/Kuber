/**
 * Core HTTP routes for the external roles (role model v2). Registered by buildServer behind the
 * same signed-request authentication. Each route names its action (who), and the Portal service
 * filters every read to the caller's own party, published snapshots or current shares.
 *
 *   /v1/tenants/:t/portal/customer            statement, open items, payments received (portal.customer.read)
 *   /v1/tenants/:t/portal/customer/queries    raise and list queries (portal.customer.query / .read)
 *   /v1/tenants/:t/portal/supplier            bills and payment status (portal.supplier.read)
 *   /v1/tenants/:t/portal/supplier/bank-change  bank-detail change request (portal.supplier.bank_request)
 *   /v1/tenants/:t/portal/investor/snapshots  published certified snapshots (investor.read)
 *   /v1/tenants/:t/snapshots/:id/publish      publish or withdraw a snapshot for investors (snapshot.publish)
 *   /v1/tenants/:t/shares                     grant (share.grant) and list shares
 *   /v1/tenants/:t/shares/mine, /shares/:id   a guest's current shares and the shared item (share.read)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Action, Member } from "@kuber/identity";
import { BankDetails, IsoDate, Principal } from "@kuber/contracts";
import type { Cell } from "./cell.ts";

type Who = (req: FastifyRequest, action: Action, scope?: { book?: string; allBooks?: boolean }) => Promise<{ tenant: string; principal: string; member: Member }>;
type TP = { Params: { tenant: string } };
type TI = { Params: { tenant: string; id: string } };

export function registerPortalRoutes(app: FastifyInstance, cell: Cell, who: Who) {
  // ------------------------------------------------------------ customer
  app.get<TP>("/v1/tenants/:tenant/portal/customer", async (req) => {
    const { tenant, principal } = await who(req, "portal.customer.read");
    return cell.portal.customer(tenant, principal);
  });
  app.get<TP>("/v1/tenants/:tenant/portal/customer/queries", async (req) => {
    const { tenant, principal } = await who(req, "portal.customer.read");
    return cell.portal.queries(tenant, principal);
  });
  app.post<TP>("/v1/tenants/:tenant/portal/customer/queries", async (req, reply) => {
    const { tenant, principal } = await who(req, "portal.customer.query");
    const b = z.object({ subject: z.string().min(2).max(200), message: z.string().min(2).max(4000), reference: z.string().max(200).optional() }).parse(req.body);
    return reply.code(201).send(await cell.portal.query(tenant, principal, b));
  });

  // ------------------------------------------------------------ supplier
  app.get<TP>("/v1/tenants/:tenant/portal/supplier", async (req) => {
    const { tenant, principal } = await who(req, "portal.supplier.read");
    return cell.portal.supplier(tenant, principal);
  });
  app.post<TP>("/v1/tenants/:tenant/portal/supplier/bank-change", async (req, reply) => {
    const { tenant, principal } = await who(req, "portal.supplier.bank_request");
    const b = z.object({ bank: BankDetails, effectiveFrom: IsoDate.optional() }).parse(req.body);
    return reply.code(202).send(await cell.portal.bankRequest(tenant, principal, b));
  });

  // ------------------------------------------------------------ investor
  app.get<TP>("/v1/tenants/:tenant/portal/investor/snapshots", async (req) => {
    const { tenant, principal } = await who(req, "investor.read");
    return cell.portal.investorSnapshots(tenant, principal);
  });
  app.get<TI>("/v1/tenants/:tenant/portal/investor/snapshots/:id", async (req) => {
    const { tenant, principal } = await who(req, "investor.read");
    return cell.portal.investorSnapshot(tenant, principal, req.params.id);
  });
  app.post<TI>("/v1/tenants/:tenant/snapshots/:id/publish", async (req) => {
    const { tenant, principal } = await who(req, "snapshot.publish");
    const b = z.object({ published: z.boolean().default(true) }).parse(req.body ?? {});
    return cell.portal.publish(tenant, principal, req.params.id, b.published);
  });

  // ------------------------------------------------------------ guest shares
  app.get<TP>("/v1/tenants/:tenant/shares", async (req) => {
    const { tenant, principal } = await who(req, "share.grant", { allBooks: true });
    return cell.identity.shares(tenant, principal);
  });
  app.post<TP>("/v1/tenants/:tenant/shares", async (req, reply) => {
    const { tenant, principal } = await who(req, "share.grant", { allBooks: true });
    const b = z.object({ grantee: Principal, itemType: z.enum(["snapshot", "report"]), itemId: z.string().min(1).max(200), expiresAt: z.string().min(10) }).parse(req.body);
    return reply.code(201).send(await cell.identity.grantShare(tenant, principal, b));
  });
  app.post<TI>("/v1/tenants/:tenant/shares/:id/revoke", async (req, reply) => {
    const { tenant, principal } = await who(req, "share.grant", { allBooks: true });
    await cell.identity.revokeShare(tenant, principal, req.params.id);
    return reply.code(204).send();
  });
  app.get<TP>("/v1/tenants/:tenant/shares/mine", async (req) => {
    const { tenant, principal } = await who(req, "share.read");
    return cell.portal.shares(tenant, principal);
  });
  app.get<TI>("/v1/tenants/:tenant/shares/:id", async (req) => {
    const { tenant, principal } = await who(req, "share.read");
    return cell.portal.shared(tenant, principal, req.params.id);
  });
}
