/**
 * Recurring journals (FIN-GL-02) and prepaid / accrual recognition schedules (FIN-GL-03).
 *
 * A schedule is defined once (template lines or a recognition basis, monthly frequency, start and
 * end, the policy version it runs under) and approved once, through the normal ops path: the
 * `schedule_approve` plan is committed by a person with period-approval authority, under the ops
 * guard and maker-checker, and its PlanApproved event is the approval. After that the runner posts
 * each occurrence as the system principal `system:scheduler`, citing the approval plan as its
 * command id, and only while:
 *   - the approver still holds that authority (the ops guard is asked again on every run),
 *   - the definition is byte-for-byte the one approved (hash) and the policy version is unchanged,
 *   - the occurrence moves no more than the approved amount.
 *
 * Every occurrence has a business id (schedule + period + kind). Its row is written in the same
 * transaction, under the same book lock, as its journal, and the journal id is derived from the
 * same key, so an occurrence posts at most once however often or concurrently the runner runs.
 * An occurrence that cannot post as scheduled (its period or its reversal date is locked, the
 * ledger refuses it) becomes an exception case; its date is never moved.
 */
import { z } from "zod";
import type { TransactionSql } from "postgres";
import { IsoDate, MinorString, canonical, isIsoDate, sha256, uuid, type Line } from "@kuber/contracts";
import type { EventStore, Migration } from "@kuber/eventstore";
import { DomainError, assertBookCurrency, checkManualControl, isSuspense, schedules as S, validateJournal, type BookState, type GeneralLedger } from "@kuber/gl";
import type { PolicyEngine } from "@kuber/policy";
import { isToken, type TenantKeys } from "@kuber/crypto";
import { balancesFromState } from "./math.ts";
import type { OpsGuard, Plan } from "./types.ts";

export const SCHEDULER = "system:scheduler";
export const SCHEDULE_POLICY = "POL-000";

export const SCHEDULE_MIGRATIONS: Migration[] = [{
  id: "ops-fin-001-schedules",
  sql: `
CREATE TABLE ops.schedules (
  tenant_id TEXT NOT NULL, schedule_id TEXT NOT NULL, book_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recurring','recognition')),
  status TEXT NOT NULL CHECK (status IN ('submitted','approved','cancelled')),
  definition JSONB NOT NULL, hash TEXT NOT NULL, policy_version TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_hash TEXT, approved_amount NUMERIC(22,0), approval_plan_id TEXT, approved_by TEXT, approved_at TIMESTAMPTZ,
  cancelled_on DATE, cancellation JSONB,
  PRIMARY KEY (tenant_id, schedule_id));
CREATE INDEX schedules_book ON ops.schedules (tenant_id, book_id, status);
CREATE TABLE ops.schedule_occurrences (
  tenant_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, schedule_id TEXT NOT NULL, book_id TEXT NOT NULL,
  period TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('post','reverse')), due_on DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('posted','exception','dismissed')),
  journal_id TEXT, amount NUMERIC(22,0) NOT NULL, reason TEXT,
  executed_by TEXT NOT NULL, executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, occurrence_id), UNIQUE (tenant_id, schedule_id, period, kind));
CREATE INDEX schedule_occurrences_book ON ops.schedule_occurrences (tenant_id, book_id, status);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['schedules', 'schedule_occurrences'] LOOP
    EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE ops.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON ops.%I USING (tenant_id = current_setting('kuber.tenant', true)) WITH CHECK (tenant_id = current_setting('kuber.tenant', true))$p$, t);
    EXECUTE format($p$CREATE POLICY system_scope ON ops.%I TO kuber_system_scope USING (true) WITH CHECK (true)$p$, t);
  END LOOP;
END $$;`,
}];

// ---------------------------------------------------------------- definition
const Paise = MinorString.refine((v) => BigInt(v) > 0n, "must be a positive amount in paise");
const AccountId = z.string().min(1).transform((s) => s.trim().toUpperCase());
const TemplateLine = z.object({ accountId: AccountId, amount: MinorString, partyId: z.string().optional(), dimensions: z.record(z.string(), z.string()).default({}) });

export const ScheduleInput = z.object({
  name: z.string().min(2).max(200).describe("narration of every occurrence"),
  kind: z.enum(["recurring", "recognition"]),
  frequency: z.literal("monthly").default("monthly"),
  start: IsoDate, end: IsoDate,
  day: z.union([z.literal("last"), z.number().int().min(1).max(28)]).default("last"),
  currency: z.string().optional(),
  /** Recurring: the journal every period posts (paise, debit positive). */
  lines: z.array(TemplateLine).min(2).optional(),
  /** Recurring: reverse each occurrence on the first day of the next period. */
  autoReverse: z.boolean().default(false),
  /** Recognition: straight-line monthly over the coverage dates (start..end). */
  recognition: z.object({
    basis: z.literal("straight_line_monthly").default("straight_line_monthly"),
    type: z.enum(["prepaid", "accrual"]),
    total: Paise,
    expenseAccount: AccountId,
    /** Prepaid asset (prepaid) or accrued liability (accrual) the schedule draws down or builds up. */
    balanceAccount: AccountId,
    dimensions: z.record(z.string(), z.string()).default({}),
  }).optional(),
}).refine((d) => d.end >= d.start, "end must not be before start")
  .refine((d) => (d.kind === "recurring" ? !!d.lines && !d.recognition : !!d.recognition && !d.lines), "a recurring schedule has lines; a recognition schedule has recognition (not both)");
export type ScheduleDef = z.infer<typeof ScheduleInput> & { policyVersion: string };

export interface Occurrence { occurrenceId: string; period: string; kind: "post" | "reverse"; dueOn: string; amount: bigint; journalId: string; lines: Line[] }

/** Every occurrence a definition implies, in due order. */
export function occurrencesOf(tenant: string, scheduleId: string, d: ScheduleDef): Occurrence[] {
  const periods = S.periodsBetween(d.start, d.end);
  const out: Occurrence[] = [];
  const parts = d.recognition ? S.straightLine(BigInt(d.recognition.total), periods.length) : [];
  periods.forEach((p, k) => {
    let dueOn = S.occurrenceDate(p, d.day);
    if (d.recognition) dueOn = dueOn > d.end ? d.end : dueOn;          // recognition stays inside its coverage
    else if (dueOn < d.start || dueOn > d.end) return;                  // a recurring posting day outside start..end
    const r = d.recognition;
    const lines: Line[] = r
      ? [{ accountId: r.expenseAccount, amount: parts[k]!.toString(), dimensions: r.dimensions },
         { accountId: r.balanceAccount, amount: (-parts[k]!).toString(), dimensions: {} }]
      : d.lines!.map((l) => ({ accountId: l.accountId, amount: BigInt(l.amount).toString(), ...(l.partyId ? { partyId: l.partyId } : {}), dimensions: l.dimensions ?? {} }));
    const amount = S.debits(lines);
    out.push({ occurrenceId: S.occurrenceId(tenant, scheduleId, p, "post"), period: p, kind: "post", dueOn, amount, lines,
      journalId: S.occurrenceJournalId(tenant, scheduleId, p, "post") });
    if (d.autoReverse && !r) {
      out.push({ occurrenceId: S.occurrenceId(tenant, scheduleId, p, "reverse"), period: p, kind: "reverse", dueOn: S.reversalDate(p), amount,
        lines: lines.map((l) => ({ ...l, amount: (-BigInt(l.amount)).toString() })), journalId: S.occurrenceJournalId(tenant, scheduleId, p, "reverse") });
    }
  });
  return out.sort((a, b) => (a.dueOn === b.dueOn ? (a.kind === b.kind ? 0 : a.kind === "post" ? -1 : 1) : a.dueOn < b.dueOn ? -1 : 1));
}

/** Largest amount one occurrence moves: what an approval authorizes per execution. */
export const maxOccurrence = (occ: Occurrence[]) => occ.reduce((m, o) => (o.amount > m ? o.amount : m), 0n);
export const definitionHash = (book: string, d: ScheduleDef) => sha256(canonical({ book, definition: d }));

export class ScheduleError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

export interface ScheduleView {
  scheduleId: string; bookId: string; kind: "recurring" | "recognition"; status: "submitted" | "approved" | "cancelled";
  definition: ScheduleDef; hash: string; policyVersion: string; createdBy: string;
  approvedAmount: string | null; approvalPlanId: string | null; approvedBy: string | null;
  cancelledOn: string | null; cancellation: { recognized: string; released: string; remaining: string; planId: string } | null;
  occurrences: { occurrenceId: string; period: string; kind: "post" | "reverse"; dueOn: string; amount: string; journalId: string;
    status: "due" | "scheduled" | "posted" | "exception" | "dismissed" | "cancelled"; reason: string | null }[];
  /** Recognition: total, recognized so far (posted), released on cancellation, and what remains. */
  balance: { total: string; recognized: string; released: string; remaining: string } | null;
}

type Row = { schedule_id: string; book_id: string; kind: "recurring" | "recognition"; status: ScheduleView["status"]; definition: unknown; hash: string;
  policy_version: string; created_by: string; approved_hash: string | null; approved_amount: string | null; approval_plan_id: string | null;
  approved_by: string | null; cancelled_on: string | null; cancellation: ScheduleView["cancellation"] };
type OccRow = { occurrence_id: string; schedule_id: string; period: string; kind: "post" | "reverse"; due_on: string; status: "posted" | "exception" | "dismissed";
  journal_id: string | null; amount: string; reason: string | null };

const defCtx = (id: string) => `ops.schedules.definition|${id}`;

export interface RunResult { tenant: string; asOf: string; posted: string[]; reversed: string[]; exceptions: { occurrenceId: string; reason: string }[];
  skipped: { scheduleId: string; reason: string }[] }

export class Schedules {
  constructor(private store: EventStore, private gl: GeneralLedger, private policies: PolicyEngine, private guard: OpsGuard,
              private clock: () => string, private getPlan: (tenant: string, planId: string) => Promise<Plan>) {}

  private currentPolicyVersion() {
    const p = this.policies.policies.find((x) => x.policyId === SCHEDULE_POLICY);
    return `${SCHEDULE_POLICY}@${p?.version ?? 1}`;
  }

  /** Validate the template against the book's rules (accounts, balance, dimensions, currency), ignoring locks. */
  private validateDef(state: BookState, d: ScheduleDef, occ: Occurrence[]) {
    assertBookCurrency(d.currency);
    if (!occ.length) throw new ScheduleError("no_occurrences", "the schedule has no posting date between its start and end", 400);
    const unlocked: BookState = { ...state, locks: [] };
    for (const o of occ.filter((x) => x.kind === "post").slice(0, 1)) {
      validateJournal(unlocked, o.dueOn, o.lines, "owner:schedule");
      checkManualControl(state, o.lines, "owner:schedule", undefined);          // control accounts come from their subledger
      if (o.lines.some((l) => isSuspense(state.accounts.get(l.accountId)))) throw new DomainError("suspense_unresolved", "a schedule cannot post to suspense");
    }
    if (d.recognition) {
      const bal = state.accounts.get(d.recognition.balanceAccount)!;
      const want = d.recognition.type === "prepaid" ? "asset" : "liability";
      if (bal.nature !== want) throw new ScheduleError("bad_account", `a ${d.recognition.type} schedule draws on ${want === "asset" ? "an asset" : "a liability"} account; ${bal.accountId} is ${bal.nature}`, 400);
    }
  }

  /** Define a schedule (status submitted). Posts nothing until a schedule_approve plan is committed. */
  async create(tenant: string, book: string, principal: string, raw: unknown) {
    await this.guard.check({ step: "plan", tenant, book, principal, op: { name: "schedule_approve", kind: "write", gate: "human" } });
    const parsed = ScheduleInput.safeParse(raw);
    if (!parsed.success) throw new ScheduleError("bad_input", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), 400);
    const def: ScheduleDef = { ...parsed.data, policyVersion: this.currentPolicyVersion() };
    const state = await this.gl.state(tenant, book);
    if (!state.exists) throw new ScheduleError("no_book", `book ${book} does not exist`, 404);
    const scheduleId = uuid();
    const occ = occurrencesOf(tenant, scheduleId, def);
    this.validateDef(state, def, occ);
    const hash = definitionHash(book, def);
    const keys = await this.store.keys(tenant);
    await this.store.tenantTx(tenant, async (tx) => {
      await tx`INSERT INTO ops.schedules (tenant_id, schedule_id, book_id, kind, status, definition, hash, policy_version, created_by)
        VALUES (${tenant}, ${scheduleId}, ${book}, ${def.kind}, 'submitted', ${tx.json({ $c: keys.sealJson(def, defCtx(scheduleId)) } as never)},
                ${hash}, ${def.policyVersion}, ${principal})`;
      await this.store.append("ops", tenant, { streamId: `${tenant}/schedule/${scheduleId}`, expected: "no_stream",
        events: [{ type: "ScheduleCreated", data: { scheduleId, bookId: book, kind: def.kind, hash, policyVersion: def.policyVersion } }] }, { principal }, tx);
    });
    return this.get(tenant, scheduleId);
  }

  private async rows(tenant: string, tx: TransactionSql, where: { book?: string; scheduleId?: string; status?: string }) {
    return tx<Row[]>`SELECT schedule_id, book_id, kind, status, definition, hash, policy_version, created_by, approved_hash, approved_amount::text AS approved_amount,
        approval_plan_id, approved_by, cancelled_on::text AS cancelled_on, cancellation FROM ops.schedules WHERE tenant_id = ${tenant}
        ${where.book ? tx`AND book_id = ${where.book}` : tx``} ${where.scheduleId ? tx`AND schedule_id = ${where.scheduleId}` : tx``}
        ${where.status ? tx`AND status = ${where.status}` : tx``} ORDER BY created_at, schedule_id`;
  }

  private occRows(tenant: string, tx: TransactionSql, scheduleIds: string[]) {
    if (!scheduleIds.length) return Promise.resolve([] as OccRow[]);
    return tx<OccRow[]>`SELECT occurrence_id, schedule_id, period, kind, due_on::text AS due_on, status, journal_id, amount::text AS amount, reason
      FROM ops.schedule_occurrences WHERE tenant_id = ${tenant} AND schedule_id IN ${tx(scheduleIds)}`;
  }

  private view(tenant: string, keys: TenantKeys, r: Row, occs: OccRow[], asOf: string): ScheduleView {
    const c = (r.definition as { $c?: unknown }).$c;
    const def = (isToken(c) ? keys.openJson<ScheduleDef>(c, defCtx(r.schedule_id)) : r.definition) as ScheduleDef;
    const done = new Map(occs.filter((o) => o.schedule_id === r.schedule_id).map((o) => [o.occurrence_id, o]));
    const occurrences = occurrencesOf(tenant, r.schedule_id, def).map((o) => {
      const row = done.get(o.occurrenceId);
      const status = row ? row.status : r.status === "cancelled" && r.cancelled_on !== null && o.dueOn > r.cancelled_on ? "cancelled" as const
        : o.dueOn <= asOf ? "due" as const : "scheduled" as const;
      return { occurrenceId: o.occurrenceId, period: o.period, kind: o.kind, dueOn: o.dueOn, amount: o.amount.toString(), journalId: o.journalId, status, reason: row?.reason ?? null };
    });
    let balance: ScheduleView["balance"] = null;
    if (def.recognition) {
      const total = BigInt(def.recognition.total);
      const recognized = occurrences.filter((o) => o.kind === "post" && o.status === "posted").reduce((a, o) => a + BigInt(o.amount), 0n);
      const released = r.cancellation ? BigInt(r.cancellation.released) : 0n;
      balance = { total: total.toString(), recognized: recognized.toString(), released: released.toString(), remaining: (total - recognized - released).toString() };
    }
    return { scheduleId: r.schedule_id, bookId: r.book_id, kind: r.kind, status: r.status, definition: def, hash: r.hash, policyVersion: r.policy_version,
      createdBy: r.created_by, approvedAmount: r.approved_amount, approvalPlanId: r.approval_plan_id, approvedBy: r.approved_by,
      cancelledOn: r.cancelled_on, cancellation: r.cancellation, occurrences, balance };
  }

  async get(tenant: string, scheduleId: string, tx?: TransactionSql): Promise<ScheduleView> {
    const keys = await this.store.keys(tenant);
    const run = async (t: TransactionSql) => {
      const [r] = await this.rows(tenant, t, { scheduleId });
      if (!r) throw new ScheduleError("no_schedule", `no schedule ${scheduleId}`, 404);
      return this.view(tenant, keys, r, await this.occRows(tenant, t, [scheduleId]), this.clock());
    };
    return tx ? run(tx) : this.store.tenantTx(tenant, run);
  }

  async list(tenant: string, book: string, opts: { asOf?: string } = {}): Promise<ScheduleView[]> {
    const keys = await this.store.keys(tenant);
    return this.store.tenantTx(tenant, async (tx) => {
      const rows = await this.rows(tenant, tx, { book });
      const occs = await this.occRows(tenant, tx, rows.map((r) => r.schedule_id));
      return rows.map((r) => this.view(tenant, keys, r, occs, opts.asOf ?? this.clock()));
    });
  }

  /** Open exception cases of a book: occurrences that could not post as scheduled. */
  async exceptions(tenant: string, book: string) {
    return this.store.tenantTx(tenant, (tx) => tx<OccRow[]>`
      SELECT occurrence_id, schedule_id, period, kind, due_on::text AS due_on, status, journal_id, amount::text AS amount, reason
      FROM ops.schedule_occurrences WHERE tenant_id = ${tenant} AND book_id = ${book} AND status = 'exception' ORDER BY due_on, occurrence_id`);
  }

  /** Close an exception case without posting (the occurrence is then never attempted again). */
  async dismissException(tenant: string, occurrenceId: string, principal: string, note: string) {
    return this.store.tenantTx(tenant, async (tx) => {
      const [o] = await tx<{ book_id: string; status: string }[]>`SELECT book_id, status FROM ops.schedule_occurrences WHERE tenant_id = ${tenant} AND occurrence_id = ${occurrenceId} FOR UPDATE`;
      if (!o || o.status !== "exception") throw new ScheduleError("not_open", `no open exception ${occurrenceId}`, 404);
      await this.guard.check({ step: "plan", tenant, book: o.book_id, principal, op: { name: "schedule_approve", kind: "write", gate: "human" } });
      await tx`UPDATE ops.schedule_occurrences SET status = 'dismissed', reason = reason || ${` · dismissed by ${principal}: ${note}`}
        WHERE tenant_id = ${tenant} AND occurrence_id = ${occurrenceId}`;
      return { occurrenceId, status: "dismissed" as const };
    });
  }

  // ---------------------------------------------------------------- plan actions (inside an ops commit)
  async approve(tx: TransactionSql, tenant: string, a: { scheduleId: string; hash: string; approvedAmount: string }, principal: string, planId: string) {
    const [r] = await tx<{ status: string; hash: string }[]>`SELECT status, hash FROM ops.schedules WHERE tenant_id = ${tenant} AND schedule_id = ${a.scheduleId} FOR UPDATE`;
    if (!r) throw new ScheduleError("no_schedule", `no schedule ${a.scheduleId}`, 404);
    if (r.status !== "submitted") throw new ScheduleError("not_open", `schedule ${a.scheduleId} is ${r.status}`);
    if (r.hash !== a.hash) throw new ScheduleError("hash_mismatch", "the schedule changed since this approval was simulated");
    await tx`UPDATE ops.schedules SET status = 'approved', approved_hash = ${a.hash}, approved_amount = ${a.approvedAmount}, approval_plan_id = ${planId},
      approved_by = ${principal}, approved_at = now() WHERE tenant_id = ${tenant} AND schedule_id = ${a.scheduleId}`;
  }

  async cancel(tx: TransactionSql, tenant: string, a: { scheduleId: string; effective: string; recognized: string; released: string; remaining: string }, planId: string) {
    const n = await tx`UPDATE ops.schedules SET status = 'cancelled', cancelled_on = ${a.effective},
      cancellation = ${tx.json({ recognized: a.recognized, released: a.released, remaining: a.remaining, planId } as never)}
      WHERE tenant_id = ${tenant} AND schedule_id = ${a.scheduleId} AND status IN ('submitted','approved') RETURNING 1`;
    if (!n.length) throw new ScheduleError("not_open", `schedule ${a.scheduleId} is not active`);
    // Occurrences after the cancellation date will never run: nothing is left due or in exception after it.
    await tx`UPDATE ops.schedule_occurrences SET status = 'dismissed', reason = COALESCE(reason, '') || ' · schedule cancelled'
      WHERE tenant_id = ${tenant} AND schedule_id = ${a.scheduleId} AND status = 'exception' AND due_on > ${a.effective}`;
  }

  // ---------------------------------------------------------------- runner
  /**
   * Post every approved occurrence due on or before `asOf`, once. Safe to rerun and to run
   * concurrently: each occurrence is claimed under the book lock in the transaction that posts it.
   */
  async run(tenant: string, asOf: string = this.clock()): Promise<RunResult> {
    if (!isIsoDate(asOf)) throw new ScheduleError("bad_date", `bad as-of date ${asOf}`, 400);
    const out: RunResult = { tenant, asOf, posted: [], reversed: [], exceptions: [], skipped: [] };
    const keys = await this.store.keys(tenant);
    const { rows, occs } = await this.store.tenantTx(tenant, async (tx) => {
      const rows = await this.rows(tenant, tx, { status: "approved" });
      return { rows, occs: await this.occRows(tenant, tx, rows.map((r) => r.schedule_id)) };
    });
    for (const r of rows) {
      const v = this.view(tenant, keys, r, occs, asOf);
      const due = occurrencesOf(tenant, r.schedule_id, v.definition).filter((o) => o.dueOn <= asOf && v.occurrences.find((x) => x.occurrenceId === o.occurrenceId)!.status === "due");
      if (!due.length) continue;
      // The approval must still stand: same definition, same policy version, approver still authorized.
      if (r.approved_hash !== r.hash || definitionHash(r.book_id, v.definition) !== r.hash) { out.skipped.push({ scheduleId: r.schedule_id, reason: "definition differs from the approved one" }); continue; }
      if (v.definition.policyVersion !== this.currentPolicyVersion()) {
        out.skipped.push({ scheduleId: r.schedule_id, reason: `policy changed (${v.definition.policyVersion} → ${this.currentPolicyVersion()}); approve the schedule again` }); continue;
      }
      try {
        const plan = await this.getPlan(tenant, r.approval_plan_id!);
        await this.guard.check({ step: "commit", tenant, book: r.book_id, principal: r.approved_by!, op: { name: "schedule_approve", kind: "write", gate: "human" }, plan });
      } catch (e) { out.skipped.push({ scheduleId: r.schedule_id, reason: `approval no longer valid: ${e instanceof Error ? e.message : String(e)}` }); continue; }
      for (const o of due) await this.runOne(tenant, r, v, o, out);
    }
    return out;
  }

  private async runOne(tenant: string, r: Row, v: ScheduleView, o: Occurrence, out: RunResult) {
    const stream = `${tenant}/schedule/${r.schedule_id}`;
    const meta = { principal: SCHEDULER, commandId: r.approval_plan_id! };
    await this.gl.transact(tenant, r.book_id, async (b) => {
      const [claimed] = await b.tx`SELECT 1 FROM ops.schedule_occurrences WHERE tenant_id = ${tenant} AND occurrence_id = ${o.occurrenceId}`;
      if (claimed) return;                                                   // another run posted it (or raised its exception)
      const [cur] = await b.tx<{ status: string }[]>`SELECT status FROM ops.schedules WHERE tenant_id = ${tenant} AND schedule_id = ${r.schedule_id} FOR SHARE`;
      if (cur?.status !== "approved") return;
      if (o.kind === "reverse") {
        const [p] = await b.tx`SELECT 1 FROM ops.schedule_occurrences WHERE tenant_id = ${tenant} AND schedule_id = ${r.schedule_id}
          AND period = ${o.period} AND kind = 'post' AND status = 'posted'`;
        if (!p) return;                                                      // nothing to reverse (yet)
      }
      const record = (status: "posted" | "exception", reason: string | null) => b.tx`
        INSERT INTO ops.schedule_occurrences (tenant_id, occurrence_id, schedule_id, book_id, period, kind, due_on, status, journal_id, amount, reason, executed_by)
        VALUES (${tenant}, ${o.occurrenceId}, ${r.schedule_id}, ${r.book_id}, ${o.period}, ${o.kind}, ${o.dueOn}, ${status},
                ${status === "posted" ? o.journalId : null}, ${o.amount.toString()}, ${reason}, ${SCHEDULER})`;
      const raise = async (reason: string) => {
        await record("exception", reason);
        await this.store.append("ops", tenant, { streamId: stream, expected: "any", events: [{ type: "ScheduleExceptionRaised",
          data: { scheduleId: r.schedule_id, bookId: r.book_id, occurrenceId: o.occurrenceId, period: o.period, kind: o.kind, dueOn: o.dueOn, reason } }] }, meta, b.tx);
        out.exceptions.push({ occurrenceId: o.occurrenceId, reason });
      };
      if (o.amount > BigInt(r.approved_amount ?? "0")) return raise(`amount ${o.amount} paise is above the approved ${r.approved_amount} paise`);
      try {
        if (o.kind === "post") {
          await b.execute({ kind: "PostJournal", journalId: o.journalId, txnDate: o.dueOn, narration: `${v.definition.name} (${o.period})`,
            voucherType: v.kind === "recognition" ? "recognition" : "recurring", lines: o.lines, autonomy: "human", source: { stream } }, meta);
        } else {
          await b.execute({ kind: "ReverseJournal", journalId: S.occurrenceJournalId(tenant, r.schedule_id, o.period, "post"), reversalJournalId: o.journalId,
            reason: `auto-reversal of ${v.definition.name} (${o.period})`, onDate: o.dueOn }, meta);
        }
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;                           // infrastructure: nothing recorded, the next run retries
        // decide() refused before anything was appended: record the case, never move the date.
        return raise(`${e.code}: ${e.message}${o.kind === "reverse" ? ` (reversal due ${o.dueOn}; the date is not moved)` : ""}`);
      }
      await record("posted", null);
      (o.kind === "post" ? out.posted : out.reversed).push(o.journalId);
    });
  }

  // ---------------------------------------------------------------- reconciliation (FIN-GL-03)
  /**
   * Recognition schedules against the GL, by period and balance account: what the schedules say
   * the account should hold at each period end (prepaid: total − recognized − released; accrual:
   * −recognized) vs the GL balance, and what was scheduled vs recognized in the GL that period.
   */
  async reconciliation(tenant: string, book: string, opts: { to?: string } = {}) {
    const state = await this.gl.state(tenant, book);
    const views = (await this.list(tenant, book)).filter((v) => v.definition.recognition && v.status !== "submitted");
    const to = opts.to ?? this.clock();
    const periods = [...new Set(views.flatMap((v) => S.periodsBetween(v.definition.start, v.definition.end)))].filter((p) => S.periodStart(p) <= to).sort();
    const accounts = [...new Set(views.map((v) => v.definition.recognition!.balanceAccount))].sort();
    const rows: { period: string; accountId: string; scheduled: string; recognizedInGl: string; scheduleBalance: string; glBalance: string; difference: string; reconciled: boolean }[] = [];
    for (const p of periods) {
      const end = S.periodEnd(p);
      const gl = balancesFromState(state, { to: end });
      for (const acc of accounts) {
        let scheduleBalance = 0n, scheduled = 0n, recognized = 0n;
        for (const v of views.filter((x) => x.definition.recognition!.balanceAccount === acc)) {
          const r = v.definition.recognition!;
          if (S.periodOf(v.definition.start) > p) continue;
          const occ = occurrencesOf(tenant, v.scheduleId, v.definition).filter((o) => !(v.cancelledOn && o.dueOn > v.cancelledOn));
          const through = occ.filter((o) => o.period <= p).reduce((a, o) => a + o.amount, 0n);
          scheduled += occ.filter((o) => o.period === p).reduce((a, o) => a + o.amount, 0n);
          for (const o of occ.filter((x) => x.period === p)) {
            const j = state.journals.get(o.journalId);
            if (j) recognized += j.lines.filter((l) => l.accountId === acc).reduce((a, l) => a - BigInt(l.amount), 0n);
          }
          const released = v.cancelledOn && v.cancelledOn <= end && v.cancellation ? BigInt(v.cancellation.released) : 0n;
          scheduleBalance += r.type === "prepaid" ? BigInt(r.total) - through - released : -through;
        }
        const glBal = gl.get(acc) ?? 0n;
        rows.push({ period: p, accountId: acc, scheduled: scheduled.toString(), recognizedInGl: recognized.toString(), scheduleBalance: scheduleBalance.toString(),
          glBalance: glBal.toString(), difference: (glBal - scheduleBalance).toString(), reconciled: glBal === scheduleBalance && scheduled === recognized });
      }
    }
    return { bookId: book, to, rows, reconciled: rows.every((x) => x.reconciled) };
  }
}

/** A deterministic plan-local id for a schedule-derived journal (release on cancellation). */
export const releaseJournalId = (tenant: string, scheduleId: string, effective: string) => S.occurrenceJournalId(tenant, scheduleId, S.periodOf(effective), "release");
