/**
 * Operations service: one entry point for the UI, the copilot and MCP clients.
 *
 *   plan(op, input)  -> simulate; write plans are stored as "proposed" with a hash
 *   commit(id, hash) -> re-verify hash and book version, check authority, execute
 *   discard(id)      -> withdraw a proposal
 *
 * Consistency (F03): commit checks the book version, claims the plan, records the approval and
 * runs every action in ONE transaction under the book lock, so a plan is applied entirely or not
 * at all, and nothing can land between the check and the effects. A retry after a failure finds
 * the plan still proposed; a retry after success returns the recorded outcome (F04).
 *
 * Authority: a person (any non-agent principal) may commit what they have seen. An agent may
 * commit only when the operation's gate is "policy" and the policy grants L3 or higher; everything
 * else waits for a person. Period operations (allocate, rebalance, close, carry-forward) are
 * gated "human" and always wait.
 *
 * Authorization (F02): every plan, commit and discard first passes the OpsGuard (the identity
 * module): membership, role, book scope and separation of duties. Without a guard, nothing passes.
 */
import type { Sql } from "postgres";
import { canonical, sha256, uuid, type EventData, type Line } from "@kuber/contracts";
import { tenantRlsFor, type EventStore, type Migration } from "@kuber/eventstore";
import { DomainError, type BookState } from "@kuber/gl";
import { AgentError } from "@kuber/agent";
import { isToken, type TenantKeys } from "@kuber/crypto";
import { balancesFromState } from "./math.ts";
import { OPERATIONS } from "./operations.ts";
import type { Action, Effect, OpContext, OpDef, OpName, OpsGuard, Plan, PlanJournal, Services } from "./types.ts";

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
}, {
  id: "ops-002-basis-version",
  // Plans are fenced on the book's full event version, not only its journal count: an account
  // or lock added after simulation also invalidates the plan. NULL for plans made before this.
  sql: `ALTER TABLE ops.plans ADD COLUMN basis_version INT;`,
}, {
  id: "ops-scale-001-plan-pages",
  // Keyset pages of open plans (F11): newest first, plan id breaks ties.
  sql: `CREATE INDEX IF NOT EXISTS plans_open_page ON ops.plans (tenant_id, book_id, created_at DESC, plan_id DESC) WHERE status = 'proposed';`,
}];

export class OpsError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

const RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
export const isAgent = (principal: string) => /^(agent|system):/.test(principal);
/** Deny by default: an Operations service built without a guard refuses every step. */
export const DENY_ALL: OpsGuard = { check: async () => { throw new OpsError("forbidden", "no authorization service configured", 403); } };

export class Operations {
  readonly defs = new Map<OpName, OpDef<any>>(OPERATIONS.map((d) => [d.name, d]));
  constructor(private sql: Sql, private store: EventStore, private svc: Services, private clock: () => string = () => new Date().toISOString().slice(0, 10),
    private guard: OpsGuard = DENY_ALL) {}

  list() {
    return [...this.defs.values()].map(({ name, title, description, kind, gate, event }) => ({ name, title, description, kind, gate, event: event ?? null }));
  }

  async plan(tenant: string, book: string, principal: string, op: string, rawInput: unknown, opts: { onBehalfOf?: string } = {}): Promise<Plan> {
    const def = this.defs.get(op as OpName);
    if (!def) throw new OpsError("unknown_op", `no operation ${op}`, 404);
    await this.guard.check({ step: "plan", tenant, book, principal, op: def, onBehalfOf: opts.onBehalfOf });
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
      basisSeq: state.seq, basisVersion: state.version, createdAt: new Date().toISOString(), createdBy: principal, hash: "",
      ...(opts.onBehalfOf ? { requestedBy: opts.onBehalfOf } : {}),
      status: committable ? "proposed" : "preview", blocked,
      needsPerson: def.gate === "human" || !decision || RANK[decision.level]! < 3,
    };
    plan.hash = sha256(canonical({ op: plan.op, book, basisSeq: plan.basisSeq, basisVersion: plan.basisVersion, actions: d.actions }));
    if (committable) {
      // Plans and their actions contain narrations and amounts: stored sealed, bound to the plan id.
      const keys = await this.store.keys(tenant);
      await this.store.tenantTx(tenant, (tx) => tx`
        INSERT INTO ops.plans (tenant_id, plan_id, book_id, op, status, plan, actions, hash, basis_seq, basis_version, created_by)
        VALUES (${tenant}, ${plan.planId}, ${book}, ${plan.op}, 'proposed', ${tx.json(seal(keys, plan.planId, "plan", plan) as never)},
                ${tx.json(seal(keys, plan.planId, "actions", d.actions) as never)}, ${plan.hash}, ${plan.basisSeq}, ${plan.basisVersion!}, ${principal})`);
    }
    return plan;
  }

  async get(tenant: string, planId: string): Promise<Plan> {
    const [r] = await this.store.tenantTx(tenant, (tx) => tx<{ plan: unknown; status: Plan["status"]; result: unknown }[]>`
      SELECT plan, status, result FROM ops.plans WHERE tenant_id = ${tenant} AND plan_id = ${planId}`);
    if (!r) throw new OpsError("no_plan", `no plan ${planId}`, 404);
    return { ...open<Plan>(await this.store.keys(tenant), planId, "plan", r.plan), status: r.status };
  }

  /** Open plans, newest first: one keyset page (default 50, at most 200) older than `before` (a previous page's `next`). */
  async pending(tenant: string, book: string, opts: { limit?: number; before?: string } = {}): Promise<Plan[]> {
    return (await this.pendingPage(tenant, book, opts)).items;
  }

  async pendingPage(tenant: string, book: string, opts: { limit?: number; before?: string } = {}): Promise<{ items: Plan[]; next: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 1, 1), 200);
    let cur: [string, string] | null = null;
    if (opts.before) {
      try { cur = JSON.parse(Buffer.from(opts.before, "base64url").toString("utf8")); } catch { cur = null; }
      if (!Array.isArray(cur) || cur.length !== 2 || !cur.every((x) => typeof x === "string")) throw new OpsError("bad_cursor", "invalid page cursor", 400);
    }
    const keys = await this.store.keys(tenant);
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ plan_id: string; plan: unknown; cur_ts: string }[]>`
      SELECT plan_id, plan, created_at::text AS cur_ts FROM ops.plans WHERE tenant_id = ${tenant} AND book_id = ${book} AND status = 'proposed'
        ${cur ? tx`AND (created_at, plan_id) < (${cur[0]}::text::timestamptz, ${cur[1]})` : tx``}
      ORDER BY created_at DESC, plan_id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page.map((r) => open<Plan>(keys, r.plan_id, "plan", r.plan)),
      next: rows.length > limit && last ? Buffer.from(JSON.stringify([last.cur_ts, last.plan_id])).toString("base64url") : null };
  }

  /** Number of open plans for a book (badges). */
  async pendingCount(tenant: string, book: string): Promise<number> {
    const [r] = await this.store.tenantTx(tenant, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ops.plans WHERE tenant_id = ${tenant} AND book_id = ${book} AND status = 'proposed'`);
    return r?.n ?? 0;
  }

  async discard(tenant: string, planId: string, principal: string) {
    const p = await this.get(tenant, planId);
    await this.guard.check({ step: "discard", tenant, book: p.bookId, principal, op: { name: p.op, kind: p.kind, gate: p.gate }, plan: p });
    const n = await this.store.tenantTx(tenant, (tx) => tx`
      UPDATE ops.plans SET status = 'discarded', resolved_by = ${principal}, resolved_at = now()
      WHERE tenant_id = ${tenant} AND plan_id = ${planId} AND status = 'proposed' RETURNING 1`);
    if (!n.length) throw new OpsError("not_open", "plan is not open");
    return { planId, status: "discarded" as const };
  }

  /**
   * Commit exactly what was simulated. Returns awaiting_person when the caller lacks authority;
   * marks the plan stale (and refuses) when the book moved since the simulation. Committing a plan
   * that is already committed, with the same hash, returns its recorded outcome (a lost response
   * can be retried safely).
   */
  async commit(tenant: string, planId: string, principal: string, hash: string) {
    const [stored] = await this.store.tenantTx(tenant, (tx) => tx<{ plan: unknown; actions: unknown; status: string; hash: string; basis_seq: number; basis_version: number | null; book_id: string; result: { done?: string[] } | null }[]>`
      SELECT plan, actions, status, hash, basis_seq, basis_version, book_id, result FROM ops.plans WHERE tenant_id = ${tenant} AND plan_id = ${planId}`);
    if (!stored) throw new OpsError("no_plan", `no plan ${planId}`, 404);
    const keys = await this.store.keys(tenant);
    const row = { ...stored, plan: open<Plan>(keys, planId, "plan", stored.plan), actions: open<Action[]>(keys, planId, "actions", stored.actions) };
    // Authorization first, for a replay too: the stored outcome goes only to someone who may commit it.
    await this.guard.check({ step: "commit", tenant, book: row.book_id, principal, op: { name: row.plan.op, kind: row.plan.kind, gate: row.plan.gate }, plan: row.plan });
    if (row.status === "committed" && row.hash === hash) return { planId, status: "committed" as const, steps: row.result?.done ?? [], replayed: true };
    if (row.status !== "proposed") throw new OpsError("not_open", `plan is ${row.status}`);
    if (row.hash !== hash) throw new OpsError("hash_mismatch", "the plan you approved is not the plan on record; simulate again");
    if (row.plan.blocked) throw new OpsError("blocked", "a blocking check failed; resolve it and simulate again");
    if (isAgent(principal) && row.plan.needsPerson) {
      return { planId, status: "awaiting_person" as const, message: `A person must approve this ${row.plan.gate === "human" ? "period operation" : "plan"} in Kuber.` };
    }
    const p = row.plan;
    let out: { steps: string[]; replayed?: true };
    try {
      out = await this.svc.gl.transact(tenant, row.book_id, async (b) => {
        // Claim the plan first, under the book lock and a row lock: a concurrent commit or discard
        // waits here, then finds it resolved (a commit that raced this one returns its outcome).
        const [cur] = await b.tx<{ status: string; result: { done?: string[] } | null }[]>`
          SELECT status, result FROM ops.plans WHERE tenant_id = ${tenant} AND plan_id = ${planId} FOR UPDATE`;
        if (cur!.status === "committed") return { steps: cur!.result?.done ?? [], replayed: true as const };
        if (cur!.status !== "proposed") throw new OpsError("not_open", `plan is ${cur!.status}`);
        // Nothing can post between this check and the actions below.
        const moved = row.basis_version !== null ? b.version !== row.basis_version : b.state.seq !== row.basis_seq;
        if (moved) throw new OpsError("stale", row.basis_version !== null
          ? `the books changed since this was simulated (version ${row.basis_version} → ${b.version}); simulate again`
          : `the books changed since this was simulated (journal ${row.basis_seq} → ${b.state.seq}); simulate again`);
        await b.tx`UPDATE ops.plans SET status = 'committed', resolved_by = ${principal}, resolved_at = now()
          WHERE tenant_id = ${tenant} AND plan_id = ${planId}`;
        // The approval is a fact alongside its effects: who committed which hash. Every action carries
        // the plan id as its command id, so the journals it posts link back here (evidence, 14.7).
        await this.store.append("ops", tenant, { streamId: `${tenant}/plan/${planId}`, expected: "any", events: [{ type: "PlanApproved", data: {
          planId, bookId: row.book_id, op: p.op, hash: row.hash, basisSeq: row.basis_seq, ...(row.basis_version !== null ? { basisVersion: row.basis_version } : {}),
          gate: p.gate, needsPerson: p.needsPerson, actions: row.actions.length, preparedBy: p.createdBy, policy: p.policy as EventData<"PlanApproved">["policy"] } }] },
          { principal, commandId: planId, policyIds: p.policy?.ids }, b.tx);
        const steps: string[] = [];
        for (const a of row.actions) {
          if (a.type === "gl") {
            await b.execute(a.command, { principal, commandId: planId });
            steps.push(a.command.kind === "PostJournal" ? `posted ${a.command.journalId}` : a.command.kind === "LockPeriod" ? `locked ${a.command.level} to ${a.command.periodEnd}` : `added ${a.command.account.accountId}`);
          } else {
            // Draft approvals are atomic with the plan; the posting itself is the GL's decision and
            // shows on the draft (approved -> posted, or back to review with the GL's reason).
            await this.svc.agent.approveDraft(tenant, a.draftId, principal, a.accountId, planId, b.tx);
            steps.push(`requested posting of ${a.draftId}`);
          }
        }
        await b.tx`UPDATE ops.plans SET result = ${b.tx.json({ done: steps } as never)} WHERE tenant_id = ${tenant} AND plan_id = ${planId}`;
        return { steps };
      });
    } catch (e) {
      if (e instanceof OpsError && e.code === "stale") {
        await this.store.tenantTx(tenant, (tx) => tx`UPDATE ops.plans SET status = 'stale' WHERE tenant_id = ${tenant} AND plan_id = ${planId} AND status = 'proposed'`);
        throw e;
      }
      if (e instanceof OpsError) throw e;
      // Nothing was applied: the plan is still proposed, and committing it again is safe.
      const msg = e instanceof Error ? e.message : String(e);
      await this.store.tenantTx(tenant, (tx) => tx`UPDATE ops.plans SET result = ${tx.json({ error: msg } as never)}
        WHERE tenant_id = ${tenant} AND plan_id = ${planId} AND status = 'proposed'`);
      throw new OpsError(e instanceof DomainError || e instanceof AgentError ? e.code : "commit_failed", `${msg} (nothing was applied; the plan is still open)`);
    }
    return { planId, status: "committed" as const, steps: out.steps, ...(out.replayed ? { replayed: true as const } : {}) };
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

// ------------------------------------------------------------------ sealed columns
const planCtx = (planId: string, field: string) => `ops.plans.${field}|${planId}`;
const seal = (keys: TenantKeys, planId: string, field: string, v: unknown) => ({ $c: keys.sealJson(v, planCtx(planId, field)) });
function open<T>(keys: TenantKeys, planId: string, field: string, v: unknown): T {
  const c = (v as { $c?: unknown } | null)?.$c;
  return (isToken(c) ? keys.openJson<T>(c, planCtx(planId, field)) : v) as T;
}
