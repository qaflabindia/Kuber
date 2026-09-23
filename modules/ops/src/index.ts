/**
 * Operations service: one entry point for the UI, the copilot and MCP clients.
 *
 *   plan(op, input)  -> simulate; write plans are stored as "proposed" with a hash
 *   commit(id, hash) -> re-verify hash and book version, check authority, execute
 *   discard(id)      -> withdraw a proposal
 *
 * Authority: a person (any non-agent principal) may commit what they have seen. An agent may
 * commit only when the operation's gate is "policy" and the policy grants L3 or higher; everything
 * else waits for a person. Period operations (allocate, rebalance, close, carry-forward) are
 * gated "human" and always wait.
 */
import type { Sql } from "postgres";
import { canonical, sha256, uuid, type Line } from "@kuber/contracts";
import { tenantRlsFor, type EventStore, type Migration } from "@kuber/eventstore";
import { DomainError, type BookState } from "@kuber/gl";
import { balancesFromState } from "./math.ts";
import { OPERATIONS } from "./operations.ts";
import type { Action, Effect, OpContext, OpDef, OpName, Plan, PlanJournal, Services } from "./types.ts";

export * from "./types.ts";
export { OPERATIONS } from "./operations.ts";
export { balancesFromState, splitByWeights, rebalanceTransfers, financialYear, pctToBp } from "./math.ts";

export const OPS_MIGRATIONS: Migration[] = [{
  id: "ops-001",
  sql: `
CREATE SCHEMA IF NOT EXISTS ops;
CREATE TABLE ops.plans (
  tenant_id TEXT NOT NULL, plan_id TEXT NOT NULL, book_id TEXT NOT NULL, op TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','committed','discarded','stale')),
  plan JSONB NOT NULL, actions JSONB NOT NULL, hash TEXT NOT NULL, basis_seq INT NOT NULL,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by TEXT, resolved_at TIMESTAMPTZ, result JSONB,
  PRIMARY KEY (tenant_id, plan_id));
CREATE INDEX plans_open ON ops.plans (tenant_id, book_id, created_at DESC) WHERE status = 'proposed';
` + tenantRlsFor("ops"),
}];

export class OpsError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

const RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
export const isAgent = (principal: string) => /^(agent|system):/.test(principal);

export class Operations {
  readonly defs = new Map<OpName, OpDef<any>>(OPERATIONS.map((d) => [d.name, d]));
  constructor(private sql: Sql, private store: EventStore, private svc: Services, private clock: () => string = () => new Date().toISOString().slice(0, 10)) {}

  list() {
    return [...this.defs.values()].map(({ name, title, description, kind, gate, event }) => ({ name, title, description, kind, gate, event: event ?? null }));
  }

  async plan(tenant: string, book: string, principal: string, op: string, rawInput: unknown): Promise<Plan> {
    const def = this.defs.get(op as OpName);
    if (!def) throw new OpsError("unknown_op", `no operation ${op}`, 404);
    const parsed = def.input.safeParse(rawInput ?? {});
    if (!parsed.success) throw new OpsError("bad_input", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), 400);
    const state = await this.svc.gl.state(tenant, book);
    if (!state.exists) throw new OpsError("no_book", `book ${book} does not exist`, 404);
    const ctx: OpContext = { tenant, book, principal, today: this.clock(), state, svc: this.svc };
    const d = await def.plan(ctx, parsed.data);

    const journals = journalsOf(state, d.actions, d.data);
    const effects = effectsOf(state, journals);
    const decision = def.event ? this.svc.policies.decide({ eventCode: def.event, on: ctx.today, amountPaise: d.amountPaise, confidence: 1 }) : null;
    const checks = d.checks ?? [];
    const blocked = checks.some((c) => c.blocking && !c.ok);
    // A blocked plan is shown, never stored: there is nothing anyone could approve.
    const committable = def.kind === "write" && !blocked;
    const plan: Plan = {
      planId: uuid(), op: def.name, bookId: book, kind: def.kind, gate: def.gate, title: d.title, summary: d.summary,
      policy: decision ? { ids: decision.policyIds, level: decision.level, approver: decision.approver, reasons: decision.reasons } : null,
      checks, journals, effects, sections: d.sections ?? [], data: d.data, notes: d.notes ?? [], links: d.links ?? [],
      basisSeq: state.seq, createdAt: new Date().toISOString(), createdBy: principal, hash: "",
      status: committable ? "proposed" : "preview", blocked,
      needsPerson: def.gate === "human" || !decision || RANK[decision.level]! < 3,
    };
    plan.hash = sha256(canonical({ op: plan.op, book, basisSeq: plan.basisSeq, actions: d.actions }));
    if (committable) {
      await this.store.tenantTx(tenant, (tx) => tx`
        INSERT INTO ops.plans (tenant_id, plan_id, book_id, op, status, plan, actions, hash, basis_seq, created_by)
        VALUES (${tenant}, ${plan.planId}, ${book}, ${plan.op}, 'proposed', ${tx.json(plan as never)}, ${tx.json(d.actions as never)},
                ${plan.hash}, ${plan.basisSeq}, ${principal})`);
    }
    return plan;
  }

  async get(tenant: string, planId: string): Promise<Plan> {
    const [r] = await this.store.tenantTx(tenant, (tx) => tx<{ plan: Plan; status: Plan["status"]; result: unknown }[]>`
      SELECT plan, status, result FROM ops.plans WHERE tenant_id = ${tenant} AND plan_id = ${planId}`);
    if (!r) throw new OpsError("no_plan", `no plan ${planId}`, 404);
    return { ...r.plan, status: r.status };
  }

  async pending(tenant: string, book: string): Promise<Plan[]> {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ plan: Plan }[]>`
      SELECT plan FROM ops.plans WHERE tenant_id = ${tenant} AND book_id = ${book} AND status = 'proposed'
      ORDER BY created_at DESC LIMIT 50`);
    return rows.map((r) => r.plan);
  }

  async discard(tenant: string, planId: string, principal: string) {
    const n = await this.store.tenantTx(tenant, (tx) => tx`
      UPDATE ops.plans SET status = 'discarded', resolved_by = ${principal}, resolved_at = now()
      WHERE tenant_id = ${tenant} AND plan_id = ${planId} AND status = 'proposed' RETURNING 1`);
    if (!n.length) throw new OpsError("not_open", "plan is not open");
    return { planId, status: "discarded" as const };
  }

  /**
   * Commit exactly what was simulated. Returns awaiting_person when the caller lacks authority;
   * marks the plan stale (and refuses) when the book moved since the simulation.
   */
  async commit(tenant: string, planId: string, principal: string, hash: string) {
    const [row] = await this.store.tenantTx(tenant, (tx) => tx<{ plan: Plan; actions: Action[]; status: string; hash: string; basis_seq: number; book_id: string }[]>`
      SELECT plan, actions, status, hash, basis_seq, book_id FROM ops.plans WHERE tenant_id = ${tenant} AND plan_id = ${planId}`);
    if (!row) throw new OpsError("no_plan", `no plan ${planId}`, 404);
    if (row.status !== "proposed") throw new OpsError("not_open", `plan is ${row.status}`);
    if (row.hash !== hash) throw new OpsError("hash_mismatch", "the plan you approved is not the plan on record; simulate again");
    if (row.plan.blocked) throw new OpsError("blocked", "a blocking check failed; resolve it and simulate again");
    if (isAgent(principal) && row.plan.needsPerson) {
      return { planId, status: "awaiting_person" as const, message: `A person must approve this ${row.plan.gate === "human" ? "period operation" : "plan"} in Kuber.` };
    }
    const state = await this.svc.gl.state(tenant, row.book_id);
    if (state.seq !== row.basis_seq) {
      await this.store.tenantTx(tenant, (tx) => tx`UPDATE ops.plans SET status = 'stale' WHERE tenant_id = ${tenant} AND plan_id = ${planId} AND status = 'proposed'`);
      throw new OpsError("stale", `the books changed since this was simulated (journal ${row.basis_seq} → ${state.seq}); simulate again`);
    }
    const done: string[] = [];
    try {
      for (const a of row.actions) {
        if (a.type === "gl") {
          await this.svc.gl.execute(tenant, row.book_id, a.command, { principal });
          done.push(a.command.kind === "PostJournal" ? `posted ${a.command.journalId}` : a.command.kind === "LockPeriod" ? `locked ${a.command.level} to ${a.command.periodEnd}` : `added ${a.command.account.accountId}`);
        } else {
          await this.svc.agent.approveDraft(tenant, a.draftId, principal, a.accountId);
          done.push(`approved ${a.draftId}`);
        }
      }
    } catch (e) {
      // Actions are idempotent (deterministic ids), so a retry after a fix resumes safely.
      const msg = e instanceof Error ? e.message : String(e);
      await this.store.tenantTx(tenant, (tx) => tx`UPDATE ops.plans SET result = ${tx.json({ done, error: msg } as never)} WHERE tenant_id = ${tenant} AND plan_id = ${planId}`);
      throw new OpsError(e instanceof DomainError ? e.code : "commit_failed", `${msg} (after ${done.length} of ${row.actions.length} steps)`);
    }
    await this.store.tenantTx(tenant, (tx) => tx`
      UPDATE ops.plans SET status = 'committed', resolved_by = ${principal}, resolved_at = now(), result = ${tx.json({ done } as never)}
      WHERE tenant_id = ${tenant} AND plan_id = ${planId}`);
    return { planId, status: "committed" as const, steps: done };
  }
}

// ---------------------------------------------------------------- derived views of a plan
function journalsOf(s: BookState, actions: Action[], data: unknown): PlanJournal[] {
  const nm = (id: string) => s.accounts.get(id)?.name ?? (id === "RETAINED" ? "Retained surplus" : id);
  const view = (journalId: string, txnDate: string, narration: string, voucherType: string, lines: Line[]): PlanJournal =>
    ({ journalId, txnDate, narration, voucherType, lines: lines.map((l) => ({ accountId: l.accountId, name: nm(l.accountId), amount: l.amount, ...(Object.keys(l.dimensions ?? {}).length ? { dimensions: l.dimensions } : {}) })) });
  const out: PlanJournal[] = [];
  for (const a of actions) if (a.type === "gl" && a.command.kind === "PostJournal") out.push(view(a.command.journalId, a.command.txnDate, a.command.narration, a.command.voucherType ?? "journal", a.command.lines));
  const fromDrafts = (data as { journalsFromDrafts?: { txnDate: string; narration: string; lines: Line[] }[] } | undefined)?.journalsFromDrafts ?? [];
  fromDrafts.forEach((j, n) => out.push(view(`draft-${n}`, j.txnDate, j.narration, "journal", j.lines)));
  return out;
}

function effectsOf(s: BookState, journals: PlanJournal[]): Effect[] {
  if (!journals.length) return [];
  const before = balancesFromState(s);
  const delta = new Map<string, bigint>();
  for (const j of journals) for (const l of j.lines) delta.set(l.accountId, (delta.get(l.accountId) ?? 0n) + BigInt(l.amount));
  const debitNormal = (id: string) => ["asset", "expense"].includes(s.accounts.get(id)?.nature ?? (id === "RETAINED" ? "equity" : "asset"));
  return [...delta.entries()].filter(([, d]) => d !== 0n).map(([id, d]) => {
    const b = before.get(id) ?? 0n, sign = debitNormal(id) ? 1n : -1n;
    return { accountId: id, name: s.accounts.get(id)?.name ?? (id === "RETAINED" ? "Retained surplus" : id),
      nature: s.accounts.get(id)?.nature ?? "equity", before: (b * sign).toString(), after: ((b + d) * sign).toString() };
  }).sort((a, b) => a.accountId.localeCompare(b.accountId));
}
