/**
 * Bank operations (FIN-CASH-03), registered with the ops service by the cell, so they are planned,
 * stored, approved and committed like every other operation, under the same guard, and appear in
 * ops.list() (every agent surface's tool catalogue and the governance register).
 *
 *   bank_reconciliation          read: the reconciliation statement of a registered account at a
 *                                period end (book and bank balances, timing items with age and
 *                                source, statement lines not yet in the books, difference, coverage)
 *   certify_bank_reconciliation  write, no policy event (a person always commits; an agent never
 *                                does): preparing it records the preparer (treasurer, controller or
 *                                staff); committing it certifies, by an independent superuser,
 *                                controller or treasurer, and over HTTP only with a passkey signature
 */
import { z } from "zod";
import { Id, IsoDate, principalRole } from "@kuber/contracts";
import type { Check, Draft, ExtensionHandler, OpContext, OpDef, Section } from "@kuber/ops";
import type { Reconciliation, TimingItem } from "./reconcile.ts";
import { PREPARERS, type BankService } from "./service.ts";

export const BANK_EXT = "bank";
const rs = (v: string | bigint | null) => {
  if (v === null) return "—";
  const p = BigInt(v), n = p < 0n ? -p : p;
  return `${p < 0n ? "-" : ""}₹${(n / 100n).toLocaleString("en-IN")}.${String(n % 100n).padStart(2, "0")}`;
};
const Input = z.object({
  bankAccountId: Id.describe("the registered bank account (see /bank/accounts)"),
  periodEnd: IsoDate.describe("the reconciliation date, usually the statement's closing date"),
  periodFrom: IsoDate.optional().describe("default: the day after the last certified period, or the account's opening date"),
});
type In = z.infer<typeof Input>;

export function reconciliationSections(r: Reconciliation): Section[] {
  const items: [string, TimingItem][] = [...r.outstandingPayments.map((x): [string, TimingItem] => ["Outstanding payment", x]),
    ...r.depositsInTransit.map((x): [string, TimingItem] => ["Deposit in transit", x])];
  return [
    { title: "Reconciliation", kind: "kv", money: [1], rows: [
      ["Balance per bank statement", r.bankBalance], ["Add: deposits in transit", r.depositsInTransit.reduce((a, x) => a + BigInt(x.amount), 0n).toString()],
      ["Less: outstanding payments", r.outstandingPayments.reduce((a, x) => a + BigInt(x.amount), 0n).toString()], ["Adjusted bank balance", r.adjustedBank],
      ["Balance per books", r.bookBalance], ["Add: statement lines not yet in the books", r.unrecorded.reduce((a, x) => a + BigInt(x.amount), 0n).toString()],
      ["Adjusted book balance", r.adjustedBook], ["Unexplained difference", r.difference]] },
    { title: "Timing items (individually identified)", kind: "table", columns: ["Kind", "Date", "Entry", "Narration", "Amount", "Age (days)", "Source", "Stale"], money: [4],
      rows: items.map(([k, x]) => [k, x.txnDate, x.journalId, x.narration, x.amount, x.ageDays, `${x.source.voucherType} by ${x.source.postedBy}${x.source.provisional ? " (provisional)" : ""}`, x.stale ? "yes" : ""]) },
    ...(r.unrecorded.length ? [{ title: "On the statement, not yet in the books", kind: "table" as const, columns: ["Date", "Line", "Narration", "Amount"], money: [3],
      rows: r.unrecorded.map((x) => [x.txnDate, x.txnId, x.narration ?? "", x.amount]) }] : []),
    { title: "Statement coverage", kind: "table", columns: ["Statement", "Period", "Status", "Provenance", "Content hash"],
      rows: [...r.statements.map((s) => [s.statementId, `${s.periodFrom}..${s.periodTo}`, s.status, s.provenance, s.contentHash.slice(0, 16)]),
        ...r.coverage.gaps.map((g) => ["(gap)", `${g.from}..${g.to}`, "missing", "", ""])] },
  ];
}

function checksOf(r: Reconciliation): Check[] {
  return [
    { label: "Statements cover the period", ok: r.coverage.complete && r.coverage.held.length === 0 && r.bankBalance !== null, blocking: true,
      detail: r.coverage.complete ? (r.coverage.held.length ? `${r.coverage.held.length} held statement(s)` : undefined) : r.coverage.gaps.map((g) => `${g.from}..${g.to}`).join(", ") || "no statement" },
    { label: "Every statement line is in the books", ok: r.unrecorded.length === 0, blocking: true,
      detail: r.unrecorded.length ? `${r.unrecorded.length} line(s), ${rs(r.unrecorded.reduce((a, x) => a + BigInt(x.amount), 0n))}` : undefined },
    { label: "Reconciliation difference is zero", ok: r.differenceZero, blocking: true, detail: r.differenceZero ? undefined : `unexplained ${rs(r.difference)}` },
    { label: "No outstanding items", ok: r.noOutstandingItems, blocking: false,
      detail: r.noOutstandingItems ? undefined : `${r.outstandingCount} timing item(s) stay listed with their age (difference zero is not the same as no outstanding items)` },
    { label: "No stale timing item", ok: r.staleItems.length === 0, blocking: false, detail: r.staleItems.length ? `${r.staleItems.length} older than ${r.staleDays} days: an exception is raised` : undefined },
  ];
}

export function bankOperations(svc: BankService): OpDef<any>[] {
  const read: OpDef<In> = {
    name: "bank_reconciliation", title: "Bank reconciliation statement", kind: "read", gate: "policy",
    description: "The reconciliation of a registered bank account at a period end: balance per bank statement and per books, each outstanding payment and deposit in transit individually with its age and source, statement lines not yet in the books, the unexplained difference, and statement coverage. Reads only; certify_bank_reconciliation certifies it.",
    input: Input,
    async plan(ctx: OpContext, i: In): Promise<Draft> {
      const r = await svc.reconciliation(ctx.tenant, ctx.book, i.bankAccountId, i.periodEnd, i.periodFrom);
      return { title: `${i.bankAccountId} (${r.masked}) at ${i.periodEnd}: ${r.differenceZero ? "difference zero" : `difference ${rs(r.difference)}`}, ${r.outstandingCount} outstanding item(s)`,
        summary: r.certifiable ? "Ready to certify." : `Not certifiable: ${r.problems.join("; ")}.`, actions: [], checks: checksOf(r), sections: reconciliationSections(r), data: r,
        links: [["Bank", "/bank"]] };
    },
  };

  const certify: OpDef<In> = {
    name: "certify_bank_reconciliation", title: "Certify a bank reconciliation", kind: "write", gate: "policy",
    description: "Prepare the certification of a registered bank account's reconciliation at a period end. The preparer (a treasurer, controller or staff member) is recorded; committing is the certification by an independent superuser, controller or treasurer who signs the coverage, the aged timing items and the report version (a passkey signature over HTTP). Certifies only with statements covering the period, every statement line in the books and an unexplained difference of exactly zero. Stores a certified snapshot with the statement hashes and ledger position; a later posting into the period withdraws it. Never posts a journal. Always needs a person.",
    input: Input,
    async plan(ctx: OpContext, i: In): Promise<Draft> {
      const preparedBy = ctx.onBehalfOf ?? ctx.principal;
      const r = await svc.reconciliation(ctx.tenant, ctx.book, i.bankAccountId, i.periodEnd, i.periodFrom);
      const checks = checksOf(r);
      checks.unshift({ label: "The preparer is a treasurer, controller or staff member", ok: PREPARERS.has(principalRole(preparedBy)), blocking: true, detail: preparedBy });
      const existing = (await svc.reconciliations(ctx.tenant, ctx.book, i.bankAccountId)).find((x) => x.periodEnd === i.periodEnd && x.status === "certified");
      checks.push({ label: "Not already certified", ok: !existing, blocking: true, detail: existing ? `${existing.reconciliationId} (v${existing.version}) by ${existing.certifiedBy}` : undefined });
      checks.push({ label: "Certified by someone other than the preparer", ok: true, blocking: false, detail: `${preparedBy} prepared it: a different superuser, controller or treasurer commits` });
      return { title: `Certify ${i.bankAccountId} (${r.masked}) reconciliation ${r.periodFrom}..${i.periodEnd}`,
        summary: `Bank ${rs(r.bankBalance)}, books ${rs(r.bookBalance)}, ${r.outstandingCount} timing item(s), difference ${rs(r.difference)}. Certifying signs the coverage (${r.statements.length} statement(s)) and the aged items.`,
        actions: [{ type: "ext", module: BANK_EXT, kind: "certify", payload: { bankAccountId: i.bankAccountId, periodFrom: r.periodFrom, periodEnd: i.periodEnd, hash: r.hash, preparedBy } }],
        checks, sections: reconciliationSections(r), data: { reconciliation: r, preparedBy }, links: [["Bank", "/bank"]] };
    },
  };
  return [read, certify];
}

/** The `bank` ext handler: the certification step of a committed plan. */
export const bankExtension = (svc: BankService): ExtensionHandler => async (tx, ctx, a) => {
  if (a.kind !== "certify") throw new Error(`unknown bank action ${a.kind}`);
  return svc.certify(tx, ctx, a.payload as Parameters<BankService["certify"]>[2]);
};
