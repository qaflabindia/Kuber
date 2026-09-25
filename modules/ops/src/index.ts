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
import { canonical, planLifecycle, sha256, uuid, type EventData, type Line } from "@kuber/contracts";
import { tenantRlsFor, type EventStore, type Migration } from "@kuber/eventstore";
import { DomainError, type BookState } from "@kuber/gl";
import { AgentError } from "@kuber/agent";
import { isToken, type TenantKeys } from "@kuber/crypto";
import { balancesFromState, paidParties } from "./math.ts";
import { ScheduleError } from "./schedules.ts";
import { OPERATIONS } from "./operations.ts";
import { FIN_OPERATIONS } from "./fin-operations.ts";
import { SCHEDULE_MIGRATIONS, Schedules } from "./schedules.ts";
import type { Action, Effect, OpContext, OpDef, OpName, OpsGuard, Plan, PlanJournal, Services } from "./types.ts";

export * from "./types.ts";
export { OPERATIONS } from "./operations.ts";
export { FIN_OPERATIONS } from "./fin-operations.ts";
export { SCHEDULER, ScheduleError, ScheduleInput, Schedules, occurrencesOf, type RunResult, type ScheduleDef, type ScheduleView } from "./schedules.ts";
export { balancesFromState, splitByWeights, rebalanceTransfers, financialYear, fiscalStart, paidParties, pctToBp } from "./math.ts";

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
}, ...SCHEDULE_MIGRATIONS];

export class OpsError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

const RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
export const isAgent = (principal: string) => /^(agent|system):/.test(principal);
/** Deny by default: an Operations service built without a guard refuses every step. */
export const DENY_ALL: OpsGuard = { check: async () => { throw new OpsError("forbidden", "no authorization service configured", 403); } };

export class Operations {
  readonly defs = new Map<OpName, OpDef<any>>([...OPERATIONS, ...FIN_OPERATIONS].map((d) => [d.name, d]));
  /** Recurring and recognition schedules (FIN-GL-02/03): approved through a plan, run by `runSchedules`. */
  readonly schedules: Schedules;
  constructor(private sql: Sql, private store: EventStore, private svc: Services, private clock: () => string = () => new Date().toISOString().slice(0, 10),
    private guard: OpsGuard = DENY_ALL) {
    this.schedules = new Schedules(store, svc.gl, svc.policies, guard, () => this.clock(), (t, id) => this.get(t, id),
      svc.parties ? (t, ids, tx) => svc.parties!.holds(t, ids, tx) : undefined);
  }

  /** Post every approved schedule occurrence due on or before `asOf` (default today), once (`ops run-schedules`). */
  runSchedules(tenant: string, asOf?: string) { return this.schedules.run(tenant, asOf ?? this.clock()); }

  /**
   * Plans of a book in the journal lifecycle vocabulary (FIN-GL-01): proposed = submitted,
   * committed = posted (posting, for draft approvals that post through the agent), discarded or
   * stale = failed, and a proposed plan whose commit failed = failed, with the reason.
   */
  async lifecycle(tenant: string, book: string) {
    const keys = await this.store.keys(tenant);
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ plan_id: string; op: string; status: string; plan: unknown; result: { error?: string } | null;
      created_at: Date; created_by: string; resolved_by: string | null }[]>`
      SELECT plan_id, op, status, plan, result, created_at, created_by, resolved_by FROM ops.plans WHERE tenant_id = ${tenant} AND book_id = ${book}
      ORDER BY created_at, plan_id`);
    return rows.map((r) => {
      const p = open<Plan>(keys, r.plan_id, "plan", r.plan);
      const error = r.status === "proposed" ? r.result?.error ?? null : null;
      return { id: r.plan_id, source: "plan" as const, op: r.op, storedStatus: r.status, state: planLifecycle(r.status, { error, viaDrafts: r.op === "post", approvalOnly: r.op === "schedule_approve" }),
        title: p.title, journals: p.journals.map((j) => j.journalId), reason: error ?? (r.status === "stale" ? "the books changed after simulation" : r.status === "discarded" ? "discarded" : null),
        at: r.created_at, by: r.resolved_by ?? r.created_by };
    });
  }

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
    const ctx: OpContext = { tenant, book, principal, today: this.clock(), state, svc: this.svc, schedules: this.schedules };
    const d = await def.plan(ctx, parsed.data);

    const journals = journalsOf(state, d.actions, d.data);
    const effects = effectsOf(state, journals);
    const decision = def.event ? this.svc.policies.decide({ eventCode: def.event, on: ctx.today, amountPaise: d.amountPaise, confidence: 1 }) : null;
    const checks = d.checks ?? [];
    // FIN-MDM-03 / POL-501: a payment to a party whose bank details changed and are not yet
    // verified and released is held. Blocking: a held plan is shown, never stored.
    const paid = paidParties(state.accounts, paymentJournals(d.actions, d.data));
    if (paid.length && this.svc.parties) {
      const held = await this.svc.parties.holds(tenant, paid);
      checks.push({ label: "No payment to a party on hold (POL-501)", ok: held.length === 0, blocking: true,
        detail: held.length ? `bank details of ${held.map((h) => `${h.partyId} (${h.status})`).join(", ")} changed: verify and release first` : undefined });
    }
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
    // FIN-GL-01: a controlled adjustment to a control account is committed only by an owner or controller.
    if ((p.data as { controlledAdjustment?: unknown } | undefined)?.controlledAdjustment && !/^(owner|controller):/.test(principal)) {
      throw new OpsError("forbidden", "a controlled adjustment to a control account needs an owner or controller to commit it", 403);
    }
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
        // A proposal made before a party's bank details changed is held too, until the change is released.
        const paying = paidParties(b.state.accounts, paymentJournals(row.actions, p.data));
        const held = paying.length && this.svc.parties ? await this.svc.parties.holds(tenant, paying, b.tx) : [];
        if (held.length) throw new OpsError("party_hold", `payments to ${held.map((h) => h.partyId).join(", ")} are held: bank details changed and not yet verified and released (POL-501); nothing was applied`);
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
            const c = a.command;
            steps.push(c.kind === "PostJournal" ? `posted ${c.journalId}` : c.kind === "LockPeriod" ? `locked ${c.level} to ${c.periodEnd}`
              : c.kind === "ResolveSuspense" ? `reversed ${c.journalId} as ${c.reversalJournalId}${c.newJournalId ? `, reposted as ${c.newJournalId}` : ""}` : `added ${c.account.accountId}`);
          } else if (a.type === "approveSchedule") {
            await this.schedules.approve(b.tx, tenant, a, principal, planId);
            steps.push(`approved schedule ${a.scheduleId}`);
          } else if (a.type === "cancelSchedule") {
            await this.schedules.cancel(b.tx, tenant, a, planId);
            steps.push(`cancelled schedule ${a.scheduleId} from ${a.effective}`);
          } else if (a.type === "resolveSuspenseItem") {
            await this.svc.agent.suspense.markResolved(b.tx, tenant, a.itemId, principal, planId, a);
            steps.push(`resolved suspense item ${a.itemId}`);
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
      if (e instanceof ScheduleError) throw new OpsError(e.code, e.message, e.status);
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
/** Journals a plan would post, with their parties: its own PostJournal actions and the drafts it approves. */
function paymentJournals(actions: Action[], data: unknown): { lines: Line[] }[] {
  const own = actions.flatMap((a) => (a.type === "gl" && a.command.kind === "PostJournal" ? [{ lines: a.command.lines }] : []));
  const drafts = (data as { journalsFromDrafts?: { lines: Line[] }[] } | undefined)?.journalsFromDrafts ?? [];
  return [...own, ...drafts];
}

function journalsOf(s: BookState, actions: Action[], data: unknown): PlanJournal[] {
  const nm = (id: string) => s.accounts.get(id)?.name ?? (id === "RETAINED" ? "Retained surplus" : id);
  const view = (journalId: string, txnDate: string, narration: string, voucherType: string, lines: Line[]): PlanJournal =>
    ({ journalId, txnDate, narration, voucherType, lines: lines.map((l) => ({ accountId: l.accountId, name: nm(l.accountId), amount: l.amount, ...(Object.keys(l.dimensions ?? {}).length ? { dimensions: l.dimensions } : {}) })) });
  const out: PlanJournal[] = [];
  for (const a of actions) {
    if (a.type !== "gl") continue;
    const c = a.command;
    if (c.kind === "PostJournal") out.push(view(c.journalId, c.txnDate, c.narration, c.voucherType ?? "journal", c.lines));
    if (c.kind === "ResolveSuspense") {
      // what the ledger will do: the reversal on the resolution date, and the replacement with suspense moved to the target
      const j = s.journals.get(c.journalId);
      if (!j) continue;
      out.push(view(c.reversalJournalId, c.onDate, `Reversal of ${c.journalId}: suspense item resolved`, j.voucherType, j.lines.map((l) => ({ ...l, amount: (-BigInt(l.amount)).toString() }))));
      if (c.newJournalId && c.toAccount) out.push(view(c.newJournalId, c.onDate, `Suspense resolved: ${j.narration}`, j.voucherType,
        j.lines.map((l) => (s.accounts.get(l.accountId)?.accountId === "SUSPENSE" || s.accounts.get(l.accountId)?.taxonomyTag === "BS.suspense" ? { ...l, accountId: c.toAccount! } : l))));
    }
  }
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
