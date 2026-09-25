/**
 * Operations for the finance requirements. Like every operation, each one only plans: it reads the
 * authoritative book state and returns the exact actions a commit would take, under the ops guard.
 *
 *   schedule_approve  FIN-GL-02/03  the one approval of a recurring or recognition schedule
 *   schedule_cancel   FIN-GL-03     stop a schedule; recalculates the remaining balance and may release it
 *   schedules         FIN-GL-03     schedules, exceptions and their reconciliation to the GL by period
 *   resolve_suspense  FIN-GL-05     clear one suspense item: reverse the original, post the replacement
 *   suspense          FIN-GL-05     suspense items (source, owner, age) and the roll-forward
 */
import { z } from "zod";
import { IsoDate, stableId, type Line } from "@kuber/contracts";
import { isSuspense, validateJournal, type BookState } from "@kuber/gl";
import { balancesFromState, financialYear, fiscalStart } from "./math.ts";
import { maxOccurrence, occurrencesOf, releaseJournalId, type ScheduleView } from "./schedules.ts";
import type { Action, Check, OpContext, OpDef, Section } from "./types.ts";

const AccountId = z.string().min(1).transform((s) => s.trim().toUpperCase());
const rs = (p: bigint) => { const n = p < 0n ? -p : p; return `${p < 0n ? "-" : ""}₹${(n / 100n).toLocaleString("en-IN")}${n % 100n ? "." + String(n % 100n).padStart(2, "0") : ""}`; };

function validates(s: BookState, date: string, lines: Line[], checks: Check[], label = "Ledger rules satisfied") {
  try { validateJournal(s, date, lines, "owner:approver"); checks.push({ label, ok: true, blocking: true }); return true; }
  catch (e) { checks.push({ label, ok: false, blocking: true, detail: e instanceof Error ? e.message : String(e) }); return false; }
}

async function scheduleOf(ctx: OpContext, id: string, checks: Check[]): Promise<ScheduleView | null> {
  if (!ctx.schedules) throw new Error("schedules are not available in this context");
  try {
    const v = await ctx.schedules.get(ctx.tenant, id);
    const here = v.bookId === ctx.book;
    checks.push({ label: "Schedule is in this book", ok: here, blocking: true, detail: here ? undefined : `it belongs to ${v.bookId}` });
    return here ? v : null;
  } catch (e) {
    checks.push({ label: "Schedule exists", ok: false, blocking: true, detail: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

const occurrenceRows = (v: ScheduleView) => v.occurrences.map((o) => [o.period, o.kind === "post" ? "Post" : "Reverse", o.dueOn, o.amount, o.status]);

// ---------------------------------------------------------------- schedules
export const scheduleApprove: OpDef<{ scheduleId: string }> = {
  name: "schedule_approve", title: "Approve a schedule", kind: "write", gate: "human",
  description: "Approve a recurring journal or a prepaid/accrual recognition schedule once. Afterwards the scheduler posts each occurrence (and its auto-reversal) as the system, at most once per period, within the approved amount. Always needs a person other than the one who defined it.",
  input: z.object({ scheduleId: z.string().min(1) }),
  async plan(ctx, i) {
    const checks: Check[] = [];
    const v = await scheduleOf(ctx, i.scheduleId, checks);
    if (!v) return { title: "Cannot approve", summary: "No such schedule in this book.", actions: [], checks };
    checks.push({ label: "Schedule awaits approval", ok: v.status === "submitted", blocking: true, detail: v.status === "submitted" ? undefined : `it is ${v.status}` });
    const occ = occurrencesOf(ctx.tenant, v.scheduleId, v.definition);
    const approved = maxOccurrence(occ);
    const d = v.definition;
    return {
      title: `Approve ${d.kind === "recurring" ? "recurring journal" : `${d.recognition!.type} schedule`}: ${d.name}`,
      summary: `${occ.filter((o) => o.kind === "post").length} monthly posting(s) ${d.start} to ${d.end}${d.autoReverse ? ", each reversed on the first day of the next month" : ""}; at most ${rs(approved)} per posting, under ${v.policyVersion}.`,
      actions: [{ type: "approveSchedule", scheduleId: v.scheduleId, hash: v.hash, approvedAmount: approved.toString() }],
      checks, amountPaise: approved,
      sections: [
        { title: "Schedule", kind: "kv", money: [1], rows: [["Approved amount per posting", approved.toString()], ["Policy version", v.policyVersion],
          ["Definition hash", v.hash], ...(d.recognition ? [["Total to recognize", d.recognition.total], ["Basis", d.recognition.basis]] : [])] },
        { title: "Occurrences", kind: "table", columns: ["Period", "Kind", "Due", "Amount", "Status"], money: [3], rows: occurrenceRows(v) },
      ],
      data: { scheduleId: v.scheduleId, approvedAmount: approved.toString() },
    };
  },
};

const CancelInput = z.object({
  scheduleId: z.string().min(1),
  effective: IsoDate.describe("the schedule stops after this date; later occurrences are cancelled"),
  releaseTo: AccountId.optional().describe("prepaid only: account that takes the unrecognized balance (e.g. a refund receivable)"),
});

export const scheduleCancel: OpDef<z.infer<typeof CancelInput>> = {
  name: "schedule_cancel", title: "Cancel a schedule", kind: "write", gate: "human",
  description: "Cancel a recurring or recognition schedule from a date. Recalculates the remaining balance (total less what was recognized) and, for a prepaid schedule, can release it to another account. Always needs a person's approval.",
  input: CancelInput,
  async plan(ctx, i) {
    const s = ctx.state, checks: Check[] = [], actions: Action[] = [];
    const v = await scheduleOf(ctx, i.scheduleId, checks);
    if (!v) return { title: "Cannot cancel", summary: "No such schedule in this book.", actions: [], checks };
    checks.push({ label: "Schedule is active", ok: v.status !== "cancelled", blocking: true, detail: v.status === "cancelled" ? `cancelled on ${v.cancelledOn}` : undefined });
    const unposted = v.occurrences.filter((o) => o.dueOn <= i.effective && (o.status === "due" || o.status === "scheduled"));
    checks.push({ label: "Every occurrence up to the date has run", ok: unposted.length === 0, blocking: true,
      detail: unposted.length ? `${unposted.length} occurrence(s) up to ${i.effective} not yet posted: run the schedules first, or cancel from an earlier date` : undefined });
    const future = v.occurrences.filter((o) => o.kind === "post" && o.dueOn > i.effective && o.status !== "posted").reduce((a, o) => a + BigInt(o.amount), 0n);
    const r = v.definition.recognition;
    const total = r ? BigInt(r.total) : 0n;
    const recognized = v.balance ? BigInt(v.balance.recognized) : 0n;
    const remaining = r ? total - recognized : 0n;
    let released = 0n;
    if (i.releaseTo) {
      const ok = r?.type === "prepaid";
      checks.push({ label: "Release applies to a prepaid schedule", ok, blocking: true });
      if (ok && remaining > 0n) {
        const lines: Line[] = [{ accountId: i.releaseTo, amount: remaining.toString(), dimensions: {} }, { accountId: r!.balanceAccount, amount: (-remaining).toString(), dimensions: {} }];
        if (!s.accounts.has(i.releaseTo) || isSuspense(s.accounts.get(i.releaseTo))) checks.push({ label: `Release account ${i.releaseTo} exists`, ok: false, blocking: true });
        else if (validates(s, i.effective, lines, checks, "Release journal valid")) {
          actions.push({ type: "gl", command: { kind: "PostJournal", journalId: releaseJournalId(ctx.tenant, v.scheduleId, i.effective), txnDate: i.effective,
            narration: `${v.definition.name}: unrecognized balance released on cancellation`, voucherType: "recognition", lines, autonomy: "human", entry: "manual" } });
          released = remaining;
        }
      }
    }
    actions.push({ type: "cancelSchedule", scheduleId: v.scheduleId, effective: i.effective, recognized: recognized.toString(), released: released.toString(),
      remaining: (remaining - released).toString() });
    return {
      title: `Cancel ${v.definition.name} from ${i.effective}`,
      summary: r ? `Recognized ${rs(recognized)} of ${rs(total)}; ${rs(future)} of future recognition is cancelled; remaining balance ${rs(remaining)}${released ? `, released to ${i.releaseTo}` : ""}.`
        : `Occurrences after ${i.effective} will not post.`,
      actions, checks, amountPaise: released,
      sections: [{ title: "Recalculated balance", kind: "kv", money: [1], rows: [["Total", total.toString()], ["Recognized to date", recognized.toString()],
        ["Future recognition cancelled", future.toString()], ["Remaining before release", remaining.toString()], ["Released", released.toString()],
        ["Remaining after cancellation", (remaining - released).toString()]] }],
    };
  },
};

export const schedulesReport: OpDef<{ to?: string }> = {
  name: "schedules", title: "Schedules and their reconciliation", kind: "read", gate: "policy",
  description: "Recurring and recognition schedules with every occurrence's status, open exceptions, remaining balances, and the reconciliation of schedule balances to the GL by period.",
  input: z.object({ to: IsoDate.optional() }),
  async plan(ctx, i) {
    if (!ctx.schedules) throw new Error("schedules are not available in this context");
    const list = await ctx.schedules.list(ctx.tenant, ctx.book);
    const rec = await ctx.schedules.reconciliation(ctx.tenant, ctx.book, { to: i.to ?? ctx.today });
    const exceptions = await ctx.schedules.exceptions(ctx.tenant, ctx.book);
    return {
      title: `${list.length} schedule(s)${rec.rows.length ? rec.reconciled ? " · reconciled to the GL" : " · differences with the GL" : ""}`,
      summary: `${list.filter((x) => x.status === "approved").length} active, ${exceptions.length} open exception(s).`,
      actions: [],
      checks: [{ label: "Schedule balances agree with the GL", ok: rec.reconciled, blocking: false },
        { label: "No schedule exceptions", ok: exceptions.length === 0, blocking: false, detail: exceptions.length ? `${exceptions.length} open` : undefined }],
      sections: [
        { title: "Schedules", kind: "table", columns: ["Name", "Kind", "Status", "Total", "Recognized", "Remaining"], money: [3, 4, 5],
          rows: list.map((x) => [x.definition.name, x.kind, x.status, x.balance?.total ?? null, x.balance?.recognized ?? null, x.balance?.remaining ?? null]) },
        { title: "Reconciliation to the GL", kind: "table", columns: ["Period", "Account", "Scheduled", "Recognized in GL", "Schedule balance", "GL balance", "Difference"],
          money: [2, 3, 4, 5, 6], rows: rec.rows.map((x) => [x.period, x.accountId, x.scheduled, x.recognizedInGl, x.scheduleBalance, x.glBalance, x.difference]) },
        ...(exceptions.length ? [{ title: "Exceptions", kind: "table" as const, columns: ["Due", "Kind", "Amount", "Reason"], money: [2],
          rows: exceptions.map((e) => [e.due_on, e.kind, e.amount, e.reason]) }] : []),
      ],
      data: { schedules: list, reconciliation: rec, exceptions },
    };
  },
};

// ---------------------------------------------------------------- suspense
const ResolveInput = z.object({
  itemId: z.string().min(1),
  toAccount: AccountId.optional().describe("where the amount belongs; omit to reverse an entry that should not exist"),
  partyId: z.string().optional(),
  date: IsoDate.optional().describe("resolution date (default today); earlier periods keep their position"),
  note: z.string().max(500).optional(),
});

export const resolveSuspense: OpDef<z.infer<typeof ResolveInput>> = {
  name: "resolve_suspense", title: "Resolve a suspense item", kind: "write", gate: "policy",
  description: "Clear one suspense item: the original entry is reversed on the resolution date and reposted to the right account, and the item records original, reversal and replacement. Balancing journals that clear suspense without resolving items are refused by the ledger.",
  input: ResolveInput,
  async plan(ctx, i) {
    const s = ctx.state, checks: Check[] = [];
    const item = await ctx.svc.agent.suspense.get(ctx.tenant, i.itemId);
    const ok = !!item && item.bookId === ctx.book;
    checks.push({ label: "Suspense item exists in this book", ok, blocking: true });
    if (!item || !ok) return { title: "Cannot resolve", summary: `No suspense item ${i.itemId} in this book.`, actions: [], checks };
    checks.push({ label: "Item is open", ok: item.status === "open", blocking: true, detail: item.status === "open" ? undefined : `resolved on ${item.resolvedOn}` });
    const date = i.date ?? ctx.today;
    checks.push({ label: "Resolution is not dated before the item", ok: date >= item.openedOn, blocking: true, detail: date >= item.openedOn ? undefined : `item opened ${item.openedOn}` });
    const orig = s.journals.get(item.journalId);
    checks.push({ label: "Original entry is in the book and not reversed", ok: !!orig && !orig.reversedBy, blocking: true });
    if (!orig || orig.reversedBy) return { title: "Cannot resolve", summary: "The original entry is missing or already reversed.", actions: [], checks };
    const reversalJournalId = stableId("suspense-reversal", `${ctx.tenant}/${item.itemId}`);
    const replacementJournalId = i.toAccount ? stableId("suspense-replacement", `${ctx.tenant}/${item.itemId}`) : null;
    validates(s, date, orig.lines.map((l) => ({ ...l, amount: (-BigInt(l.amount)).toString() })), checks, "Reversal valid");
    if (i.toAccount) {
      const target = s.accounts.get(i.toAccount);
      checks.push({ label: `Account ${i.toAccount} exists and is not suspense`, ok: !!target && !isSuspense(target), blocking: true });
      if (target && !isSuspense(target)) {
        validates(s, date, orig.lines.map((l) => (isSuspense(s.accounts.get(l.accountId)) ? { ...l, accountId: i.toAccount!, ...(i.partyId ? { partyId: i.partyId } : {}) } : l)), checks, "Replacement valid");
      }
    }
    const amt = BigInt(item.amount);
    return {
      title: `Resolve suspense ${rs(amt < 0n ? -amt : amt)}${i.toAccount ? ` to ${i.toAccount}` : " (reverse)"}`,
      summary: `Reverses ${item.journalId} on ${date}${i.toAccount ? ` and reposts it to ${s.accounts.get(i.toAccount)?.name ?? i.toAccount}` : ""}. The item (opened ${item.openedOn}, ${item.ageDays} day(s) old) is closed with links to all three entries.`,
      actions: [
        { type: "gl", command: { kind: "ResolveSuspense", itemId: item.itemId, journalId: item.journalId, reversalJournalId,
          ...(replacementJournalId ? { newJournalId: replacementJournalId, toAccount: i.toAccount } : {}), ...(i.partyId ? { partyId: i.partyId } : {}), onDate: date } },
        { type: "resolveSuspenseItem", itemId: item.itemId, bookId: ctx.book, reversalJournalId, replacementJournalId, toAccount: i.toAccount ?? null, resolvedOn: date,
          ...(i.note ? { note: i.note } : {}) },
      ],
      checks, amountPaise: amt < 0n ? -amt : amt,
      data: { item, links: { original: item.journalId, reversal: reversalJournalId, replacement: replacementJournalId } },
    };
  },
};

export const suspenseReport: OpDef<{ from?: string; to?: string }> = {
  name: "suspense", title: "Suspense items and roll-forward", kind: "read", gate: "policy",
  description: "Every suspense item with its source, owner, age and resolution, and the roll-forward for a period (default: the book's fiscal year to date): opening + additions − resolved = closing, tied to the GL suspense balance.",
  input: z.object({ from: IsoDate.optional(), to: IsoDate.optional() }),
  async plan(ctx, i) {
    const fy = financialYear(ctx.today, fiscalStart(ctx.state));           // the book's fiscal year (FIN-MDM-01)
    const from = i.from ?? fy.from, to = i.to ?? ctx.today;
    const items = await ctx.svc.agent.suspense.list(ctx.tenant, ctx.book, { asOf: to });
    const rf = await ctx.svc.agent.suspense.rollForward(ctx.tenant, ctx.book, from, to);
    const atTo = balancesFromState(ctx.state, { to });
    const gl = [...ctx.state.accounts.values()].filter((a) => isSuspense(a)).reduce((a, acc) => a + (atTo.get(acc.accountId) ?? 0n), 0n);
    const ties = gl === BigInt(rf.closing);
    const rows: Section["rows"] = items.filter((x) => x.openedOn <= to).map((x) => [x.openedOn, x.source, x.owner ?? "unassigned", x.ageDays,
      x.resolvedOn && x.resolvedOn <= to ? `resolved ${x.resolvedOn}${x.resolution?.toAccount ? ` to ${x.resolution.toAccount}` : ""}` : "open", x.amount]);
    return {
      title: `Suspense ${from} to ${to}: closing ${rs(BigInt(rf.closing))}`,
      summary: `Opening ${rs(BigInt(rf.opening))} + additions ${rs(BigInt(rf.additions))} − resolved ${rs(BigInt(rf.resolved))} = closing ${rs(BigInt(rf.closing))}.`,
      actions: [],
      checks: [{ label: "Roll-forward adds up", ok: rf.balanced, blocking: false }, { label: "Closing items agree with the GL suspense balance", ok: ties, blocking: false,
        detail: ties ? undefined : `GL ${rs(gl)} vs items ${rs(BigInt(rf.closing))}` }],
      sections: [
        { title: "Roll-forward", kind: "kv", money: [1], rows: [["Opening", rf.opening], ["Additions", rf.additions], ["Resolved", rf.resolved], ["Closing", rf.closing], ["GL suspense balance", gl.toString()]] },
        { title: "Items", kind: "table", columns: ["Opened", "Source", "Owner", "Age (days)", "Status", "Amount"], money: [5], rows },
      ],
      data: { rollForward: rf, glBalance: gl.toString(), items },
    };
  },
};

export const FIN_OPERATIONS = [scheduleApprove, scheduleCancel, schedulesReport, resolveSuspense, suspenseReport] as OpDef<any>[];
