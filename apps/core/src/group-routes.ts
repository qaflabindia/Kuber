/**
 * Group consolidation routes (FIN-GRP-01..04), registered by buildServer behind the same signed
 * request authentication. Writes to the register, the consolidation book and the group close are
 * ops plans on the group's consolidation book: these routes simulate them, and the plan is committed
 * through POST /v1/tenants/:tenant/plans/:id/commit like any other (a person, gate "human").
 *
 *   GET  /groups                                  groups of this tenant
 *   POST /groups                                  define a group and open its consolidation book
 *   GET  /groups/:group                           structure, ownership register, IC links, runs, closes
 *   POST /groups/:group/structure | ownership | ic-links      plan a register change
 *   GET  /groups/:group/ic-matches?periodEnd=     matched / in transit / mismatched / disputed
 *   GET  /groups/:group/disputes                  POST: open a dispute on an item
 *   POST /groups/:group/disputes/:id/positions    one side's approver records its position
 *   POST /groups/:group/disputes/:id/adjustments  propose each side's own ic_adjust plan
 *   POST /groups/:group/consolidate               plan the consolidation run
 *   POST /groups/:group/certify                   plan the certified group close
 *   GET  /groups/:group/closes[/:id[/reproduce]]  certified closes, versions, rerun check
 *   GET  /groups/:group/reports/{trial-balance,profit-and-loss,balance-sheet,nci,perimeter}
 *   GET  /groups/links                            link consent records of this tenant
 *   POST /groups/:group/links                     request a link (group superuser)
 *   POST /groups/links/:id/accept | revoke        subsidiary accepts; either side revokes
 *   POST /groups/links/:id/packs                  subsidiary publishes a certified pack
 *   GET  /groups/:group/packs                     packs received (availability shown)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Id, IsoDate } from "@kuber/contracts";
import type { Action, Member } from "@kuber/identity";
import { ConsolidationError } from "@kuber/consolidation";
import type { Cell } from "./cell.ts";

type Who = (req: FastifyRequest, action: Action, scope?: { book?: string; allBooks?: boolean }) => Promise<{ tenant: string; principal: string; member: Member }>;
type TG = { Params: { tenant: string; group: string } };
type TGI = { Params: { tenant: string; group: string; id: string } };
type TI = { Params: { tenant: string; id: string } };
const Period = z.object({ periodEnd: IsoDate.optional() });

export function registerGroupRoutes(app: FastifyInstance, cell: Cell, who: Who) {
  const c = cell.consolidation;
  const groupOf = async (tenant: string, groupId: string) => {
    const g = await c.group(tenant, groupId);
    if (!g.exists) throw new ConsolidationError("no_group", `no group ${groupId}`, 404);
    return g;
  };
  /** Membership and the group's consolidation book scope here; role and maker-checker in the ops guard. */
  const plan = (op: string, input: (req: FastifyRequest) => unknown) => async (req: FastifyRequest<TG>) => {
    const { tenant, principal } = await who(req, "read", { book: (await groupOf(req.params.tenant, req.params.group)).bookId });
    return cell.ops.plan(tenant, (await groupOf(tenant, req.params.group)).bookId, principal, op, input(req));
  };

  app.get<{ Params: { tenant: string } }>("/v1/tenants/:tenant/groups", async (req) => c.groups((await who(req, "read")).tenant));
  app.post<{ Params: { tenant: string } }>("/v1/tenants/:tenant/groups", async (req, reply) => {
    const { tenant, principal } = await who(req, "book.open", { allBooks: true });
    const b = z.object({ groupId: Id, name: z.string().min(1).max(200), bookId: Id, parentEntityId: Id }).parse(req.body);
    const g = await c.defineGroup(tenant, principal, b);
    return reply.code(201).send({ groupId: g.groupId, bookId: g.bookId, parentEntityId: g.parentEntityId, registerVersion: g.version });
  });
  app.get<{ Params: { tenant: string } }>("/v1/tenants/:tenant/groups/links", async (req) => c.links.list((await who(req, "settings.manage", { allBooks: true })).tenant));
  app.post<TI>("/v1/tenants/:tenant/groups/links/:id/accept", async (req) => {
    const { tenant, principal } = await who(req, "settings.manage", { allBooks: true });
    return c.links.accept(tenant, principal, req.params.id);
  });
  app.post<TI>("/v1/tenants/:tenant/groups/links/:id/revoke", async (req) => {
    const { tenant, principal } = await who(req, "settings.manage", { allBooks: true });
    return c.links.revoke(tenant, principal, req.params.id, z.object({ reason: z.string().min(3).max(500) }).parse(req.body).reason);
  });
  app.post<TI>("/v1/tenants/:tenant/groups/links/:id/packs", async (req, reply) => {
    const b = z.object({ bookId: Id, periodEnd: IsoDate, icParties: z.record(z.string(), Id).optional(),
      ownershipFacts: z.array(z.object({ childEntityId: Id, ownershipBp: z.number().int().min(0).max(10000), votingBp: z.number().int().min(0).max(10000) })).optional() }).parse(req.body);
    const { tenant, principal } = await who(req, "plan.approve.period", { book: b.bookId });
    return reply.code(201).send(await c.links.publish(tenant, principal, req.params.id, b));
  });

  app.get<TG>("/v1/tenants/:tenant/groups/:group", async (req) => {
    const g = await groupOf(req.params.tenant, req.params.group);
    const { tenant } = await who(req, "read", { book: g.bookId });
    return { groupId: g.groupId, name: g.name, bookId: g.bookId, parentEntityId: g.parentEntityId, registerVersion: g.version, entities: g.entities,
      mapping: [...g.mapping].map(([k, v]) => ({ entityId: k.split("|")[0], accountId: k.split("|")[1], ...v })), ownership: g.ownership, icLinks: g.icLinks,
      runs: await c.runs(tenant, g.groupId), closes: await c.closes(tenant, g.groupId) };
  });
  app.post<TG>("/v1/tenants/:tenant/groups/:group/structure", plan("group_structure", (r) => r.body ?? {}));
  app.post<TG>("/v1/tenants/:tenant/groups/:group/ownership", plan("group_ownership", (r) => r.body ?? {}));
  app.post<TG>("/v1/tenants/:tenant/groups/:group/ic-links", plan("group_ic_link", (r) => r.body ?? {}));
  app.post<TG>("/v1/tenants/:tenant/groups/:group/consolidate", plan("consolidate", (r) => r.body ?? {}));
  app.post<TG>("/v1/tenants/:tenant/groups/:group/certify", plan("certify_group", (r) => r.body ?? {}));
  app.get<TG>("/v1/tenants/:tenant/groups/:group/ic-matches", plan("ic_mismatches", (r) => Period.parse(r.query)));
  for (const [path, op] of [["trial-balance", "group_trial_balance"], ["profit-and-loss", "group_pnl"], ["balance-sheet", "group_balance_sheet"], ["nci", "nci"]] as const)
    app.get<TG>(`/v1/tenants/:tenant/groups/:group/reports/${path}`, plan(op, (r) => Period.parse(r.query)));
  app.get<TG>("/v1/tenants/:tenant/groups/:group/reports/perimeter", plan("group_perimeter", (r) => z.object({ asOf: IsoDate.optional() }).parse(r.query)));

  app.get<TG>("/v1/tenants/:tenant/groups/:group/disputes", async (req) => {
    const g = await groupOf(req.params.tenant, req.params.group);
    return c.disputeViews((await who(req, "read", { book: g.bookId })).tenant, g.groupId);
  });
  app.post<TG>("/v1/tenants/:tenant/groups/:group/disputes", async (req, reply) => {
    const { tenant, principal } = await who(req, "read");                       // either side's plan.prepare: checked inside
    const b = z.object({ itemKey: z.string().min(1).max(500), periodEnd: IsoDate, reason: z.string().min(3).max(2000) }).parse(req.body);
    return reply.code(201).send(await c.openDispute(tenant, principal, req.params.group, b));
  });
  app.post<TGI>("/v1/tenants/:tenant/groups/:group/disputes/:id/positions", async (req) => {
    const { tenant, principal } = await who(req, "read");                       // that side's plan.approve: checked inside
    const b = z.object({ entityId: Id, agreedPaise: z.string().regex(/^\d{1,18}$/), note: z.string().min(3).max(2000) }).parse(req.body);
    return c.recordPosition(tenant, principal, req.params.id, { entityId: b.entityId, agreedPaise: BigInt(b.agreedPaise), note: b.note });
  });
  app.post<TGI>("/v1/tenants/:tenant/groups/:group/disputes/:id/adjustments", async (req) => {
    const { tenant, principal } = await who(req, "read");                       // plan.prepare in each side's book: ops guard
    const b = z.object({ accounts: z.record(z.string(), z.string().min(1)), date: IsoDate.optional() }).parse(req.body);
    return c.proposeAdjustments(tenant, principal, req.params.id, b.accounts, b.date ? { date: b.date } : {});
  });
  app.get<TG>("/v1/tenants/:tenant/groups/:group/closes", async (req) => {
    const g = await groupOf(req.params.tenant, req.params.group);
    return c.closes((await who(req, "read", { book: g.bookId })).tenant, g.groupId);
  });
  app.get<TGI>("/v1/tenants/:tenant/groups/:group/closes/:id", async (req, reply) => {
    const g = await groupOf(req.params.tenant, req.params.group);
    const s = await c.close((await who(req, "read", { book: g.bookId })).tenant, req.params.id);
    return s && s.body.groupId === g.groupId ? s : reply.code(404).send({ error: "no_snapshot", message: `no close ${req.params.id} in group ${g.groupId}` });
  });
  app.get<TGI>("/v1/tenants/:tenant/groups/:group/closes/:id/reproduce", async (req) => {
    const g = await groupOf(req.params.tenant, req.params.group);
    const r = await c.reproduce((await who(req, "read", { book: g.bookId })).tenant, req.params.id);
    return { snapshotId: r.snapshot.snapshotId, version: r.snapshot.version, storedHash: r.snapshot.contentHash, recomputedHash: r.contentHash, matches: r.matches };
  });
  app.post<TG>("/v1/tenants/:tenant/groups/:group/links", async (req, reply) => {
    const { tenant, principal } = await who(req, "settings.manage", { allBooks: true });
    const b = z.object({ subsidiaryTenant: Id, entityId: Id }).parse(req.body);
    return reply.code(201).send(await c.links.request(tenant, principal, { ...b, groupId: req.params.group }));
  });
  app.get<TG>("/v1/tenants/:tenant/groups/:group/packs", async (req) => {
    const g = await groupOf(req.params.tenant, req.params.group);
    const { tenant } = await who(req, "read", { book: g.bookId });
    const packs = await c.links.packs(tenant);
    return Promise.all(packs.map(async (p) => { const o = await c.links.open(tenant, p.pack_id); return { ...p, available: o.available, ...(o.available ? {} : { reason: o.reason }) }; }));
  });
}
