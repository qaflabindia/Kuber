/**
 * Signed commands at the HTTP boundary (design 14.4 and 16.4). For each high-risk command that
 * exists as one HTTP request, this derives what a signature must be over, from the command itself
 * (never from the client): the subject and its hash, the book, and the summary the person is shown
 * (amount, payees, accounts, periods). The identity module turns that into WebAuthn options whose
 * challenge is the command digest, and verifies the answer inside the command's own transaction.
 *
 *   plan.commit    POST /plans/:id/commit     step-up-class plans: period operations (allocate,
 *                                             rebalance, close, carry-forward, ...) and amounts above
 *                                             the approval (SoD) limit; close is how periods are locked
 *   plan.approve   POST /plans/:id/approve    the same plans, approve now and execute later
 *   draft.approve  POST /drafts/:id/approve   a draft whose amount is above the tenant's SoD limit
 *   journal.ratify POST /journals/:id/ratify  an automatic posting above the tenant's SoD limit
 *   period.lock    POST /books/:book/locks    always (a direct period lock)
 *   migration.golive POST /migrations/:p/go-live  always: a superuser signs the parallel-run comparison and
 *                                             the cut-over checklist (FIN-MIG-02); Kuber becomes the book of record
 *
 * Not reachable as one HTTP command today (documented, not signed here): "publish policy" (policies
 * are files loaded at start-up, no API) and "pay" as a bank payment (Kuber records payments; a
 * payment is a record/post plan and is signed as plan.commit when above the limit).
 */
import { z } from "zod";
import { IsoDate, SIGNED_ACTIONS, canonical, sha256, type CommandSummary, type Line, type SignedAction } from "@kuber/contracts";
import { lockSubjectHash, type SigningIntent } from "@kuber/identity";
import { OpsError } from "@kuber/ops";
import type { Cell } from "./cell.ts";

export const SigningRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("plan.commit"), planId: z.string().min(1), hash: z.string().length(64) }),
  z.object({ action: z.literal("plan.approve"), planId: z.string().min(1), hash: z.string().length(64) }),
  z.object({ action: z.literal("draft.approve"), draftId: z.string().min(1), accountId: z.string().min(1).optional() }),
  z.object({ action: z.literal("journal.ratify"), journalId: z.string().min(1) }),
  z.object({ action: z.literal("period.lock"), book: z.string().min(1), periodEnd: IsoDate, level: z.enum(["soft", "hard"]) }),
  z.object({ action: z.literal("migration.golive"), projectId: z.string().min(1), comparisonId: z.string().min(1) }),
]);
export type SigningRequest = z.infer<typeof SigningRequest>;
void SIGNED_ACTIONS;

const rupees = (p: bigint) => { const n = p < 0n ? -p : p; return `₹${(n / 100n).toLocaleString("en-IN")}${n % 100n ? "." + String(n % 100n).padStart(2, "0") : ""}`; };

/** Debits and credits per account (paise) and the largest journal's total debits. */
function accountsOf(lines: Line[], name: (id: string) => string) {
  const m = new Map<string, { accountId: string; name: string; debit: bigint; credit: bigint }>();
  let amount = 0n;
  for (const l of lines) {
    const a = m.get(l.accountId) ?? { accountId: l.accountId, name: name(l.accountId), debit: 0n, credit: 0n };
    const v = BigInt(l.amount);
    if (v > 0n) { a.debit += v; amount += v; } else a.credit -= v;
    m.set(l.accountId, a);
  }
  const rows = [...m.values()].sort((a, b) => a.accountId.localeCompare(b.accountId));
  return { amount, accounts: rows.map((a) => ({ accountId: a.accountId, name: a.name, debitPaise: a.debit.toString(), creditPaise: a.credit.toString() })),
    lines: rows.map((a) => `${a.name} (${a.accountId}): ${a.debit ? `debit ${rupees(a.debit)}` : ""}${a.debit && a.credit ? ", " : ""}${a.credit ? `credit ${rupees(a.credit)}` : ""}`) };
}

/** Names of the parties a summary pays, from the party master; a payee line for each. Deterministic for the same master data. */
async function withPayees(cell: Cell, tenant: string, s: CommandSummary): Promise<CommandSummary> {
  if (!s.payees.length) return s;
  const payees = await Promise.all(s.payees.map(async (p) => ({ partyId: p.partyId, name: (await cell.parties.get(tenant, p.partyId).catch(() => null))?.name ?? null })));
  const at = Math.min(s.lines.length, s.amountPaise ? 3 : 2);
  return { ...s, payees, lines: [...s.lines.slice(0, at), ...payees.map((p) => `Payee ${p.name ? `${p.name} (${p.partyId})` : p.partyId}`), ...s.lines.slice(at)] };
}

/** The signing intent for a plan: its stored hash must be the one the person saw. */
export async function planIntent(cell: Cell, tenant: string, planId: string, hash: string, action: "plan.commit" | "plan.approve"): Promise<SigningIntent> {
  const plan = await cell.ops.get(tenant, planId);
  if (plan.hash !== hash) throw new OpsError("hash_mismatch", "the plan you approved is not the plan on record; simulate again");
  const summary = await withPayees(cell, tenant, await cell.ops.commandSummary(tenant, planId, action));
  return { action, book: plan.bookId, subject: planId, subjectHash: plan.hash, summary };
}

/** Largest amount a draft would post (paise). */
const draftAmount = (lines: Line[]) => lines.reduce((a, l) => (BigInt(l.amount) > 0n ? a + BigInt(l.amount) : a), 0n);

/** The draft approval as it would be posted: the chosen account replaces the proposed one. */
export async function draftIntent(cell: Cell, tenant: string, draftId: string, accountId?: string): Promise<SigningIntent & { amount: bigint }> {
  const d = await cell.agent.draft(tenant, draftId);
  if (!d) throw new OpsError("not_found", `no draft ${draftId}`, 404);
  const final = accountId ?? d.proposal.accountId;
  const lines = d.proposal.lines.map((l) => (l.accountId === d.proposal.accountId ? { ...l, accountId: final } : l));
  const st = await cell.gl.state(tenant, d.bookId);
  const a = accountsOf(lines, (id) => st.accounts.get(id)?.name ?? id);
  const parties = [...new Set(lines.map((l) => l.partyId).filter((p): p is string => !!p))].sort();
  const summary = await withPayees(cell, tenant, { action: "draft.approve", title: `Approve draft: ${d.proposal.narration}`, book: d.bookId,
    amountPaise: a.amount ? a.amount.toString() : null, payees: parties.map((partyId) => ({ partyId, name: null })), accounts: a.accounts, periods: [],
    lines: [`Approve and post: ${d.proposal.narration} on ${d.proposal.txnDate}`, `Book ${d.bookId}`, ...(a.amount ? [`Amount ${rupees(a.amount)}`] : []), ...a.lines] });
  return { action: "draft.approve", book: d.bookId, subject: draftId, subjectHash: sha256(canonical({ draftId, txnDate: d.proposal.txnDate, accountId: final, lines })),
    summary, amount: draftAmount(lines) };
}

/** Ratifying an automatic posting: the journal as it is in the book. */
export async function ratifyIntent(cell: Cell, tenant: string, journalId: string): Promise<(SigningIntent & { amount: bigint }) | null> {
  const book = await cell.agent.journalBook(tenant, journalId);
  if (!book) return null;
  const st = await cell.gl.state(tenant, book);
  const j = st.journals.get(journalId);
  if (!j) return null;
  const a = accountsOf(j.lines, (id) => st.accounts.get(id)?.name ?? id);
  const parties = [...new Set(j.lines.map((l) => l.partyId).filter((p): p is string => !!p))].sort();
  const summary = await withPayees(cell, tenant, { action: "journal.ratify", title: `Confirm automatic posting: ${j.narration}`, book,
    amountPaise: a.amount ? a.amount.toString() : null, payees: parties.map((partyId) => ({ partyId, name: null })), accounts: a.accounts, periods: [],
    lines: [`Confirm the automatic posting: ${j.narration} on ${j.txnDate}`, `Book ${book}`, ...(a.amount ? [`Amount ${rupees(a.amount)}`] : []), ...a.lines] });
  return { action: "journal.ratify", book, subject: journalId, subjectHash: sha256(canonical({ journalId, txnDate: j.txnDate, lines: j.lines })), summary, amount: a.amount };
}

/** A direct period lock. */
export function lockIntent(book: string, periodEnd: string, level: "soft" | "hard"): SigningIntent {
  return { action: "period.lock", book, subject: `${periodEnd}:${level}`, subjectHash: lockSubjectHash(book, periodEnd, level),
    summary: { action: "period.lock", title: `Lock ${book} up to ${periodEnd} (${level})`, book, amountPaise: null, payees: [], accounts: [],
      periods: [{ periodEnd, level }], lines: [`Lock (${level}) everything in book ${book} up to ${periodEnd}`, level === "hard" ? "Nothing dated on or before it can be posted afterwards." : "Only owners and controllers can post into it afterwards."] } };
}

/** Why an amount needs a signature: above the tenant's SoD limit (drafts and ratifications have no plan policy). */
export async function amountReason(cell: Cell, tenant: string, amount: bigint): Promise<string | null> {
  const s = await cell.identity.settings(tenant);
  if (s.sodLimitPaise === null || amount <= BigInt(s.sodLimitPaise)) return null;
  return `the amount is above the approval limit of ₹${(BigInt(s.sodLimitPaise) / 100n).toLocaleString("en-IN")}`;
}

/** Everything a signing prompt needs besides the WebAuthn options. */
export const actionLabel: Record<SignedAction, string> = {
  "plan.commit": "approve and carry out this plan", "plan.approve": "approve this plan", "draft.approve": "approve this draft",
  "journal.ratify": "confirm this automatic posting", "period.lock": "lock this period",
  "migration.golive": "go live and make Kuber the book of record",
};

/** FIN-MIG-02: the go-live of a migration project, over its comparison and checklist (rendered by the migration module). */
export async function goLiveIntent(cell: Cell, tenant: string, projectId: string, comparisonId: string): Promise<SigningIntent> {
  const i = await cell.migration.goLiveIntent(tenant, projectId, comparisonId);
  return { action: "migration.golive", book: i.book, subject: i.subject, subjectHash: i.subjectHash, summary: i.summary };
}
