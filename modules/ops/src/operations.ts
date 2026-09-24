/**
 * The operations. Each one reads the authoritative book state, computes what it would do and
 * returns a Draft. None of them writes: writing happens only in Operations.commit, after approval.
 *
 * Lifecycle coverage (mutually exclusive, collectively exhaustive for Phase 0):
 *   capture   - record
 *   commit    - post
 *   assure    - balance, reconcile
 *   distribute- allocate, rebalance
 *   period    - close, carry_forward
 *   insight   - report, simulate, dashboard
 */
import { z } from "zod";
import { IsoDate, parseAmount, stableId, type Line } from "@kuber/contracts";
import { validateJournal, type BookState } from "@kuber/gl";
import { balancesFromState, financialYear, latestTxnDate, openProvisional, pctToBp, rebalanceTransfers, splitByWeights } from "./math.ts";
import type { Action, Check, Draft, OpContext, OpDef, Section } from "./types.ts";

// ---------------------------------------------------------------- shared helpers
const Rupees = z.union([z.string(), z.number()]).transform((v, c) => {
  try { const p = parseAmount(String(v)); if (p <= 0n) throw new Error(); return p; }
  catch { c.addIssue({ code: "custom", message: `not a positive amount: ${v}` }); return z.NEVER; }
});
const AccountId = z.string().min(1).transform((s) => s.trim().toUpperCase());

const DEBIT_NORMAL = new Set(["asset", "expense"]);
const name = (s: BookState, id: string) => s.accounts.get(id)?.name ?? id;
const natural = (s: BookState, id: string, bal: bigint) => (DEBIT_NORMAL.has(s.accounts.get(id)?.nature ?? "asset") ? bal : -bal);
const rs = (p: bigint) => { const n = p < 0n ? -p : p; return `${p < 0n ? "-" : ""}₹${(n / 100n).toLocaleString("en-IN")}${n % 100n ? "." + String(n % 100n).padStart(2, "0") : ""}`; };

/** Deterministic journal id for the n-th journal of a plan: re-committing is a no-op. */
const jid = (ctx: OpContext, seed: string, n: number) => stableId("ops-journal", `${ctx.tenant}/${ctx.book}/${ctx.state.seq}/${seed}/${n}`);

function requireAccount(s: BookState, id: string, checks: Check[], role = "account") {
  const ok = s.accounts.has(id);
  checks.push({ label: `${role.charAt(0).toUpperCase()}${role.slice(1)} ${id} exists`, ok, blocking: true, detail: ok ? name(s, id) : `No account ${id} in this book` });
  return ok;
}

/** Validate a journal exactly as the ledger will at commit time (as the approving owner). */
function validates(s: BookState, date: string, lines: Line[], checks: Check[], label = "Ledger rules satisfied") {
  try { validateJournal(s, date, lines, "owner:approver"); checks.push({ label, ok: true, blocking: true }); return true; }
  catch (e) { checks.push({ label, ok: false, blocking: true, detail: e instanceof Error ? e.message : String(e) }); return false; }
}

const post = (journalId: string, txnDate: string, narration: string, lines: Line[], voucherType = "journal"): Action =>
  ({ type: "gl", command: { kind: "PostJournal", journalId, txnDate, narration, voucherType, lines, autonomy: "human" } });

/** Default date for transfers and allocations: never before the last posting already in the book. */
function asOfDefault(ctx: OpContext) {
  const last = latestTxnDate(ctx.state);
  return last !== null && last > ctx.today ? last : ctx.today;
}

function cashLike(s: BookState) { return [...s.accounts.values()].filter((a) => a.isCashLike && a.nature === "asset").map((a) => a.accountId); }

// ---------------------------------------------------------------- capture
const RecordInput = z.object({
  date: IsoDate.optional(),
  narration: z.string().min(2).max(200),
  amount: Rupees,
  direction: z.enum(["in", "out"]),
  account: AccountId.describe("where it belongs, e.g. LIVING, BIZEXP, SALARY, LOANS"),
  via: AccountId.default("BANK").describe("the money account: BANK, CASH or CARD"),
  dimensions: z.record(z.string(), z.string()).optional(),
});

export const record: OpDef<z.infer<typeof RecordInput>> = {
  name: "record", title: "Record a transaction", kind: "write", gate: "policy", event: "EVT-TXN-INGESTED",
  description: "Record money in or out: one amount, where it belongs, and which money account (bank, cash or card) it moved through. Returns the journal it would post; nothing is posted until committed.",
  input: RecordInput,
  async plan(ctx, i) {
    const s = ctx.state, checks: Check[] = [];
    const date = i.date ?? ctx.today;
    requireAccount(s, i.account, checks, "Category"); requireAccount(s, i.via, checks, "Money account");
    checks.push({ label: "Not the suspense account", ok: i.account !== "SUSPENSE", blocking: true });
    const dims = i.dimensions ?? {};
    const lines: Line[] = i.direction === "out"
      ? [{ accountId: i.account, amount: i.amount.toString(), dimensions: dims }, { accountId: i.via, amount: (-i.amount).toString(), dimensions: {} }]
      : [{ accountId: i.via, amount: i.amount.toString(), dimensions: {} }, { accountId: i.account, amount: (-i.amount).toString(), dimensions: dims }];
    if (checks.every((c) => c.ok)) validates(s, date, lines, checks);
    return {
      title: `${i.direction === "out" ? "Pay" : "Receive"} ${rs(i.amount)}`,
      summary: `${i.narration}: ${rs(i.amount)} ${i.direction === "out" ? "out of" : "into"} ${name(s, i.via)}, recorded as ${name(s, i.account)} on ${date}.`,
      actions: [post(jid(ctx, `record/${date}/${i.narration}/${i.amount}/${i.direction}/${i.account}/${i.via}`, 0), date, i.narration, lines)],
      checks, amountPaise: i.amount,
    };
  },
};

// ---------------------------------------------------------------- commit
const PostInput = z.object({
  draftIds: z.array(z.string()).optional().describe("specific drafts; omit to take every draft Kuber has classified"),
  minConfidence: z.number().min(0).max(1).default(0),
  overrides: z.record(z.string(), AccountId).optional().describe("draftId -> account, where you disagree with Kuber"),
});

interface DraftRow { draft_id: string; book_id: string; proposal: { txnDate: string; narration: string; accountId: string; confidence: number; amount: string; direction: "in" | "out"; lines: Line[] } }

export const postDrafts: OpDef<z.infer<typeof PostInput>> = {
  name: "post", title: "Post drafted entries", kind: "write", gate: "policy", event: "EVT-TXN-INGESTED",
  description: "Post entries Kuber drafted from statements, in bulk, as classified (or with per-draft account overrides). Unclassified drafts are left for a person to decide.",
  input: PostInput,
  async plan(ctx, i) {
    const s = ctx.state;
    const all = await ctx.svc.agent.queue(ctx.tenant, { bookId: ctx.book }) as unknown as DraftRow[];
    const picked = all.filter((d) => (!i.draftIds || i.draftIds.includes(d.draft_id)) && d.proposal.confidence >= i.minConfidence);
    const actions: Action[] = [], skipped: DraftRow[] = [];
    let max = 0n;
    const rows: Section["rows"] = [];
    for (const d of picked) {
      const acc = i.overrides?.[d.draft_id] ?? d.proposal.accountId;
      if (acc === "SUSPENSE" || !s.accounts.has(acc)) { skipped.push(d); continue; }
      actions.push({ type: "approveDraft", draftId: d.draft_id, accountId: acc });
      const amt = BigInt(d.proposal.amount); if (amt > max) max = amt;
      rows.push([d.proposal.txnDate, d.proposal.narration, name(s, acc), (d.proposal.direction === "out" ? -amt : amt).toString()]);
    }
    const checks: Check[] = [
      { label: "Something to post", ok: actions.length > 0, blocking: true, detail: `${actions.length} of ${all.length} drafts` },
      { label: "Every posted draft has a category", ok: true, blocking: false, detail: skipped.length ? `${skipped.length} unclassified left for you` : undefined },
    ];
    return {
      title: `Post ${actions.length} ${actions.length === 1 ? "entry" : "entries"}`,
      summary: `${actions.length} drafted ${actions.length === 1 ? "entry" : "entries"} will be posted as classified${skipped.length ? `; ${skipped.length} unclassified stay in Review` : ""}.`,
      actions, checks, amountPaise: max,
      sections: [{ title: "Entries", kind: "table", columns: ["Date", "Narration", "Recorded as", "Amount"], rows, money: [3] }],
      links: skipped.length ? [["Decide the unclassified ones", "/review"]] : [],
      // Drafts post through the agent (bus -> GL); effects come from their proposed lines.
      data: { journalsFromDrafts: picked.filter((d) => !skipped.includes(d)).map((d) => {
        const acc = i.overrides?.[d.draft_id] ?? d.proposal.accountId;
        return { txnDate: d.proposal.txnDate, narration: d.proposal.narration,
          lines: d.proposal.lines.map((l) => (l.accountId === d.proposal.accountId ? { ...l, accountId: acc } : l)) };
      }) },
    };
  },
};

// ---------------------------------------------------------------- assure
export const balance: OpDef<{ asOf?: string }> = {
  name: "balance", title: "Check the books balance", kind: "read", gate: "policy",
  description: "Prove the books are in order: debits equal credits, the hash chain is intact, nothing is stuck in suspense, reports are current, and list what is still open.",
  input: z.object({ asOf: IsoDate.optional() }),
  async plan(ctx, i) {
    const s = ctx.state;
    const b = balancesFromState(s, { to: i.asOf });
    let dr = 0n, cr = 0n;
    for (const v of b.values()) if (v > 0n) dr += v; else cr -= v;
    const chain = await ctx.svc.gl.verifyDetail(ctx.tenant, ctx.book);          // from the last verified checkpoint
    const broken = chain.broken;
    const pos = await ctx.svc.reporting.position(ctx.tenant, ctx.book);
    const drafts = (await ctx.svc.agent.queueCounts(ctx.tenant, ctx.book)).open;   // counts: nothing decrypted
    const ratifs = await ctx.svc.agent.openRatificationCount(ctx.tenant);
    const suspense = b.get("SUSPENSE") ?? 0n;
    const provisional = [...openProvisional(s)].filter(([, j]) => !i.asOf || j.txnDate <= i.asOf).length;
    const checks: Check[] = [
      { label: "Debits equal credits", ok: dr === cr, blocking: true, detail: `${rs(dr)} each side` },
      { label: "Hash chain intact", ok: broken === null, blocking: true, detail: broken ? `broken at ${broken}` : `${s.seq} journals; ${chain.events} new event(s) verified since the last check` },
      { label: "Nothing in suspense", ok: suspense === 0n, blocking: false, detail: suspense ? rs(suspense) : undefined },
      { label: "Reports up to date", ok: pos.seq === s.seq, blocking: false, detail: pos.seq === s.seq ? undefined : `reports at ${pos.seq} of ${s.seq}; catching up` },
      { label: "No drafts waiting", ok: drafts === 0, blocking: false, detail: drafts ? `${drafts} waiting` : undefined },
      { label: "No automatic postings to confirm", ok: ratifs === 0, blocking: false, detail: ratifs ? `${ratifs} to confirm` : undefined },
      { label: "No entries awaiting a statement", ok: provisional === 0, blocking: false, detail: provisional ? `${provisional} provisional` : undefined },
    ];
    const allOk = checks.every((c) => c.ok);
    return {
      title: allOk ? "Books are in order" : checks.some((c) => !c.ok && c.blocking) ? "Books are out of balance" : "Books balance; some items are open",
      summary: `Trial balance ${dr === cr ? "agrees" : "does not agree"} at ${rs(dr)}; ${checks.filter((c) => !c.ok).length} open item(s).`,
      actions: [], checks,
      links: [["Trial balance", "/reports/trial-balance"], ...(drafts ? [["Review drafts", "/review"] as [string, string]] : [])],
    };
  },
};

const ReconcileInput = z.object({
  account: AccountId.default("BANK"),
  statementBalance: z.union([z.string(), z.number()]).transform((v) => parseAmount(String(v))).describe("closing balance on the bank or card statement"),
  asOf: IsoDate,
  adjustTo: AccountId.optional().describe("account for an unexplained difference, e.g. BIZEXP for bank charges, OTHINC for interest"),
});

export const reconcile: OpDef<z.infer<typeof ReconcileInput>> = {
  name: "reconcile", title: "Reconcile an account", kind: "write", gate: "policy", event: "EVT-BANK-STATEMENT-RECEIVED",
  description: "Reconcile a bank, cash or card account to its statement closing balance: explains the difference by entries not yet in the statement and statement lines not yet in the books, and optionally posts an adjustment for any unexplained remainder.",
  input: ReconcileInput,
  async plan(ctx, i) {
    const s = ctx.state, checks: Check[] = [];
    if (!requireAccount(s, i.account, checks)) return { title: "Cannot reconcile", summary: `No account ${i.account}.`, actions: [], checks };
    const liability = s.accounts.get(i.account)!.nature === "liability";
    const books = natural(s, i.account, balancesFromState(s, { to: i.asOf }).get(i.account) ?? 0n);
    // In the books, not yet on the statement: provisional entries (entered by hand or chat).
    const inBooks = [...openProvisional(s)].filter(([, j]) => j.txnDate <= i.asOf)
      .map(([id, j]) => ({ id, j, amt: natural(s, i.account, j.lines.filter((l) => l.accountId === i.account).reduce((a, l) => a + BigInt(l.amount), 0n)) }))
      .filter((x) => x.amt !== 0n);
    // On the statement, not yet in the books: drafts from this instrument awaiting a decision.
    const drafts = (await ctx.svc.agent.queue(ctx.tenant, { bookId: ctx.book }) as unknown as DraftRow[]).filter((d) => d.proposal.txnDate <= i.asOf)
      .map((d) => ({ d, amt: natural(s, i.account, d.proposal.lines.filter((l) => l.accountId === i.account).reduce((a, l) => a + BigInt(l.amount), 0n)) }))
      .filter((x) => x.amt !== 0n);
    // Also on the statement, not yet in the books: lines waiting for a person to say whether they are a provisional entry.
    const matches = (await ctx.svc.agent.openMatchReviews(ctx.tenant)).filter((m) => m.book_id === ctx.book && m.detail.instrument === i.account && m.detail.txnDate <= i.asOf)
      .map((m) => ({ d: { proposal: { txnDate: m.detail.txnDate, narration: `${m.detail.narration} (match review)` } } as DraftRow,
        amt: natural(s, i.account, BigInt(m.detail.amount) * (m.detail.direction === "in" ? 1n : -1n)) }));
    drafts.push(...matches);
    const expected = books - inBooks.reduce((a, x) => a + x.amt, 0n) + drafts.reduce((a, x) => a + x.amt, 0n);
    const diff = i.statementBalance - expected;
    const actions: Action[] = [];
    checks.push({ label: "Statement agrees with the books after timing items", ok: diff === 0n, blocking: false, detail: diff ? `unexplained ${rs(diff)}` : "fully explained" });
    if (diff !== 0n && i.adjustTo) {
      if (requireAccount(s, i.adjustTo, checks, "Adjustment account")) {
        // Raise (or lower) the money account by the difference in its natural direction.
        const onAccount = liability ? -diff : diff;
        const lines: Line[] = [{ accountId: i.account, amount: onAccount.toString(), dimensions: {} }, { accountId: i.adjustTo, amount: (-onAccount).toString(), dimensions: {} }];
        if (validates(s, i.asOf, lines, checks)) actions.push(post(jid(ctx, `reconcile/${i.account}/${i.asOf}/${diff}`, 0), i.asOf, `Reconciliation adjustment ${i.account} to statement ${i.asOf}`, lines));
      }
    }
    const sections: Section[] = [
      { title: "Reconciliation", kind: "kv", rows: [
        ["Balance per books", books.toString()],
        ["Less: in books, not yet on statement", (-inBooks.reduce((a, x) => a + x.amt, 0n)).toString()],
        ["Add: on statement, not yet in books", drafts.reduce((a, x) => a + x.amt, 0n).toString()],
        ["Expected statement balance", expected.toString()],
        ["Statement balance", i.statementBalance.toString()],
        ["Unexplained difference", diff.toString()]], money: [1] },
    ];
    if (inBooks.length || drafts.length) sections.push({ title: "Timing items", kind: "table", columns: ["Date", "Item", "Side", "Amount"], money: [3],
      rows: [...inBooks.map((x) => [x.j.txnDate, x.j.narration, "Books only", x.amt.toString()]), ...drafts.map((x) => [x.d.proposal.txnDate, x.d.proposal.narration, "Statement only", x.amt.toString()])] });
    return {
      title: diff === 0n ? `${name(s, i.account)} reconciles` : `${name(s, i.account)} is off by ${rs(diff)}`,
      summary: diff === 0n
        ? `Statement ${rs(i.statementBalance)} agrees with the books as of ${i.asOf} after ${inBooks.length + drafts.length} timing item(s). Committing records the sign-off.`
        : `Statement ${rs(i.statementBalance)} vs expected ${rs(expected)}.${i.adjustTo ? ` An adjustment to ${name(s, i.adjustTo)} is proposed.` : " Name an account to adjust, or find the missing entry."}`,
      actions, checks, sections, amountPaise: diff < 0n ? -diff : diff,
      links: drafts.length ? [["Review statement lines", "/review"]] : [],
    };
  },
};

// ---------------------------------------------------------------- distribute
const AllocateInput = z.object({
  from: AccountId,
  amount: Rupees.optional().describe("defaults to the account's movement in the period"),
  period: z.object({ from: IsoDate, to: IsoDate }).optional(),
  date: IsoDate.optional(),
  to: z.array(z.object({
    account: AccountId, weight: z.union([z.string(), z.number()]).describe("share, e.g. 60 or 33.33"),
    dimensions: z.record(z.string(), z.string()).optional().describe("e.g. { costCentre: 'Chennai' }"),
  })).min(1),
  narration: z.string().optional(),
});

export const allocate: OpDef<z.infer<typeof AllocateInput>> = {
  name: "allocate", title: "Allocate an amount", kind: "write", gate: "human", event: "EVT-ANY",
  description: "Split an amount (or an account's movement for a period) across accounts, cost centres or projects by weights. Parts always sum exactly to the total (largest-remainder rounding to the paisa).",
  input: AllocateInput,
  async plan(ctx, i) {
    const s = ctx.state, checks: Check[] = [];
    const date = i.date ?? i.period?.to ?? asOfDefault(ctx);
    requireAccount(s, i.from, checks, "Source account");
    i.to.forEach((t) => requireAccount(s, t.account, checks, "Target account"));
    if (!checks.every((c) => c.ok)) return { title: "Cannot allocate", summary: "Unknown account.", actions: [], checks };
    const movement = balancesFromState(s, { from: i.period?.from, to: i.period?.to ?? date, excludeVoucher: "closing" }).get(i.from) ?? 0n;
    const total = i.amount ? (movement < 0n ? -i.amount : i.amount) : movement;   // keep the account's own sign
    checks.push({ label: "Something to allocate", ok: total !== 0n, blocking: true, detail: rs(total) });
    const natures = new Set([i.from, ...i.to.map((t) => t.account)].map((a) => s.accounts.get(a)!.nature));
    checks.push({ label: "Source and targets share a nature", ok: natures.size === 1, blocking: false, detail: natures.size > 1 ? "mixing natures moves amounts between statements" : undefined });
    if (total === 0n) return { title: "Nothing to allocate", summary: `${name(s, i.from)} has no movement to allocate.`, actions: [], checks };
    const weights = i.to.map((t) => pctToBp(t.weight));
    const parts = splitByWeights(total, weights);
    const lines: Line[] = [{ accountId: i.from, amount: (-total).toString(), dimensions: {} },
      ...i.to.map((t, k) => ({ accountId: t.account, amount: parts[k]!.toString(), dimensions: t.dimensions ?? {} }))].filter((l) => l.amount !== "0");
    validates(s, date, lines, checks);
    const narration = i.narration ?? `Allocation of ${name(s, i.from)}${i.period ? ` ${i.period.from} to ${i.period.to}` : ""}`;
    const wsum = weights.reduce((a, b) => a + b, 0n);
    return {
      title: `Allocate ${rs(total < 0n ? -total : total)} from ${name(s, i.from)}`,
      summary: `${i.to.length} part(s) by weight; rounding differences go to the largest remainders so the parts sum exactly.`,
      actions: [post(jid(ctx, `allocate/${i.from}/${total}/${JSON.stringify(i.to)}`, 0), date, narration, lines, "allocation")], checks,
      amountPaise: total < 0n ? -total : total,
      sections: [{ title: "Split", kind: "table", columns: ["To", "Dimensions", "Share", "Amount"], money: [3],
        rows: i.to.map((t, k) => [name(s, t.account), Object.entries(t.dimensions ?? {}).map(([a, b]) => `${a}: ${b}`).join(", ") || "—",
          `${(Number(weights[k]! * 10000n / wsum) / 100).toFixed(2)}%`, parts[k]!.toString()]) }],
    };
  },
};

const RebalanceInput = z.object({
  targets: z.array(z.object({ account: AccountId, pct: z.union([z.string(), z.number()]) })).min(2).describe("asset accounts and their target share of the pool; must sum to 100"),
  minTransfer: Rupees.optional().describe("skip transfers smaller than this; default ₹1,000"),
  date: IsoDate.optional(),
});

export const rebalance: OpDef<z.infer<typeof RebalanceInput>> = {
  name: "rebalance", title: "Rebalance funds", kind: "write", gate: "human", event: "EVT-CASH-SURPLUS",
  description: "Move money between your asset accounts (bank, cash, investments, deposits) to reach target shares of the pool. Proposes the fewest transfers, largest surplus first. It records the transfers in the books; it does not move money at the bank.",
  input: RebalanceInput,
  async plan(ctx, i) {
    const s = ctx.state, checks: Check[] = [];
    const date = i.date ?? asOfDefault(ctx);
    i.targets.forEach((t) => requireAccount(s, t.account, checks));
    if (!checks.every((c) => c.ok)) return { title: "Cannot rebalance", summary: "Unknown account.", actions: [], checks };
    const nonAsset = i.targets.filter((t) => s.accounts.get(t.account)!.nature !== "asset");
    checks.push({ label: "Only asset accounts in the pool", ok: !nonAsset.length, blocking: true, detail: nonAsset.map((t) => t.account).join(", ") || undefined });
    const bp = new Map(i.targets.map((t) => [t.account, pctToBp(t.pct)]));
    const sum = [...bp.values()].reduce((a, b) => a + b, 0n);
    checks.push({ label: "Targets sum to 100%", ok: sum === 10000n, blocking: true, detail: `${Number(sum) / 100}%` });
    const bal = balancesFromState(s, { to: date });
    const current = i.targets.map((t) => ({ id: t.account, bal: bal.get(t.account) ?? 0n }));
    const pool = current.reduce((a, c) => a + c.bal, 0n);
    checks.push({ label: "Pool is positive", ok: pool > 0n, blocking: true, detail: rs(pool) });
    if (!checks.every((c) => c.ok || !c.blocking)) return { title: "Cannot rebalance", summary: "See checks.", actions: [], checks };
    const transfers = rebalanceTransfers(current, bp, i.minTransfer ?? 100000n);
    const actions: Action[] = transfers.map((t, n) => {
      const lines: Line[] = [{ accountId: t.to, amount: t.amount.toString(), dimensions: {} }, { accountId: t.from, amount: (-t.amount).toString(), dimensions: {} }];
      validates(s, date, lines, checks, `Transfer ${t.from} → ${t.to} valid`);
      return post(jid(ctx, `rebalance/${date}/${t.from}/${t.to}/${t.amount}`, n), date, `Rebalance: ${name(s, t.from)} to ${name(s, t.to)}`, lines, "contra");
    });
    const targets = splitByWeights(pool, current.map((c) => bp.get(c.id)!));
    return {
      title: transfers.length ? `Rebalance with ${transfers.length} transfer(s)` : "Already balanced",
      summary: `Pool ${rs(pool)} across ${current.length} accounts.${transfers.length ? "" : " No transfer above the minimum is needed."} Record the transfers after moving the money at the bank, or commit now if it has moved.`,
      actions, checks, amountPaise: transfers.reduce((a, t) => (t.amount > a ? t.amount : a), 0n),
      sections: [{ title: "Allocation", kind: "table", columns: ["Account", "Now", "Target", "Target amount"], money: [1, 3],
        rows: current.map((c, k) => [name(s, c.id), c.bal.toString(), `${Number(bp.get(c.id)!) / 100}%`, targets[k]!.toString()]) }],
    };
  },
};

// ---------------------------------------------------------------- period
const CloseInput = z.object({ periodEnd: IsoDate.describe("last day of the period; a 31 March end also closes the financial year") });

export const close: OpDef<z.infer<typeof CloseInput>> = {
  name: "close", title: "Close a period", kind: "write", gate: "human", event: "EVT-PERIOD-END",
  description: "Close a month or a financial year. Checks that nothing is pending, then locks the period. A year-end close also posts the closing voucher that moves the year's income and expenses into retained surplus. Always needs a person's approval.",
  input: CloseInput,
  async plan(ctx, i) {
    const s = ctx.state, checks: Check[] = [], actions: Action[] = [];
    const yearEnd = i.periodEnd.slice(5) === "03-31";
    const fy = financialYear(i.periodEnd);
    const hard = s.locks.filter((l) => l.level === "hard").map((l) => l.periodEnd).sort().at(-1);
    checks.push({ label: "Period has ended", ok: i.periodEnd < ctx.today, blocking: true, detail: i.periodEnd < ctx.today ? undefined : `ends ${i.periodEnd}; today is ${ctx.today}` });
    checks.push({ label: "Not already closed", ok: !hard || hard < i.periodEnd, blocking: true, detail: hard ? `closed up to ${hard}` : undefined });
    const b = balancesFromState(s, { to: i.periodEnd });
    let dr = 0n, cr = 0n; for (const v of b.values()) if (v > 0n) dr += v; else cr -= v;
    checks.push({ label: "Debits equal credits", ok: dr === cr, blocking: true });
    checks.push({ label: "Nothing in suspense", ok: (b.get("SUSPENSE") ?? 0n) === 0n, blocking: true, detail: b.get("SUSPENSE") ? rs(b.get("SUSPENSE")!) : undefined });
    const drafts = (await ctx.svc.agent.queue(ctx.tenant, { bookId: ctx.book }) as unknown as DraftRow[]).filter((d) => d.proposal.txnDate <= i.periodEnd);
    checks.push({ label: "No drafts dated in the period", ok: drafts.length === 0, blocking: true, detail: drafts.length ? `${drafts.length} to decide first` : undefined });
    // Approved drafts the GL has not answered yet would land in (or be refused by) the closed period.
    const inFlight = (await ctx.svc.agent.inFlight(ctx.tenant, ctx.book)).length;
    checks.push({ label: "No postings in flight", ok: inFlight === 0, blocking: true, detail: inFlight ? `${inFlight} approved, awaiting the ledger` : undefined });
    const prov = [...openProvisional(s)].filter(([, j]) => j.txnDate <= i.periodEnd).length;
    checks.push({ label: "No entries awaiting a statement", ok: prov === 0, blocking: false, detail: prov ? `${prov} provisional; they will be frozen as entered` : undefined });

    actions.push({ type: "gl", command: { kind: "LockPeriod", periodEnd: i.periodEnd, level: "soft" } });
    const rows: Section["rows"] = [];
    if (yearEnd) {
      const year = balancesFromState(s, { from: fy.from, to: i.periodEnd, excludeVoucher: "closing" });
      const lines: Line[] = [];
      let surplus = 0n;
      for (const [id, v] of [...year.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const n = s.accounts.get(id)?.nature;
        if ((n === "income" || n === "expense") && v !== 0n) { lines.push({ accountId: id, amount: (-v).toString(), dimensions: {} }); surplus -= v; rows.push([name(s, id), (-v).toString()]); }
      }
      if (lines.length) {
        if (!s.accounts.has("RETAINED")) actions.push({ type: "gl", command: { kind: "AddAccount", account: { accountId: "RETAINED", name: "Retained surplus", nature: "equity", taxonomyTag: "BS.reserves", isControl: false, isCashLike: false, requiredDims: [] } } });
        lines.push({ accountId: "RETAINED", amount: (-surplus).toString(), dimensions: {} });
        rows.push(["Retained surplus", (-surplus).toString()]);
        const sim = s.accounts.has("RETAINED") ? s : { ...s, accounts: new Map(s.accounts).set("RETAINED", { accountId: "RETAINED", name: "Retained surplus", nature: "equity", isControl: false, isCashLike: false, requiredDims: [] }), locks: [] };
        validates(sim, i.periodEnd, lines, checks, "Closing voucher valid");
        actions.push(post(jid(ctx, `close/${i.periodEnd}`, 0), i.periodEnd, `Closing voucher ${fy.label}: income and expenses to retained surplus`, lines, "closing"));
      }
      checks.push({ label: `${fy.label} surplus computed`, ok: true, blocking: false, detail: rs(surplus) });
    }
    actions.push({ type: "gl", command: { kind: "LockPeriod", periodEnd: i.periodEnd, level: "hard" } });
    return {
      title: `Close ${yearEnd ? fy.label : `period to ${i.periodEnd}`}`,
      summary: yearEnd
        ? `Soft-locks the year, posts the closing voucher into retained surplus, then hard-locks everything up to ${i.periodEnd}. Nothing dated on or before it can be posted afterwards.`
        : `Soft-locks, then hard-locks everything up to ${i.periodEnd}. Nothing dated on or before it can be posted afterwards.`,
      actions, checks,
      sections: rows.length ? [{ title: "Closing voucher", kind: "table", columns: ["Account", "Amount"], rows, money: [1] }] : [],
      links: drafts.length ? [["Decide pending drafts", "/review"]] : [],
    };
  },
};

export const carryForward: OpDef<{ yearEnd: string }> = {
  name: "carry_forward", title: "Carry forward to the new year", kind: "write", gate: "human", event: "EVT-PERIOD-END",
  description: "Open the next financial year from a closed one: verifies the closing voucher emptied income and expenses, and that the new year's opening balance sheet equals the closed year's closing balance sheet, then records the sign-off. The ledger is continuous, so balances are not re-posted.",
  input: z.object({ yearEnd: IsoDate.refine((d) => d.slice(5) === "03-31", "a financial year ends on 31 March") }),
  async plan(ctx, i) {
    const s = ctx.state, checks: Check[] = [];
    const fy = financialYear(i.yearEnd), next = financialYear(`${Number(i.yearEnd.slice(0, 4))}-04-01`);
    const closed = s.locks.some((l) => l.level === "hard" && l.periodEnd >= i.yearEnd);
    const voucher = [...s.journals.values()].some((j) => j.voucherType === "closing" && j.txnDate === i.yearEnd);
    checks.push({ label: `${fy.label} is closed and locked`, ok: closed, blocking: true, detail: closed ? undefined : `close ${fy.label} first` });
    checks.push({ label: "Closing voucher posted", ok: voucher, blocking: false, detail: voucher ? undefined : "no income or expenses to close, or not closed" });
    const atEnd = balancesFromState(s, { to: i.yearEnd });
    const leftover = [...atEnd.entries()].filter(([id, v]) => v !== 0n && ["income", "expense"].includes(s.accounts.get(id)?.nature ?? ""));
    checks.push({ label: "Income and expenses start the year at zero", ok: leftover.length === 0, blocking: true, detail: leftover.map(([id]) => id).join(", ") || undefined });
    const rows = [...atEnd.entries()].filter(([id, v]) => v !== 0n && !["income", "expense"].includes(s.accounts.get(id)?.nature ?? ""))
      .sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => [name(s, id), s.accounts.get(id)!.nature, natural(s, id, v).toString()]);
    const net = [...atEnd.values()].reduce((a, b) => a + b, 0n);
    checks.push({ label: "Opening balance sheet balances", ok: net === 0n, blocking: true });
    return {
      title: `Open ${next.label}`,
      summary: `Opening position of ${next.label} = closing position of ${fy.label} (${rows.length} balances). Committing records the carry-forward sign-off.`,
      actions: [], checks,
      sections: [{ title: `Opening balances ${next.from}`, kind: "table", columns: ["Account", "Nature", "Balance"], rows, money: [2] }],
      links: [["Balance sheet", `/reports/balance-sheet?to=${i.yearEnd}`]],
    };
  },
};

// ---------------------------------------------------------------- insight
const ReportInput = z.object({ kind: z.enum(["profit-and-loss", "balance-sheet", "trial-balance", "statement-of-affairs"]), from: IsoDate.optional(), to: IsoDate.optional() });

export const report: OpDef<z.infer<typeof ReportInput>> = {
  name: "report", title: "Produce a report", kind: "read", gate: "policy",
  description: "Income and expenses, balance sheet, trial balance or statement of affairs for a period. Figures are in paise.",
  input: ReportInput,
  async plan(ctx, i) {
    const fy = financialYear(ctx.today);
    const from = i.from ?? fy.from, to = i.to ?? fy.to;
    const r = ctx.svc.reporting;
    const st = i.kind === "profit-and-loss" ? await r.profitAndLoss(ctx.tenant, ctx.book, from, to)
      : i.kind === "balance-sheet" ? await r.balanceSheet(ctx.tenant, ctx.book, to)
      : i.kind === "trial-balance" ? await r.trialBalance(ctx.tenant, ctx.book, to)
      : await r.statementOfAffairs(ctx.tenant, ctx.book, from, to);
    const q = i.kind === "profit-and-loss" || i.kind === "statement-of-affairs" ? `?from=${from}&to=${to}` : `?to=${to}`;
    return {
      title: st.title, summary: Object.entries(st.totals).map(([k, v]) => `${k}: ${rs(v)}`).join(" · "), actions: [],
      sections: [{ title: st.title, kind: "table", columns: ["Line", "Amount"], rows: [...st.rows.map((x) => [x.label, x.amount.toString()]),
        ...Object.entries(st.totals).map(([k, v]) => [k, v.toString()])], money: [1] }],
      data: { kind: i.kind, from, to, rows: st.rows.map((x) => ({ ...x, amount: x.amount.toString() })), totals: Object.fromEntries(Object.entries(st.totals).map(([k, v]) => [k, v.toString()])) },
      links: [["Open full report", `/reports/${i.kind}${q}`]],
    };
  },
};

/** Figures shared by dashboard and simulate, computed from a book state. */
function figures(s: BookState, today: string) {
  const fy = financialYear(today);
  const all = balancesFromState(s);
  const year = balancesFromState(s, { from: fy.from, to: fy.to, excludeVoucher: "closing" });
  const sum = (m: Map<string, bigint>, pred: (n: string, id: string) => boolean) =>
    [...m.entries()].reduce((a, [id, v]) => (pred(s.accounts.get(id)?.nature ?? "", id) ? a + v : a), 0n);
  const cash = cashLike(s).reduce((a, id) => a + (all.get(id) ?? 0n), 0n);
  const assets = sum(all, (n) => n === "asset"), liabilities = -sum(all, (n) => n === "liability");
  const income = -sum(year, (n) => n === "income"), expenses = sum(year, (n) => n === "expense");
  return { cash, assets, liabilities, netWorth: assets - liabilities, income, expenses, surplus: income - expenses, fy };
}

export const dashboard: OpDef<{ months?: number }> = {
  name: "dashboard", title: "Show the dashboard", kind: "read", gate: "policy",
  description: "Live position: cash, net worth, this year's surplus, average monthly spend and runway, top spending categories, month-by-month trend and what needs attention.",
  input: z.object({ months: z.number().int().min(1).max(24).default(6) }),
  async plan(ctx, i) {
    const s = ctx.state, f = figures(s, ctx.today);
    const pos = await ctx.svc.reporting.position(ctx.tenant, ctx.book);
    // Trend window ends at the later of today and the last posting (statements can be future-dated in demos).
    const end = pos.lastDate && pos.lastDate > ctx.today ? pos.lastDate : ctx.today;
    const start = (() => { const d = new Date(end + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - ((i.months ?? 6) - 1), 1); return d.toISOString().slice(0, 10); })();
    const monthly = await ctx.svc.reporting.monthly(ctx.tenant, ctx.book, start, end);
    const months = [...new Set(monthly.map((m) => m.month))].sort();
    const trend = months.map((m) => ({ month: m,
      income: (-monthly.filter((x) => x.month === m && x.nature === "income").reduce((a, x) => a + x.net, 0n)).toString(),
      expenses: monthly.filter((x) => x.month === m && x.nature === "expense").reduce((a, x) => a + x.net, 0n).toString() }));
    const last3 = trend.slice(-3);
    const avgOut = last3.length ? last3.reduce((a, t) => a + BigInt(t.expenses), 0n) / BigInt(last3.length) : 0n;
    const runway = avgOut > 0n ? Number((f.cash * 10n) / avgOut) / 10 : null;
    const year = balancesFromState(s, { from: f.fy.from, to: f.fy.to, excludeVoucher: "closing" });
    const top = [...year.entries()].filter(([id, v]) => s.accounts.get(id)?.nature === "expense" && v > 0n).sort((a, b) => (a[1] > b[1] ? -1 : 1)).slice(0, 5)
      .map(([id, v]) => ({ accountId: id, name: name(s, id), amount: v.toString() }));
    const drafts = (await ctx.svc.agent.queueCounts(ctx.tenant, ctx.book)).open;
    const ratifs = await ctx.svc.agent.openRatificationCount(ctx.tenant);
    const suspense = balancesFromState(s).get("SUSPENSE") ?? 0n;
    const k = { cash: f.cash.toString(), netWorth: f.netWorth.toString(), income: f.income.toString(), expenses: f.expenses.toString(),
      surplus: f.surplus.toString(), avgMonthlySpend: avgOut.toString(), runwayMonths: runway, fy: f.fy.label };
    return {
      title: `Position · ${f.fy.label}`,
      summary: `Cash ${rs(f.cash)}, net worth ${rs(f.netWorth)}, ${f.fy.label} surplus ${rs(f.surplus)}${runway !== null ? `, runway ${runway} months at ${rs(avgOut)}/month` : ""}.`,
      actions: [], data: { kpis: k, trend, top, attention: { drafts, ratifications: ratifs, suspense: suspense.toString() } },
      sections: [{ title: "Figures", kind: "kv", money: [1], rows: [["Cash and bank", k.cash], ["Net worth", k.netWorth], ["Income this year", k.income], ["Expenses this year", k.expenses], ["Surplus this year", k.surplus], ["Average monthly spend (3 mo)", k.avgMonthlySpend]] }],
      links: [["Income & expenses", "/reports/profit-and-loss"], ["Balance sheet", "/reports/balance-sheet"]],
    };
  },
};

const SimInput = z.object({
  entries: z.array(RecordInput).default([]).describe("hypothetical transactions"),
  monthlyChange: z.object({ income: z.union([z.string(), z.number()]).optional(), expenses: z.union([z.string(), z.number()]).optional() }).optional()
    .describe("recurring change per month, e.g. { expenses: 15000 } for a new rent"),
  months: z.number().int().min(1).max(60).default(12),
});

export const simulate: OpDef<z.infer<typeof SimInput>> = {
  name: "simulate", title: "Simulate a what-if", kind: "read", gate: "policy",
  description: "What-if without touching the books: apply hypothetical transactions and recurring monthly changes to the current position and show cash, net worth, surplus and runway before and after. Never posts.",
  input: SimInput,
  async plan(ctx, i) {
    const s = ctx.state, checks: Check[] = [];
    const before = figures(s, ctx.today);
    const hypo = new Map(s.journals);
    let n = 0;
    for (const e of i.entries) {
      const d = await record.plan(ctx, e);
      checks.push(...(d.checks ?? []).filter((c) => !c.ok).map((c) => ({ ...c, label: `${e.narration}: ${c.label}` })));
      for (const a of d.actions) if (a.type === "gl" && a.command.kind === "PostJournal")
        hypo.set(`sim-${n++}`, { lines: a.command.lines, txnDate: a.command.txnDate, narration: a.command.narration, voucherType: "journal", provisional: false, createdBy: "sim" });
    }
    const after = figures({ ...s, journals: hypo }, ctx.today);
    const mi = i.monthlyChange?.income ? parseAmount(String(i.monthlyChange.income)) : 0n;
    const me = i.monthlyChange?.expenses ? parseAmount(String(i.monthlyChange.expenses)) : 0n;
    const monthly = await ctx.svc.reporting.monthly(ctx.tenant, ctx.book, financialYear(ctx.today).from, "9999-12-31");
    const months = new Set(monthly.map((m) => m.month)).size || 1;
    const baseNet = monthly.reduce((a, m) => a + (m.nature === "income" ? -m.net : m.nature === "expense" ? -m.net : 0n), 0n) / BigInt(months);
    const projNet = baseNet + mi - me;
    const projection = Array.from({ length: i.months }, (_, k) => [`Month ${k + 1}`, (after.cash + projNet * BigInt(k + 1)).toString()]);
    const zeroAt = projNet < 0n ? Number(after.cash / -projNet) : null;
    const kv = (label: string, a: bigint, b: bigint) => [label, a.toString(), b.toString(), (b - a).toString()];
    return {
      title: "What-if",
      summary: `Cash ${rs(before.cash)} → ${rs(after.cash)}; net worth ${rs(before.netWorth)} → ${rs(after.netWorth)}. At ${rs(projNet)}/month net, ${zeroAt !== null ? `cash runs out in about ${zeroAt} month(s)` : "cash does not run out in the horizon"}. Nothing was posted.`,
      actions: [], checks,
      sections: [
        { title: "Before and after", kind: "table", columns: ["Figure", "Now", "After", "Change"], money: [1, 2, 3], rows: [
          kv("Cash and bank", before.cash, after.cash), kv("Net worth", before.netWorth, after.netWorth), kv(`Surplus ${before.fy.label}`, before.surplus, after.surplus)] },
        { title: `Cash over ${i.months} months`, kind: "table", columns: ["Month", "Projected cash"], money: [1], rows: projection },
      ],
      data: { before: { cash: before.cash.toString(), netWorth: before.netWorth.toString(), surplus: before.surplus.toString() },
        after: { cash: after.cash.toString(), netWorth: after.netWorth.toString(), surplus: after.surplus.toString() },
        monthlyNet: projNet.toString(), runsOutInMonths: zeroAt, projection: projection.map(([m, v]) => ({ month: m, cash: v })) },
      notes: ["Run-rate is this financial year's average monthly net income, adjusted by the changes you gave."],
    };
  },
};

export const OPERATIONS = [record, postDrafts, balance, reconcile, allocate, rebalance, close, carryForward, report, simulate, dashboard] as OpDef<any>[];
