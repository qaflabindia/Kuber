/**
 * The close service (FIN-CLS-01..04).
 *
 *   checklist        per book and period, seeded from the template (template.ts): owner, dependencies,
 *                    deadline, evidence kinds, status. Created and reassigned by a superuser or controller.
 *   substantiation   per balance-sheet account at period end: GL balance, the subledger or schedule
 *                    balance where one exists, reconciling items with age and owner, preparer, approver.
 *   completeness     expected sources with no data: a bank account with no statement, a schedule not
 *                    run, drafts, postings in flight and plans dated in the period.
 *   certified close  under one book version: the period's journal population and trial balance from the
 *                    ledger itself, the certified report snapshots (reporting.snapshots), the chart mapping
 *                    and rules versions, and every task and substantiation certification, sealed and hashed.
 *   reopen           withdraws the close, the substantiations and the bank reconciliations of the period.
 *   restatement      a controlled adjustment in an open period plus a restated comparative version with a
 *                    bridge (original → adjustments → restated); the original close is never changed.
 *
 * Every change to the checklist state, substantiations, closes and restatements happens in an ops plan's
 * commit (the `ext` handler below, in that transaction, under the book lock), so it has a preparer and a
 * different checker, passes the identity guard, is fenced on the book version and happens once. The only
 * direct writes are the checklist itself, a task's owner or deadline and a document hash, each authorized
 * by the identity module first.
 */
import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import { IsoDate, Principal, canonical, uuid } from "@kuber/contracts";
import type { EventStore, NewEvent } from "@kuber/eventstore";
import { bookStream, isSuspense, type BookState, type GeneralLedger } from "@kuber/gl";
import { OpsError, balancesFromState, type Check, type ExtensionHandler, type Operations } from "@kuber/ops";
import type { Reporting } from "@kuber/reporting";
import type { Agent } from "@kuber/agent";
import type { PolicyEngine } from "@kuber/policy";
import { EvidenceRegistry, contentHash, isEvidenceRef, type EvidenceKind, type EvidenceRef } from "./evidence.ts";
import { TEMPLATE, TEMPLATE_VERSION, addDays, daysBetween, inactiveReasons, monthStart, notApplicable, statementAccounts } from "./template.ts";
import { accountsOf, isBalanceSheet, journalsOf, mappingVersion, natural, population, rulesVersion, trialBalance, type TbRow } from "./ledger.ts";
import { closeBodyCtx, closeStream, documentNameCtx, restatementCtx, substantiationCtx } from "./migrations.ts";

export class CloseError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

/** The part of the identity module the close service needs (the cell passes Identity). */
export interface CloseGuard {
  /** Throws (403) unless `principal` may do `action` within `scope`. */
  authorize(tenant: string, principal: string, action: string, scope?: { book?: string; allBooks?: boolean }, tx?: TransactionSql): Promise<unknown>;
  /** The active membership, or null. */
  member(tenant: string, principal: string): Promise<{ role: string; books: string[] | null } | null>;
}

export interface CloseDeps {
  store: EventStore; gl: GeneralLedger; reporting: Reporting; ops: Operations; agent: Agent; policies: PolicyEngine;
  guard: CloseGuard; clock: () => string;
  /** FIN-GRP-01: is the book's entity in a consolidation group with intercompany links? Absent: no. */
  intercompanyActive?: (tenant: string, book: string) => Promise<boolean>;
}

export type TaskState = "open" | "awaiting_review" | "done" | "not_applicable";
export interface TaskView {
  taskId: string; area: string; title: string; owner: string | null; deadline: string; dependsOn: string[]; evidenceKinds: EvidenceKind[];
  applicable: boolean; reason: string | null; status: "open" | "done" | "not_applicable"; state: TaskState; overdue: boolean;
  evidence: EvidenceRef[]; completedBy: string | null; reviewedBy: string | null; completedAt: string | null; planId: string | null;
  /** Set when a reopen withdrew this task's evidence (FIN-CLS-04). */
  withdrawnReason: string | null;
}
export interface Checklist { bookId: string; periodEnd: string; periodStart: string; templateVersion: string; createdBy: string; tasks: TaskView[] }

export interface ReconcilingItem { description: string; amount: string; openedOn: string; ageDays: number; owner: string }
/** A substantiation as computed for a plan: amounts in paise; `glBalance` debit positive, the others in the account's natural sign. */
export interface Substantiation {
  bookId: string; periodEnd: string; periodStart: string; accountId: string; name: string; nature: string;
  glBalance: string; glNatural: string; activity: boolean;
  source: "bank_reconciliation" | "suspense" | "schedule" | "party_subledger" | "manual";
  sourceBalance: string | null; sourceDetail: string;
  items: ReconcilingItem[]; itemsTotal: string; difference: string;
  /** What the source consists of, for the reviewer: parties, open suspense items, schedule rows. */
  breakdown: { label: string; amount: string; detail?: string }[];
  evidence: EvidenceRef[]; note: string | null;
  problems: string[];
}
export interface SubstantiationInput {
  sourceBalance?: string;
  items?: { description: string; amount: string; openedOn: string; owner: string }[];
  evidence?: EvidenceRef[]; note?: string;
}
export interface StoredSubstantiation {
  accountId: string; version: number; status: "approved" | "withdrawn"; glBalance: string; hash: string; preparedBy: string; approvedBy: string;
  approvedAt: string; planId: string; withdrawnReason: string | null; record: Substantiation;
}
export interface Finding { code: "no_statement" | "schedule_not_run" | "pending_drafts" | "postings_in_flight" | "pending_plans" | "open_suspense"; label: string; detail: string; blocking: boolean }

export interface CloseBody {
  closeId: string; bookId: string; periodEnd: string; periodStart: string; version: number; supersedes: string | null;
  basisSeq: number; basisVersion: number; closeSeq: number; ledgerHash: string | null;
  population: { count: number; hash: string };
  trialBalance: { rows: TbRow[]; debits: string; credits: string };
  mappingVersion: string; rulesVersion: string;
  reportSnapshots: { kind: string; snapshotId: string; seq: number; contentHash: string }[];
  tasks: { taskId: string; status: string; reason: string | null; evidence: EvidenceRef[]; completedBy: string | null; reviewedBy: string | null }[];
  substantiations: { accountId: string; version: number; glBalance: string; hash: string; preparedBy: string; approvedBy: string }[];
  certifiedBy: string; planId: string;
}
export interface CloseRecord {
  closeId: string; bookId: string; periodEnd: string; version: number; status: "certified" | "withdrawn"; basisSeq: number; closeSeq: number;
  contentHash: string; populationHash: string; certifiedBy: string; certifiedAt: string; planId: string;
  withdrawnBy: string | null; withdrawnAt: string | null; withdrawnReason: string | null;
}
export interface BridgeRow { accountId: string; name: string; nature: string; original: string; adjustment: string; restated: string }
export interface RestatementBody {
  restatementId: string; bookId: string; comparativePeriodEnd: string; version: number; framework: string; reason: string;
  supersedes: { closeId: string; version: number; contentHash: string; reportSnapshots: CloseBody["reportSnapshots"] };
  journalId: string; postingDate: string; bridge: BridgeRow[]; changed: BridgeRow[]; bridgeHash: string;
  restatedTrialBalance: { accountId: string; balance: string }[];
}

type TaskRow = { task_id: string; area: string; title: string; owner: string | null; deadline: string; depends_on: string[]; evidence_kinds: EvidenceKind[];
  applicable: boolean; na_reason: string | null; status: TaskView["status"]; evidence: EvidenceRef[]; completed_by: string | null; reviewed_by: string | null;
  completed_at: Date | null; plan_id: string | null; withdrawn_reason: string | null };

const EXT = "close";
const J = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const isDate = (s: unknown): s is string => typeof s === "string" && IsoDate.safeParse(s).success;

export class CloseService {
  readonly evidence = new EvidenceRegistry();
  constructor(readonly d: CloseDeps) {
    // Built-in resolvers: the modules whose content Kuber computes itself. Bank reconciliations are FIN-CASH's.
    this.evidence.registerResolver("document", (ref, q) => this.resolveDocument(ref, q.tenant, q.book, q.tx));
    this.evidence.registerResolver("schedule_reconciliation", async (ref, q) => {
      const cur = await this.scheduleEvidence(q.tenant, q.book, q.periodEnd);
      if (ref.id !== cur.ref.id) return { ok: false, reason: `the schedule reconciliation for this period is ${cur.ref.id}` };
      if (ref.hash !== cur.ref.hash) return { ok: false, reason: "the schedules or the ledger changed since this reconciliation: cite the current one" };
      return cur.reconciled ? { ok: true, periodEnd: q.periodEnd } : { ok: false, reason: "the recognition schedules do not reconcile to the ledger for the period" };
    });
    this.evidence.registerResolver("suspense_roll_forward", async (ref, q) => {
      const cur = await this.suspenseEvidence(q.tenant, q.book, q.periodStart, q.periodEnd);
      if (ref.id !== cur.ref.id) return { ok: false, reason: `the suspense roll-forward for this period is ${cur.ref.id}` };
      if (ref.hash !== cur.ref.hash) return { ok: false, reason: "suspense items changed since this roll-forward: cite the current one" };
      return cur.balanced ? { ok: true, periodEnd: q.periodEnd, balancePaise: cur.closing } : { ok: false, reason: "the suspense roll-forward does not balance" };
    });
  }

  private keys(tenant: string) { return this.d.store.keys(tenant); }
  private tx<T>(tenant: string, fn: (tx: TransactionSql) => Promise<T>, tx?: TransactionSql) { return tx ? fn(tx) : this.d.store.tenantTx(tenant, fn); }
  private append(tx: TransactionSql, tenant: string, book: string, periodEnd: string, events: NewEvent[], meta: { principal: string; commandId?: string }) {
    return this.d.store.append("close", tenant, { streamId: closeStream(tenant, book, periodEnd), expected: "any", events }, meta, tx);
  }

  // ================================================================ checklist (FIN-CLS-01)
  async features(tenant: string, book: string, state: BookState) {
    const schedules = (await this.d.ops.schedules.list(tenant, book)).filter((v) => v.status === "approved").length;
    const intercompany = this.d.intercompanyActive ? await this.d.intercompanyActive(tenant, book) : false;
    return inactiveReasons(state, { schedules, intercompany });
  }

  async checklists(tenant: string, book: string) {
    return this.d.store.tenantTx(tenant, (tx) => tx<{ period_end: string; period_start: string; created_by: string; created_at: Date }[]>`
      SELECT period_end, period_start, created_by, created_at FROM close.checklists WHERE tenant_id = ${tenant} AND book_id = ${book} ORDER BY period_end`)
      .then((rows) => rows.map((r) => ({ periodEnd: r.period_end, periodStart: r.period_start, createdBy: r.created_by, createdAt: r.created_at.toISOString() })));
  }

  async checklist(tenant: string, book: string, periodEnd: string, tx?: TransactionSql): Promise<Checklist | null> {
    const today = this.d.clock();
    return this.tx(tenant, async (t) => {
      const [c] = await t<{ period_start: string; template_version: string; created_by: string }[]>`
        SELECT period_start, template_version, created_by FROM close.checklists WHERE tenant_id = ${tenant} AND book_id = ${book} AND period_end = ${periodEnd}`;
      if (!c) return null;
      const rows = await t<TaskRow[]>`SELECT task_id, area, title, owner, deadline, depends_on, evidence_kinds, applicable, na_reason, status, evidence,
          completed_by, reviewed_by, completed_at, plan_id, withdrawn_reason
        FROM close.tasks WHERE tenant_id = ${tenant} AND book_id = ${book} AND period_end = ${periodEnd}`;
      const order = new Map(TEMPLATE.map((x, i) => [x.taskId, i]));
      rows.sort((a, b) => (order.get(a.task_id) ?? 99) - (order.get(b.task_id) ?? 99));
      const tasks: TaskView[] = rows.map((r) => ({ taskId: r.task_id, area: r.area, title: r.title, owner: r.owner, deadline: r.deadline, dependsOn: r.depends_on,
        evidenceKinds: r.evidence_kinds, applicable: r.applicable, reason: r.na_reason, status: r.status,
        state: r.status === "open" ? "open" : r.status, overdue: r.status === "open" && r.deadline < today, evidence: r.evidence,
        completedBy: r.completed_by, reviewedBy: r.reviewed_by, completedAt: r.completed_at?.toISOString() ?? null, planId: r.plan_id, withdrawnReason: r.withdrawn_reason }));
      return { bookId: book, periodEnd, periodStart: c.period_start, templateVersion: c.template_version, createdBy: c.created_by, tasks };
    }, tx);
  }

  /** The checklist with "awaiting review" for tasks whose completion plan is proposed (read side only). */
  async checklistView(tenant: string, book: string, periodEnd: string): Promise<Checklist | null> {
    const c = await this.checklist(tenant, book, periodEnd);
    if (!c) return null;
    const pending = (await this.d.ops.pending(tenant, book, { limit: 200 })).filter((p) => p.op === "complete_close_task");
    for (const t of c.tasks) {
      if (t.status === "open" && pending.some((p) => (p.data as { taskId?: string; periodEnd?: string } | undefined)?.taskId === t.taskId
        && (p.data as { periodEnd?: string }).periodEnd === periodEnd)) t.state = "awaiting_review";
    }
    return c;
  }

  /**
   * Create the checklist of a period from the template. `owners`: a named principal per task (or
   * `defaultOwner`), each an active member who may prepare plans in the book. Tasks of features
   * not enabled are recorded as not applicable with the reason. A superuser or controller.
   */
  async createChecklist(tenant: string, book: string, principal: string, input: { periodEnd: string; periodStart?: string; owners?: Record<string, string>;
    defaultOwner?: string; deadlines?: Record<string, string> }) {
    await this.d.guard.authorize(tenant, principal, "plan.approve.period", { book });
    if (!isDate(input.periodEnd)) throw new CloseError("bad_date", `bad period end ${input.periodEnd}`, 400);
    const periodStart = input.periodStart ?? monthStart(input.periodEnd);
    if (!isDate(periodStart) || periodStart > input.periodEnd) throw new CloseError("bad_date", `the period must start (${periodStart}) on or before its end (${input.periodEnd})`, 400);
    const state = await this.d.gl.state(tenant, book);
    if (!state.exists) throw new CloseError("no_book", `book ${book} does not exist`, 404);
    const inactive = await this.features(tenant, book, state);
    const tasks: (typeof TEMPLATE[number] & { owner: string | null; deadline: string; applicable: boolean; reason: string | null })[] = [];
    for (const t of TEMPLATE) {
      const reason = inactive[t.taskId] ?? null;
      const owner = reason ? null : input.owners?.[t.taskId] ?? input.defaultOwner ?? null;
      if (!reason) {
        if (!owner) throw new CloseError("owner_required", `task ${t.taskId} (${t.area}) needs a named owner`, 400);
        await this.checkOwner(tenant, book, owner);
      }
      const deadline = input.deadlines?.[t.taskId] ?? addDays(input.periodEnd, t.offsetDays);
      if (!isDate(deadline)) throw new CloseError("bad_date", `bad deadline ${deadline} for ${t.taskId}`, 400);
      tasks.push({ ...t, owner, deadline, applicable: !reason, reason: reason ? notApplicable(reason) : null });
    }
    await this.d.store.tenantTx(tenant, async (tx) => {
      const ins = await tx`INSERT INTO close.checklists (tenant_id, book_id, period_end, period_start, template_version, created_by)
        VALUES (${tenant}, ${book}, ${input.periodEnd}, ${periodStart}, ${TEMPLATE_VERSION}, ${principal}) ON CONFLICT DO NOTHING RETURNING 1`;
      if (!ins.length) throw new CloseError("checklist_exists", `the checklist for ${book} to ${input.periodEnd} already exists`);
      for (const t of tasks) {
        await tx`INSERT INTO close.tasks (tenant_id, book_id, period_end, task_id, area, title, owner, deadline, depends_on, evidence_kinds, applicable, na_reason, status)
          VALUES (${tenant}, ${book}, ${input.periodEnd}, ${t.taskId}, ${t.area}, ${t.title}, ${t.owner}, ${t.deadline}, ${tx.json(t.dependsOn)}, ${tx.json(t.evidence)},
                  ${t.applicable}, ${t.reason}, ${t.applicable ? "open" : "not_applicable"})`;
      }
      await this.append(tx, tenant, book, input.periodEnd, [{ type: "CloseChecklistCreated", data: { bookId: book, periodEnd: input.periodEnd, periodStart, templateVersion: TEMPLATE_VERSION,
        tasks: tasks.map((t) => ({ taskId: t.taskId, area: t.area, owner: t.owner, deadline: t.deadline, dependsOn: t.dependsOn, applicable: t.applicable, reason: t.reason })) } }], { principal });
    });
    return (await this.checklist(tenant, book, input.periodEnd))!;
  }

  private async checkOwner(tenant: string, book: string, owner: string) {
    if (!Principal.safeParse(owner).success || /^(agent|system):/.test(owner)) throw new CloseError("bad_owner", `the owner ${owner} must be a named person`, 400);
    const m = await this.d.guard.member(tenant, owner);
    if (!m) throw new CloseError("bad_owner", `${owner} is not a member of this workspace`, 400);
    if (m.books !== null && !m.books.includes(book)) throw new CloseError("bad_owner", `${owner} has no access to book ${book}`, 400);
  }

  /** Change an open task's owner or deadline (a superuser or controller). */
  async assignTask(tenant: string, book: string, principal: string, periodEnd: string, taskId: string, input: { owner?: string; deadline?: string }) {
    await this.d.guard.authorize(tenant, principal, "plan.approve.period", { book });
    if (input.deadline !== undefined && !isDate(input.deadline)) throw new CloseError("bad_date", `bad deadline ${input.deadline}`, 400);
    if (input.owner !== undefined) await this.checkOwner(tenant, book, input.owner);
    await this.d.store.tenantTx(tenant, async (tx) => {
      const [t] = await tx<{ status: string; owner: string | null; deadline: string }[]>`SELECT status, owner, deadline FROM close.tasks
        WHERE tenant_id = ${tenant} AND book_id = ${book} AND period_end = ${periodEnd} AND task_id = ${taskId} FOR UPDATE`;
      if (!t) throw new CloseError("no_task", `no task ${taskId} in the checklist to ${periodEnd}`, 404);
      if (t.status !== "open") throw new CloseError("task_not_open", `task ${taskId} is ${t.status === "done" ? "done" : "not applicable"}: it cannot be reassigned`);
      const owner = input.owner ?? t.owner!, deadline = input.deadline ?? t.deadline;
      await tx`UPDATE close.tasks SET owner = ${owner}, deadline = ${deadline} WHERE tenant_id = ${tenant} AND book_id = ${book} AND period_end = ${periodEnd} AND task_id = ${taskId}`;
      await this.append(tx, tenant, book, periodEnd, [{ type: "CloseTaskAssigned", data: { bookId: book, periodEnd, taskId, owner, deadline } }], { principal });
    });
    return (await this.checklist(tenant, book, periodEnd))!;
  }

  /** Open tasks past their deadline in a book (FIN-CLS-01: they surface in attention). */
  async overdue(tenant: string, book: string): Promise<{ periodEnd: string; taskId: string; owner: string | null; deadline: string }[]> {
    const today = this.d.clock();
    const rows = await this.d.store.tenantTx(tenant, (tx) => tx<{ period_end: string; task_id: string; owner: string | null; deadline: string }[]>`
      SELECT period_end, task_id, owner, deadline FROM close.tasks WHERE tenant_id = ${tenant} AND book_id = ${book} AND status = 'open' AND deadline < ${today}
      ORDER BY deadline, task_id`);
    return rows.map((r) => ({ periodEnd: r.period_end, taskId: r.task_id, owner: r.owner, deadline: r.deadline }));
  }

  // ================================================================ evidence
  /** Register an uploaded document's SHA-256 for the book (the content is hashed here and not kept). */
  async registerDocument(tenant: string, book: string, principal: string, input: { name: string; contentBase64?: string; sha256?: string; periodEnd?: string }) {
    await this.d.guard.authorize(tenant, principal, "plan.prepare", { book });
    if (!input.name?.trim() || input.name.length > 300) throw new CloseError("bad_document", "a document needs a name (at most 300 characters)", 400);
    if (input.periodEnd !== undefined && !isDate(input.periodEnd)) throw new CloseError("bad_date", `bad period end ${input.periodEnd}`, 400);
    let hash: string;
    if (input.contentBase64 !== undefined) {
      const bytes = Buffer.from(input.contentBase64, "base64");
      if (!bytes.length) throw new CloseError("bad_document", "the document is empty", 400);
      hash = createHash("sha256").update(bytes).digest("hex");
      if (input.sha256 && input.sha256 !== hash) throw new CloseError("hash_mismatch", "the document's content does not match the SHA-256 given", 400);
    } else if (input.sha256 && /^[0-9a-f]{64}$/.test(input.sha256)) hash = input.sha256;
    else throw new CloseError("bad_document", "give the document's content (base64) or its SHA-256", 400);
    const documentId = uuid();
    const keys = await this.keys(tenant);
    await this.d.store.tenantTx(tenant, async (tx) => {
      await tx`INSERT INTO close.documents (tenant_id, document_id, book_id, sha256, name, period_end, registered_by)
        VALUES (${tenant}, ${documentId}, ${book}, ${hash}, ${keys.seal(input.name, documentNameCtx(documentId))}, ${input.periodEnd ?? null}, ${principal})`;
      await this.append(tx, tenant, book, input.periodEnd ?? "documents", [{ type: "CloseDocumentRegistered", data: { bookId: book, documentId, sha256: hash, periodEnd: input.periodEnd ?? null } }], { principal });
    });
    return { documentId, sha256: hash, name: input.name, ref: { kind: "document" as const, id: documentId, hash } };
  }

  private async resolveDocument(ref: EvidenceRef, tenant: string, book: string, tx?: TransactionSql) {
    const [r] = await this.tx(tenant, (t) => t<{ book_id: string; sha256: string; period_end: string | null }[]>`
      SELECT book_id, sha256, period_end FROM close.documents WHERE tenant_id = ${tenant} AND document_id = ${ref.id}`, tx);
    if (!r) return { ok: false as const, reason: "no such document is registered" };
    if (r.book_id !== book) return { ok: false as const, reason: `the document is registered for book ${r.book_id}, not ${book}` };
    if (r.sha256 !== ref.hash) return { ok: false as const, reason: "the hash does not match the registered document" };
    return { ok: true as const, ...(r.period_end ? { periodEnd: r.period_end } : {}) };
  }

  /** The current schedule reconciliation of the period (FIN-GL-03) and the reference that cites it. */
  async scheduleEvidence(tenant: string, book: string, periodEnd: string) {
    const r = await this.d.ops.schedules.reconciliation(tenant, book, { to: periodEnd });
    const rows = r.rows.filter((x) => x.period <= periodEnd.slice(0, 7));
    const reconciled = rows.every((x) => x.reconciled);
    return { ref: { kind: "schedule_reconciliation" as const, id: `schedules/${book}/${periodEnd}`, hash: contentHash({ book, periodEnd, rows }) }, reconciled, rows };
  }

  /** The current suspense roll-forward of the period (FIN-GL-05) and the reference that cites it. */
  async suspenseEvidence(tenant: string, book: string, periodStart: string, periodEnd: string) {
    const rf = await this.d.agent.suspense.rollForward(tenant, book, periodStart, periodEnd);
    return { ref: { kind: "suspense_roll_forward" as const, id: `suspense/${book}/${periodStart}/${periodEnd}`, hash: contentHash(rf) }, balanced: rf.balanced, closing: rf.closing, rollForward: rf };
  }

  // ================================================================ substantiation (FIN-CLS-02)
  /**
   * Balance-sheet accounts that need substantiation at period end: a balance, or activity in the
   * period (a zero balance with activity still needs it), and every bank or card account whatever its
   * balance (a statement must show there was nothing unrecorded).
   */
  requiredAccounts(s: BookState, periodStart: string, periodEnd: string): string[] {
    const bal = balancesFromState(s, { to: periodEnd }), act = new Set<string>();
    for (const j of s.journals.values()) if (j.txnDate >= periodStart && j.txnDate <= periodEnd) for (const l of j.lines) act.add(l.accountId);
    const banks = new Set(statementAccounts(s).map((a) => a.accountId));
    return [...s.accounts.values()].filter((a) => isBalanceSheet(a.nature) && ((bal.get(a.accountId) ?? 0n) !== 0n || act.has(a.accountId) || banks.has(a.accountId)))
      .map((a) => a.accountId).sort();
  }

  /** Compute an account's substantiation at period end from the ledger and its source; `problems` block approval. */
  async computeSubstantiation(tenant: string, book: string, s: BookState, periodStart: string, periodEnd: string, accountId: string, input: SubstantiationInput,
                              tx?: TransactionSql): Promise<Substantiation> {
    const a = s.accounts.get(accountId);
    const problems: string[] = [];
    if (!a) throw new CloseError("no_account", `no account ${accountId} in book ${book}`, 404);
    const gl = balancesFromState(s, { to: periodEnd }).get(accountId) ?? 0n;
    const nat = (raw: bigint) => natural(a.nature, raw);
    let activity = false;
    for (const j of s.journals.values()) if (j.txnDate >= periodStart && j.txnDate <= periodEnd && j.lines.some((l) => l.accountId === accountId)) { activity = true; break; }
    const evidence = input.evidence ?? [];
    for (const e of evidence) if (!isEvidenceRef(e)) problems.push("an evidence reference is not {kind, id, hash}");
    const q = { tenant, book, periodEnd, periodStart, accountId, ...(tx ? { tx } : {}) };
    let source: Substantiation["source"], sourceNatural: bigint | null = null, sourceDetail = "";
    const breakdown: Substantiation["breakdown"] = [];
    const isBank = statementAccounts(s).some((x) => x.accountId === accountId);
    if (isBank) {
      source = "bank_reconciliation";
      const recs = evidence.filter((e) => e.kind === "bank_reconciliation");
      if (!recs.length) problems.push(`no certified bank reconciliation (no statement) for ${accountId} for the period: cite one`);
      for (const r of recs.slice(0, 1)) {
        const out = await this.evidence.resolve(r, q);
        if (!out.ok) problems.push(`bank reconciliation ${r.id}: ${out.reason}`);
        else if (out.balancePaise === undefined || !/^-?\d+$/.test(out.balancePaise)) problems.push(`bank reconciliation ${r.id} does not state the reconciled balance`);
        else { sourceNatural = nat(BigInt(out.balancePaise)); sourceDetail = `certified bank reconciliation ${r.id}`; }
      }
    } else if (isSuspense(a)) {
      source = "suspense";
      const items = (await this.d.agent.suspense.list(tenant, book, { asOf: periodEnd }))
        .filter((i) => i.openedOn <= periodEnd && (i.resolvedOn === null || i.resolvedOn > periodEnd));
      let total = 0n;
      for (const i of items) { total += BigInt(i.amount); breakdown.push({ label: `Suspense item ${i.itemId} (${i.journalId})`, amount: nat(BigInt(i.amount)).toString(), detail: `opened ${i.openedOn}, ${i.ageDays} day(s), owner ${i.owner ?? "unassigned"}` }); }
      sourceNatural = nat(total); sourceDetail = `${items.length} open suspense item(s) at ${periodEnd}`;
    } else {
      const sched = (await this.d.ops.schedules.reconciliation(tenant, book, { to: periodEnd })).rows.filter((r) => r.accountId === accountId && r.period === periodEnd.slice(0, 7));
      if (sched.length) {
        source = "schedule";
        const b = sched.reduce((x, r) => x + BigInt(r.scheduleBalance), 0n);
        for (const r of sched) breakdown.push({ label: `Recognition schedules ${r.period}`, amount: nat(BigInt(r.scheduleBalance)).toString(), detail: r.reconciled ? "reconciled" : `difference ${r.difference}` });
        sourceNatural = nat(b); sourceDetail = "recognition schedule balance (FIN-GL-03)";
      } else if (a.isControl) {
        source = "party_subledger";
        const parties = new Map<string, bigint>();
        for (const j of s.journals.values()) if (j.txnDate <= periodEnd) for (const l of j.lines) if (l.accountId === accountId) parties.set(l.partyId ?? "(no party)", (parties.get(l.partyId ?? "(no party)") ?? 0n) + BigInt(l.amount));
        let total = 0n;
        for (const [p, v] of [...parties.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) { if (v === 0n) continue; total += v; breakdown.push({ label: `Party ${p}`, amount: nat(v).toString() }); }
        sourceNatural = nat(total); sourceDetail = `party subledger (${breakdown.length} part${breakdown.length === 1 ? "y" : "ies"} with a balance)`;
      } else {
        source = "manual";
        if (input.sourceBalance === undefined) problems.push("no subledger or schedule for this account: give the supporting balance (sourceBalance) from its evidence");
        else {
          try { sourceNatural = parseRupees(input.sourceBalance); sourceDetail = "supporting balance given by the preparer"; }
          catch { problems.push(`not an amount: ${input.sourceBalance}`); }
        }
        if (gl !== 0n && !evidence.some((e) => e.kind === "document")) problems.push("a balance without a subledger needs a supporting document (document evidence)");
      }
    }
    // every cited reference must resolve (the bank reconciliation was resolved above)
    for (const e of evidence.filter((x) => isEvidenceRef(x) && x.kind !== "bank_reconciliation")) {
      const out = await this.evidence.resolve(e, q);
      if (!out.ok) problems.push(`${e.kind} ${e.id}: ${out.reason}`);
    }
    const items: ReconcilingItem[] = [];
    for (const i of input.items ?? []) {
      let amt: bigint;
      try { amt = parseRupees(i.amount); } catch { problems.push(`reconciling item "${i.description}": not an amount (${i.amount})`); continue; }
      if (!isDate(i.openedOn) || i.openedOn > periodEnd) problems.push(`reconciling item "${i.description}": opened on ${i.openedOn}, which is not on or before ${periodEnd}`);
      if (!Principal.safeParse(i.owner).success) problems.push(`reconciling item "${i.description}": the owner ${i.owner} is not a named person`);
      if (amt === 0n) problems.push(`reconciling item "${i.description}" has no amount`);
      items.push({ description: i.description, amount: amt.toString(), openedOn: i.openedOn, ageDays: isDate(i.openedOn) ? daysBetween(i.openedOn, periodEnd) : 0, owner: i.owner });
    }
    const itemsTotal = items.reduce((x, i) => x + BigInt(i.amount), 0n);
    const difference = sourceNatural === null ? null : nat(gl) - sourceNatural - itemsTotal;
    if (difference !== null && difference !== 0n) problems.push(`GL ${nat(gl)} − source ${sourceNatural} − reconciling items ${itemsTotal} = ${difference} paise: it must be exactly zero`);
    if (!isBalanceSheet(a.nature)) problems.push(`${accountId} is a ${a.nature} account: only balance-sheet accounts are substantiated`);
    if (gl === 0n && activity && !input.note?.trim() && source === "manual") problems.push("a zero balance with activity in the period needs an explanation (note)");
    return { bookId: book, periodEnd, periodStart, accountId, name: a.name, nature: a.nature, glBalance: gl.toString(), glNatural: nat(gl).toString(), activity,
      source: source!, sourceBalance: sourceNatural === null ? null : sourceNatural.toString(), sourceDetail, items, itemsTotal: itemsTotal.toString(),
      difference: difference === null ? "unknown" : difference.toString(), breakdown, evidence, note: input.note?.trim() || null, problems };
  }

  async substantiations(tenant: string, book: string, periodEnd: string, opts: { all?: boolean; tx?: TransactionSql } = {}): Promise<StoredSubstantiation[]> {
    const keys = await this.keys(tenant);
    const rows = await this.tx(tenant, (t) => t<{ account_id: string; version: number; status: "approved" | "withdrawn"; gl_balance: string; hash: string; body: string;
      prepared_by: string; approved_by: string; approved_at: Date; plan_id: string; withdrawn_reason: string | null }[]>`
      SELECT account_id, version, status, gl_balance::text AS gl_balance, hash, body, prepared_by, approved_by, approved_at, plan_id, withdrawn_reason
      FROM close.substantiations WHERE tenant_id = ${tenant} AND book_id = ${book} AND period_end = ${periodEnd} ${opts.all ? t`` : t`AND status = 'approved'`}
      ORDER BY account_id, version`, opts.tx);
    return rows.map((r) => ({ accountId: r.account_id, version: r.version, status: r.status, glBalance: r.gl_balance, hash: r.hash, preparedBy: r.prepared_by,
      approvedBy: r.approved_by, approvedAt: r.approved_at.toISOString(), planId: r.plan_id, withdrawnReason: r.withdrawn_reason,
      record: JSON.parse(keys.openText(r.body, substantiationCtx(book, periodEnd, r.account_id, r.version))) as Substantiation }));
  }

  // ================================================================ completeness (FIN-CLS-02)
  /** Expected sources with no data, and pending financial effects dated in the period. Every finding blocks certification. */
  async completeness(tenant: string, book: string, s: BookState, periodEnd: string, current: StoredSubstantiation[]): Promise<Finding[]> {
    const out: Finding[] = [];
    for (const a of statementAccounts(s)) {
      const sub = current.find((x) => x.accountId === a.accountId);
      if (!sub || !sub.record.evidence.some((e) => e.kind === "bank_reconciliation"))
        out.push({ code: "no_statement", label: `No statement for ${a.accountId} for the period`, detail: `${a.name}: no certified bank reconciliation is cited for ${periodEnd}; a zero ledger balance does not show that nothing is missing`, blocking: true });
    }
    for (const v of (await this.d.ops.schedules.list(tenant, book, { asOf: periodEnd })).filter((x) => x.status === "approved")) {
      const behind = v.occurrences.filter((o) => o.dueOn <= periodEnd && (o.status === "due" || o.status === "exception"));
      if (behind.length) out.push({ code: "schedule_not_run", label: `Schedule ${v.definition.name ?? v.scheduleId} not run for the period`, detail: behind.map((o) => `${o.kind} ${o.period} (${o.status}${o.reason ? `: ${o.reason}` : ""})`).join(", "), blocking: true });
    }
    const drafts = (await this.d.agent.queue(tenant, { bookId: book }) as unknown as { draft_id: string; status: string; proposal: { txnDate: string } }[]).filter((d) => d.proposal.txnDate <= periodEnd);
    if (drafts.length) out.push({ code: "pending_drafts", label: `${drafts.length} draft(s) dated in the period`, detail: `decide them first (including postings the ledger refused): ${drafts.slice(0, 5).map((d) => d.draft_id).join(", ")}`, blocking: true });
    const inFlight = (await this.d.agent.inFlight(tenant, book)).length;
    if (inFlight) out.push({ code: "postings_in_flight", label: `${inFlight} approved posting(s) awaiting the ledger`, detail: "wait for the ledger's answer", blocking: true });
    const plans = (await this.d.ops.pending(tenant, book, { limit: 200 }))
      .filter((p) => !["complete_close_task", "approve_substantiation", "certify_close", "reopen_period", "restate", "close"].includes(p.op) && p.journals.some((j) => j.txnDate <= periodEnd));
    if (plans.length) out.push({ code: "pending_plans", label: `${plans.length} open plan(s) dated in the period`, detail: plans.slice(0, 5).map((p) => `${p.title} (${p.planId})`).join("; "), blocking: true });
    return out;
  }

  /** Everything the close of a period stands on, for people and the close_status operation. */
  async status(tenant: string, book: string, periodEnd: string) {
    const c = await this.checklistView(tenant, book, periodEnd);
    const state = await this.d.gl.state(tenant, book);
    if (!state.exists) throw new CloseError("no_book", `book ${book} does not exist`, 404);
    const periodStart = c?.periodStart ?? monthStart(periodEnd);
    const current = await this.substantiations(tenant, book, periodEnd);
    const required = this.requiredAccounts(state, periodStart, periodEnd);
    const bal = balancesFromState(state, { to: periodEnd });
    const accounts = required.map((id) => {
      const sub = current.find((x) => x.accountId === id);
      const gl = (bal.get(id) ?? 0n).toString();
      return { accountId: id, name: state.accounts.get(id)?.name ?? id, glBalance: gl,
        status: !sub ? "missing" as const : sub.glBalance !== gl ? "stale" as const : "approved" as const,
        preparedBy: sub?.preparedBy ?? null, approvedBy: sub?.approvedBy ?? null, source: sub?.record.source ?? null, items: sub?.record.items ?? [] };
    });
    const findings = c ? await this.completeness(tenant, book, state, periodEnd, current) : [];
    const closes = (await this.closes(tenant, book)).filter((x) => x.periodEnd === periodEnd);
    const certified = closes.find((x) => x.status === "certified") ?? null;
    const blockers = [
      ...(!c ? ["no close checklist for this period"] : []),
      ...(c?.tasks.filter((t) => t.status === "open").map((t) => `task ${t.taskId} is not complete${t.overdue ? " (overdue)" : ""}`) ?? []),
      ...accounts.filter((a) => a.status !== "approved").map((a) => `substantiation of ${a.accountId} is ${a.status}`),
      ...findings.filter((f) => f.blocking).map((f) => f.label),
    ];
    return { bookId: book, periodEnd, periodStart, checklist: c, substantiations: accounts, findings, certified, closes, blockers,
      hardLocked: state.locks.some((l) => l.level === "hard" && l.periodEnd >= periodEnd), closedInLedger: (state.closes ?? []).some((x) => x.periodEnd === periodEnd) };
  }

  /** FIN-CLS-03: the `close` operation's gate. A book that keeps a checklist is hard-closed only after a current certified close. */
  async gate(tenant: string, book: string, periodEnd: string): Promise<Check[]> {
    const lists = await this.checklists(tenant, book);
    if (!lists.length) return [{ label: "Certified close (FIN-CLS-03)", ok: true, blocking: false, detail: "this book keeps no close checklist: the close is not a certified close" }];
    const cur = (await this.closes(tenant, book)).find((x) => x.periodEnd === periodEnd && x.status === "certified");
    return [{ label: "A certified close of the period exists (FIN-CLS-03)", ok: !!cur, blocking: true,
      detail: cur ? `close ${cur.closeId}, version ${cur.version}` : "complete the checklist and the substantiations, then certify the close (certify_close) before the hard close" }];
  }

  // ================================================================ certified closes (FIN-CLS-03)
  async closes(tenant: string, book?: string, tx?: TransactionSql): Promise<CloseRecord[]> {
    const rows = await this.tx(tenant, (t) => t<{ close_id: string; book_id: string; period_end: string; version: number; status: "certified" | "withdrawn"; basis_seq: number; close_seq: number;
      content_hash: string; population_hash: string; certified_by: string; certified_at: Date; plan_id: string; withdrawn_by: string | null; withdrawn_at: Date | null; withdrawn_reason: string | null }[]>`
      SELECT close_id, book_id, period_end, version, status, basis_seq, close_seq, content_hash, population_hash, certified_by, certified_at, plan_id, withdrawn_by, withdrawn_at, withdrawn_reason
      FROM close.closes WHERE tenant_id = ${tenant} ${book ? t`AND book_id = ${book}` : t``} ORDER BY period_end, version`, tx);
    return rows.map((r) => ({ closeId: r.close_id, bookId: r.book_id, periodEnd: r.period_end, version: r.version, status: r.status, basisSeq: r.basis_seq, closeSeq: r.close_seq,
      contentHash: r.content_hash, populationHash: r.population_hash, certifiedBy: r.certified_by, certifiedAt: r.certified_at.toISOString(), planId: r.plan_id,
      withdrawnBy: r.withdrawn_by, withdrawnAt: r.withdrawn_at?.toISOString() ?? null, withdrawnReason: r.withdrawn_reason }));
  }

  /** A certified close with its sealed body, its hash re-checked. Withdrawn closes stay retrievable. */
  async getClose(tenant: string, closeId: string): Promise<(CloseRecord & { body: CloseBody; verified: boolean }) | null> {
    const [r] = await this.d.store.tenantTx(tenant, (tx) => tx<{ body: string; book_id: string }[]>`SELECT body, book_id FROM close.closes WHERE tenant_id = ${tenant} AND close_id = ${closeId}`);
    if (!r) return null;
    const rec = (await this.closes(tenant, r.book_id)).find((x) => x.closeId === closeId)!;
    const body = JSON.parse((await this.keys(tenant)).openText(r.body, closeBodyCtx(closeId))) as CloseBody;
    return { ...rec, body, verified: contentHash(body) === rec.contentHash && body.population.hash === rec.populationHash };
  }

  /** Recompute a certified close from the ledger at its position (population, trial balance) and its report snapshots; compare. */
  async reproduce(tenant: string, closeId: string) {
    const c = await this.getClose(tenant, closeId);
    if (!c) throw new CloseError("no_close", `no close ${closeId}`, 404);
    const events = await this.d.store.readStream(tenant, bookStream(tenant, c.bookId));
    const journals = journalsOf(events);
    const pop = population(journals, c.periodEnd, c.body.closeSeq);
    const tb = trialBalance(pop.journals, accountsOf(events));
    const reports = [];
    for (const s of c.body.reportSnapshots) {
      const r = await this.d.reporting.reproduceSnapshot(tenant, s.snapshotId);
      reports.push({ kind: s.kind, snapshotId: s.snapshotId, matches: r.matches });
    }
    const populationMatches = pop.hash === c.body.population.hash && pop.count === c.body.population.count;
    const trialBalanceMatches = canonical(tb.rows.map((r) => [r.accountId, r.balance])) === canonical(c.body.trialBalance.rows.map((r) => [r.accountId, r.balance]));
    return { closeId, verified: c.verified, populationMatches, trialBalanceMatches, reports, matches: c.verified && populationMatches && trialBalanceMatches && reports.every((r) => r.matches) };
  }

  // ================================================================ restatements (FIN-CLS-04)
  async restatements(tenant: string, book: string) {
    const rows = await this.d.store.tenantTx(tenant, (tx) => tx<{ restatement_id: string; comparative_period_end: string; version: number; supersedes_close_id: string; journal_id: string;
      bridge_hash: string; approved_by: string; plan_id: string; created_at: Date }[]>`
      SELECT restatement_id, comparative_period_end, version, supersedes_close_id, journal_id, bridge_hash, approved_by, plan_id, created_at FROM close.restatements
      WHERE tenant_id = ${tenant} AND book_id = ${book} ORDER BY comparative_period_end, version`);
    return rows.map((r) => ({ restatementId: r.restatement_id, comparativePeriodEnd: r.comparative_period_end, version: r.version, supersedesCloseId: r.supersedes_close_id,
      journalId: r.journal_id, bridgeHash: r.bridge_hash, approvedBy: r.approved_by, planId: r.plan_id, createdAt: r.created_at.toISOString() }));
  }
  async getRestatement(tenant: string, restatementId: string): Promise<(RestatementBody & { approvedBy: string; planId: string; verified: boolean; bookId: string }) | null> {
    const [r] = await this.d.store.tenantTx(tenant, (tx) => tx<{ body: string; bridge_hash: string; approved_by: string; plan_id: string }[]>`
      SELECT body, bridge_hash, approved_by, plan_id FROM close.restatements WHERE tenant_id = ${tenant} AND restatement_id = ${restatementId}`);
    if (!r) return null;
    const body = JSON.parse((await this.keys(tenant)).openText(r.body, restatementCtx(restatementId))) as RestatementBody;
    return { ...body, approvedBy: r.approved_by, planId: r.plan_id, verified: body.bridgeHash === r.bridge_hash && contentHash(body.bridge) === r.bridge_hash };
  }

  // ================================================================ ext actions (inside an ops commit)
  readonly extension: ExtensionHandler = async (tx, ctx, a) => {
    const p = a.payload as { bookId: string; periodEnd: string; preparedBy: string } & Record<string, unknown>;
    if (p.bookId !== ctx.book) throw new OpsError("wrong_book", `this close action is for book ${p.bookId}, not ${ctx.book}; nothing was applied`);
    const checker = ctx.approvedBy ?? ctx.principal;
    const meta = { principal: ctx.principal, commandId: ctx.planId };
    const t = ctx.tenant, book = ctx.book;
    switch (a.kind) {
      case "completeTask": return this.extCompleteTask(tx, t, book, p as never, checker, meta);
      case "substantiate": return this.extSubstantiate(tx, t, book, p as never, checker, meta);
      case "certify": return this.extCertify(tx, t, book, p as never, checker, meta);
      case "reopen": return this.extReopen(tx, t, book, p as never, checker, meta);
      case "restate": return this.extRestate(tx, t, book, p as never, checker, meta);
      default: throw new OpsError("bad_action", `unknown close action ${a.kind}; nothing was applied`);
    }
  };

  private async lockChecklist(tx: TransactionSql, t: string, book: string, periodEnd: string) {
    const [c] = await tx<{ period_start: string }[]>`SELECT period_start FROM close.checklists WHERE tenant_id = ${t} AND book_id = ${book} AND period_end = ${periodEnd} FOR UPDATE`;
    if (!c) throw new OpsError("no_checklist", `no close checklist for ${book} to ${periodEnd}; nothing was applied`);
    return c.period_start;
  }

  private async extCompleteTask(tx: TransactionSql, t: string, book: string, p: { periodEnd: string; taskId: string; preparedBy: string; evidence: EvidenceRef[] },
                                checker: string, meta: { principal: string; commandId: string }) {
    const periodStart = await this.lockChecklist(tx, t, book, p.periodEnd);
    const c = (await this.checklist(t, book, p.periodEnd, tx))!;
    const task = c.tasks.find((x) => x.taskId === p.taskId);
    if (!task) throw new OpsError("no_task", `no task ${p.taskId}; nothing was applied`);
    if (task.status === "done") throw new OpsError("task_done", `task ${p.taskId} is already complete (reviewed by ${task.reviewedBy}); nothing was applied`);
    if (task.status !== "open") throw new OpsError("task_not_applicable", `task ${p.taskId} is ${task.reason}; it cannot be completed`);
    if (task.owner !== p.preparedBy) throw new OpsError("not_owner", `task ${p.taskId} is owned by ${task.owner}; ${p.preparedBy} cannot complete it`, 403);
    if (checker === p.preparedBy) throw new OpsError("same_person", `the owner (${p.preparedBy}) completed task ${p.taskId}; review is by a different person`, 403);
    const waiting = task.dependsOn.filter((dep) => c.tasks.find((x) => x.taskId === dep)?.status === "open");
    if (waiting.length) throw new OpsError("dependencies_open", `task ${p.taskId} depends on ${waiting.join(", ")}, not yet complete; nothing was applied`);
    this.checkTaskEvidence(task, p.evidence);
    const problems = await this.evidence.problems(p.evidence, { tenant: t, book, periodEnd: p.periodEnd, periodStart, tx });
    if (problems.length) throw new OpsError("evidence_invalid", `evidence does not resolve: ${problems.join("; ")}; nothing was applied`);
    await tx`UPDATE close.tasks SET status = 'done', evidence = ${tx.json(J(p.evidence) as never)}, completed_by = ${p.preparedBy}, reviewed_by = ${checker},
      completed_at = now(), plan_id = ${meta.commandId}, withdrawn_reason = NULL
      WHERE tenant_id = ${t} AND book_id = ${book} AND period_end = ${p.periodEnd} AND task_id = ${p.taskId}`;
    await this.append(tx, t, book, p.periodEnd, [{ type: "CloseTaskCompleted", data: { bookId: book, periodEnd: p.periodEnd, taskId: p.taskId, completedBy: p.preparedBy,
      reviewedBy: checker, evidence: p.evidence, planId: meta.commandId } }], meta);
    return `completed task ${p.taskId} (by ${p.preparedBy}, reviewed by ${checker})`;
  }

  /** A task completes only with at least one reference of a kind it accepts. */
  checkTaskEvidence(task: Pick<TaskView, "taskId" | "evidenceKinds">, evidence: EvidenceRef[]) {
    if (!evidence.length) throw new OpsError("evidence_required", `task ${task.taskId} needs its evidence (${task.evidenceKinds.join(" or ")}); nothing was applied`);
    const wrong = evidence.filter((e) => !task.evidenceKinds.includes(e.kind));
    if (wrong.length) throw new OpsError("evidence_kind", `task ${task.taskId} accepts ${task.evidenceKinds.join(" or ")} evidence, not ${wrong.map((w) => w.kind).join(", ")}`);
  }

  private async extSubstantiate(tx: TransactionSql, t: string, book: string, p: { periodEnd: string; accountId: string; preparedBy: string; record: Substantiation; hash: string },
                                checker: string, meta: { principal: string; commandId: string }) {
    const periodStart = await this.lockChecklist(tx, t, book, p.periodEnd);
    if (checker === p.preparedBy) throw new OpsError("same_person", `${p.preparedBy} prepared this substantiation; approval is independent (a different person)`, 403);
    if (contentHash(p.record) !== p.hash) throw new OpsError("hash_mismatch", "the substantiation is not the one simulated; nothing was applied");
    const problems = await this.evidence.problems(p.record.evidence, { tenant: t, book, periodEnd: p.periodEnd, periodStart, accountId: p.accountId, tx });
    if (problems.length) throw new OpsError("evidence_invalid", `evidence does not resolve: ${problems.join("; ")}; nothing was applied`);
    const [cur] = await tx<{ n: number; v: number }[]>`SELECT count(*) FILTER (WHERE status = 'approved')::int AS n, COALESCE(max(version), 0)::int AS v FROM close.substantiations
      WHERE tenant_id = ${t} AND book_id = ${book} AND period_end = ${p.periodEnd} AND account_id = ${p.accountId}`;
    if (cur!.n) throw new OpsError("already_substantiated", `${p.accountId} is already substantiated for ${p.periodEnd}; nothing was applied`);
    const version = cur!.v + 1;
    const keys = await this.keys(t);
    await tx`INSERT INTO close.substantiations (tenant_id, book_id, period_end, account_id, version, status, gl_balance, hash, body, prepared_by, approved_by, plan_id)
      VALUES (${t}, ${book}, ${p.periodEnd}, ${p.accountId}, ${version}, 'approved', ${p.record.glBalance}, ${p.hash},
              ${keys.seal(JSON.stringify(p.record), substantiationCtx(book, p.periodEnd, p.accountId, version))}, ${p.preparedBy}, ${checker}, ${meta.commandId})`;
    await this.append(tx, t, book, p.periodEnd, [{ type: "AccountSubstantiated", data: { bookId: book, periodEnd: p.periodEnd, accountId: p.accountId, glBalance: p.record.glBalance,
      source: p.record.source, sourceBalance: p.record.sourceBalance, items: p.record.items.length, preparedBy: p.preparedBy, approvedBy: checker, hash: p.hash, planId: meta.commandId } }], meta);
    return `substantiated ${p.accountId} at ${p.periodEnd} (prepared by ${p.preparedBy}, approved by ${checker})`;
  }

  /**
   * Everything a certification needs, checked in the commit's transaction: the checklist complete,
   * every required account substantiated at its current balance, the completeness test clean, the
   * evidence still resolving, and the ledger's population and mapping exactly as simulated.
   */
  private async extCertify(tx: TransactionSql, t: string, book: string, p: { periodEnd: string; preparedBy: string; closeId: string; version: number; basisSeq: number; basisVersion: number;
    populationHash: string; mappingVersion: string; rulesVersion: string }, checker: string, meta: { principal: string; commandId: string }) {
    const periodStart = await this.lockChecklist(tx, t, book, p.periodEnd);
    const prior = await this.closes(t, book, tx);
    const active = prior.find((x) => x.periodEnd === p.periodEnd && x.status === "certified");
    if (active) throw new OpsError("already_certified", `${p.periodEnd} is already certified (close ${active.closeId}, version ${active.version}); nothing was applied`);
    const version = Math.max(0, ...prior.filter((x) => x.periodEnd === p.periodEnd).map((x) => x.version)) + 1;
    if (version !== p.version) throw new OpsError("stale", `a close of ${p.periodEnd} was certified or withdrawn since this was simulated; simulate again`);
    const c = (await this.checklist(t, book, p.periodEnd, tx))!;
    const open = c.tasks.filter((x) => x.status === "open");
    if (open.length) throw new OpsError("checklist_open", `tasks not complete: ${open.map((x) => x.taskId).join(", ")}; nothing was applied`);
    for (const task of c.tasks.filter((x) => x.status === "done")) {
      const problems = await this.evidence.problems(task.evidence, { tenant: t, book, periodEnd: p.periodEnd, periodStart, tx });
      if (problems.length) throw new OpsError("evidence_invalid", `task ${task.taskId}: evidence no longer resolves: ${problems.join("; ")}; nothing was applied`);
    }
    // the ledger inside this transaction (the book lock is held: nothing else can post)
    const events = await this.d.store.readStream(t, bookStream(t, book), 0, tx);
    const journals = journalsOf(events);
    const accounts = accountsOf(events);
    const pop = population(journals, p.periodEnd);
    if (pop.hash !== p.populationHash) throw new OpsError("stale", `the journals of the period changed since this was simulated; simulate again`);
    if (mappingVersion(accounts.values()) !== p.mappingVersion) throw new OpsError("stale", "the chart mapping changed since this was simulated; simulate again");
    const tb = trialBalance(pop.journals, accounts);
    const subs = await this.substantiations(t, book, p.periodEnd, { tx });
    const state = await this.d.gl.state(t, book);
    const required = this.requiredAccounts(state, periodStart, p.periodEnd);
    const bal = new Map(tb.rows.map((r) => [r.accountId, r.balance]));
    for (const id of required) {
      const s = subs.find((x) => x.accountId === id);
      if (!s) throw new OpsError("substantiation_missing", `${id} is not substantiated for ${p.periodEnd}; nothing was applied`);
      if (s.glBalance !== (bal.get(id) ?? "0")) throw new OpsError("substantiation_stale", `${id} was substantiated at ${s.glBalance}; the ledger shows ${bal.get(id) ?? "0"}: substantiate again`);
    }
    const findings = (await this.completeness(t, book, state, p.periodEnd, subs)).filter((f) => f.blocking);
    if (findings.length) throw new OpsError("incomplete", `completeness test: ${findings.map((f) => f.label).join("; ")}; nothing was applied`);
    const closeSeq = journals.at(-1)?.seq ?? 0;
    // Certified report snapshots (reporting.snapshots): the same statements every export of this close uses.
    const reportSnapshots: CloseBody["reportSnapshots"] = [];
    for (const [kind, params] of [["trial-balance", { asOf: p.periodEnd }], ["balance-sheet", { asOf: p.periodEnd }], ["profit-and-loss", { from: periodStart, to: p.periodEnd }]] as const) {
      const snap = await this.d.reporting.certify(t, book, kind, params, checker);
      if (snap.seq !== closeSeq) throw new OpsError("stale", `the report projection is at journal ${snap.seq}, the ledger at ${closeSeq}; try again`);
      reportSnapshots.push({ kind, snapshotId: snap.snapshotId, seq: snap.seq, contentHash: snap.contentHash });
    }
    const previous = prior.filter((x) => x.periodEnd === p.periodEnd).at(-1)?.closeId ?? null;
    const body: CloseBody = {
      closeId: p.closeId, bookId: book, periodEnd: p.periodEnd, periodStart, version, supersedes: previous, basisSeq: p.basisSeq, basisVersion: p.basisVersion, closeSeq,
      ledgerHash: journals.at(-1)?.hash ?? null, population: { count: pop.count, hash: pop.hash }, trialBalance: tb, mappingVersion: p.mappingVersion,
      rulesVersion: rulesVersion(this.d.policies.policies), reportSnapshots,
      tasks: c.tasks.map((x) => ({ taskId: x.taskId, status: x.status, reason: x.reason, evidence: x.evidence, completedBy: x.completedBy, reviewedBy: x.reviewedBy })),
      substantiations: subs.map((s) => ({ accountId: s.accountId, version: s.version, glBalance: s.glBalance, hash: s.hash, preparedBy: s.preparedBy, approvedBy: s.approvedBy })),
      certifiedBy: checker, planId: meta.commandId,
    };
    const hash = contentHash(body);
    const keys = await this.keys(t);
    await tx`INSERT INTO close.closes (tenant_id, close_id, book_id, period_end, version, status, basis_seq, close_seq, content_hash, population_hash, body, certified_by, plan_id)
      VALUES (${t}, ${p.closeId}, ${book}, ${p.periodEnd}, ${version}, 'certified', ${p.basisSeq}, ${closeSeq}, ${hash}, ${pop.hash},
              ${keys.seal(JSON.stringify(body), closeBodyCtx(p.closeId))}, ${checker}, ${meta.commandId})`;
    await this.append(tx, t, book, p.periodEnd, [{ type: "PeriodCloseCertified", data: { bookId: book, periodEnd: p.periodEnd, closeId: p.closeId, version, basisSeq: p.basisSeq,
      contentHash: hash, populationHash: pop.hash, reportSnapshots: reportSnapshots.map(({ kind, snapshotId, contentHash }) => ({ kind, snapshotId, contentHash })), planId: meta.commandId } }], meta);
    return `certified the close of ${p.periodEnd} (close ${p.closeId}, version ${version}, ${pop.count} journal(s), certified by ${checker})`;
  }

  private async extReopen(tx: TransactionSql, t: string, book: string, p: { periodEnd: string; closeId: string; reason: string }, checker: string, meta: { principal: string; commandId: string }) {
    await this.lockChecklist(tx, t, book, p.periodEnd);
    const n = await tx`UPDATE close.closes SET status = 'withdrawn', withdrawn_by = ${checker}, withdrawn_at = now(), withdrawn_reason = ${p.reason}
      WHERE tenant_id = ${t} AND close_id = ${p.closeId} AND status = 'certified' RETURNING 1`;
    if (!n.length) throw new OpsError("not_certified", `close ${p.closeId} is not the current certified close; nothing was applied`);
    const events: NewEvent[] = [{ type: "CloseCertificationWithdrawn", data: { bookId: book, periodEnd: p.periodEnd, kind: "close", ref: p.closeId, reason: p.reason, planId: meta.commandId } }];
    const subs = await tx<{ account_id: string; version: number }[]>`UPDATE close.substantiations SET status = 'withdrawn', withdrawn_reason = ${`period reopened: ${p.reason}`}, withdrawn_at = now()
      WHERE tenant_id = ${t} AND book_id = ${book} AND period_end = ${p.periodEnd} AND status = 'approved' RETURNING account_id, version`;
    for (const s of subs) events.push({ type: "CloseCertificationWithdrawn", data: { bookId: book, periodEnd: p.periodEnd, kind: "substantiation", ref: `${s.account_id}#${s.version}`, reason: p.reason, planId: meta.commandId } });
    // Bank reconciliations dated in the period: their certification is withdrawn, and so is every task that relied on one.
    const c = (await this.checklist(t, book, p.periodEnd, tx))!;
    const recs: EvidenceRef[] = [];
    for (const task of c.tasks.filter((x) => x.status === "done" && x.evidence.some((e) => e.kind === "bank_reconciliation"))) {
      recs.push(...task.evidence.filter((e) => e.kind === "bank_reconciliation"));
      await tx`UPDATE close.tasks SET status = 'open', withdrawn_reason = ${`bank reconciliation withdrawn by the reopen: ${p.reason}`}
        WHERE tenant_id = ${t} AND book_id = ${book} AND period_end = ${p.periodEnd} AND task_id = ${task.taskId}`;
      events.push({ type: "CloseCertificationWithdrawn", data: { bookId: book, periodEnd: p.periodEnd, kind: "task", ref: task.taskId, reason: p.reason, planId: meta.commandId } });
    }
    for (const s of await this.substantiations(t, book, p.periodEnd, { all: true, tx })) if (s.status === "withdrawn" && subs.some((x) => x.account_id === s.accountId && x.version === s.version))
      recs.push(...s.record.evidence.filter((e) => e.kind === "bank_reconciliation"));
    const unique = [...new Map(recs.map((r) => [`${r.id}|${r.hash}`, r])).values()];
    for (const r of unique) events.push({ type: "CloseCertificationWithdrawn", data: { bookId: book, periodEnd: p.periodEnd, kind: "bank_reconciliation", ref: r.id, reason: p.reason, planId: meta.commandId } });
    const w = this.evidence.withdrawer("bank_reconciliation");
    const external = w && unique.length ? await w(tx, { tenant: t, book, periodEnd: p.periodEnd, refs: unique, reason: p.reason, planId: meta.commandId }) : [];
    await this.append(tx, t, book, p.periodEnd, events, meta);
    return `withdrew close ${p.closeId}, ${subs.length} substantiation(s) and ${unique.length} bank reconciliation(s)${external.length ? ` (${external.join(", ")})` : ""}`;
  }

  private async extRestate(tx: TransactionSql, t: string, book: string, p: { periodEnd: string; restatementId: string; closeId: string; framework: string; reason: string;
    journalId: string; postingDate: string; bridge: BridgeRow[]; bridgeHash: string }, checker: string, meta: { principal: string; commandId: string }) {
    const [cl] = await tx<{ status: string; version: number; content_hash: string; body: string }[]>`
      SELECT status, version, content_hash, body FROM close.closes WHERE tenant_id = ${t} AND close_id = ${p.closeId} FOR UPDATE`;
    if (!cl || cl.status !== "certified") throw new OpsError("not_certified", `close ${p.closeId} is not a current certified close; nothing was applied`);
    if (contentHash(p.bridge) !== p.bridgeHash) throw new OpsError("hash_mismatch", "the bridge is not the one simulated; nothing was applied");
    const keys = await this.keys(t);
    const orig = JSON.parse(keys.openText(cl.body, closeBodyCtx(p.closeId))) as CloseBody;
    const [v] = await tx<{ v: number }[]>`SELECT COALESCE(max(version), 0)::int AS v FROM close.restatements WHERE tenant_id = ${t} AND book_id = ${book} AND comparative_period_end = ${p.periodEnd}`;
    const version = v!.v + 1;
    const changed = p.bridge.filter((r) => r.adjustment !== "0");
    const body: RestatementBody = { restatementId: p.restatementId, bookId: book, comparativePeriodEnd: p.periodEnd, version, framework: p.framework, reason: p.reason,
      supersedes: { closeId: p.closeId, version: cl.version, contentHash: cl.content_hash, reportSnapshots: orig.reportSnapshots },
      journalId: p.journalId, postingDate: p.postingDate, bridge: p.bridge, changed, bridgeHash: p.bridgeHash,
      restatedTrialBalance: p.bridge.filter((r) => r.restated !== "0").map((r) => ({ accountId: r.accountId, balance: r.restated })) };
    await tx`INSERT INTO close.restatements (tenant_id, restatement_id, book_id, comparative_period_end, version, supersedes_close_id, journal_id, bridge_hash, body, approved_by, plan_id)
      VALUES (${t}, ${p.restatementId}, ${book}, ${p.periodEnd}, ${version}, ${p.closeId}, ${p.journalId}, ${p.bridgeHash},
              ${keys.seal(JSON.stringify(body), restatementCtx(p.restatementId))}, ${checker}, ${meta.commandId})`;
    await this.append(tx, t, book, p.periodEnd, [{ type: "RestatementRecorded", data: { bookId: book, restatementId: p.restatementId, comparativePeriodEnd: p.periodEnd,
      supersedesCloseId: p.closeId, journalId: p.journalId, framework: p.framework, bridgeHash: p.bridgeHash, changed: changed.length, planId: meta.commandId } }], meta);
    return `recorded restatement ${p.restatementId} of ${p.periodEnd} (version ${version}, ${changed.length} comparative amount(s) changed; supersedes close ${p.closeId})`;
  }
}

/** Rupees as typed (natural sign, "-" allowed) to paise. */
export function parseRupees(v: string): bigint {
  const t = String(v).replace(/[,₹\s]/g, "");
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) throw new RangeError(`not an amount: ${v}`);
  const p = BigInt(m[2]!) * 100n + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] ? -p : p;
}

