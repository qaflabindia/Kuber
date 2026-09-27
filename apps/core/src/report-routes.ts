/**
 * Mapped statements and KPI routes (FIN-RPT-01/02), registered by buildServer behind the same
 * signed request authentication. Every route is a read of one book ("read" in that book's scope).
 *
 *   GET /v1/tenants/:tenant/books/:book/statements                     all statements (current + comparative)
 *   GET /v1/tenants/:tenant/books/:book/statements/export?format=csv|json   export with its SHA-256
 *   GET /v1/tenants/:tenant/books/:book/statements/:kind               balance-sheet | profit-and-loss | cash-flow | equity | notes
 *   GET /v1/tenants/:tenant/books/:book/metrics                        KPIs (ids=a,b to select)
 *   GET /v1/tenants/:tenant/books/:book/metrics/catalogue              definitions, versions, certification
 *   GET /v1/tenants/:tenant/books/:book/metrics/export?format=csv|json
 *   GET /v1/tenants/:tenant/books/:book/metrics/:id                    one KPI
 *   GET /v1/tenants/:tenant/books/:book/metrics/:id/drill              journals, balances and open items behind it
 *
 * Query: from, to (default: the book's fiscal year to date), compareFrom / compareTo (default: the same
 * span a year earlier), comparative=false to omit it, fresh=any|require|wait and timeoutMs as for /reports.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { IsoDate } from "@kuber/contracts";
import type { Action, Member } from "@kuber/identity";
import { FinReportError, fiscalYearOf, type ExportFile, type StatementBundle } from "@kuber/reporting";
import type { Cell } from "./cell.ts";

type Who = (req: FastifyRequest, action: Action, scope?: { book?: string; allBooks?: boolean }) => Promise<{ tenant: string; principal: string; member: Member }>;
type B = { Params: { tenant: string; book: string } };
type BK = { Params: { tenant: string; book: string; kind: string } };
type BI = { Params: { tenant: string; book: string; id: string } };

const Query = z.object({
  from: IsoDate.optional(), to: IsoDate.optional(), compareFrom: IsoDate.optional(), compareTo: IsoDate.optional(),
  comparative: z.enum(["true", "false"]).optional(), ids: z.string().max(500).optional(), format: z.enum(["csv", "json"]).optional(),
  fresh: z.enum(["any", "require", "wait"]).optional(), timeoutMs: z.coerce.number().int().min(0).max(30_000).optional(),
});
const KINDS: Record<string, keyof StatementBundle["statements"]> = {
  "balance-sheet": "balanceSheet", "profit-and-loss": "profitAndLoss", "cash-flow": "cashFlow", equity: "equity", notes: "notes",
};

export function registerReportRoutes(app: FastifyInstance, cell: Cell, who: Who, clock: () => string) {
  const fin = cell.reporting.fin;
  const base = "/v1/tenants/:tenant/books/:book";
  /** The authenticated reader and the validated request (defaults from the book's fiscal year). */
  const input = async (req: FastifyRequest<B>) => {
    const { tenant } = await who(req, "read");
    const q = Query.parse(req.query);
    const st = await cell.gl.state(tenant, req.params.book);
    if (!st.exists) throw new FinReportError("no_book", `book ${req.params.book} does not exist`, 404);
    const today = clock();
    const fy = fiscalYearOf(q.to ?? today, st.config.fiscalYearStartMonth);
    const to = q.to ?? (today < fy.to ? today : fy.to);
    const from = q.from ?? fiscalYearOf(to, st.config.fiscalYearStartMonth).from;
    return { tenant, q, params: { from, to, compareFrom: q.compareFrom ?? null, compareTo: q.compareTo ?? null, comparative: q.comparative !== "false" },
      opts: { freshness: q.fresh ?? "any", timeoutMs: q.timeoutMs ?? 5_000 } as const };
  };
  const handle = <R extends B>(fn: (req: FastifyRequest<R>, reply: FastifyReply) => Promise<unknown>) => async (req: FastifyRequest<R>, reply: FastifyReply) => {
    try { return await fn(req, reply); }
    catch (e) { if (e instanceof FinReportError) return reply.code(e.status).send({ error: e.code, message: e.message }); throw e; }
  };
  const send = (reply: FastifyReply, f: ExportFile) => reply.header("content-type", f.mediaType).header("x-content-sha256", f.sha256)
    .header("content-disposition", `attachment; filename="${f.filename}"`).send(f.content);

  app.get<B>(`${base}/statements`, handle(async (req) => { const i = await input(req); return fin.statements(i.tenant, req.params.book, i.params, i.opts); }));
  app.get<B>(`${base}/statements/export`, handle(async (req, reply) => {
    const i = await input(req);
    return send(reply, fin.exportStatements(await fin.statements(i.tenant, req.params.book, i.params, i.opts), i.q.format ?? "csv"));
  }));
  app.get<BK>(`${base}/statements/:kind`, handle<BK>(async (req, reply) => {
    const k = KINDS[req.params.kind];
    if (!k) return reply.code(404).send({ error: "unknown_statement", message: `no statement ${req.params.kind}; one of ${Object.keys(KINDS).join(", ")}` });
    const i = await input(req);
    const b = await fin.statements(i.tenant, req.params.book, i.params, i.opts);
    return { bookId: b.bookId, book: b.book, mapping: b.mapping, periods: b.periods, basis: b.basis, statement: b.statements[k] };
  }));

  app.get<B>(`${base}/metrics`, handle(async (req) => {
    const i = await input(req);
    return fin.kpis(i.tenant, req.params.book, { ...i.params, ids: i.q.ids?.split(",").map((s) => s.trim()).filter(Boolean) }, i.opts);
  }));
  app.get<B>(`${base}/metrics/catalogue`, handle(async (req) => { await who(req, "read"); return fin.catalogue(); }));
  app.get<B>(`${base}/metrics/export`, handle(async (req, reply) => {
    const i = await input(req);
    const r = await fin.kpis(i.tenant, req.params.book, { ...i.params, ids: i.q.ids?.split(",").map((s) => s.trim()).filter(Boolean) }, i.opts);
    return send(reply, fin.exportKpis(r, i.q.format ?? "csv"));
  }));
  app.get<BI>(`${base}/metrics/:id`, handle<BI>(async (req) => { const i = await input(req); return fin.kpis(i.tenant, req.params.book, { ...i.params, ids: [req.params.id] }, i.opts); }));
  app.get<BI>(`${base}/metrics/:id/drill`, handle<BI>(async (req) => {
    const i = await input(req);
    return fin.kpiDrill(i.tenant, req.params.book, req.params.id, { from: i.params.from, to: i.params.to }, i.opts);
  }));
}
