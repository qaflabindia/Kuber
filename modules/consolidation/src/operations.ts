/**
 * Consolidation operations (FIN-GRP-01..04), registered with the ops service by the cell, so they
 * are planned, stored, approved and committed like every other operation, under the same guard,
 * and appear in `ops.list()` (every agent surface's tool catalogue and the governance register).
 *
 * Writes, all gated "human" (period-affecting: a person always commits):
 *   group_structure   entities and group chart mapping           (consolidation book)
 *   group_ownership   an effective-dated ownership record         (consolidation book)
 *   group_ic_link     a party of one entity IS another entity     (consolidation book)
 *   consolidate       eliminations and NCI for a period           (consolidation book ONLY)
 *   certify_group     the certified group close                   (consolidation book)
 *   ic_adjust         one side's own adjustment after a resolved dispute (that entity's own book)
 * Reads: group_trial_balance, group_pnl, group_balance_sheet, ic_mismatches, nci, group_perimeter.
 *
 * Scope: the acting person's book scope must cover every entity involved. Reads return the
 * permitted subset and name the entities left out; writes are blocked, naming them.
 */
import { z } from "zod";
import { GroupEntity, Id, IsoDate, stableId, type Line } from "@kuber/contracts";
import { validateJournal, type BookState } from "@kuber/gl";
import type { Action, Check, Draft, OpContext, OpDef, Section } from "@kuber/ops";
import { consolidatedBalances, statements, type ConsolJournal, type StockInput } from "./engine.ts";
import { ownershipProblems, pct, type GroupState } from "./register.ts";
import type { Computation, Consolidation } from "./service.ts";

const EXT = "consolidation";
const rs = (p: bigint) => { const n = p < 0n ? -p : p; return `${p < 0n ? "-" : ""}₹${(n / 100n).toLocaleString("en-IN")}.${String(n % 100n).padStart(2, "0")}`; };
const PaiseIn = z.union([z.string().regex(/^\d{1,18}$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));

async function groupOf(svc: Consolidation, ctx: OpContext, checks: Check[]): Promise<GroupState | null> {
  const g = await svc.groupByBook(ctx.tenant, ctx.book);
  const ok = !!g && ctx.state.config.basis === "consolidation";
  checks.push({ label: "This is a group's consolidation book", ok, blocking: true, detail: ok ? `group ${g!.groupId}` : `${ctx.book} is a ${ctx.state.config.basis} book, not a group's consolidation book` });
  return ok ? g : null;
}

const blocked = (title: string, checks: Check[]): Draft => ({ title, summary: checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail ?? "no"}`).join("; "), actions: [], checks });

function scopeCheck(c: Computation, checks: Check[], blocking: boolean) {
  const ok = c.outOfScope.length === 0;
  checks.push({ label: "Your book scope covers every entity of the group", ok, blocking,
    detail: ok ? undefined : `left out (outside your books): ${c.outOfScope.map((x) => `${x.entityId} (${x.bookId})`).join(", ")}${blocking ? "" : "; figures are the permitted subset only"}` });
}

function perimeterSection(c: Computation): Section {
  return { title: "Perimeter", kind: "table", columns: ["Entity", "Method", "Group interest", "NCI", "Investor", "Source", "Pack hash", "Exclusion"],
    rows: c.perimeter.map((p) => [p.entityId, p.method, pct(p.interest), pct(p.nci), p.investor ?? "", c.packs.get(p.entityId)?.source ?? (p.method === "excluded" ? "" : "missing"),
      c.packs.get(p.entityId)?.packHash.slice(0, 12) ?? "", p.exclusion ?? c.missing.find((m) => m.entityId === p.entityId)?.reason ?? ""]) };
}
function exclusionSections(c: Computation): Section[] {
  const rows = [...c.result.exclusions.map((x) => [x.entityId, x.reason]), ...c.outOfScope.map((x) => [x.entityId, `outside your book scope (${x.bookId}): left out`])];
  return rows.length ? [{ title: "Excluded entities (visible exclusion lines)", kind: "table", columns: ["Entity", "Reason"], rows }] : [];
}
function journalSections(js: ConsolJournal[]): Section[] {
  return js.map((j) => ({ title: `${j.narration} [${j.key}]`, kind: "table" as const, columns: ["Computation"], rows: j.computation.map((t) => [t]) }));
}
function nciSection(c: Computation): Section {
  return { title: "Non-controlling interest", kind: "table", columns: ["Entity", "NCI %", "Net assets", "NCI in net assets", "Profit", "NCI in profit", "NCI balance"], money: [2, 3, 4, 5, 6],
    rows: c.result.nci.map((n) => [n.entityId, n.nci, n.netAssets.toString(), n.nciNetAssets.toString(), n.profit.toString(), n.nciProfit.toString(), n.nciBalance.toString()]) };
}
function openIcSection(c: Computation): Section[] {
  return c.result.openIc.length ? [{ title: "Open intercompany differences (not eliminated, never plugged)", kind: "table", columns: ["Kind", "Entities", "Difference", "Explanation"], money: [2],
    rows: c.result.openIc.map((o) => [o.kind, `${o.a} / ${o.b}`, o.difference.toString(), o.explanation]) }] : [];
}

const accountAction = (id: string, name: string, nature: string): Action => ({ type: "gl", command: { kind: "AddAccount", account: { accountId: id, name, nature: nature as never, taxonomyTag: id, isControl: false, isCashLike: false, requiredDims: [] } } });

export function consolidationOperations(svc: Consolidation): OpDef<any>[] {
  // ---------------------------------------------------------------- register changes
  const groupStructure: OpDef<{ entities?: z.infer<typeof GroupEntity>[]; mapping?: { entityId: string; accountId: string; groupAccount: string; groupAccountName: string }[] }> = {
    name: "group_structure", title: "Change the group structure or chart mapping", kind: "write", gate: "human",
    description: "Set the group's entities (each with its book in this workspace, or its linked tenant, and its functional currency) and/or map entity accounts to group accounts (overriding their statement mapping). Changes the consolidation register only; never posts. Always needs a person.",
    input: z.object({ entities: z.array(GroupEntity).min(1).optional(),
      mapping: z.array(z.object({ entityId: Id, accountId: Id, groupAccount: Id, groupAccountName: z.string().min(1).max(200) })).min(1).optional() })
      .refine((x) => x.entities || x.mapping, "give entities and/or mapping"),
    async plan(ctx, i) {
      const checks: Check[] = [];
      const g = await groupOf(svc, ctx, checks);
      if (!g) return blocked("Cannot change the group structure", checks);
      const entities = i.entities ?? g.entities;
      checks.push({ label: "The parent is one of the entities", ok: entities.some((e) => e.entityId === g.parentEntityId), blocking: true, detail: g.parentEntityId });
      const ids = entities.map((e) => e.entityId);
      checks.push({ label: "Entity ids are unique", ok: new Set(ids).size === ids.length, blocking: true });
      for (const e of i.entities ?? []) {
        if (!e.bookId) { checks.push({ label: `${e.entityId}: no book here`, ok: true, blocking: false, detail: e.linkedTenant ? `packs from linked tenant ${e.linkedTenant}` : "outside Kuber: it can never provide a certified pack" }); continue; }
        const s = await ctx.svc.gl.state(ctx.tenant, e.bookId);
        const ok = s.exists && s.config.basis !== "consolidation" && s.config.legalEntityId === e.entityId;
        checks.push({ label: `${e.entityId}: book ${e.bookId} is its own local book`, ok, blocking: true,
          detail: !s.exists ? "no such book" : s.config.basis === "consolidation" ? "a consolidation book cannot be an entity" : s.config.legalEntityId !== e.entityId ? `the book belongs to legal entity ${s.config.legalEntityId}` : undefined });
      }
      for (const m of i.mapping ?? []) checks.push({ label: `mapping ${m.entityId}/${m.accountId} → ${m.groupAccount}`, ok: ids.includes(m.entityId), blocking: true, detail: ids.includes(m.entityId) ? undefined : "not an entity of the group" });
      const actions: Action[] = [];
      let v = g.version;
      if (i.entities) actions.push({ type: "ext", module: EXT, kind: "setEntities", payload: { groupId: g.groupId, registerVersion: v++, entities: i.entities } });
      if (i.mapping) actions.push({ type: "ext", module: EXT, kind: "setMapping", payload: { groupId: g.groupId, registerVersion: v++, mapping: i.mapping } });
      return { title: `Group ${g.groupId}: ${[i.entities ? `${i.entities.length} entities` : "", i.mapping ? `${i.mapping.length} mapping(s)` : ""].filter(Boolean).join(", ")}`,
        summary: "Changes the consolidation register. Nothing is posted to any book.", actions, checks,
        sections: [...(i.entities ? [{ title: "Entities", kind: "table" as const, columns: ["Entity", "Name", "Book", "Linked tenant", "Currency"], rows: i.entities.map((e) => [e.entityId, e.name, e.bookId ?? "", e.linkedTenant ?? "", e.functionalCurrency]) }] : []),
          ...(i.mapping ? [{ title: "Group chart mapping", kind: "table" as const, columns: ["Entity", "Account", "Group account", "Name"], rows: i.mapping.map((m) => [m.entityId, m.accountId, m.groupAccount, m.groupAccountName]) }] : [])] };
    },
  };

  const OwnershipInput = z.object({
    parentEntityId: Id, childEntityId: Id, effectiveFrom: IsoDate, ownershipBp: z.number().int().min(0).max(10000), votingBp: z.number().int().min(0).max(10000),
    control: z.enum(["control", "joint_control", "significant_influence", "none"]), method: z.enum(["full", "equity", "excluded"]),
    exclusionReason: z.string().min(3).max(500).optional(), marginBp: z.number().int().min(0).max(10000).optional(),
    acquisition: z.object({ date: IsoDate, costPaise: z.string().regex(/^\d{1,18}$/), investmentAccount: Id,
      equity: z.array(z.object({ accountId: Id, amountPaise: z.string().regex(/^-?\d{1,18}$/) })).min(1) }).optional(),
  });
  const groupOwnership: OpDef<z.infer<typeof OwnershipInput>> = {
    name: "group_ownership", title: "Record an ownership change", kind: "write", gate: "human",
    description: "Record, effective from a date, who owns an entity of the group: ownership %, voting %, the control assessment and the method (full, equity or excluded with its reason), with the acquisition facts used to eliminate the investment. Earlier records stay in force for earlier dates. Changes the register only; always needs a person.",
    input: OwnershipInput,
    async plan(ctx, i) {
      const checks: Check[] = [];
      const g = await groupOf(svc, ctx, checks);
      if (!g) return blocked("Cannot record ownership", checks);
      const ids = g.entities.map((e) => e.entityId);
      for (const e of [i.parentEntityId, i.childEntityId]) checks.push({ label: `${e} is an entity of the group`, ok: ids.includes(e), blocking: true });
      for (const p of ownershipProblems(i)) checks.push({ label: "Method follows the control assessment", ok: false, blocking: true, detail: p });
      const bookOf = (id: string) => g.entities.find((e) => e.entityId === id)?.bookId ?? null;
      if (i.acquisition) {
        const ib = bookOf(i.parentEntityId);
        if (ib) { const s = await ctx.svc.gl.state(ctx.tenant, ib); checks.push({ label: `Investment account ${i.acquisition.investmentAccount} exists in ${i.parentEntityId}`, ok: s.accounts.has(i.acquisition.investmentAccount), blocking: true }); }
        const cb = bookOf(i.childEntityId);
        if (cb) { const s = await ctx.svc.gl.state(ctx.tenant, cb); for (const e of i.acquisition.equity) checks.push({ label: `Equity account ${e.accountId} exists in ${i.childEntityId}`, ok: s.accounts.get(e.accountId)?.nature === "equity", blocking: true }); }
      }
      return { title: `Ownership ${i.parentEntityId} → ${i.childEntityId}: ${(i.ownershipBp / 100).toFixed(2)}% (${i.method}) from ${i.effectiveFrom}`,
        summary: `Voting ${(i.votingBp / 100).toFixed(2)}%, ${i.control.replace("_", " ")}.${i.exclusionReason ? ` Excluded: ${i.exclusionReason}.` : ""} Changes the register only.`,
        actions: [{ type: "ext", module: EXT, kind: "recordOwnership", payload: { groupId: g.groupId, registerVersion: g.version, record: i } }], checks };
    },
  };

  const groupIcLink: OpDef<{ entityId: string; partyId: string; counterpartyEntityId: string }> = {
    name: "group_ic_link", title: "Link a party to a group entity", kind: "write", gate: "human",
    description: "Declare that a party in one entity's party master IS another entity of the group, so journals on control accounts with that party are tagged intercompany. Changes the register only; always needs a person.",
    input: z.object({ entityId: Id, partyId: Id, counterpartyEntityId: Id }),
    async plan(ctx, i) {
      const checks: Check[] = [];
      const g = await groupOf(svc, ctx, checks);
      if (!g) return blocked("Cannot link the party", checks);
      const ids = g.entities.map((e) => e.entityId);
      for (const e of [i.entityId, i.counterpartyEntityId]) checks.push({ label: `${e} is an entity of the group`, ok: ids.includes(e), blocking: true });
      checks.push({ label: "The counterparty is another entity", ok: i.entityId !== i.counterpartyEntityId, blocking: true });
      const pe = (await svc.d.partyEntities(ctx.tenant, [i.partyId])).get(i.partyId);
      checks.push({ label: `Party ${i.partyId} belongs to ${i.entityId}'s party master`, ok: pe === i.entityId, blocking: true, detail: pe === undefined ? "no such party" : pe !== i.entityId ? `it belongs to ${pe}` : undefined });
      return { title: `Party ${i.partyId} of ${i.entityId} is entity ${i.counterpartyEntityId}`, summary: "Journals on control accounts with this party become intercompany.",
        actions: [{ type: "ext", module: EXT, kind: "linkParty", payload: { groupId: g.groupId, registerVersion: g.version, link: i } }], checks };
    },
  };

  // ---------------------------------------------------------------- consolidate
  const StockIn = z.object({ sellerEntityId: Id, buyerEntityId: Id, closingStockPaise: PaiseIn, marginBp: z.number().int().min(0).max(10000).optional(), buyerInventoryAccount: Id });
  const consolidateOp: OpDef<{ periodEnd?: string; stock?: z.infer<typeof StockIn>[] }> = {
    name: "consolidate", title: "Run consolidation (eliminations and NCI)", kind: "write", gate: "human",
    description: "Compute the group's eliminations for a period end: intercompany balances and income/expense (matched amounts only; differences stay open, never plugged), investment against equity at acquisition (goodwill or capital reserve), unrealised profit in intra-group stock, NCI in net assets and profit, and the equity-method share of associates. Posts ONLY to the group's consolidation book, reversing the previous active run; local books are never touched. Shows every computation. Always needs a person.",
    input: z.object({ periodEnd: IsoDate.optional(), stock: z.array(StockIn).optional() }),
    async plan(ctx, i) {
      const checks: Check[] = [];
      const g = await groupOf(svc, ctx, checks);
      if (!g) return blocked("Cannot consolidate", checks);
      const periodEnd = i.periodEnd ?? ctx.today;
      const stock: StockInput[] = i.stock ?? [];
      const c = await svc.compute(ctx.tenant, g, periodEnd, { stock, scope: await svc.scopeOf(ctx.tenant, ctx.principal, ctx.onBehalfOf) });
      scopeCheck(c, checks, true);
      for (const m of c.missing) checks.push({ label: `Input from ${m.entityId}`, ok: false, blocking: true, detail: m.reason });
      const live = [...c.packs.values()].filter((p) => p.source === "live").map((p) => p.entityId);
      checks.push({ label: "Every input is a certified pack", ok: live.length === 0, blocking: false, detail: live.length ? `live ledger (not certifiable) for ${live.join(", ")}: certify their trial balances as of ${periodEnd}, then run again before certifying the group` : undefined });
      for (const p of c.result.problems) checks.push({ label: "Consolidation rules satisfied", ok: false, blocking: true, detail: p });
      const runs = await svc.runs(ctx.tenant, g.groupId);
      const active = runs.filter((r) => r.status === "active");
      const later = active.find((r) => r.periodEnd > periodEnd);
      checks.push({ label: "No later period is consolidated", ok: !later, blocking: true, detail: later ? `the run for ${later.periodEnd} is active: consolidate periods in order` : undefined });
      const same = active.find((r) => r.periodEnd === periodEnd && r.inputHash === c.result.inputHash);
      checks.push({ label: "Inputs differ from the active run for this period", ok: !same, blocking: true, detail: same ? `run v${same.version} already holds exactly these eliminations (${same.inputHash.slice(0, 12)})` : undefined });
      // The book: reverse every active run's journals on this date, post the new set, add missing group accounts.
      const s = ctx.state;
      const actions: Action[] = [];
      const used = new Set(c.result.journals.flatMap((j) => j.lines.map((l) => l.accountId)));
      for (const id of [...used].sort()) if (!s.accounts.has(id)) { const a = c.result.groupAccounts.get(id)!; actions.push(accountAction(id, a.name, a.nature)); }
      const jid = (seed: string) => stableId("consolidation-journal", `${ctx.tenant}/${ctx.book}/${s.version}/${seed}`);
      const reversals: { journalId: string; lines: Line[] }[] = [];
      for (const r of active) for (const j of r.journals) {
        const rec = s.journals.get(j.journalId);
        if (!rec || rec.reversedBy) continue;
        reversals.push({ journalId: jid(`rev/${j.journalId}`), lines: rec.lines.map((l) => ({ ...l, amount: (-BigInt(l.amount)).toString() })) });
        actions.push({ type: "gl", command: { kind: "PostJournal", journalId: jid(`rev/${j.journalId}`), txnDate: periodEnd, narration: `Reverse consolidation run v${r.version} (${r.periodEnd}): ${j.key}`,
          voucherType: "consolidation", lines: rec.lines.map((l) => ({ ...l, amount: (-BigInt(l.amount)).toString(), dimensions: { ...l.dimensions, grp_reverses: j.journalId } })), autonomy: "human" } });
      }
      const journals = c.result.journals.map((j) => ({ ...j, journalId: jid(j.key) }));
      for (const j of journals) {
        actions.push({ type: "gl", command: { kind: "PostJournal", journalId: j.journalId, txnDate: periodEnd, narration: j.narration, voucherType: "consolidation", autonomy: "human",
          lines: j.lines.map((l) => ({ accountId: l.accountId, amount: l.amount.toString(), dimensions: { ...l.dimensions, grp_period: periodEnd } })) } });
      }
      // Validate against the book as it will be once the accounts exist.
      if (journals.length) {
        const accounts = new Map(s.accounts);
        for (const a of actions) if (a.type === "gl" && a.command.kind === "AddAccount") accounts.set(a.command.account.accountId, a.command.account);
        const probe: BookState = { ...s, accounts };
        try { for (const j of journals) validateJournal(probe, periodEnd, j.lines.map((l) => ({ accountId: l.accountId, amount: l.amount.toString(), dimensions: {} })), "controller:check"); checks.push({ label: "Ledger rules satisfied", ok: true, blocking: true }); }
        catch (e) { checks.push({ label: "Ledger rules satisfied", ok: false, blocking: true, detail: e instanceof Error ? e.message : String(e) }); }
      }
      actions.push({ type: "ext", module: EXT, kind: "recordRun", payload: { groupId: g.groupId, registerVersion: g.version, periodEnd, inputHash: c.result.inputHash,
        journals: journals.map((j) => ({ journalId: j.journalId, key: j.key, contentHash: j.contentHash })), supersedes: active.map((r) => r.runId),
        stock: stock.map((x) => ({ ...x, closingStockPaise: x.closingStockPaise.toString() })) } });
      const bal = consolidatedBalances(c.result, c.result.journals.flatMap((j) => j.lines));
      const st = statements(c.result.groupAccounts, bal);
      const amount = journals.reduce((m, j) => { const d = j.lines.reduce((a, l) => (l.amount > 0n ? a + l.amount : a), 0n); return d > m ? d : m; }, 0n);
      return {
        title: `Consolidate group ${g.groupId} as of ${periodEnd}`,
        summary: `${journals.length} elimination journal(s)${reversals.length ? `, reversing ${reversals.length} journal(s) of the previous run` : ""}, in the consolidation book ${ctx.book} only. Group profit ${rs(st.pnl.profit)} (NCI ${rs(st.pnl.nci)}, owners ${rs(st.pnl.owners)}).`,
        actions, checks, amountPaise: amount,
        sections: [perimeterSection(c), ...exclusionSections(c), ...journalSections(c.result.journals), nciSection(c), ...openIcSection(c),
          { title: "Inputs", kind: "kv", rows: [["Input hash", c.result.inputHash], ["Rules", c.result.rulesHash], ["Register version", String(g.version)]] }],
        data: { inputHash: c.result.inputHash, periodEnd, journals: journals.map((j) => ({ journalId: j.journalId, key: j.key, contentHash: j.contentHash, computation: j.computation })),
          nci: c.result.nci.map((n) => ({ ...n, netAssets: n.netAssets.toString(), nciNetAssets: n.nciNetAssets.toString(), profit: n.profit.toString(), nciProfit: n.nciProfit.toString(), nciBalance: n.nciBalance.toString() })) },
      };
    },
  };

  // ---------------------------------------------------------------- certify
  const certifyGroup: OpDef<{ periodEnd?: string }> = {
    name: "certify_group", title: "Certify the group close", kind: "write", gate: "human",
    description: "Certify the group's statements for a period end. Needs every in-perimeter entity's certified local pack (a certified trial balance, or a linked tenant's published pack) and the active consolidation run computed from exactly those packs. Records a versioned snapshot with the input pack hashes, register and rules versions and elimination hashes; a later correction is a new version linked to the previous one. Always needs a person.",
    input: z.object({ periodEnd: IsoDate.optional() }),
    async plan(ctx, i) {
      const checks: Check[] = [];
      const g = await groupOf(svc, ctx, checks);
      if (!g) return blocked("Cannot certify", checks);
      const periodEnd = i.periodEnd ?? ctx.today;
      const run = (await svc.runs(ctx.tenant, g.groupId)).find((r) => r.status === "active" && r.periodEnd === periodEnd) ?? null;
      const stock = run ? await svc.runStock(ctx.tenant, run.runId) : [];
      const c = await svc.compute(ctx.tenant, g, periodEnd, { stock, certifiedOnly: true, scope: await svc.scopeOf(ctx.tenant, ctx.principal, ctx.onBehalfOf) });
      scopeCheck(c, checks, true);
      for (const p of c.perimeter.filter((x) => x.method !== "excluded")) {
        const m = c.missing.find((x) => x.entityId === p.entityId);
        checks.push({ label: `Certified pack from ${p.entityId}`, ok: !m, blocking: true, detail: m ? m.reason : `${c.packs.get(p.entityId)!.source} ${c.packs.get(p.entityId)!.packHash.slice(0, 12)}` });
      }
      checks.push({ label: `Consolidation run for ${periodEnd}`, ok: !!run, blocking: true, detail: run ? `v${run.version}` : "none: run consolidate first" });
      const sameInputs = !!run && run.inputHash === c.result.inputHash;
      if (run) checks.push({ label: "The run used exactly these certified packs, register and rules", ok: sameInputs, blocking: true,
        detail: sameInputs ? run.inputHash.slice(0, 12) : "the packs, register or rules changed since the run (or it used live ledgers): run consolidate again" });
      const hashes = c.result.journals.map((j) => `${j.key}:${j.contentHash}`).join(), onBook = run?.journals.map((j) => `${j.key}:${j.contentHash}`).join();
      if (run && sameInputs) checks.push({ label: "The consolidation book holds exactly these eliminations", ok: hashes === onBook, blocking: true });
      for (const p of c.result.problems) checks.push({ label: "Consolidation rules satisfied", ok: false, blocking: true, detail: p });
      if (checks.some((x) => x.blocking && !x.ok) || !run) return { ...blocked(`Cannot certify group ${g.groupId} as of ${periodEnd}`, checks), sections: [perimeterSection(c), ...exclusionSections(c)] };
      const st = statements(c.result.groupAccounts, consolidatedBalances(c.result, c.result.journals.flatMap((j) => j.lines)));
      const { body, contentHash } = svc.snapshotBody(c, run, { statements: st });
      const prev = (await svc.closes(ctx.tenant, g.groupId)).filter((x) => x.period_end === periodEnd).at(-1);
      checks.push({ label: "Differs from the current certified version", ok: prev?.content_hash !== contentHash, blocking: false, detail: prev ? `v${prev.version} ${prev.content_hash.slice(0, 12)}` : "first certification" });
      return {
        title: `Certify group ${g.groupId} as of ${periodEnd}${prev && prev.content_hash !== contentHash ? ` (correction of v${prev.version})` : ""}`,
        summary: `Assets ${rs(st.balanceSheet.totalAssets)}, profit ${rs(st.pnl.profit)} (owners ${rs(st.pnl.owners)}, NCI ${rs(st.pnl.nci)}). Content hash ${contentHash}.`,
        actions: [{ type: "ext", module: EXT, kind: "recordClose", payload: { groupId: g.groupId, registerVersion: g.version, periodEnd, body, contentHash } }], checks,
        sections: [perimeterSection(c), ...exclusionSections(c), { title: "Snapshot", kind: "kv", rows: [["Content hash", contentHash], ["Input hash", body.inputHash], ["Register version", String(body.registerVersion)], ["Rules", `${body.rulesVersion} ${body.rulesHash.slice(0, 12)}`]] },
          { title: "Input packs", kind: "table", columns: ["Entity", "Method", "Source", "Pack hash"], rows: body.inputs.map((x) => [x.entityId, x.method, x.source, x.packHash]) },
          { title: "Eliminations", kind: "table", columns: ["Key", "Content hash"], rows: body.eliminations.map((x) => [x.key, x.contentHash]) }],
        data: { contentHash, body },
      };
    },
  };

  // ---------------------------------------------------------------- ic_adjust (an entity's own book)
  const icAdjust: OpDef<{ disputeId: string; account: string; date?: string }> = {
    name: "ic_adjust", title: "Adjust this entity's side of a resolved IC dispute", kind: "write", gate: "policy",
    description: "After both sides resolved an intercompany dispute at an agreed amount, bring THIS book's side to that amount: the difference between what this entity recorded and the agreed amount, against the account given. Only in this entity's own book, for its own people to approve; never in the other entity.",
    input: z.object({ disputeId: z.string().min(1), account: z.string().min(1).transform((s) => s.trim().toUpperCase()), date: IsoDate.optional() }),
    async plan(ctx, i) {
      const checks: Check[] = [];
      const d = await svc.dispute(ctx.tenant, i.disputeId);
      if (!d) { checks.push({ label: "Dispute exists", ok: false, blocking: true }); return blocked("Cannot adjust", checks); }
      checks.push({ label: "Both sides resolved the dispute", ok: d.status === "resolved", blocking: true, detail: d.status === "resolved" ? `agreed ${rs(BigInt(d.agreedPaise!))}` : "still open: both sides' approvers must record the same position" });
      const g = await svc.group(ctx.tenant, d.groupId);
      const side = [d.senderEntityId, d.receiverEntityId].find((e) => g.entities.find((x) => x.entityId === e)?.bookId === ctx.book);
      checks.push({ label: "This book is one side of the dispute", ok: !!side, blocking: true, detail: side ?? `${ctx.book} belongs to neither ${d.senderEntityId} nor ${d.receiverEntityId}` });
      if (!side || d.status !== "resolved") return blocked("Cannot adjust", checks);
      const item = await svc.item(ctx.tenant, g, d.itemKey, d.periodEnd);
      if (!item) { checks.push({ label: "The intercompany item still exists", ok: false, blocking: true }); return blocked("Cannot adjust", checks); }
      const agreed = BigInt(d.agreedPaise!);
      const sender = side === item.senderEntityId;
      const recorded = sender ? item.sent : item.received;
      const delta = agreed - recorded;                                     // this side's control balance must move by this (sender: debit, receiver: credit)
      checks.push({ label: "This side differs from the agreed amount", ok: delta !== 0n, blocking: true, detail: `recorded ${rs(recorded)}, agreed ${rs(agreed)}` });
      const own = item.journals.find((j) => j.entityId === side);
      const rec = own ? ctx.state.journals.get(own.journalId) : undefined;
      const cpLine = rec?.lines.find((l) => l.partyId && g.icLinks.some((x) => x.entityId === side && x.partyId === l.partyId) && ctx.state.accounts.get(l.accountId)?.isControl);
      const cp = side === item.senderEntityId ? item.receiverEntityId : item.senderEntityId;
      const link = g.icLinks.find((x) => x.entityId === side && x.counterpartyEntityId === cp);
      const control = cpLine?.accountId ?? (sender ? "DEBTORS" : "CREDITORS"), partyId = cpLine?.partyId ?? link?.partyId;
      checks.push({ label: `A party of ${side} is linked to ${cp}`, ok: !!partyId, blocking: true });
      checks.push({ label: `Account ${i.account} exists`, ok: ctx.state.accounts.has(i.account), blocking: true });
      if (checks.some((c) => c.blocking && !c.ok)) return blocked("Cannot adjust", checks);
      const amt = sender ? delta : -delta;                                 // control line amount (debit positive)
      const date = i.date ?? ctx.today;
      const lines: Line[] = [{ accountId: control, amount: amt.toString(), partyId, dimensions: { ic_ref: item.docRef, ic_dispute: d.disputeId } },
        { accountId: i.account, amount: (-amt).toString(), dimensions: { ic_dispute: d.disputeId } }];
      try { validateJournal(ctx.state, date, lines, "owner:approver"); checks.push({ label: "Ledger rules satisfied", ok: true, blocking: true }); }
      catch (e) { checks.push({ label: "Ledger rules satisfied", ok: false, blocking: true, detail: e instanceof Error ? e.message : String(e) }); }
      const journalId = stableId("ic-adjust", `${ctx.tenant}/${ctx.book}/${d.disputeId}/${ctx.state.version}`);
      return { title: `${side}: adjust ${item.docRef} to the agreed ${rs(agreed)}`, summary: `${rs(delta < 0n ? -delta : delta)} in ${ctx.book} only (${side}'s own book); ${cp} is not touched.`,
        actions: [{ type: "gl", command: { kind: "PostJournal", journalId, txnDate: date, narration: `IC dispute ${d.disputeId} resolved at ${rs(agreed)} (${item.docRef})`, lines, autonomy: "human", entry: "manual" } }],
        checks, amountPaise: delta < 0n ? -delta : delta };
    },
  };

  // ---------------------------------------------------------------- reads
  const PeriodIn = z.object({ periodEnd: IsoDate.optional() });
  const readGroup = async (ctx: OpContext, periodEnd: string) => {
    const g = await svc.groupByBook(ctx.tenant, ctx.book);
    if (!g) return null;
    return svc.statements(ctx.tenant, ctx.book, periodEnd, await svc.scopeOf(ctx.tenant, ctx.principal, ctx.onBehalfOf));
  };
  const notGroup = (ctx: OpContext): Draft => ({ title: "Not a group", summary: `${ctx.book} is not a group's consolidation book.`, actions: [],
    checks: [{ label: "This is a group's consolidation book", ok: false, blocking: true }] });
  const readChecks = (r: NonNullable<Awaited<ReturnType<typeof readGroup>>>): Check[] => {
    const checks: Check[] = [];
    scopeCheck(r.computation, checks, false);
    checks.push({ label: "The committed consolidation run matches these inputs", ok: r.runMatchesInputs, blocking: false,
      detail: r.run ? (r.runMatchesInputs ? `run v${r.run.version}` : `run v${r.run.version} was computed on other inputs: run consolidate again`) : "no consolidation run for this period: figures are before eliminations" });
    const live = [...r.computation.packs.values()].filter((p) => p.source === "live").map((p) => p.entityId);
    if (live.length) checks.push({ label: "Inputs are certified packs", ok: false, blocking: false, detail: `live (uncertified) for ${live.join(", ")}` });
    return checks;
  };
  const moneyRows = (xs: { accountId: string; name: string; amount: bigint }[]) => xs.map((x) => [x.accountId, x.name, x.amount.toString()]);

  const groupTb: OpDef<{ periodEnd?: string }> = {
    name: "group_trial_balance", title: "Consolidated trial balance", kind: "read", gate: "policy",
    description: "The group's consolidated trial balance at a period end: each group account's total from the entities' packs, the eliminations in the consolidation book, and the consolidated balance (debit positive). Names any entity left out of your scope.",
    input: PeriodIn,
    async plan(ctx, i) {
      const r = await readGroup(ctx, i.periodEnd ?? ctx.today);
      if (!r) return notGroup(ctx);
      const tb = r.statements.trialBalance;
      return { title: `Consolidated trial balance as of ${i.periodEnd ?? ctx.today}`, summary: `${tb.length} group accounts.`, actions: [], checks: readChecks(r),
        sections: [{ title: "Trial balance (debit positive)", kind: "table", columns: ["Group account", "Name", "Entities", "Eliminations", "Consolidated"], money: [2, 3, 4],
          rows: tb.map((x) => [x.accountId, x.name, x.entities.toString(), x.eliminations.toString(), x.consolidated.toString()]) }, ...exclusionSections(r.computation)],
        data: { trialBalance: tb.map((x) => ({ ...x, entities: x.entities.toString(), eliminations: x.eliminations.toString(), consolidated: x.consolidated.toString() })),
          excluded: [...r.computation.result.exclusions, ...r.computation.outOfScope.map((x) => ({ entityId: x.entityId, reason: "outside your book scope" }))] } };
    },
  };
  const groupPnl: OpDef<{ periodEnd?: string }> = {
    name: "group_pnl", title: "Consolidated profit and loss", kind: "read", gate: "policy",
    description: "The group's consolidated profit and loss for the fiscal year to the period end, with profit attributable to non-controlling interest and to the owners of the parent.",
    input: PeriodIn,
    async plan(ctx, i) {
      const r = await readGroup(ctx, i.periodEnd ?? ctx.today);
      if (!r) return notGroup(ctx);
      const p = r.statements.pnl;
      return { title: `Consolidated profit and loss to ${i.periodEnd ?? ctx.today}`, summary: `Profit ${rs(p.profit)}: owners ${rs(p.owners)}, NCI ${rs(p.nci)}.`, actions: [], checks: readChecks(r),
        sections: [{ title: "Income", kind: "table", columns: ["Group account", "Name", "Amount"], money: [2], rows: moneyRows(p.income) },
          { title: "Expenses", kind: "table", columns: ["Group account", "Name", "Amount"], money: [2], rows: moneyRows(p.expenses) },
          { title: "Profit", kind: "kv", money: [1], rows: [["Total income", p.totalIncome.toString()], ["Total expenses", p.totalExpenses.toString()], ["Profit for the period", p.profit.toString()],
            ["Attributable to non-controlling interest", p.nci.toString()], ["Attributable to owners of the parent", p.owners.toString()]] }, ...exclusionSections(r.computation)],
        data: { totalIncome: p.totalIncome.toString(), totalExpenses: p.totalExpenses.toString(), profit: p.profit.toString(), nci: p.nci.toString(), owners: p.owners.toString() } };
    },
  };
  const groupBs: OpDef<{ periodEnd?: string }> = {
    name: "group_balance_sheet", title: "Consolidated balance sheet", kind: "read", gate: "policy",
    description: "The group's consolidated balance sheet at a period end, with non-controlling interest shown separately from the owners' equity.",
    input: PeriodIn,
    async plan(ctx, i) {
      const r = await readGroup(ctx, i.periodEnd ?? ctx.today);
      if (!r) return notGroup(ctx);
      const b = r.statements.balanceSheet;
      return { title: `Consolidated balance sheet as of ${i.periodEnd ?? ctx.today}`, summary: `Assets ${rs(b.totalAssets)}; NCI ${rs(b.nci)}.`, actions: [], checks: readChecks(r),
        sections: [{ title: "Assets", kind: "table", columns: ["Group account", "Name", "Amount"], money: [2], rows: moneyRows(b.assets) },
          { title: "Liabilities", kind: "table", columns: ["Group account", "Name", "Amount"], money: [2], rows: moneyRows(b.liabilities) },
          { title: "Equity (owners of the parent)", kind: "table", columns: ["Group account", "Name", "Amount"], money: [2], rows: [...moneyRows(b.equity), ["", "Surplus to date (owners)", b.surplus.toString()]] },
          { title: "Totals", kind: "kv", money: [1], rows: [["Total assets", b.totalAssets.toString()], ["Total liabilities", b.totalLiabilities.toString()], ["Owners' equity", b.totalEquity.toString()],
            ["Non-controlling interest", b.nci.toString()], ["Assets - liabilities - equity - NCI (must be 0)", b.check.toString()]] }, ...exclusionSections(r.computation)],
        data: { totalAssets: b.totalAssets.toString(), totalLiabilities: b.totalLiabilities.toString(), totalEquity: b.totalEquity.toString(), nci: b.nci.toString(), check: b.check.toString() } };
    },
  };
  const icMismatches: OpDef<{ periodEnd?: string }> = {
    name: "ic_mismatches", title: "Intercompany mismatches", kind: "read", gate: "policy",
    description: "Intercompany documents matched by counterparty, document (IC reference), currency and period: matched, in transit (sent, not received, with the difference explained), mismatched (period, FX, tax or amount) and disputed; plus the reciprocal balance check per pair. Never proposes a plug entry.",
    input: PeriodIn,
    async plan(ctx, i) {
      const g = await svc.groupByBook(ctx.tenant, ctx.book);
      if (!g) return notGroup(ctx);
      const m = await svc.mismatches(ctx.tenant, g, i.periodEnd ?? ctx.today, await svc.scopeOf(ctx.tenant, ctx.principal, ctx.onBehalfOf));
      const checks: Check[] = []; scopeCheck(m.computation, checks, false);
      const open = m.items.filter((x) => x.status !== "matched");
      return { title: `Intercompany items to ${i.periodEnd ?? ctx.today}`, summary: `${m.items.length} document(s): ${open.length} not matched.`, actions: [], checks,
        sections: [{ title: "Documents", kind: "table", columns: ["Key", "Status", "Classification", "Sent", "Received", "Difference", "Explanation"], money: [3, 4, 5],
          rows: m.items.map((x) => [x.key, x.status, x.classification, x.sent.toString(), x.received.toString(), x.difference.toString(), x.explanation]) },
          { title: "Reciprocal balances", kind: "table", columns: ["A", "B", "A with B", "B with A", "Difference"], money: [2, 3, 4], rows: m.balances.map((b) => [b.a, b.b, b.aWithB.toString(), b.bWithA.toString(), b.difference.toString()]) },
          ...exclusionSections(m.computation)],
        data: { items: m.items.map((x) => ({ ...x, sent: x.sent.toString(), received: x.received.toString(), matched: x.matched.toString(), difference: x.difference.toString(),
          journals: x.journals.map((j) => ({ ...j, amount: j.amount.toString() })) })) } };
    },
  };
  const nciOp: OpDef<{ periodEnd?: string }> = {
    name: "nci", title: "Non-controlling interest", kind: "read", gate: "policy",
    description: "Non-controlling interest per subsidiary at a period end: the NCI %, the subsidiary's net assets and profit, and NCI's share of each, at the ownership in force.",
    input: PeriodIn,
    async plan(ctx, i) {
      const g = await svc.groupByBook(ctx.tenant, ctx.book);
      if (!g) return notGroup(ctx);
      const c = await svc.compute(ctx.tenant, g, i.periodEnd ?? ctx.today, { scope: await svc.scopeOf(ctx.tenant, ctx.principal, ctx.onBehalfOf) });
      const checks: Check[] = []; scopeCheck(c, checks, false);
      return { title: `Non-controlling interest as of ${i.periodEnd ?? ctx.today}`, summary: c.result.nci.map((n) => `${n.entityId}: ${n.nci}, ${rs(n.nciBalance)}`).join("; ") || "No subsidiary with NCI.",
        actions: [], checks, sections: [nciSection(c), ...exclusionSections(c)],
        data: { nci: c.result.nci.map((n) => ({ ...n, netAssets: n.netAssets.toString(), nciNetAssets: n.nciNetAssets.toString(), profit: n.profit.toString(), nciProfit: n.nciProfit.toString(), nciBalance: n.nciBalance.toString() })) } };
    },
  };
  const perimeterOp: OpDef<{ asOf?: string }> = {
    name: "group_perimeter", title: "Consolidation perimeter", kind: "read", gate: "policy",
    description: "Who is in the group on a date: each entity's method (full, equity, excluded with the reason), ownership and effective interest, NCI and the source of its pack.",
    input: z.object({ asOf: IsoDate.optional() }),
    async plan(ctx, i) {
      const g = await svc.groupByBook(ctx.tenant, ctx.book);
      if (!g) return notGroup(ctx);
      const c = await svc.compute(ctx.tenant, g, i.asOf ?? ctx.today, { scope: await svc.scopeOf(ctx.tenant, ctx.principal, ctx.onBehalfOf) });
      const checks: Check[] = []; scopeCheck(c, checks, false);
      return { title: `Perimeter of group ${g.groupId} on ${i.asOf ?? ctx.today}`, summary: `${c.perimeter.length} entities in view.`, actions: [], checks, sections: [perimeterSection(c), ...exclusionSections(c)],
        data: { perimeter: c.perimeter.map((p) => ({ entityId: p.entityId, method: p.method, interest: pct(p.interest), nci: pct(p.nci), exclusion: p.exclusion, source: c.packs.get(p.entityId)?.source ?? null })),
          excluded: [...c.result.exclusions, ...c.outOfScope.map((x) => ({ entityId: x.entityId, reason: "outside your book scope" }))] } };
    },
  };

  return [groupStructure, groupOwnership, groupIcLink, consolidateOp, certifyGroup, icAdjust, groupTb, groupPnl, groupBs, icMismatches, nciOp, perimeterOp];
}
