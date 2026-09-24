/**
 * FIN-OPS-02: the financial incident register. One record per incident that may have cost money
 * or duplicated postings: the affected tenant, books and periods; the possible loss (paise) and
 * whether postings may be duplicated; an owner; containment; corrections (journal ids of the
 * correcting entries); and closure.
 *
 *   open(by, …)                 incident.manage; the owner must be an active person in the workspace
 *   update(by, id, …)           containment (moves it to 'contained'), corrections, owner, note
 *   close(by, id, {reconciliationRef})
 *                               needs a reconciliation reference (the reconciliation that shows the
 *                               books are right again) and is approved by someone other than the owner
 *
 * Every change is an event in `<tenant>/incident/<id>` (actor in the metadata), written in the same
 * transaction as the register row. Every write passes the module guard (the identity service).
 */
import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { Id, Principal } from "@kuber/contracts";
import type { EventStore, ModuleGuard } from "@kuber/eventstore";
import { incidentDetailCtx } from "./fin-migrations.ts";

export class IncidentError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

export interface IncidentInput {
  title: string; description: string; books: string[]; periods: string[];
  /** Possible loss or exposure, whole paise. */
  possibleLossPaise: string; duplication: boolean; owner: string;
}
export interface Incident extends IncidentInput {
  incidentId: string; status: "open" | "contained" | "closed"; containment: string | null; corrections: string[]; notes: string[];
  reconciliationRef: string | null; openedBy: string; openedAt: string; closedBy: string | null; closedAt: string | null;
}
interface Detail { title: string; description: string; containment: string | null; notes: string[] }
type Row = { incident_id: string; status: Incident["status"]; owner: string; books: string[]; periods: string[]; possible_loss_paise: string;
  duplication: boolean; corrections: string[]; detail: string; reconciliation_ref: string | null; opened_by: string; opened_at: Date;
  closed_by: string | null; closed_at: Date | null };

const PERIOD = /^(\d{4}-\d{2}|\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?|FY\d{4}-\d{2})$/;

export class Incidents {
  constructor(private store: EventStore, private guard: ModuleGuard) {}

  private bad(msg: string) { return new IncidentError("bad_input", msg, 400); }
  private validate(i: Partial<IncidentInput>) {
    if (i.title !== undefined && (i.title.trim().length < 3 || i.title.length > 200)) throw this.bad("title: 3 to 200 characters");
    if (i.books !== undefined && (!i.books.length || !i.books.every((b) => Id.safeParse(b).success))) throw this.bad("books: at least one book id");
    if (i.periods !== undefined && (!i.periods.length || !i.periods.every((p) => PERIOD.test(p)))) throw this.bad("periods: YYYY-MM, YYYY-MM-DD, a range YYYY-MM-DD..YYYY-MM-DD or FYyyyy-yy");
    if (i.possibleLossPaise !== undefined && !/^\d{1,18}$/.test(i.possibleLossPaise)) throw this.bad("possibleLossPaise: whole paise");
    if (i.owner !== undefined && !Principal.safeParse(i.owner).success) throw this.bad(`owner: ${i.owner} is not a principal`);
  }
  /** The owner is an active person who may read the register. */
  private async checkOwner(tx: TransactionSql, tenant: string, owner: string) {
    if (/^(agent|system):/.test(owner)) throw this.bad("an incident is owned by a person");
    await this.guard.permit(tenant, owner, "read", { allBooks: true }, tx);
  }
  private async event(tx: TransactionSql, tenant: string, id: string, by: string, type: "IncidentOpened" | "IncidentUpdated" | "IncidentClosed", data: object) {
    await this.store.append("ops", tenant, { streamId: `${tenant}/incident/${id}`, expected: "any", events: [{ type, data: data as never }] }, { principal: by }, tx);
  }

  async open(tenant: string, by: string, i: IncidentInput): Promise<Incident> {
    this.validate(i);
    if (i.description.trim().length < 3) throw this.bad("description: say what happened");
    const id = `inc-${randomUUID()}`, keys = await this.store.keys(tenant);
    const detail: Detail = { title: i.title.trim(), description: i.description.trim(), containment: null, notes: [] };
    await this.store.tenantTx(tenant, async (tx) => {
      await this.guard.permit(tenant, by, "incident.manage", { allBooks: true }, tx);
      await this.checkOwner(tx, tenant, i.owner);
      await tx`INSERT INTO ops.incidents (tenant_id, incident_id, owner, books, periods, possible_loss_paise, duplication, detail, opened_by)
        VALUES (${tenant}, ${id}, ${i.owner}, ${i.books}, ${i.periods}, ${i.possibleLossPaise}, ${i.duplication},
                ${keys.sealJson(detail, incidentDetailCtx(id))}, ${by})`;
      await this.event(tx, tenant, id, by, "IncidentOpened", { incidentId: id, title: detail.title, description: detail.description, books: i.books,
        periods: i.periods, possibleLossPaise: i.possibleLossPaise, duplication: i.duplication, owner: i.owner });
    });
    return this.get(tenant, id);
  }

  /** Record containment, add correcting journal ids, hand over ownership or add a note. */
  async update(tenant: string, by: string, id: string, u: { containment?: string; corrections?: string[]; owner?: string; note?: string }): Promise<Incident> {
    this.validate({ owner: u.owner });
    if (u.corrections && !u.corrections.every((j) => Id.safeParse(j).success)) throw this.bad("corrections: journal ids");
    if (u.containment !== undefined && u.containment.trim().length < 3) throw this.bad("containment: say what was done");
    const keys = await this.store.keys(tenant);
    await this.store.tenantTx(tenant, async (tx) => {
      await this.guard.permit(tenant, by, "incident.manage", { allBooks: true }, tx);
      const r = await this.row(tx, tenant, id, true);
      if (r.status === "closed") throw new IncidentError("closed", `incident ${id} is closed`);
      if (u.owner) await this.checkOwner(tx, tenant, u.owner);
      const d = keys.openJson<Detail>(r.detail, incidentDetailCtx(id));
      if (u.containment) d.containment = u.containment.trim();
      if (u.note?.trim()) d.notes.push(`${new Date().toISOString()} ${by}: ${u.note.trim()}`);
      const corrections = [...new Set([...r.corrections, ...(u.corrections ?? [])])];
      const status = d.containment ? "contained" : "open";
      await tx`UPDATE ops.incidents SET status = ${status}, owner = ${u.owner ?? r.owner}, corrections = ${corrections},
        detail = ${keys.sealJson(d, incidentDetailCtx(id))}, updated_at = now() WHERE tenant_id = ${tenant} AND incident_id = ${id}`;
      await this.event(tx, tenant, id, by, "IncidentUpdated", { incidentId: id, status, ...(u.containment ? { containment: d.containment! } : {}),
        ...(u.corrections ? { corrections: u.corrections } : {}), ...(u.owner ? { owner: u.owner } : {}), ...(u.note?.trim() ? { note: u.note.trim() } : {}) });
    });
    return this.get(tenant, id);
  }

  /** Close: a reconciliation reference, approved by someone other than the incident's owner. */
  async close(tenant: string, by: string, id: string, c: { reconciliationRef: string; note?: string }): Promise<Incident> {
    const ref = (c.reconciliationRef ?? "").trim();
    if (!ref) throw new IncidentError("reconciliation_required", "closing an incident needs a reconciliation reference", 400);
    await this.store.tenantTx(tenant, async (tx) => {
      await this.guard.permit(tenant, by, "incident.manage", { allBooks: true }, tx);
      const r = await this.row(tx, tenant, id, true);
      if (r.status === "closed") throw new IncidentError("closed", `incident ${id} is already closed`);
      if (r.owner === by) throw new IncidentError("forbidden", `the owner (${by}) cannot approve closing their own incident; someone else must`, 403);
      await tx`UPDATE ops.incidents SET status = 'closed', reconciliation_ref = ${ref}, closed_by = ${by}, closed_at = now(), updated_at = now()
        WHERE tenant_id = ${tenant} AND incident_id = ${id}`;
      await this.event(tx, tenant, id, by, "IncidentClosed", { incidentId: id, reconciliationRef: ref, owner: r.owner, approvedBy: by,
        ...(c.note?.trim() ? { note: c.note.trim() } : {}) });
    });
    return this.get(tenant, id);
  }

  private async row(tx: TransactionSql, tenant: string, id: string, lock = false): Promise<Row> {
    const [r] = lock
      ? await tx<Row[]>`SELECT incident_id, status, owner, books, periods, possible_loss_paise::text, duplication, corrections, detail, reconciliation_ref,
          opened_by, opened_at, closed_by, closed_at FROM ops.incidents WHERE tenant_id = ${tenant} AND incident_id = ${id} FOR UPDATE`
      : await tx<Row[]>`SELECT incident_id, status, owner, books, periods, possible_loss_paise::text, duplication, corrections, detail, reconciliation_ref,
          opened_by, opened_at, closed_by, closed_at FROM ops.incidents WHERE tenant_id = ${tenant} AND incident_id = ${id}`;
    if (!r) throw new IncidentError("not_found", `no incident ${id}`, 404);
    return r;
  }

  private async view(tenant: string, r: Row): Promise<Incident> {
    const d = (await this.store.keys(tenant)).openJson<Detail>(r.detail, incidentDetailCtx(r.incident_id));
    return { incidentId: r.incident_id, status: r.status, title: d.title, description: d.description, books: r.books, periods: r.periods,
      possibleLossPaise: r.possible_loss_paise, duplication: r.duplication, owner: r.owner, containment: d.containment, corrections: r.corrections,
      notes: d.notes, reconciliationRef: r.reconciliation_ref, openedBy: r.opened_by, openedAt: r.opened_at.toISOString(),
      closedBy: r.closed_by, closedAt: r.closed_at?.toISOString() ?? null };
  }

  async get(tenant: string, id: string): Promise<Incident> {
    return this.view(tenant, await this.store.tenantTx(tenant, (tx) => this.row(tx, tenant, id)));
  }

  async list(tenant: string, f: { status?: "open" | "contained" | "closed" | "unclosed" } = {}): Promise<Incident[]> {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<Row[]>`
      SELECT incident_id, status, owner, books, periods, possible_loss_paise::text, duplication, corrections, detail, reconciliation_ref,
             opened_by, opened_at, closed_by, closed_at FROM ops.incidents WHERE tenant_id = ${tenant}
        ${f.status === "unclosed" ? tx`AND status <> 'closed'` : f.status ? tx`AND status = ${f.status}` : tx``}
      ORDER BY opened_at DESC, incident_id`);
    return Promise.all(rows.map((r) => this.view(tenant, r)));
  }
}
