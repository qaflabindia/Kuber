/**
 * Read tools of the agent catalogue (AAWDS L1): every one is book-scoped, authorized before it reads
 * anything, and returns concise text, structured data and a read card (a Plan of kind "read" the
 * canvas renders). Figures come from the reporting, ops, agent, schedules, suspense and party
 * services exactly as they compute them (paise; shown as ₹ by rs()): the tool layer selects and
 * arranges, it does not do accounting.
 *
 * Authorization: the same ops guard every read operation passes (identity.check, step "plan",
 * kind "read"): for the copilot, the person it acts for (onBehalfOf) must hold "read" in the book;
 * for an MCP agent, its grant must cover the book. Tenant-wide data (parties) additionally needs a
 * person who may read every book.
 */
import { z } from "zod";
import { IsoDate, JOURNAL_STATES, parseAmount, uuid } from "@kuber/contracts";
import { AccessDenied, COPILOT } from "@kuber/identity";
import { balancesFromState, financialYear, fiscalStart, type OpName, type Plan, type Section } from "@kuber/ops";
import type { BookState } from "@kuber/gl";
import type { Cell } from "./cell.ts";
import type { Completeness, ToolResult, ToolSpec, Who } from "./tools.ts";
import { matchAccounts, type AccountRef } from "./copilot/router.ts";

// ---------------------------------------------------------------- formatting (shared with tools.ts)
export const rs = (paise: string | bigint) => {
  const p = BigInt(paise), n = p < 0n ? -p : p;
  return `${p < 0n ? "-" : ""}₹${(n / 100n).toLocaleString("en-IN")}${n % 100n ? "." + String(n % 100n).padStart(2, "0") : ""}`;
};

/** A plan as plain text: what a model (or a person reading a transcript) needs to judge it. */
export function planText(p: Plan): string {
  const out = [`# ${p.title}`, p.summary];
  if (p.kind === "write") out.push(`planId: ${p.planId}\nhash: ${p.hash}\nstatus: ${p.status}${p.blocked ? " (BLOCKED)" : ""} · commit by: ${p.needsPerson ? "a person in Kuber" : "you (policy allows)"}`);
  if (p.policy) out.push(`Policy ${p.policy.ids.join(", ")} → ${p.policy.level}, approver ${p.policy.approver}${p.policy.reasons.length ? ` (${p.policy.reasons.join("; ")})` : ""}`);
  if (p.checks.length) out.push("Checks:\n" + p.checks.map((c) => `- [${c.ok ? "x" : " "}] ${c.label}${c.detail ? `: ${c.detail}` : ""}${!c.ok && c.blocking ? " (blocking)" : ""}`).join("\n"));
  if (p.journals.length) out.push("Journals:\n" + p.journals.map((j) => `- ${j.txnDate} ${j.narration} [${j.voucherType}]\n` +
    j.lines.map((l) => `    ${l.accountId.padEnd(10)} ${BigInt(l.amount) > 0n ? "Dr" : "Cr"} ${rs(BigInt(l.amount) < 0n ? -BigInt(l.amount) : BigInt(l.amount))}${l.dimensions ? " " + JSON.stringify(l.dimensions) : ""}`).join("\n")).join("\n"));
  if (p.effects.length) out.push("Effect on balances:\n" + p.effects.map((e) => `- ${e.name}: ${rs(e.before)} → ${rs(e.after)}`).join("\n"));
  for (const s of p.sections) {
    const fmt = (v: unknown, i: number) => (s.money?.includes(i) && typeof v === "string" && /^-?\d+$/.test(v) ? rs(v) : String(v ?? ""));
    out.push(`${s.title}:\n` + (s.columns ? `| ${s.columns.join(" | ")} |\n` : "") + s.rows.map((r) => (s.kind === "kv" ? `- ${r[0]}: ${fmt(r[1], 1)}` : `| ${r.map(fmt).join(" | ")} |`)).join("\n"));
  }
  if (p.notes.length) out.push(p.notes.join("\n"));
  return out.join("\n\n");
}

const NATURE_ORDER = ["asset", "liability", "equity", "income", "expense"];
const DEBIT_NORMAL = new Set(["asset", "expense"]);
/** Balance in the account's natural sign (debit-normal accounts as is, others negated). */
const natural = (nature: string, bal: bigint) => (DEBIT_NORMAL.has(nature) ? bal : -bal);
const dayBefore = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const abs = (v: bigint) => (v < 0n ? -v : v);
/** A journal's size: the sum of its debit lines (paise). */
const journalAmount = (lines: { amount: string }[]) => lines.reduce((a, l) => (BigInt(l.amount) > 0n ? a + BigInt(l.amount) : a), 0n);

/** A read answer the canvas renders with the existing PlanCard (kind "read"; nothing to approve). */
export function readCard(who: Who, op: string, title: string, summary: string, sections: Section[], data: unknown, links: [string, string][] = [], notes: string[] = []): Plan {
  return {
    planId: uuid(), op: op as OpName, bookId: who.book, kind: "read", gate: "policy", title, summary, policy: null,
    checks: [], journals: [], effects: [], sections, data, notes, links, basisSeq: 0, createdAt: new Date().toISOString(),
    createdBy: who.principal, hash: "", ...(who.onBehalfOf ? { requestedBy: who.onBehalfOf } : {}), status: "preview", blocked: false, needsPerson: false,
  };
}
// ---------------------------------------------------------------- completeness (context integrity: fragments)
const WHY: Record<NonNullable<Completeness["truncatedBy"]>, string> = { page: "one page", top_n: "top-N cut", scope: "outside the reader's scope", row_limit: "row limit",
  projection_lag: "the reporting projection is behind the ledger; the missing journals are not in these figures" };
/** The one "Completeness:" line every read result carries in its text. */
export function completenessLine(c: Completeness, noun: string, where = ""): string {
  if (c.complete) return `Completeness: complete (${c.returned}${c.total !== undefined ? ` of ${c.total}` : ""} ${noun})${where ? `${where}.` : "."}`;
  const of = c.total !== undefined ? `showing ${c.returned} of ${c.total} ${noun}` : `showing ${c.returned} ${noun}; more exist`;
  return `Completeness: PARTIAL, ${of} (${c.truncatedBy ? WHY[c.truncatedBy] : "partial"})${c.excluded?.length ? `; excluded: ${c.excluded.join(", ")}` : ""}${where}.`;
}
/** The sentence a reply carries when a result it used is partial: "Showing 6 of 14 accounts in the by-month table (top-N cut)." */
export function completenessNote(c: Completeness, noun: string, where = ""): string | undefined {
  if (c.complete) return undefined;
  const of = c.total !== undefined ? `Showing ${c.returned} of ${c.total} ${noun}` : `Showing ${c.returned} ${noun}; more exist`;
  return `${of}${where}${c.truncatedBy ? ` (${WHY[c.truncatedBy]})` : ""}${c.excluded?.length && !where.includes("excluded") ? `; excluded: ${c.excluded.join(", ")}` : ""}. Totals over the rows shown are not totals of the whole.`;
}
/** A tool result with its completeness declared in structured data (result and `data`), in the text, and on the read card. */
export function withCompleteness(r: ToolResult, c: Completeness, noun: string, where = "", scopeTotals?: (string | bigint)[]): ToolResult {
  const line = completenessLine(c, noun, where), note = completenessNote(c, noun, where);
  const data = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? { ...(r.data as Record<string, unknown>), completeness: c } : r.data;
  const plan = r.plan ? { ...r.plan, notes: [...r.plan.notes, line], ...(r.plan.data && typeof r.plan.data === "object" && !Array.isArray(r.plan.data) ? { data: { ...(r.plan.data as Record<string, unknown>), completeness: c } } : {}) } : undefined;
  return { ...r, text: plan ? planText(plan) : `${r.text}\n\n${line}`, ...(plan ? { plan } : {}), data, completeness: c, ...(note ? { completenessNote: note } : {}),
    ...(scopeTotals?.length ? { scopeTotals: scopeTotals.map(String) } : {}) };
}
const answer = (card: Plan, data: unknown, c: Completeness = { complete: true, returned: 0 }, noun = "rows", where = "", scopeTotals?: (string | bigint)[]): ToolResult =>
  withCompleteness({ text: planText(card), plan: card, data, summary: `${card.title}: ${card.summary}` }, c, noun, where, scopeTotals);
const whole = (n: number): Completeness => ({ complete: true, returned: n, total: n });
/** [completeness, noun]: the statement's own noun when whole, "journals" when the projection lags. */
const lagOr = ([c, noun]: [Completeness, string], wholeNoun: string): [Completeness, string] => [c, c.complete ? wholeNoun : noun];
/**
 * A statement's completeness: whole when its projection has every journal of the ledger; otherwise PARTIAL
 * in journals (projected of posted), so a statement from a lagging projection is never presented as complete.
 */
export const statementCompleteness = (st: { basis?: { fresh: boolean; projectedSeq: number; ledgerSeq: number } }, lines: number): [Completeness, string] =>
  st.basis && !st.basis.fresh
    ? [{ complete: false, returned: st.basis.projectedSeq, total: st.basis.ledgerSeq, truncatedBy: "projection_lag" }, "journals"]
    : [whole(lines), "lines"];

// ---------------------------------------------------------------- shared service reads (also used by HTTP routes)
/** FIN-GL-01: one vocabulary over every path an entry takes (drafts, plans, ledger rejections, schedule exceptions). */
export async function journalLifecycle(cell: Cell, tenant: string, book: string) {
  const [drafts, plans, rejections, exceptions] = await Promise.all([cell.agent.lifecycle(tenant, book), cell.ops.lifecycle(tenant, book),
    cell.gl.rejections(tenant, book), cell.ops.schedules.exceptions(tenant, book)]);
  const items = [
    ...drafts, ...plans,
    ...rejections.map((r) => ({ id: r.requestId, source: "ledger" as const, state: "failed" as const, reason: r.reason, origin: r.source, at: r.at, by: r.principal })),
    ...exceptions.map((x) => ({ id: x.occurrence_id, source: "schedule" as const, state: "failed" as const, reason: x.reason, scheduleId: x.schedule_id,
      period: x.period, dueOn: x.due_on })),
  ];
  const counts = Object.fromEntries(JOURNAL_STATES.map((st) => [st, items.filter((i) => i.state === st).length]));
  return { states: JOURNAL_STATES, counts, items };
}

/** What needs a person: drafts in review, ratifications (tenant-wide members only) and open plans. */
export async function attentionCounts(cell: Cell, tenant: string, book: string, tenantWide: boolean) {
  const [d, ratifications, plans, overdue] = await Promise.all([cell.agent.queueCounts(tenant, tenantWide ? undefined : book),
    tenantWide ? cell.agent.openRatificationCount(tenant) : Promise.resolve(0), cell.ops.pendingCount(tenant, book),
    cell.periodClose ? cell.periodClose.overdue(tenant, book) : Promise.resolve([])]);
  // FIN-CLS-01: open close checklist tasks past their deadline.
  return { drafts: d.open, awaitingApproval: d.awaitingApproval, ratifications, plans, closeTasksOverdue: overdue.length };
}

/** The read guard every read tool passes first: the ops guard for a read operation, in this book. */
export const readGuard = (cell: Cell, who: Who, name: string) => cell.identity.check({ step: "plan", tenant: who.tenant, book: who.book, principal: who.principal,
  op: { name: name as OpName, kind: "read", gate: "policy" }, onBehalfOf: who.onBehalfOf });

// ---------------------------------------------------------------- the read tools
const Period = { from: IsoDate.optional().describe("first day, YYYY-MM-DD (default: start of the book's fiscal year)"), to: IsoDate.optional().describe("last day, YYYY-MM-DD (default: end of the fiscal year)") };
const Rupees = z.union([z.string(), z.number()]).transform((v) => parseAmount(String(v)));

export function readTools(cell: Cell, who: Who, clock: () => string = () => new Date().toISOString().slice(0, 10)): ToolSpec[] {
  const T = who.tenant, B = who.book;
  const person = () => (who.principal === COPILOT ? who.onBehalfOf : who.principal);
  const guard = async (name: string, tenantWide = false) => {
    await readGuard(cell, who, name);
    if (tenantWide) {
      const p = person();
      if (!p || /^(agent|system):/.test(p)) throw new AccessDenied("workspace-wide data is available only to a person who may read every book");
      await cell.identity.authorize(T, p, "read", { allBooks: true });
    }
  };
  const state = async (): Promise<BookState> => {
    const s = await cell.gl.state(T, B);
    if (!s.exists) throw new Error(`book ${B} does not exist`);
    return s;
  };
  const fy = (s: BookState, on = clock()) => financialYear(on, fiscalStart(s));
  const periodOf = (s: BookState, a: { from?: string; to?: string }) => {
    const y = fy(s);
    const from = a.from ?? (a.to ? fy(s, a.to).from : y.from), to = a.to ?? (a.from ? fy(s, a.from).to : y.to);
    const f = fy(s, from);
    return { from, to, label: from === f.from && to === f.to ? f.label : `${from} to ${to}` };
  };
  const refs = (s: BookState): AccountRef[] => [...s.accounts.values()].map((a) => ({ id: a.accountId, name: a.name }));
  /** An account id from an id or a name; ambiguous or unknown names are an error that lists the candidates (never a guess). */
  const accountOf = (s: BookState, q: string) => {
    const exact = [...s.accounts.keys()].find((id) => id.toLowerCase() === q.trim().toLowerCase());
    if (exact) return exact;
    const m = matchAccounts(q, refs(s));
    if (m.length && m[0]!.score >= 0.5 && (m.length === 1 || m[0]!.score - m[1]!.score >= 0.2)) return m[0]!.id;
    if (m.length) throw new Error(`"${q}" could be ${m.slice(0, 4).map((x) => `${x.id} (${x.name})`).join(", ")}: say which account`);
    throw new Error(`no account matches "${q}"; use kuber_chart_of_accounts for the ids`);
  };
  /** The account and its sub-accounts (parentId chain). */
  const subtree = (s: BookState, root: string) => {
    const out = new Set([root]);
    for (let grew = true; grew;) { grew = false; for (const a of s.accounts.values()) if (a.parentId && out.has(a.parentId) && !out.has(a.accountId)) { out.add(a.accountId); grew = true; } }
    return out;
  };

  const tool = <S extends z.ZodType>(name: string, title: string, description: string, schema: S, run: (a: z.infer<S>) => Promise<ToolResult>, tenantWide = false): ToolSpec => ({
    name, title, description, readOnly: true,
    inputSchema: z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
    async run(args) { await guard(name, tenantWide); return run(schema.parse(args ?? {})); },
  });

  const breakdown = async (nature: "income" | "expense", a: { from?: string; to?: string; account?: string }) => {
    const s = await state(), p = periodOf(s, a);
    const only = a.account ? subtree(s, accountOf(s, a.account)) : null;
    const rows = (await cell.reporting.monthly(T, B, p.from, p.to)).filter((r) => r.nature === nature && (!only || only.has(r.account_id)));
    const sign = nature === "income" ? -1n : 1n;
    const months = [...new Set(rows.map((r) => r.month))].sort();
    const by = new Map<string, Map<string, bigint>>();
    for (const r of rows) { const m = by.get(r.account_id) ?? new Map<string, bigint>(); m.set(r.month, (m.get(r.month) ?? 0n) + sign * r.net); by.set(r.account_id, m); }
    const totals = [...by.entries()].map(([id, m]) => ({ id, name: s.accounts.get(id)?.name ?? id, total: [...m.values()].reduce((x, y) => x + y, 0n), months: m }))
      .filter((x) => x.total !== 0n || [...x.months.values()].some((v) => v !== 0n)).sort((x, y) => (x.total > y.total ? -1 : x.total < y.total ? 1 : x.id.localeCompare(y.id)));
    const monthTotals = months.map((m) => [m, totals.reduce((x, t) => x + (t.months.get(m) ?? 0n), 0n)] as const);
    const grand = totals.reduce((x, t) => x + t.total, 0n);
    const word = nature === "income" ? "Income" : "Expenses";
    const summary = totals.length
      ? `${word} ${p.label}: ${rs(grand)} across ${totals.length} account(s)${totals[0] ? `; largest ${totals[0].name} ${rs(totals[0].total)}` : ""}.`
      : `No ${nature} recorded ${p.label.startsWith("FY") ? `in ${p.label}` : `from ${p.from} to ${p.to}`}.`;
    const sections: Section[] = [
      { title: `${word} by account`, kind: "table", columns: ["Account", "Name", "Total", "Share"], money: [2],
        rows: [...totals.map((t) => [t.id, t.name, t.total.toString(), grand !== 0n ? `${(Number((t.total * 1000n) / grand) / 10).toFixed(1)}%` : ""]), ["", "Total", grand.toString(), ""]] },
      { title: `${word} by month`, kind: "table", columns: ["Month", ...totals.slice(0, 6).map((t) => t.id), "Total"], money: [...totals.slice(0, 6).map((_, i) => i + 1), Math.min(totals.length, 6) + 1],
        rows: monthTotals.map(([m, v]) => [m, ...totals.slice(0, 6).map((t) => (t.months.get(m) ?? 0n).toString()), v.toString()]) },
    ];
    const data = { nature, from: p.from, to: p.to, label: p.label, total: grand.toString(),
      accounts: totals.map((t) => ({ accountId: t.id, name: t.name, total: t.total.toString(), months: Object.fromEntries([...t.months].map(([m, v]) => [m, v.toString()])) })),
      months: monthTotals.map(([m, v]) => ({ month: m, total: v.toString() })) };
    // Fragment: the by-month table shows the top 6 accounts only; the by-account table, the month totals and the grand total cover every account.
    const shown = Math.min(totals.length, 6);
    const c: Completeness = totals.length > 6 ? { complete: false, returned: shown, total: totals.length, truncatedBy: "top_n" } : whole(totals.length);
    return answer(readCard(who, `${nature}_breakdown`, `${word} · ${p.label}`, summary, sections, data, [["Income & expenses", `/reports/profit-and-loss?from=${p.from}&to=${p.to}`]]), data,
      c, "accounts", totals.length > 6 ? " in the by-month table (the largest 6; the by-account table and the totals cover all accounts)" : "",
      [grand, ...totals.map((t) => t.total), ...monthTotals.map(([, v]) => v)]);
  };

  return [
    tool("kuber_chart_of_accounts", "Chart of accounts",
      "The chart of accounts as a tree: id, name, category (asset, liability, equity, income, expense), the statement it maps to (balance sheet or P&L) and its reporting tag, control and cash flags, whether it is closed, and its balance.",
      z.object({ category: z.enum(["asset", "liability", "equity", "income", "expense"]).optional() }),
      async (a) => {
        const s = await state(), bal = balancesFromState(s);
        const all = [...s.accounts.values()].filter((x) => !a.category || x.nature === a.category);
        const kids = new Map<string | undefined, typeof all>();
        for (const x of all) { const p = x.parentId && all.some((y) => y.accountId === x.parentId) ? x.parentId : undefined; kids.set(p, [...(kids.get(p) ?? []), x]); }
        const ordered: { acc: (typeof all)[number]; depth: number }[] = [];
        const walk = (parent: string | undefined, depth: number) => {
          for (const x of (kids.get(parent) ?? []).sort((m, n) => NATURE_ORDER.indexOf(m.nature) - NATURE_ORDER.indexOf(n.nature) || m.accountId.localeCompare(n.accountId))) {
            ordered.push({ acc: x, depth }); walk(x.accountId, depth + 1);
          }
        };
        walk(undefined, 0);
        const rows = ordered.map(({ acc, depth }) => [`${"· ".repeat(depth)}${acc.accountId}`, acc.name, acc.nature, ["income", "expense"].includes(acc.nature) ? "P&L" : "Balance sheet",
          acc.taxonomyTag ?? "", s.closed.has(acc.accountId) ? "closed" : "", natural(acc.nature, bal.get(acc.accountId) ?? 0n).toString()]);
        const count = (n: string) => all.filter((x) => x.nature === n).length;
        const closed = all.filter((x) => s.closed.has(x.accountId)).length;
        const summary = `${all.length} accounts: ${NATURE_ORDER.map((n) => `${count(n)} ${n}`).join(", ")}${closed ? `; ${closed} closed` : ""}.`;
        const data = ordered.map(({ acc, depth }) => ({ accountId: acc.accountId, name: acc.name, nature: acc.nature, parentId: acc.parentId ?? null, depth,
          statement: ["income", "expense"].includes(acc.nature) ? "profit-and-loss" : "balance-sheet", taxonomyTag: acc.taxonomyTag ?? null,
          isControl: acc.isControl, isCashLike: acc.isCashLike, closed: s.closed.has(acc.accountId), balance: natural(acc.nature, bal.get(acc.accountId) ?? 0n).toString() }));
        return answer(readCard(who, "chart_of_accounts", "Chart of accounts", summary,
          [{ title: "Accounts", kind: "table", columns: ["Account", "Name", "Category", "Statement", "Mapping", "Closed", "Balance"], money: [6], rows }], data,
          [["Ledger", "/ledger"]], ["Balances are in each account's natural sign (debit for assets and expenses, credit for the rest)."]), data, whole(ordered.length), a.category ? `${a.category} accounts` : "accounts");
      }),

    tool("kuber_trial_balance", "Trial balance", "Trial balance as of a date (default today): every account with a balance, debit or credit, and the totals, which must agree.",
      z.object({ asOf: IsoDate.optional() }),
      async (a) => {
        const st = await cell.reporting.trialBalance(T, B, a.asOf ?? null);
        const rows = st.rows.map((r) => [r.label.replace(/\s+\((Dr|Cr)\)$/, ""), r.section === "Dr" ? r.amount.toString() : "", r.section === "Cr" ? r.amount.toString() : ""]);
        const t = st.totals;
        const summary = Object.entries(t).map(([k, v]) => `${k}: ${rs(v)}`).join(" · ");
        const data = { asOf: a.asOf ?? null, rows: st.rows.map((r) => ({ ...r, amount: r.amount.toString() })), totals: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.toString()])) };
        return answer(readCard(who, "trial_balance", st.title, summary, [{ title: "Trial balance", kind: "table", columns: ["Account", "Debit", "Credit"], money: [1, 2],
          rows: [...rows, ["Total", (t["Total debits"] ?? 0n).toString(), (t["Total credits"] ?? 0n).toString()]] }], data,
          [["Open full report", `/reports/trial-balance${a.asOf ? `?to=${a.asOf}` : ""}`]]), data, ...lagOr(statementCompleteness(st, rows.length), "accounts"));
      }),

    tool("kuber_profit_and_loss", "Profit and loss", "Income, expenses and surplus for a period (default: the book's fiscal year). Closed years still show what they earned and spent.",
      z.object(Period),
      async (a) => {
        const s = await state(), p = periodOf(s, a);
        const st = await cell.reporting.profitAndLoss(T, B, p.from, p.to);
        const summary = Object.entries(st.totals).map(([k, v]) => `${k}: ${rs(v)}`).join(" · ");
        const data = { from: p.from, to: p.to, label: p.label, rows: st.rows.map((r) => ({ ...r, amount: r.amount.toString() })), totals: Object.fromEntries(Object.entries(st.totals).map(([k, v]) => [k, v.toString()])) };
        return answer(readCard(who, "profit_and_loss", `Profit and loss · ${p.label}`, summary, [{ title: "Profit and loss", kind: "table", columns: ["Line", "Amount"], money: [1],
          rows: [...st.rows.map((r) => [r.label, r.amount.toString()]), ...Object.entries(st.totals).map(([k, v]) => [k, v.toString()])] }], data,
          [["Open full report", `/reports/profit-and-loss?from=${p.from}&to=${p.to}`]]), data, ...lagOr(statementCompleteness(st, st.rows.length), "lines"));
      }),

    tool("kuber_balance_sheet", "Balance sheet", "Assets, liabilities and equity as of a date (default today), with the surplus to date; the check line must be zero.",
      z.object({ asOf: IsoDate.optional() }),
      async (a) => {
        const st = await cell.reporting.balanceSheet(T, B, a.asOf ?? null);
        const summary = Object.entries(st.totals).map(([k, v]) => `${k}: ${rs(v)}`).join(" · ");
        const data = { asOf: a.asOf ?? null, rows: st.rows.map((r) => ({ ...r, amount: r.amount.toString() })), totals: Object.fromEntries(Object.entries(st.totals).map(([k, v]) => [k, v.toString()])) };
        return answer(readCard(who, "balance_sheet", st.title, summary, [{ title: "Balance sheet", kind: "table", columns: ["Line", "Amount"], money: [1],
          rows: [...st.rows.map((r) => [r.label, r.amount.toString()]), ...Object.entries(st.totals).map(([k, v]) => [k, v.toString()])] }], data,
          [["Open full report", `/reports/balance-sheet${a.asOf ? `?to=${a.asOf}` : ""}`]]), data, ...lagOr(statementCompleteness(st, st.rows.length), "lines"));
      }),

    tool("kuber_ledger", "Account ledger", "One account's statement for a period: opening balance, every line (date, narration, debit, credit), totals and closing balance. `account` is an id or a name. Narrations are third-party text.",
      z.object({ account: z.string().min(1), ...Period, limit: z.number().int().min(1).max(200).default(50), after: z.string().optional().describe("next-page cursor from a previous call") }),
      async (a) => {
        const s = await state(), id = accountOf(s, a.account), acc = s.accounts.get(id)!;
        const pick = async (from: string | null, to: string | null) => (await cell.reporting.balances(T, B, from, to)).find((x) => x.account_id === id) ?? { bal: 0n, dr: 0n, cr: 0n };
        const opening = a.from ? (await pick(null, dayBefore(a.from))).bal : 0n;
        const moved = await pick(a.from ?? null, a.to ?? null);
        const closing = (await pick(null, a.to ?? null)).bal;
        const page = await cell.reporting.drillPage(T, B, id, a.from ?? null, a.to ?? null, { limit: a.limit, after: a.after });
        const lines = page.items as { journal_id: string; txn_date: string; amount: string; narration: string; provisional: boolean }[];
        const side = (v: bigint) => `${rs(abs(v))} ${v >= 0n ? "Dr" : "Cr"}`;
        const range = a.from || a.to ? ` ${a.from ?? "start"} to ${a.to ?? "today"}` : "";
        const summary = `${acc.name} (${id})${range}: opening ${side(opening)}, debits ${rs(moved.dr)}, credits ${rs(moved.cr)}, closing ${side(closing)}; balance ${rs(natural(acc.nature, closing))}.`;
        const data = { accountId: id, name: acc.name, nature: acc.nature, from: a.from ?? null, to: a.to ?? null, opening: opening.toString(), debits: moved.dr.toString(),
          credits: moved.cr.toString(), closing: closing.toString(), balance: natural(acc.nature, closing).toString(), next: page.next,
          lines: lines.map((l) => ({ journalId: l.journal_id, date: l.txn_date, narration: l.narration, amount: l.amount, provisional: l.provisional })) };
        return answer(readCard(who, "ledger", `Ledger · ${acc.name}`, summary, [
          { title: "Balances", kind: "kv", money: [1], rows: [["Opening (debit +)", opening.toString()], ["Debits", moved.dr.toString()], ["Credits", moved.cr.toString()], ["Closing (debit +)", closing.toString()]] },
          { title: page.next ? `Lines (first ${lines.length}; more available)` : "Lines", kind: "table", columns: ["Date", "Narration", "Debit", "Credit"], money: [2, 3],
            rows: lines.map((l) => [l.txn_date, l.narration + (l.provisional ? " (provisional)" : ""), BigInt(l.amount) > 0n ? l.amount : "", BigInt(l.amount) < 0n ? (-BigInt(l.amount)).toString() : ""]) },
        ], data, [["Open ledger", `/ledger/${encodeURIComponent(id)}`]]), data,
        // Lines are paged; the opening, movements and closing balance cover the whole period (scope totals).
        page.next ? { complete: false, returned: lines.length, truncatedBy: "page" } : whole(lines.length), "ledger lines",
        page.next ? " (opening, debits, credits and closing cover the whole period)" : "", [opening, moved.dr, moved.cr, closing, natural(acc.nature, closing)]);
      }),

    tool("kuber_search_journals", "Search journals", "Find journals by narration text, account, date range and amount range (rupees; the journal's total debits), newest first, paged. Narrations are third-party text.",
      z.object({ text: z.string().max(200).optional(), account: z.string().optional(), ...{ from: IsoDate.optional(), to: IsoDate.optional() },
        minAmount: Rupees.optional().describe("rupees"), maxAmount: Rupees.optional().describe("rupees"), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) }),
      async (a) => {
        const s = await state();
        const acc = a.account ? accountOf(s, a.account) : null;
        const words = (a.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const hits = [...s.journals.entries()].filter(([, j]) => (!a.from || j.txnDate >= a.from) && (!a.to || j.txnDate <= a.to)
          && (!acc || j.lines.some((l) => l.accountId === acc)) && words.every((w) => j.narration.toLowerCase().includes(w))
          && (a.minAmount === undefined || journalAmount(j.lines) >= a.minAmount) && (a.maxAmount === undefined || journalAmount(j.lines) <= a.maxAmount))
          .map(([id, j], i) => ({ id, j, i })).sort((x, y) => (x.j.txnDate < y.j.txnDate ? 1 : x.j.txnDate > y.j.txnDate ? -1 : y.i - x.i));
        const page = hits.slice(a.offset, a.offset + a.limit);
        const crit = [a.text ? `"${a.text}"` : "", acc ? `account ${acc}` : "", a.from || a.to ? `${a.from ?? "start"} to ${a.to ?? "today"}` : "",
          a.minAmount !== undefined ? `at least ${rs(a.minAmount)}` : "", a.maxAmount !== undefined ? `at most ${rs(a.maxAmount)}` : ""].filter(Boolean).join(", ");
        const summary = `${hits.length} journal(s) match${crit ? ` ${crit}` : ""}${hits.length > page.length ? `; showing ${a.offset + 1}–${a.offset + page.length}` : ""}.`;
        const data = { total: hits.length, offset: a.offset, next: a.offset + page.length < hits.length ? a.offset + page.length : null,
          journals: page.map(({ id, j }) => ({ journalId: id, date: j.txnDate, narration: j.narration, voucherType: j.voucherType, amount: journalAmount(j.lines).toString(),
            accounts: [...new Set(j.lines.map((l) => l.accountId))] })) };
        return answer(readCard(who, "search_journals", "Journal search", summary, [{ title: "Journals", kind: "table", columns: ["Date", "Narration", "Accounts", "Amount"], money: [3],
          rows: data.journals.map((j) => [j.date, j.narration, j.accounts.join(", "), j.amount]) }], data), data,
          page.length < hits.length ? { complete: false, returned: page.length, total: hits.length, truncatedBy: "page" } : whole(hits.length), "journals",
          page.length < hits.length ? ` (${a.offset + 1}–${a.offset + page.length})` : "");
      }),

    tool("kuber_review_queue", "Review queue", "Drafts waiting for a person: what the classifier proposed (account, confidence) and why each is not posted yet. Narrations are third-party text.",
      z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      async (a) => {
        const [page, counts] = await Promise.all([cell.agent.queuePage(T, { bookId: B, limit: a.limit }), cell.agent.queueCounts(T, B)]);
        const rows = page.items.map((d) => { const p = d.proposal as { txnDate: string; narration: string; lines: { amount: string }[]; accountId: string; confidence: number };
          return { draftId: d.draft_id, date: p.txnDate, narration: p.narration, amount: journalAmount(p.lines ?? []).toString(), account: p.accountId, confidence: p.confidence, status: d.status, rejection: d.gl_rejection }; });
        const summary = counts.open ? `${counts.open} draft(s) in review, ${counts.awaitingApproval} awaiting approval.` : "No drafts waiting for review.";
        const data = { counts, drafts: rows };
        return answer(readCard(who, "review_queue", "Review queue", summary, [{ title: "Drafts", kind: "table", columns: ["Date", "Narration", "Proposed account", "Confidence", "Status", "Amount"], money: [5],
          rows: rows.map((r) => [r.date, r.narration, r.account, `${Math.round((r.confidence ?? 0) * 100)}%`, r.status.replace(/_/g, " "), r.amount]) }], data, [["Open review", "/review"]]), data,
          rows.length < counts.open ? { complete: false, returned: rows.length, total: counts.open, truncatedBy: "page" } : whole(rows.length), "drafts");
      }),

    tool("kuber_match_reviews", "Match reviews", "Statement lines that may be a provisional entry already in the books, waiting for a person to link or separate them. Narrations are third-party text.",
      z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      async (a) => {
        const page = await cell.agent.matchReviewsPage(T, { bookIds: [B], limit: a.limit });
        const rows = page.items.map((m) => ({ reviewId: m.review_id, date: m.detail.txnDate, narration: m.detail.narration, direction: m.detail.direction, amount: String(m.detail.amount),
          instrument: m.detail.instrument, reason: m.detail.reason, candidates: m.candidates }));
        const summary = rows.length ? `${rows.length}${page.next ? "+" : ""} statement line(s) to match against provisional entries.` : "No match reviews open.";
        const data = { reviews: rows, next: page.next };
        return answer(readCard(who, "match_reviews", "Match reviews", summary, [{ title: "To match", kind: "table", columns: ["Date", "Narration", "In/out", "Candidates", "Amount"], money: [4],
          rows: rows.map((r) => [r.date, r.narration, r.direction, r.candidates.length, r.amount]) }], data, [["Open review", "/review"]]), data,
          page.next ? { complete: false, returned: rows.length, truncatedBy: "page" } : whole(rows.length), "statement lines");
      }),

    tool("kuber_income_breakdown", "Income breakdown", "Sales, revenue and other income by account and by month for a period (default: the fiscal year). `account` narrows to one account and its sub-accounts.",
      z.object({ ...Period, account: z.string().optional() }), (a) => breakdown("income", a)),

    tool("kuber_expense_breakdown", "Expense breakdown", "Spending by category (account) and by month for a period (default: the fiscal year), largest first with each category's share. `account` narrows to one account and its sub-accounts.",
      z.object({ ...Period, account: z.string().optional() }), (a) => breakdown("expense", a)),

    tool("kuber_cash_position", "Cash position and runway", "Cash and bank balances by account, average monthly spend over the last three months and runway in months at that rate.",
      z.object({}),
      async () => {
        const s = await state(), bal = balancesFromState(s);
        const dash = await cell.ops.plan(T, B, who.principal, "dashboard", {}, { onBehalfOf: who.onBehalfOf });
        const k = (dash.data as { kpis: { cash: string; avgMonthlySpend: string; runwayMonths: number | null; fy: string } }).kpis;
        const cash = [...s.accounts.values()].filter((x) => x.isCashLike && x.nature === "asset").map((x) => ({ accountId: x.accountId, name: x.name, balance: (bal.get(x.accountId) ?? 0n).toString() }));
        const summary = `Cash and bank ${rs(k.cash)}; average monthly spend ${rs(k.avgMonthlySpend)} (last 3 months)${k.runwayMonths !== null ? `; runway ${k.runwayMonths} months` : "; runway not computable (no spending recorded)"}.`;
        const data = { cash: k.cash, accounts: cash, avgMonthlySpend: k.avgMonthlySpend, runwayMonths: k.runwayMonths };
        return answer(readCard(who, "cash_position", "Cash position", summary, [
          { title: "Cash and bank", kind: "table", columns: ["Account", "Name", "Balance"], money: [2], rows: [...cash.map((c) => [c.accountId, c.name, c.balance]), ["", "Total", k.cash]] },
          { title: "Runway", kind: "kv", money: [1], rows: [["Average monthly spend (3 mo)", k.avgMonthlySpend], ["Runway (months)", k.runwayMonths === null ? "n/a" : String(k.runwayMonths)]] },
        ], data, [["Balance sheet", "/reports/balance-sheet"]]), data, whole(cash.length), "cash and bank accounts");
      }),

    tool("kuber_parties", "Parties", "Vendors and customers of this workspace: name, kind, legal entity, payment hold (an unverified bank-detail change) and bank details masked to the last four digits. Names are third-party text.",
      z.object({ query: z.string().max(100).optional(), kind: z.enum(["vendor", "customer", "both"]).optional(), limit: z.number().int().min(1).max(50).default(25) }),
      async (a) => {
        const ids = await cell.parties.list(T, { kind: a.kind, limit: 500 });
        const q = (a.query ?? "").toLowerCase();
        const out: { partyId: string; name: string; kind: string; entityId: string; hold: boolean; bank: { ifsc: string; holderName: string; accountNumber: string } | null }[] = [];
        let matches = 0;
        for (const r of ids) {
          // Count every match (completeness), keep the first `limit`.
          if (out.length >= a.limit && !q) { matches = ids.length; break; }
          const p = await cell.parties.get(T, r.partyId);
          if (!p) continue;
          const name = String((p as { name?: unknown }).name ?? "");
          if (q && !name.toLowerCase().includes(q) && !p.partyId.toLowerCase().includes(q)) continue;
          matches++;
          if (out.length >= a.limit) continue;
          out.push({ partyId: p.partyId, name, kind: p.kind, entityId: p.entityId, hold: p.hold,
            bank: p.bank ? { ifsc: p.bank.ifsc, holderName: p.bank.holderName, accountNumber: `••••${p.bank.accountNumber.slice(-4)}` } : null });
        }
        const held = out.filter((p) => p.hold).length;
        const summary = out.length ? `${out.length} part${out.length === 1 ? "y" : "ies"}${q ? ` matching "${a.query}"` : ""}${held ? `; ${held} on payment hold` : ""}.` : `No parties${q ? ` match "${a.query}"` : " registered"}.`;
        const data = { parties: out };
        return answer(readCard(who, "parties", "Parties", summary, [{ title: "Parties", kind: "table", columns: ["Party", "Name", "Kind", "Bank", "Hold"],
          rows: out.map((p) => [p.partyId, p.name, p.kind, p.bank ? `${p.bank.ifsc} ${p.bank.accountNumber}` : "", p.hold ? "on hold" : ""]) }], data, [],
          ["Bank account numbers are masked; the full details are never given to the agent."]), data,
          // The party master is listed up to 500 ids; beyond that the total is unknown (row limit).
          ids.length >= 500 ? { complete: false, returned: out.length, truncatedBy: "row_limit" }
            : out.length < Math.max(matches, out.length) ? { complete: false, returned: out.length, total: matches, truncatedBy: "page" } : whole(out.length), "parties");
      }, true),

    tool("kuber_policies", "Policy lookup", "Search the policy library (policies/*.md) by id (e.g. POL-501) or keywords (e.g. \"vendor bank change\"): each match's intent, autonomy level, approver, limits and rules. Without a query, lists every policy.",
      z.object({ query: z.string().max(200).optional() }),
      async (a) => {
        const lib = cell.policies.policies;
        const q = (a.query ?? "").trim();
        if (!q || /^(all|list|every|policy|policies|all policies)$/i.test(q)) {
          const data = { policies: lib.map((p) => ({ policyId: p.policyId, title: p.title, autonomy: p.autonomy, approver: p.approver, status: p.status })) };
          return answer(readCard(who, "policies", "Policy library", `${lib.length} policies; ask about one by id or topic for its rules.`,
            [{ title: "Policies", kind: "table", columns: ["Policy", "Title", "Autonomy", "Approver", "Status"], rows: lib.map((p) => [p.policyId, p.title, p.autonomy, p.approver, p.status]) }], data), data, whole(lib.length), "policies");
        }
        // Every policy id named ("POL-502 or POL-506?"), or a bare three-digit id.
        const ids = [...q.matchAll(/\bpol[-\s]?(\d{3})\b/gi)].map((m) => `POL-${m[1]}`);
        const bare = /^\s*(\d{3})\s*$/.exec(q);
        const idm = ids.length ? ids : bare ? [`POL-${bare[1]}`] : null;
        const STOP = new Set(["the", "a", "an", "for", "of", "on", "to", "is", "what", "whats", "policy", "policies", "rule", "rules", "about", "and", "in", "when", "how", "do", "we", "our", "my", "me", "tell"]);
        const words = q.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w) && w.length > 1).map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)) ?? [];
        const scored = idm ? lib.filter((p) => idm.includes(p.policyId)).map((p) => ({ p, score: 100 }))
          : lib.map((p) => { const title = p.title.toLowerCase(), body = p.body.toLowerCase(), ev = p.event.toLowerCase();
            return { p, score: words.reduce((sc, w) => sc + (title.includes(w) ? 3 : 0) + (ev.includes(w) ? 2 : 0) + (body.includes(w) ? 1 : 0), 0) }; })
            .filter((x) => x.score > 0).sort((x, y) => y.score - x.score || x.p.policyId.localeCompare(y.p.policyId));
        const top = scored.slice(0, 3).map(({ p }) => {
          const section = (h: string) => new RegExp(`##\\s*${h}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i").exec(p.body)?.[1]?.trim() ?? "";
          const bullets = (h: string) => section(h).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("-")).map((l) => l.replace(/^-\s*/, ""));
          return { policyId: p.policyId, title: p.title, event: p.event, autonomy: p.autonomy, approver: p.approver, amountLimitInr: p.amountLimitInr, status: p.status,
            effectiveFrom: p.effectiveFrom, summary: section("Intent").split("\n").filter(Boolean).join(" "), rules: [...bullets("Decision"), ...bullets("Checks")] };
        });
        // Competing context: when several policies are in view, say which prevails (the policy engine applies all that match an event, strictest autonomy wins).
        const precedence = top.length > 1 ? " Where more than one active policy applies to the same event, all apply and the strictest autonomy wins (POL-900); the policy engine decides, not the conversation." : "";
        const summary = top.length ? top.map((p) => `${p.policyId} ${p.title} (autonomy ${p.autonomy}): ${p.summary}`).join(" ") + precedence : `No policy matches "${q}".`;
        const data = { policies: top };
        return answer(readCard(who, "policies", top.length === 1 ? `${top[0]!.policyId} · ${top[0]!.title}` : "Policies", summary, top.flatMap((p) => [
          { title: `${p.policyId} · ${p.title}`, kind: "kv" as const, rows: [["Intent", p.summary], ["Event", p.event], ["Autonomy", p.autonomy], ["Approver", p.approver],
            ["Amount limit (₹)", p.amountLimitInr === null ? "none" : p.amountLimitInr.toLocaleString("en-IN")], ["Status", `${p.status}${p.effectiveFrom ? ` from ${p.effectiveFrom}` : ""}`]] },
          { title: "Rules", kind: "table" as const, columns: ["Rule"], rows: p.rules.map((r) => [r]) },
        ]), data), data, top.length < scored.length ? { complete: false, returned: top.length, total: scored.length, truncatedBy: "top_n" } : whole(top.length), "matching policies");
      }),

    tool("kuber_lifecycle", "Journal lifecycle", "Every entry's lifecycle state (draft, submitted, approved, posting, posted, failed) across drafts, plans, ledger rejections and schedule exceptions, with counts and failure reasons.",
      z.object({ state: z.string().optional().describe("only items in this state, e.g. failed") }),
      async (a) => {
        const l = await journalLifecycle(cell, T, B);
        const items = l.items.filter((i) => !a.state || i.state === a.state);
        const summary = Object.entries(l.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") || "No entries yet.";
        const recent = items.slice(-30).reverse();
        const data = { counts: l.counts, items: recent };
        return answer(readCard(who, "lifecycle", "Journal lifecycle", summary, [
          { title: "Counts", kind: "kv", rows: l.states.map((st) => [st, String(l.counts[st] ?? 0)]) },
          { title: a.state ? `Items: ${a.state}` : "Latest items", kind: "table", columns: ["Source", "State", "What", "Reason"],
            rows: recent.map((i) => [i.source, i.state, String((i as { title?: string; narration?: string }).title ?? (i as { narration?: string }).narration ?? i.id), String((i as { reason?: string | null }).reason ?? "")]) },
        ], data), data, items.length > recent.length ? { complete: false, returned: recent.length, total: items.length, truncatedBy: "row_limit" } : whole(items.length), "items",
          items.length > recent.length ? " (the latest; the counts cover every entry)" : "");
      }),

    tool("kuber_attention", "What needs attention", "What needs a person now: drafts in review and awaiting approval, postings to ratify, open plans, open suspense items and statement lines to match.",
      z.object({}),
      async () => {
        const p = person();
        let tenantWide = false;
        if (p && !/^(agent|system):/.test(p)) tenantWide = (await cell.identity.authorize(T, p, "read", { book: B })).books === null;
        const [c, suspense, matches] = await Promise.all([attentionCounts(cell, T, B, tenantWide), cell.agent.suspense.list(T, B, { status: "open" }),
          cell.agent.matchReviewsPage(T, { bookIds: [B], limit: 100 })]);
        const items: [string, string, string][] = [];
        if (c.drafts) items.push(["Drafts in review", String(c.drafts), "/review"]);
        if (c.awaitingApproval) items.push(["Drafts awaiting approval", String(c.awaitingApproval), "/review"]);
        if (c.ratifications) items.push(["Automatic postings to ratify", String(c.ratifications), "/review"]);
        if (c.plans) items.push(["Plans waiting for approval", String(c.plans), "/"]);
        if (suspense.length) items.push(["Open suspense items", String(suspense.length), "/"]);
        if (matches.items.length) items.push(["Statement lines to match", `${matches.items.length}${matches.next ? "+" : ""}`, "/review"]);
        if (c.closeTasksOverdue) items.push(["Close tasks overdue", String(c.closeTasksOverdue), "/close"]);
        const summary = items.length ? items.map(([k, n]) => `${k}: ${n}`).join("; ") + "." : "Nothing needs your attention right now.";
        const data = { ...c, suspense: suspense.length, matchReviews: matches.items.length };
        return answer(readCard(who, "attention", "What needs your attention", summary, [{ title: "Waiting for a person", kind: "kv", rows: items.length ? items.map(([k, n]) => [k, n]) : [["Nothing waiting", "0"]] }],
          data, items.some((i) => i[2] === "/review") ? [["Open review", "/review"]] : []), data,
          matches.next ? { complete: false, returned: items.length, truncatedBy: "row_limit" } : whole(items.length), "kinds of item", matches.next ? " (statement lines to match counted up to 100)" : "");
      }),
  ];
}
