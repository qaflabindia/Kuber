/**
 * The load plan (FIN-MIG-01), computed purely from the source extract, the approved mapping and the
 * target chart. It separates the two things a migration loads:
 *
 *   1. the posted opening GL: ONE opening journal per book, dated at the cut-off, with one line per
 *      Kuber account (per party on control accounts) carrying the cut-off trial balance;
 *   2. the subledger: open receivables and payables per party and document, loaded as open items
 *      that do NOT post to the GL. They must add up, per control account and party, to the opening
 *      journal's control lines: that tie is the proof nothing was posted twice or left out.
 *
 * Blocking problems stop the load; nothing is ever balanced through suspense or an invented line.
 */
import { createHash } from "node:crypto";
import type { Account, BankDetails } from "@kuber/contracts";
import { isSuspenseAccount, type NewAccountSpec } from "./mapping.ts";
import type { Extract, SrcAccount } from "./types.ts";

export interface MappingRow { sourceKey: string; accountId: string | null; partyId: string | null; newAccount: NewAccountSpec | null; status: "suggested" | "approved" }
export interface Problem { code: string; message: string; blocking: boolean }
export interface SourceRef { key: string; file: string; row: number; amount: string }
export interface PlanLine { accountId: string; partyId: string | null; amount: bigint; sources: SourceRef[] }
export interface PlanOpenItem { key: string; partyId: string; partyKey: string; accountId: string; docNo: string; docDate: string; dueDate: string | null; amount: bigint;
  kind: "receivable" | "payable"; onAccount: boolean; file: string; row: number }
export interface PlanParty { partyId: string; key: string; name: string; kind: "customer" | "vendor" | "both"; gstin?: string; pan?: string; creditDays?: number; bank?: BankDetails; file: string; row: number }
export interface ScheduleTie { kind: string; accountKey: string; items: number; scheduleValue: bigint; ledgerBalance: bigint; ties: boolean }
export interface LoadPlan {
  cutoff: string;
  balances: Map<string, bigint>;
  lines: PlanLine[];
  openItems: PlanOpenItem[];
  parties: PlanParty[];
  newAccounts: NewAccountSpec[];
  schedules: ScheduleTie[];
  sourceTotals: { debits: bigint; credits: bigint; ledgers: number };
  sourceTbChecks: { asOf: string | null; file: string; rows: number; mismatches: { accountKey: string; reported: bigint; computed: bigint }[] }[];
  problems: Problem[];
  blocked: boolean;
}

export const partyIdFor = (system: string, key: string) => `pty-${createHash("sha256").update(`${system}|${key}`).digest("hex").slice(0, 16)}`;
const sum = (xs: Iterable<bigint>) => { let s = 0n; for (const x of xs) s += x; return s; };
const add = <K>(m: Map<K, bigint>, k: K, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);

/** The cut-off balance of every source ledger (debit positive). */
export function cutoffBalances(x: Extract, cutoff: string): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const b of x.openingBalances) add(m, b.accountKey, BigInt(b.amount));
  if (x.openingAsOf === "books_start") {
    for (const v of x.vouchers) if (!v.cancelled && v.date <= cutoff) for (const l of v.lines) add(m, l.accountKey, BigInt(l.amount));
  }
  return m;
}

/**
 * Open items at the cut-off. Tally: opening bills plus the bill allocations of vouchers dated on or
 * before the cut-off (New Ref / Advance open a bill, Agst Ref settles it), netted per party and bill.
 * Zoho and CSV: the open items of the export, as at the cut-off.
 */
export function cutoffOpenItems(x: Extract, cutoff: string): Extract["openItems"] {
  const items = new Map(x.openItems.filter((i) => i.docDate <= cutoff).map((i) => [i.key, { ...i }]));
  if (x.openingAsOf === "books_start") {
    const parties = new Map(x.accounts.filter((a) => a.party).map((a) => [a.key, a]));
    for (const v of x.vouchers) {
      if (v.cancelled || v.date > cutoff) continue;
      for (const l of v.lines) {
        const p = parties.get(l.accountKey);
        if (!p || !l.bills) continue;
        for (const b of l.bills) {
          const key = `${l.accountKey}|${b.name}`;
          const cur = items.get(key);
          if (cur) cur.amount = (BigInt(cur.amount) + BigInt(b.amount)).toString();
          else items.set(key, { file: v.file, row: v.row, key, partyKey: l.accountKey, docNo: b.name, docDate: v.date, dueDate: null, amount: b.amount,
            kind: p.party === "customer" ? "receivable" : "payable" });
        }
      }
    }
  }
  return [...items.values()].filter((i) => BigInt(i.amount) !== 0n);
}

/**
 * Build the plan. `accounts`: the target book's chart; `closed`: its closed accounts. `scope`: the
 * project's inventory categories (open items and schedules load only when in scope).
 */
export function buildPlan(x: Extract, cutoff: string, mapping: Map<string, MappingRow>, accounts: ReadonlyMap<string, Account>, closed: ReadonlySet<string>, scope: readonly string[]): LoadPlan {
  const problems: Problem[] = [];
  const block = (code: string, message: string) => problems.push({ code, message, blocking: true });
  const note = (code: string, message: string) => problems.push({ code, message, blocking: false });
  const srcBy = new Map(x.accounts.map((a) => [a.key, a]));
  const balances = cutoffBalances(x, cutoff);
  const partyBy = new Map(x.parties.map((p) => [p.key, p]));
  const partyIdOf = (key: string) => mapping.get(key)?.partyId ?? partyIdFor(x.system, key);
  const withItems = scope.includes("open_items");

  // Approved targets; anything with a balance must have one.
  const newAccounts = new Map<string, NewAccountSpec>();
  const target = (key: string): { accountId: string; account: Pick<Account, "isControl" | "nature" | "accountId" | "taxonomyTag"> } | null => {
    const m = mapping.get(key);
    if (!m || m.status !== "approved" || !m.accountId) return null;
    if (m.newAccount && !accounts.has(m.newAccount.accountId)) {
      newAccounts.set(m.newAccount.accountId, m.newAccount);
      return { accountId: m.newAccount.accountId, account: { accountId: m.newAccount.accountId, nature: m.newAccount.nature, isControl: false } };
    }
    const a = accounts.get(m.accountId);
    return a ? { accountId: a.accountId, account: a } : null;
  };

  const items = withItems ? cutoffOpenItems(x, cutoff) : [];
  const itemsByParty = new Map<string, bigint>();
  for (const i of items) add(itemsByParty, `${i.kind}|${i.partyKey}`, BigInt(i.amount));

  const lines = new Map<string, PlanLine>();
  const line = (accountId: string, partyId: string | null, amount: bigint, src: SourceRef) => {
    const k = `${accountId}|${partyId ?? ""}`;
    const l = lines.get(k) ?? { accountId, partyId, amount: 0n, sources: [] };
    l.amount += amount; l.sources.push(src); lines.set(k, l);
  };
  const planItems: PlanOpenItem[] = [];
  const partiesUsed = new Map<string, PlanParty>();
  const useParty = (key: string, fallbackKind: "customer" | "vendor", file: string, row: number) => {
    const p = partyBy.get(key);
    const partyId = partyIdOf(key);
    if (!partiesUsed.has(partyId)) partiesUsed.set(partyId, p ? { partyId, key, name: p.name, kind: p.kind, ...(p.gstin ? { gstin: p.gstin } : {}), ...(p.pan ? { pan: p.pan } : {}),
      ...(p.creditDays !== undefined ? { creditDays: p.creditDays } : {}), ...(p.bank ? { bank: p.bank } : {}), file: p.file, row: p.row }
      : { partyId, key, name: key, kind: fallbackKind, file, row });
    if (!p) note("party_not_in_master", `party ${key} has no master record in the source files: registered by name only`);
    return partyId;
  };

  let ledgers = 0;
  // Ledgers with a cut-off balance, and party ledgers whose bills are open even though they net to nil.
  const keys = [...new Set([...balances.keys(), ...(withItems ? items.map((i) => i.partyKey).filter((k) => srcBy.get(k)?.party) : [])])];
  for (const kind of ["receivable", "payable"] as const) {
    const ctl = [...balances].filter(([k, b]) => b !== 0n && srcBy.get(k)?.control === kind);
    if (ctl.length > 1) block("multiple_control_accounts", `${ctl.length} source ${kind} control accounts carry balances; their open items cannot be told apart: merge them in the source first`);
  }
  for (const key of keys) {
    const bal = balances.get(key) ?? 0n;
    if (bal === 0n && !(withItems && srcBy.get(key)?.party && items.some((i) => i.partyKey === key))) continue;
    if (bal !== 0n) ledgers++;
    const src: SrcAccount | undefined = srcBy.get(key);
    const ref = { key, file: src?.file ?? "", row: src?.row ?? 0, amount: bal.toString() };
    const t = target(key);
    if (!t) { block("unmapped", `source ledger ${key} (balance ${bal} paise) has no approved mapping`); continue; }
    if (closed.has(t.accountId)) { block("closed_target", `${key} is mapped to closed account ${t.accountId}`); continue; }
    if (isSuspenseAccount(t.account)) { block("suspense_target", `${key} is mapped to suspense: a mapping gap cannot be hidden there`); continue; }
    const role = src?.party ?? (src?.control === "receivable" ? "customer" : src?.control === "payable" ? "vendor" : null);
    if (role && !t.account.isControl) { block("needs_control", `${key} is a ${role} ledger: map it to a control account (the party goes on the line)`); continue; }
    if (!role && t.account.isControl) { block("control_without_party", `${key} is not a party ledger: it cannot go to control account ${t.accountId}`); continue; }
    const kind = role === "customer" ? "receivable" : "payable";
    if (src?.party) {
      // One party ledger (Tally): one control line for its party; its bills are the open items.
      const partyId = useParty(key, src.party, ref.file, ref.row);
      if (bal !== 0n) line(t.accountId, partyId, bal, ref);
      if (withItems) {
        const mine = items.filter((i) => i.partyKey === key);
        for (const i of mine) planItems.push({ key: i.key, partyId, partyKey: key, accountId: t.accountId, docNo: i.docNo, docDate: i.docDate, dueDate: i.dueDate, amount: BigInt(i.amount), kind: i.kind, onAccount: false, file: i.file, row: i.row });
        const rest = bal - sum(mine.map((i) => BigInt(i.amount)));
        if (rest !== 0n) {
          planItems.push({ key: `${key}|ON-ACCOUNT`, partyId, partyKey: key, accountId: t.accountId, docNo: "ON-ACCOUNT", docDate: cutoff, dueDate: null, amount: rest, kind, onAccount: true, file: ref.file, row: ref.row });
          note("on_account", `${key}: ${rest} paise of the ledger balance is not allocated to bills; carried as an on-account item`);
        }
      }
    } else if (role) {
      // A control account without party detail (Zoho AR/AP): split by party through the open items.
      if (!withItems) { block("control_without_items", `${key} is a control account: its balance needs the open items (in scope) to be split by party`); continue; }
      const mine = items.filter((i) => i.kind === kind);
      const byParty = new Map<string, bigint>();
      for (const i of mine) add(byParty, i.partyKey, BigInt(i.amount));
      const explained = sum(byParty.values());
      if (explained !== bal) { block("open_items_do_not_explain_control", `${key}: open items add up to ${explained} paise, the control balance is ${bal} (difference ${bal - explained})`); continue; }
      for (const [pk, amt] of byParty) {
        const partyId = useParty(pk, role, ref.file, ref.row);
        line(t.accountId, partyId, amt, { ...ref, amount: amt.toString() });
      }
      for (const i of mine) planItems.push({ key: i.key, partyId: partyIdOf(i.partyKey), partyKey: i.partyKey, accountId: t.accountId, docNo: i.docNo, docDate: i.docDate, dueDate: i.dueDate,
        amount: BigInt(i.amount), kind: i.kind, onAccount: false, file: i.file, row: i.row });
    } else {
      line(t.accountId, null, bal, ref);
    }
  }
  // Open items of parties no ledger/control balance carried: they would not tie to the GL.
  if (withItems) {
    const planned = new Set(planItems.map((i) => i.key));
    const orphans = items.filter((i) => !planned.has(i.key) && !(i.key.endsWith("|ON-ACCOUNT")));
    for (const o of orphans) {
      const src = srcBy.get(o.partyKey);
      if (src?.party) continue;                                   // its ledger's problem (unmapped, ...) is reported above
      block("orphan_open_item", `open item ${o.docNo} of ${o.partyKey} (${o.amount} paise): no control account balance carries it`);
    }
    for (const i of x.openItems) if (i.docDate > cutoff) note("open_item_after_cutoff", `open item ${i.docNo} is dated ${i.docDate}, after the cut-off: left to the delta import`);
  }

  const planLines = [...lines.values()].filter((l) => l.amount !== 0n).sort((a, b) => a.accountId.localeCompare(b.accountId) || (a.partyId ?? "").localeCompare(b.partyId ?? ""));
  const net = sum(planLines.map((l) => l.amount));
  if (net !== 0n && !problems.some((p) => p.blocking)) block("source_tb_unbalanced", `the source trial balance at ${cutoff} does not balance: debits minus credits = ${net} paise (resolve the difference in the source; it is never posted to suspense)`);
  if (planLines.length < 2 && !problems.some((p) => p.blocking)) block("nothing_to_load", "there is no cut-off balance to load");
  for (const [id, a] of newAccounts) if (!/^[A-Za-z0-9_.:@+-]{1,200}$/.test(id) || !a.name) block("bad_new_account", `new account ${id} is not valid`);

  // The source's own trial balance(s) at the cut-off must equal the computed cut-off balances.
  const checks = x.trialBalances.filter((t) => t.asOf === null || t.asOf === cutoff).map((t) => {
    const reported = new Map<string, bigint>();
    for (const r of t.rows) add(reported, r.accountKey, BigInt(r.amount));
    const keys = new Set([...reported.keys(), ...[...balances.keys()].filter((k) => balances.get(k) !== 0n)]);
    const mismatches = [...keys].map((k) => ({ accountKey: k, reported: reported.get(k) ?? 0n, computed: balances.get(k) ?? 0n })).filter((m) => m.reported !== m.computed);
    if (mismatches.length) block("source_totals", `the source trial balance in file ${t.file.slice(0, 12)} differs from the ledgers at the cut-off on ${mismatches.length} ledger(s)`);
    return { asOf: t.asOf, file: t.file, rows: t.rows.length, mismatches };
  });

  // Stock and asset schedules tie to the ledgers they value.
  const schedules: ScheduleTie[] = [];
  for (const kind of ["stock", "assets"] as const) {
    if (!scope.includes(kind)) continue;
    const by = new Map<string, { n: number; v: bigint }>();
    for (const s of x.schedules) if (s.kind === kind && s.value !== null && s.accountKey) { const c = by.get(s.accountKey) ?? { n: 0, v: 0n }; c.n++; c.v += BigInt(s.value); by.set(s.accountKey, c); }
    for (const [accountKey, c] of by) {
      const tie = { kind, accountKey, items: c.n, scheduleValue: c.v, ledgerBalance: balances.get(accountKey) ?? 0n, ties: c.v === (balances.get(accountKey) ?? 0n) };
      schedules.push(tie);
      if (!tie.ties) block("schedule_does_not_tie", `${kind} schedule for ${accountKey}: ${c.v} paise against a ledger balance of ${tie.ledgerBalance}`);
    }
  }

  const debits = sum(planLines.filter((l) => l.amount > 0n).map((l) => l.amount)), credits = -sum(planLines.filter((l) => l.amount < 0n).map((l) => l.amount));
  return { cutoff, balances, lines: planLines, openItems: planItems, parties: [...partiesUsed.values()], newAccounts: [...newAccounts.values()], schedules,
    sourceTotals: { debits, credits, ledgers }, sourceTbChecks: checks, problems, blocked: problems.some((p) => p.blocking) };
}

// ------------------------------------------------------------------ balances of a Kuber book
interface JournalLike { lines: { accountId: string; amount: string; partyId?: string }[]; txnDate: string }
/** Balance per account (and per `account|party`) over journals dated in [from, to] (either bound open). */
export function bookBalances(journals: Iterable<JournalLike>, to: string | null, from: string | null = null) {
  const byAccount = new Map<string, bigint>(), byParty = new Map<string, bigint>();
  for (const j of journals) {
    if ((to && j.txnDate > to) || (from && j.txnDate < from)) continue;
    for (const l of j.lines) {
      const v = BigInt(l.amount);
      add(byAccount, l.accountId, v);
      if (l.partyId) add(byParty, `${l.accountId}|${l.partyId}`, v);
    }
  }
  return { byAccount, byParty };
}
