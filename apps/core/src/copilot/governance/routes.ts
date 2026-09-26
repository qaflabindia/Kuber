/**
 * HTTP routes of the governance layer, registered by buildServer behind the signed-request
 * authentication. Permissions are checked by action name (agent.turns.read; see
 * modules/identity/src/agent-actions.ts for the fallbacks until the System Owner role lands).
 *
 *   GET /v1/tenants/:tenant/books/:book/agent/turns?since=&limit=&before=   TOL-05, AGT-07, LOG-04
 *   GET /v1/tenants/:tenant/books/:book/agent/turns/:turnId                 one turn's sealed record (hashes only)
 *   GET /v1/tenants/:tenant/books/:book/agent/signals?since=                Part VII monitoring signals for the book
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authorizeNamed } from "@kuber/identity";
import type { Cell } from "../../cell.ts";
import type { KuberGovernance } from "./index.ts";

type Authn = (req: FastifyRequest) => Promise<{ tenant: string; principal: string }>;
type BP = { Params: { tenant: string; book: string } };
type TP = { Params: { tenant: string; book: string; turnId: string } };
const When = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "a date or timestamp");

export function registerAgentRoutes(app: FastifyInstance, cell: Cell, gov: KuberGovernance, authn: Authn) {
  const reader = async (req: FastifyRequest & { params: { book: string } }) => {
    const { tenant, principal } = await authn(req);
    await authorizeNamed("agent.turns.read", (a) => cell.identity.authorize(tenant, principal, a, { book: req.params.book }));
    return tenant;
  };
  app.get<BP>("/v1/tenants/:tenant/books/:book/agent/turns", async (req) => {
    const tenant = await reader(req);
    const q = z.object({ since: When.optional(), limit: z.coerce.number().int().min(1).max(500).optional(), before: z.string().max(400).optional() }).parse(req.query);
    return gov.turns(tenant, { book: req.params.book, ...q });
  });
  app.get<TP>("/v1/tenants/:tenant/books/:book/agent/turns/:turnId", async (req, reply) => {
    const tenant = await reader(req);
    const e = await gov.turnEvent(tenant, req.params.turnId);
    if (!e || e.data.bookId !== req.params.book) return reply.code(404).send({ error: "not_found", message: `no turn ${req.params.turnId} in this book` });
    return { eventId: e.eventId, streamId: e.streamId, streamVersion: e.streamVersion, recordedAt: e.recordedAt, record: e.data };
  });
  app.get<BP>("/v1/tenants/:tenant/books/:book/agent/signals", async (req) => {
    const tenant = await reader(req);
    const q = z.object({ since: When.optional() }).parse(req.query);
    return { periods: await gov.stats(tenant, { book: req.params.book, since: q.since }) };
  });
}
