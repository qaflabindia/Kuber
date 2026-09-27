/**
 * The close's view of the ledger (FIN-CLS-03), computed from the book's own events, not from a
 * projection: the journal population of a period, its trial balance, and the versions of the chart
 * mapping and rules a close was certified under. Pure and deterministic, so a certified close can
 * be reproduced later from the same events and compared by hash.
 */
import { canonical, sha256, type Account, type Envelope, type EventData, type Line } from "@kuber/contracts";
import type { Policy } from "@kuber/policy";

export interface LedgerJournal { journalId: string; seq: number; txnDate: string; voucherType: string; hash: string; lines: Line[] }

/** Journals of a book stream in posting order, up to stream version `upTo` (inclusive) when given. */
export function journalsOf(events: Envelope[], upTo?: number): LedgerJournal[] {
  const out: LedgerJournal[] = [];
  for (const e of events) {
    if (upTo !== undefined && e.streamVersion > upTo) break;
    if (e.type !== "JournalPosted") continue;
    const d = e.data as EventData<"JournalPosted">;
    out.push({ journalId: d.journalId, seq: d.seq, txnDate: d.txnDate, voucherType: d.voucherType, hash: d.hash, lines: d.lines });
  }
  return out;
}

/** Chart accounts from a book stream (as of `upTo`), with the latest mapping of each. */
export function accountsOf(events: Envelope[], upTo?: number): Map<string, Account> {
  const out = new Map<string, Account>();
  for (const e of events) {
    if (upTo !== undefined && e.streamVersion > upTo) break;
    if (e.type === "BookOpened") for (const a of (e.data as EventData<"BookOpened">).accounts) out.set(a.accountId, a);
    else if (e.type === "AccountAdded") { const a = (e.data as EventData<"AccountAdded">).account; out.set(a.accountId, a); }
    else if (e.type === "AccountControlsChanged") {
      const d = e.data as EventData<"AccountControlsChanged">; const a = out.get(d.accountId);
      if (a) out.set(d.accountId, { ...a, ...(d.taxonomyTag !== undefined ? { taxonomyTag: d.taxonomyTag } : {}), ...(d.requiredDims !== undefined ? { requiredDims: d.requiredDims } : {}) });
    }
  }
  return out;
}

/**
 * The period's journal population: every journal dated on or before `periodEnd` with seq up to
 * `atSeq`, in posting order. Its hash covers each journal's id, seq and chain hash (which covers
 * its lines), so any journal added, removed or changed in the period changes it.
 */
export function population(journals: LedgerJournal[], periodEnd: string, atSeq?: number) {
  const inPeriod = journals.filter((j) => j.txnDate <= periodEnd && (atSeq === undefined || j.seq <= atSeq));
  return { journals: inPeriod, count: inPeriod.length, hash: sha256(canonical(inPeriod.map((j) => ({ journalId: j.journalId, seq: j.seq, hash: j.hash })))) };
}

export interface TbRow { accountId: string; name: string; nature: string; taxonomyTag: string | null; balance: string }

/** Trial balance (debit positive, non-zero accounts, by account id) of a population. */
export function trialBalance(journals: LedgerJournal[], accounts: Map<string, Account>): { rows: TbRow[]; debits: string; credits: string } {
  const bal = new Map<string, bigint>();
  for (const j of journals) for (const l of j.lines) bal.set(l.accountId, (bal.get(l.accountId) ?? 0n) + BigInt(l.amount));
  let dr = 0n, cr = 0n;
  const rows: TbRow[] = [];
  for (const [id, v] of [...bal.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v === 0n) continue;
    if (v > 0n) dr += v; else cr -= v;
    const a = accounts.get(id);
    rows.push({ accountId: id, name: a?.name ?? id, nature: a?.nature ?? "unknown", taxonomyTag: a?.taxonomyTag ?? null, balance: v.toString() });
  }
  return { rows, debits: dr.toString(), credits: cr.toString() };
}

/** The chart mapping version: nature, statement mapping and parent of every account. */
export const mappingVersion = (accounts: Iterable<Account>) =>
  sha256(canonical([...accounts].map((a) => ({ accountId: a.accountId, nature: a.nature, taxonomyTag: a.taxonomyTag ?? null, parentId: a.parentId ?? null }))
    .sort((a, b) => (a.accountId < b.accountId ? -1 : 1))));

/** The rules version: every loaded policy's id, version, status and effective date. */
export const rulesVersion = (policies: readonly Policy[]) =>
  sha256(canonical(policies.map((p) => ({ id: p.policyId, version: p.version, status: p.status, effectiveFrom: p.effectiveFrom ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))));

/** Natural sign: debit-normal accounts as they are, credit-normal accounts negated. */
export const natural = (nature: string, raw: bigint) => (nature === "asset" || nature === "expense" ? raw : -raw);
export const isBalanceSheet = (nature: string) => nature === "asset" || nature === "liability" || nature === "equity";
