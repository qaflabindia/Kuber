/**
 * Close operations (FIN-CLS-01..04), registered with the ops service by the cell, so they are
 * planned, stored, approved and committed like every other operation, under the same guard, and
 * appear in `ops.list()` (every agent surface's tool catalogue and the governance register).
 *
 *   close_status           read   checklist, substantiation, completeness and certified closes of a period
 *   complete_close_task    write  the task's owner prepares it with the evidence; committing is the review,
 *                                 by a different person (gate policy, no autonomy: a person commits)
 *   approve_substantiation write  the preparer prepares it; committing is the independent approval
 *   certify_close          write  gate human, superuser only, signed on HTTP: the certified close snapshot,
 *                                 the ledger's close marker (nothing posts into the period) and the soft lock
 *   reopen_period          write  gate human, superuser only: reopen a soft close with a reason, withdrawing
 *                                 the close, substantiations and bank reconciliations of the period
 *   restate                write  gate human, superuser only: a controlled adjustment in an open period and a
 *                                 restated comparative version with its bridge
 *
 * Every write plan is fenced on the period (Draft.fence) except restate (the whole book).
 */
import { z } from "zod";
import { CloseEvidenceRef, IsoDate, Principal, parseAmount, stableId, type Line } from "@kuber/contracts";
import { bookStream, validateJournal, type BookState } from "@kuber/gl";
import { balancesFromState, financialYear, fiscalStart, type Action, type Check, type Draft, type OpContext, type OpDef, type Section } from "@kuber/ops";
import { contentHash, type EvidenceRef } from "./evidence.ts";
import { accountsOf, isBalanceSheet, journalsOf, mappingVersion, population, rulesVersion, trialBalance } from "./ledger.ts";
import { monthStart } from "./template.ts";
import type { BridgeRow, CloseService } from "./service.ts";

const EXT = "close";
const rs = (p: bigint | string) => { const v = BigInt(p); const n = v < 0n ? -v : v; return `${v < 0n ? "-" : ""}₹${(n / 100n).toLocaleString("en-IN")}.${String(n % 100n).padStart(2, "0")}`; };
const preparer = (ctx: OpContext) => ctx.onBehalfOf ?? ctx.principal;
const blocked = (title: string, checks: Check[]): Draft => ({ title, summary: checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail ?? "no"}`).join("; "), actions: [], checks });
const ext = (kind: string, payload: Record<string, unknown>): Action => ({ type: "ext", module: EXT, kind, payload });

const ApiLine = z.object({ accountId: z.string().min(1).transform((s) => s.trim().toUpperCase()), debit: z.string().optional(), credit: z.string().optional(), partyId: z.string().min(1).optional() })
  .refine((l) => !!l.debit !== !!l.credit, "each line needs exactly one of debit or credit");
const toLine = (l: z.infer<typeof ApiLine>): Line => ({ accountId: l.accountId, amount: (l.debit ? parseAmount(l.debit) : -parseAmount(l.credit!)).toString(),
  ...(l.partyId ? { partyId: l.partyId } : {}), dimensions: {} });

async function checklistCheck(svc: CloseService, ctx: OpContext, periodEnd: string, checks: Check[]) {
  const c = await svc.checklist(ctx.tenant, ctx.book, periodEnd);
  checks.push({ label: "A close checklist exists for the period", ok: !!c, blocking: true, detail: c ? `${c.periodStart} to ${periodEnd}` : `create the checklist for ${periodEnd} first` });
  return c;
}

export function closeOperations(svc: CloseService): OpDef<any>[] {
  // ---------------------------------------------------------------- read
  const closeStatus: OpDef<{ periodEnd: string }> = {
    name: "close_status", title: "Close status of a period", kind: "read", gate: "policy",
    description: "The close of one period: checklist tasks (owner, deadline, dependencies, evidence, status, overdue), account substantiations (GL balance, source, reconciling items, preparer, approver), the completeness test (bank accounts with no statement, schedules not run, drafts and plans dated in the period) and certified closes. Reads only.",
    input: z.object({ periodEnd: IsoDate.describe("last day of the period, YYYY-MM-DD") }),
    async plan(ctx, i) {
      const st = await svc.status(ctx.tenant, ctx.book, i.periodEnd);
      const tasks = st.checklist?.tasks ?? [];
      const sections: Section[] = [
        { title: "Checklist", kind: "table", columns: ["Task", "Owner", "Deadline", "Depends on", "Evidence", "Status"],
          rows: tasks.map((t) => [`${t.area}: ${t.title}`, t.owner ?? "—", t.deadline, t.dependsOn.join(", ") || "—",
            t.evidence.length ? t.evidence.map((e) => `${e.kind} ${e.id}`).join(", ") : t.evidenceKinds.join(" or "),
            t.status === "not_applicable" ? t.reason : t.state === "awaiting_review" ? "awaiting review" : t.status === "done" ? `done (${t.completedBy}, reviewed by ${t.reviewedBy})` : t.overdue ? "OVERDUE" : "open"]) },
        { title: "Account substantiation", kind: "table", columns: ["Account", "GL balance", "Source", "Status", "Preparer", "Approver"], money: [1],
          rows: st.substantiations.map((a) => [`${a.accountId} ${a.name}`, a.glBalance, a.source ?? "—", a.status, a.preparedBy ?? "—", a.approvedBy ?? "—"]) },
        { title: "Completeness test", kind: "table", columns: ["Finding", "Detail"], rows: st.findings.length ? st.findings.map((f) => [f.label, f.detail]) : [["No expected source is missing", ""]] },
        { title: "Certified closes", kind: "table", columns: ["Version", "Close", "Status", "Certified by", "Journals to"],
          rows: st.closes.map((c) => [c.version, c.closeId, c.status === "withdrawn" ? `withdrawn: ${c.withdrawnReason}` : "certified", c.certifiedBy, c.closeSeq]) },
      ];
      return {
        title: `Close of ${i.periodEnd}${st.certified ? " (certified)" : ""}`,
        summary: st.certified ? `Certified as close ${st.certified.closeId} (version ${st.certified.version}).`
          : st.blockers.length ? `${st.blockers.length} item(s) before the close can be certified: ${st.blockers.slice(0, 4).join("; ")}${st.blockers.length > 4 ? "; …" : ""}.` : "Ready to certify.",
        actions: [], sections, data: st, links: [["Close", `/close?period=${i.periodEnd}`]],
      };
    },
  };

  // ---------------------------------------------------------------- FIN-CLS-01
  const completeTask: OpDef<{ periodEnd: string; taskId: string; evidence: EvidenceRef[]; note?: string }> = {
    name: "complete_close_task", title: "Complete a close task", kind: "write", gate: "policy",
    description: "The task's owner completes a close checklist task with its evidence ({kind, id, hash}: a certified bank reconciliation, a schedule reconciliation, a suspense roll-forward or a registered document hash). Refused before its dependencies are complete or without evidence that resolves. Committing is the review, by a person other than the owner.",
    input: z.object({ periodEnd: IsoDate, taskId: z.string().min(1).max(60), evidence: z.array(CloseEvidenceRef).max(20).default([]), note: z.string().max(500).optional() }),
    async plan(ctx, i) {
      const checks: Check[] = [];
      const c = await checklistCheck(svc, ctx, i.periodEnd, checks);
      if (!c) return blocked("Cannot complete the task", checks);
      const task = c.tasks.find((t) => t.taskId === i.taskId);
      checks.push({ label: `Task ${i.taskId} is on the checklist`, ok: !!task, blocking: true, detail: task ? task.title : `tasks: ${c.tasks.map((t) => t.taskId).join(", ")}` });
      if (!task) return blocked("Cannot complete the task", checks);
      checks.push({ label: "The task applies to this book", ok: task.applicable, blocking: true, detail: task.reason ?? undefined });
      checks.push({ label: "The task is open", ok: task.status !== "done", blocking: true, detail: task.status === "done" ? `completed by ${task.completedBy}, reviewed by ${task.reviewedBy}` : undefined });
      const who = preparer(ctx);
      checks.push({ label: "Completed by the task's owner", ok: task.owner === who, blocking: true, detail: task.owner === who ? who : `the owner is ${task.owner}; ${who} cannot complete it` });
      const waiting = task.dependsOn.filter((d) => c.tasks.find((x) => x.taskId === d)?.status === "open");
      checks.push({ label: "Dependencies complete", ok: !waiting.length, blocking: true, detail: waiting.length ? `waiting for ${waiting.join(", ")}` : task.dependsOn.join(", ") || "none" });
      const wrong = i.evidence.filter((e) => !task.evidenceKinds.includes(e.kind));
      checks.push({ label: "Evidence of the required kind", ok: i.evidence.length > 0 && !wrong.length, blocking: true,
        detail: !i.evidence.length ? `needs ${task.evidenceKinds.join(" or ")}` : wrong.length ? `${task.taskId} accepts ${task.evidenceKinds.join(" or ")}, not ${wrong.map((w) => w.kind).join(", ")}` : undefined });
      const problems = await svc.evidence.problems(i.evidence, { tenant: ctx.tenant, book: ctx.book, periodEnd: i.periodEnd, periodStart: c.periodStart });
      checks.push({ label: "The evidence resolves (current and certified)", ok: !problems.length, blocking: true, detail: problems.join("; ") || undefined });
      checks.push({ label: "On time", ok: !(task.deadline < ctx.today), blocking: false, detail: task.deadline < ctx.today ? `overdue since ${task.deadline}` : `due ${task.deadline}` });
      return {
        title: `Complete close task ${task.taskId} (${task.area}) to ${i.periodEnd}`,
        summary: `${who} completes "${task.title}" with ${i.evidence.length} evidence reference(s). Committing records your review: a person other than the owner.`,
        actions: [ext("completeTask", { bookId: ctx.book, periodEnd: i.periodEnd, taskId: task.taskId, preparedBy: who, evidence: i.evidence })],
        checks, data: { periodEnd: i.periodEnd, taskId: task.taskId, owner: task.owner },
        sections: [{ title: "Evidence", kind: "table", columns: ["Kind", "Reference", "Hash"], rows: i.evidence.map((e) => [e.kind, e.id, e.hash.slice(0, 16)]) }],
        notes: i.note ? [i.note] : [], fence: { periodEnd: i.periodEnd },
      };
    },
  };

  // ---------------------------------------------------------------- FIN-CLS-02
  const Item = z.object({ description: z.string().min(2).max(300), amount: z.string().min(1).max(30), openedOn: IsoDate, owner: Principal });
  const substantiate: OpDef<{ periodEnd: string; accountId: string; sourceBalance?: string; items: z.infer<typeof Item>[]; evidence: EvidenceRef[]; note?: string }> = {
    name: "approve_substantiation", title: "Substantiate a balance-sheet account", kind: "write", gate: "policy",
    description: "Substantiate one balance-sheet account at period end: the GL balance against its subledger or schedule where one exists (bank reconciliation, suspense items, recognition schedules, party subledger) or a supporting balance with a document, with reconciling items (amount, date opened, owner; aged to period end). GL − source − items must be exactly zero. Committing is the independent approval, by a person other than the preparer. Amounts in rupees, natural sign.",
    input: z.object({ periodEnd: IsoDate, accountId: z.string().min(1).transform((s) => s.trim().toUpperCase()), sourceBalance: z.string().max(30).optional(),
      items: z.array(Item).max(200).default([]), evidence: z.array(CloseEvidenceRef).max(20).default([]), note: z.string().max(1000).optional() }),
    async plan(ctx, i) {
      const checks: Check[] = [];
      const c = await checklistCheck(svc, ctx, i.periodEnd, checks);
      if (!c) return blocked("Cannot substantiate", checks);
      if (!ctx.state.accounts.has(i.accountId)) { checks.push({ label: `Account ${i.accountId} exists`, ok: false, blocking: true }); return blocked("Cannot substantiate", checks); }
      const s = await svc.computeSubstantiation(ctx.tenant, ctx.book, ctx.state, c.periodStart, i.periodEnd, i.accountId,
        { sourceBalance: i.sourceBalance, items: i.items, evidence: i.evidence, note: i.note });
      const current = (await svc.substantiations(ctx.tenant, ctx.book, i.periodEnd)).find((x) => x.accountId === i.accountId);
      checks.push({ label: "Not already substantiated for the period", ok: !current, blocking: true, detail: current ? `approved by ${current.approvedBy} (reopen withdraws it)` : undefined });
      const required = svc.requiredAccounts(ctx.state, c.periodStart, i.periodEnd).includes(i.accountId);
      checks.push({ label: "Required at period end", ok: required, blocking: false, detail: required ? (s.activity && s.glBalance === "0" ? "zero balance with activity in the period" : undefined) : "no balance and no activity: not required" });
      checks.push({ label: `Source: ${s.source}`, ok: s.sourceBalance !== null, blocking: true, detail: s.sourceDetail || undefined });
      for (const p of s.problems) checks.push({ label: "Substantiation rule", ok: false, blocking: true, detail: p });
      if (!s.problems.length) checks.push({ label: "GL − source − reconciling items = 0", ok: true, blocking: true });
      const who = preparer(ctx);
      const record = { ...s, problems: [] as string[] };
      return {
        title: `Substantiate ${i.accountId} at ${i.periodEnd}`,
        summary: `GL ${rs(s.glNatural)}; ${s.source} ${s.sourceBalance === null ? "missing" : rs(s.sourceBalance)}; ${s.items.length} reconciling item(s) ${rs(s.itemsTotal)}. Prepared by ${who}; committing is your independent approval.`,
        actions: [ext("substantiate", { bookId: ctx.book, periodEnd: i.periodEnd, accountId: i.accountId, preparedBy: who, record, hash: contentHash(record) })],
        checks, data: { periodEnd: i.periodEnd, accountId: i.accountId, substantiation: record },
        sections: [
          { title: "Balance", kind: "kv", rows: [["GL balance", s.glNatural], ["Source", s.sourceDetail || s.source], ["Source balance", s.sourceBalance], ["Reconciling items", s.itemsTotal], ["Difference", s.difference]], money: [1] },
          ...(s.items.length ? [{ title: "Reconciling items (aged to period end)", kind: "table" as const, columns: ["Item", "Amount", "Opened", "Age (days)", "Owner"], money: [1],
            rows: s.items.map((x) => [x.description, x.amount, x.openedOn, x.ageDays, x.owner]) }] : []),
          ...(s.breakdown.length ? [{ title: "Source detail", kind: "table" as const, columns: ["Item", "Amount", "Detail"], money: [1], rows: s.breakdown.map((b) => [b.label, b.amount, b.detail ?? ""]) }] : []),
        ],
        notes: s.note ? [s.note] : [], fence: { periodEnd: i.periodEnd },
      };
    },
  };

  // ---------------------------------------------------------------- FIN-CLS-03
  const certify: OpDef<{ periodEnd: string }> = {
    name: "certify_close", title: "Certify the close of a period", kind: "write", gate: "human",
    description: "Certify a period's close under one book version: requires every checklist task complete and reviewed, every required account substantiated at its current balance and a clean completeness test. Commit persists the certified close snapshot (trial balance and journal population from the ledger, certified report snapshots, chart mapping and rules versions, every certification), marks the period closed in the ledger (no one posts into it until an approved reopen) and soft-locks it. A fiscal year end also posts the closing voucher. Approved by a superuser only, with a passkey signature.",
    input: z.object({ periodEnd: IsoDate }),
    async plan(ctx, i) {
      const s = ctx.state, checks: Check[] = [], actions: Action[] = [];
      const c = await checklistCheck(svc, ctx, i.periodEnd, checks);
      if (!c) return blocked(`Cannot certify the close of ${i.periodEnd}`, checks);
      const st = await svc.status(ctx.tenant, ctx.book, i.periodEnd);
      checks.push({ label: "Period has ended", ok: i.periodEnd < ctx.today, blocking: true, detail: i.periodEnd < ctx.today ? undefined : `ends ${i.periodEnd}; today is ${ctx.today}` });
      checks.push({ label: "Not hard-closed", ok: !st.hardLocked, blocking: true, detail: st.hardLocked ? "hard-closed: journals are immutable; a correction is a restatement" : undefined });
      checks.push({ label: "Not already certified", ok: !st.certified, blocking: true, detail: st.certified ? `close ${st.certified.closeId} (version ${st.certified.version}); reopen it first` : undefined });
      const open = c.tasks.filter((t) => t.status === "open");
      checks.push({ label: "Every checklist task complete and reviewed", ok: !open.length, blocking: true, detail: open.length ? open.map((t) => `${t.taskId}${t.overdue ? " (overdue)" : ""}`).join(", ") : `${c.tasks.filter((t) => t.status === "done").length} done, ${c.tasks.filter((t) => t.status === "not_applicable").length} not applicable` });
      for (const t of c.tasks.filter((x) => x.status === "done")) {
        const problems = await svc.evidence.problems(t.evidence, { tenant: ctx.tenant, book: ctx.book, periodEnd: i.periodEnd, periodStart: c.periodStart });
        if (problems.length) checks.push({ label: `Evidence of ${t.taskId} still resolves`, ok: false, blocking: true, detail: problems.join("; ") });
      }
      const notOk = st.substantiations.filter((a) => a.status !== "approved");
      checks.push({ label: "Every required account substantiated at its current balance", ok: !notOk.length, blocking: true,
        detail: notOk.length ? notOk.map((a) => `${a.accountId} (${a.status})`).join(", ") : `${st.substantiations.length} account(s)` });
      for (const f of st.findings) checks.push({ label: `Completeness: ${f.label}`, ok: false, blocking: f.blocking, detail: f.detail });
      if (!st.findings.length) checks.push({ label: "Completeness test: no expected source missing", ok: true, blocking: true });
      // One consistent book version: the population, trial balance and mapping at the plan's basis.
      const events = (await svc.d.store.readStream(ctx.tenant, bookStream(ctx.tenant, ctx.book))).filter((e) => e.streamVersion <= s.version);
      const journals = journalsOf(events), accounts = accountsOf(events);
      const pop = population(journals, i.periodEnd);
      const tb = trialBalance(pop.journals, accounts);
      checks.push({ label: "Debits equal credits", ok: tb.debits === tb.credits, blocking: true, detail: `${rs(tb.debits)} / ${rs(tb.credits)}` });
      const version = Math.max(0, ...st.closes.map((x) => x.version)) + 1;
      const closeId = stableId("close", `${ctx.tenant}/${ctx.book}/${i.periodEnd}/${version}/${s.version}`);
      const mv = mappingVersion(accounts.values()), rv = rulesVersion(svc.d.policies.policies);
      actions.push(ext("certify", { bookId: ctx.book, periodEnd: i.periodEnd, preparedBy: preparer(ctx), closeId, version, basisSeq: s.seq, basisVersion: s.version,
        populationHash: pop.hash, mappingVersion: mv, rulesVersion: rv }));
      const voucher = yearEndVoucher(ctx, s, i.periodEnd, checks);
      actions.push(...voucher.actions);
      actions.push({ type: "gl", command: { kind: "ClosePeriod", periodEnd: i.periodEnd, closeId, populationHash: pop.hash } });
      if (!s.locks.some((l) => l.periodEnd >= i.periodEnd)) actions.push({ type: "gl", command: { kind: "LockPeriod", periodEnd: i.periodEnd, level: "soft" } });
      return {
        title: `Certify the close of ${i.periodEnd}`,
        summary: `Certifies ${pop.count} journal(s) to ${i.periodEnd} at book version ${s.version} (journal ${s.seq}) as close version ${version}: the trial balance, report snapshots, mapping and rules versions and every certification are sealed together. Then nobody can post on or before ${i.periodEnd} until an approved reopen.${voucher.actions.length ? " Posts the year's closing voucher." : ""}`,
        actions, checks, data: { periodEnd: i.periodEnd, closeId, version, basisSeq: s.seq, basisVersion: s.version, populationHash: pop.hash, populationCount: pop.count, mappingVersion: mv, rulesVersion: rv },
        sections: [
          { title: `Trial balance to ${i.periodEnd} (from the ledger)`, kind: "table", columns: ["Account", "Debit", "Credit"], money: [1, 2],
            rows: tb.rows.map((r) => [`${r.accountId} ${r.name}`, BigInt(r.balance) > 0n ? r.balance : null, BigInt(r.balance) < 0n ? (-BigInt(r.balance)).toString() : null]) },
          { title: "Basis", kind: "kv", rows: [["Book version", s.version], ["Journal seq", s.seq], ["Population hash", pop.hash], ["Mapping version", mv], ["Rules version", rv]] },
          ...voucher.sections,
        ],
        fence: { periodEnd: i.periodEnd }, links: [["Close", `/close?period=${i.periodEnd}`]],
      };
    },
  };

  // ---------------------------------------------------------------- FIN-CLS-04
  const reopen: OpDef<{ periodEnd: string; reason: string }> = {
    name: "reopen_period", title: "Reopen a certified (soft) close", kind: "write", gate: "human",
    description: "Reopen a period's certified soft close, with a reason. Withdraws, visibly, the certified close snapshot, the period's account substantiations and the bank reconciliations the checklist relied on; the period stays soft-locked (only a superuser or controller posts adjustments), and it must be certified again. A hard-closed period is never reopened: its journals are immutable (use restate). Approved by a superuser only.",
    input: z.object({ periodEnd: IsoDate, reason: z.string().min(10).max(1000) }),
    async plan(ctx, i) {
      const checks: Check[] = [];
      const st = await svc.status(ctx.tenant, ctx.book, i.periodEnd);
      checks.push({ label: "The period has a certified close", ok: !!st.certified, blocking: true, detail: st.certified ? `close ${st.certified.closeId}, version ${st.certified.version}` : "nothing to reopen" });
      checks.push({ label: "Not hard-closed", ok: !st.hardLocked, blocking: true, detail: st.hardLocked ? "hard-closed journals are immutable: a correction is a restatement in an open period (restate)" : undefined });
      const ledger = (ctx.state.closes ?? []).find((x) => x.periodEnd === i.periodEnd);
      checks.push({ label: "The ledger holds that close", ok: !!st.certified && ledger?.closeId === st.certified.closeId, blocking: true, detail: ledger ? ledger.closeId : "no close marker in the ledger" });
      if (!st.certified) return blocked(`Cannot reopen ${i.periodEnd}`, checks);
      const approved = st.substantiations.filter((a) => a.status !== "missing");
      const banks = (st.checklist?.tasks ?? []).filter((t) => t.status === "done").flatMap((t) => t.evidence.filter((e) => e.kind === "bank_reconciliation"));
      return {
        title: `Reopen the close of ${i.periodEnd}`,
        summary: `Withdraws close ${st.certified.closeId}, ${approved.length} substantiation(s) and ${banks.length} bank reconciliation(s). Reason: ${i.reason}`,
        actions: [{ type: "gl", command: { kind: "ReopenPeriod", periodEnd: i.periodEnd, closeId: st.certified.closeId, reason: i.reason } },
          ext("reopen", { bookId: ctx.book, periodEnd: i.periodEnd, preparedBy: preparer(ctx), closeId: st.certified.closeId, reason: i.reason })],
        checks, data: { periodEnd: i.periodEnd, closeId: st.certified.closeId },
        sections: [{ title: "Certifications withdrawn", kind: "table", columns: ["Kind", "Reference"],
          rows: [["certified close", st.certified.closeId], ...approved.map((a) => ["substantiation", a.accountId]), ...banks.map((b) => ["bank reconciliation", b.id])] }],
        fence: { periodEnd: i.periodEnd },
      };
    },
  };

  const restate: OpDef<{ comparativePeriodEnd: string; postingDate?: string; framework: string; reason: string; lines: z.infer<typeof ApiLine>[]; comparativeLines: z.infer<typeof ApiLine>[] }> = {
    name: "restate", title: "Restate a certified comparative period", kind: "write", gate: "human",
    description: "A framework-required restatement of a certified period: a controlled adjustment posted in an open period (lines: balance-sheet and equity accounts only), and a restated reporting version of the comparative period (comparativeLines: the same correction as it belongs in that period) with a bridge original → adjustments → restated. The original certified close stays retrievable and unchanged; hard-closed journals are never touched. Approved by a superuser only. Amounts in rupees as debit/credit.",
    input: z.object({ comparativePeriodEnd: IsoDate, postingDate: IsoDate.optional(), framework: z.string().min(2).max(60), reason: z.string().min(10).max(1000),
      lines: z.array(ApiLine).min(2).max(50), comparativeLines: z.array(ApiLine).min(2).max(50) }),
    async plan(ctx, i) {
      const s = ctx.state, checks: Check[] = [];
      const cur = (await svc.closes(ctx.tenant, ctx.book)).find((x) => x.periodEnd === i.comparativePeriodEnd && x.status === "certified");
      checks.push({ label: "The comparative period has a certified close", ok: !!cur, blocking: true, detail: cur ? `close ${cur.closeId}, version ${cur.version}` : `no certified close of ${i.comparativePeriodEnd}` });
      if (!cur) return blocked("Cannot restate", checks);
      const close = (await svc.getClose(ctx.tenant, cur.closeId))!;
      const postingDate = i.postingDate ?? ctx.today;
      const shut = [...s.locks.map((l) => l.periodEnd), ...(s.closes ?? []).map((x) => x.periodEnd)].sort().at(-1);
      checks.push({ label: "Posted in an open period", ok: postingDate > i.comparativePeriodEnd && (!shut || postingDate > shut), blocking: true,
        detail: `${postingDate}${shut ? `; closed or locked to ${shut}` : ""}` });
      let lines: Line[] = [], comp: Line[] = [];
      try { lines = i.lines.map(toLine); comp = i.comparativeLines.map(toLine); } catch (e) { checks.push({ label: "Amounts", ok: false, blocking: true, detail: (e as Error).message }); return blocked("Cannot restate", checks); }
      const nature = (id: string) => s.accounts.get(id)?.nature;
      const unknown = [...lines, ...comp].map((l) => l.accountId).filter((id) => !nature(id));
      checks.push({ label: "Accounts exist", ok: !unknown.length, blocking: true, detail: unknown.join(", ") || undefined });
      if (unknown.length) return blocked("Cannot restate", checks);
      const pl = lines.filter((l) => !isBalanceSheet(nature(l.accountId)!));
      checks.push({ label: "The open-period adjustment touches no current income or expense", ok: !pl.length, blocking: true, detail: pl.length ? `${pl.map((l) => l.accountId).join(", ")}: a prior-period correction goes to equity, not this period's results` : undefined });
      const sum = (ls: Line[]) => ls.reduce((a, l) => a + BigInt(l.amount), 0n);
      checks.push({ label: "Comparative lines balance", ok: sum(comp) === 0n, blocking: true });
      const bs = (ls: Line[]) => { const m = new Map<string, bigint>(); for (const l of ls) if (["asset", "liability"].includes(nature(l.accountId)!)) m.set(l.accountId, (m.get(l.accountId) ?? 0n) + BigInt(l.amount)); return m; };
      const a = bs(lines), b = bs(comp);
      const differ = [...new Set([...a.keys(), ...b.keys()])].filter((k) => (a.get(k) ?? 0n) !== (b.get(k) ?? 0n));
      checks.push({ label: "The same balance-sheet correction in both periods", ok: !differ.length, blocking: true, detail: differ.length ? `assets or liabilities differ on ${differ.join(", ")}` : undefined });
      const control = lines.some((l) => s.accounts.get(l.accountId)?.isControl);
      try { validateJournal(s, postingDate, lines, "owner:approver"); checks.push({ label: "Ledger rules satisfied", ok: true, blocking: true }); }
      catch (e) { checks.push({ label: "Ledger rules satisfied", ok: false, blocking: true, detail: (e as Error).message }); }
      // Bridge: original certified trial balance → comparative adjustments → restated.
      const orig = new Map(close.body.trialBalance.rows.map((r) => [r.accountId, BigInt(r.balance)]));
      const adj = new Map<string, bigint>(); for (const l of comp) adj.set(l.accountId, (adj.get(l.accountId) ?? 0n) + BigInt(l.amount));
      const bridge: BridgeRow[] = [...new Set([...orig.keys(), ...adj.keys()])].sort().map((id) => ({ accountId: id, name: s.accounts.get(id)?.name ?? id, nature: nature(id) ?? "unknown",
        original: (orig.get(id) ?? 0n).toString(), adjustment: (adj.get(id) ?? 0n).toString(), restated: ((orig.get(id) ?? 0n) + (adj.get(id) ?? 0n)).toString() }));
      const restatementId = stableId("restatement", `${ctx.tenant}/${ctx.book}/${i.comparativePeriodEnd}/${s.version}`);
      const journalId = stableId("ops-journal", `${ctx.tenant}/${ctx.book}/${s.seq}/restate/${i.comparativePeriodEnd}`);
      const amount = lines.reduce((m, l) => (BigInt(l.amount) > 0n ? m + BigInt(l.amount) : m), 0n);
      return {
        title: `Restate ${i.comparativePeriodEnd} (${i.framework})`,
        summary: `Posts a controlled adjustment of ${rs(amount)} on ${postingDate} and records restated comparatives for ${i.comparativePeriodEnd} (${bridge.filter((r) => r.adjustment !== "0").length} amount(s) change). Close ${cur.closeId} stays as issued. Reason: ${i.reason}`,
        actions: [
          { type: "gl", command: { kind: "PostJournal", journalId, txnDate: postingDate, narration: `Restatement of ${i.comparativePeriodEnd} (${i.framework}): ${i.reason}`.slice(0, 500), voucherType: "restatement",
            lines, autonomy: "human", entry: "manual", ...(control ? { controlledAdjustment: { reason: i.reason } } : {}) } },
          ext("restate", { bookId: ctx.book, periodEnd: i.comparativePeriodEnd, preparedBy: preparer(ctx), restatementId, closeId: cur.closeId, framework: i.framework, reason: i.reason,
            journalId, postingDate, bridge, bridgeHash: contentHash(bridge) }),
        ],
        checks, amountPaise: amount, data: { comparativePeriodEnd: i.comparativePeriodEnd, restatementId, supersedes: cur.closeId, ...(control ? { controlledAdjustment: { reason: i.reason } } : {}) },
        sections: [{ title: `Comparative bridge ${i.comparativePeriodEnd}`, kind: "table", columns: ["Account", "Original", "Adjustment", "Restated"], money: [1, 2, 3],
          rows: bridge.map((r) => [`${r.accountId} ${r.name}`, r.original, r.adjustment, r.restated]) }],
      };
    },
  };

  return [closeStatus, completeTask, substantiate, certify, reopen, restate];
}

/** A fiscal year end closes the year's remaining income and expenses into retained surplus (as the `close` operation does). */
function yearEndVoucher(ctx: OpContext, s: BookState, periodEnd: string, checks: Check[]): { actions: Action[]; sections: Section[] } {
  const fy = financialYear(periodEnd, fiscalStart(s));
  if (periodEnd !== fy.to) return { actions: [], sections: [] };
  const year = balancesFromState(s, { from: fy.from, to: periodEnd });
  const lines: Line[] = [], rows: Section["rows"] = [];
  let surplus = 0n;
  for (const [id, v] of [...year.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const n = s.accounts.get(id)?.nature;
    if ((n === "income" || n === "expense") && v !== 0n) { lines.push({ accountId: id, amount: (-v).toString(), dimensions: {} }); surplus -= v; rows.push([s.accounts.get(id)!.name, (-v).toString()]); }
  }
  if (!lines.length) return { actions: [], sections: [] };
  const actions: Action[] = [];
  const retained = { accountId: "RETAINED", name: "Retained surplus", nature: "equity" as const, taxonomyTag: "BS.reserves", isControl: false, isCashLike: false, requiredDims: [] };
  if (!s.accounts.has("RETAINED")) actions.push({ type: "gl", command: { kind: "AddAccount", account: retained } });
  lines.push({ accountId: "RETAINED", amount: (-surplus).toString(), dimensions: {} });
  rows.push(["Retained surplus", (-surplus).toString()]);
  const sim = s.accounts.has("RETAINED") ? s : { ...s, accounts: new Map(s.accounts).set("RETAINED", retained) };
  try { validateJournal(sim, periodEnd, lines, "owner:approver"); checks.push({ label: "Closing voucher valid", ok: true, blocking: true }); }
  catch (e) { checks.push({ label: "Closing voucher valid", ok: false, blocking: true, detail: (e as Error).message }); }
  const journalId = stableId("ops-journal", `${ctx.tenant}/${ctx.book}/${s.seq}/close/${periodEnd}/0`);
  actions.push({ type: "gl", command: { kind: "PostJournal", journalId, txnDate: periodEnd, narration: `Closing voucher ${fy.label}: income and expenses to retained surplus`,
    voucherType: "closing", lines, autonomy: "human", entry: "manual" } });
  return { actions, sections: [{ title: "Closing voucher", kind: "table", columns: ["Account", "Amount"], rows, money: [1] }] };
}


