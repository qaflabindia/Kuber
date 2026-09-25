/**
 * The consolidation service (FIN-GRP-01..04). Groups live in the group tenant; row-level security
 * stays per tenant. Everything that changes the register, the consolidation book or the group
 * close goes through an ops plan on the group's consolidation book (see operations.ts) and is
 * written here, by the `ext` handler, in that plan's commit transaction. Disputes are recorded
 * directly by each side's approver; resolution needs both.
 *
 * What this service never does:
 *   - post to, or change, a local (entity) book: the consolidation book is the only book it plans for;
 *     intercompany differences are cleared only by plans in each entity's own book (ic_adjust) that
 *     that entity's people approve;
 *   - read a linked subsidiary's ledger: a linked entity is known only by the packs it published.
 */
import type { TransactionSql } from "postgres";
import { canonical, sha256, stableId, uuid, type Envelope, type EventData } from "@kuber/contracts";
import type { EventStore, NewEvent } from "@kuber/eventstore";
import type { BookState, GeneralLedger } from "@kuber/gl";
import { OpsError, financialYear, type ExtensionHandler, type Operations } from "@kuber/ops";
import type { CertifiedSnapshot, Reporting } from "@kuber/reporting";
import { consolidate, consolidatedBalances, statements, RULES_VERSION, type EngineResult, type EntityPack, type GroupAccount, type StockInput, type TbRow } from "./engine.ts";
import { icSchedule, matchIc, balancePairs, type IcDisputeView, type IcItem } from "./ic.ts";
import { disputeDetailCtx, groupNameCtx, groupSnapshotCtx, positionNoteCtx, runStockCtx } from "./migrations.ts";
import { closeStream, disputeStream, emptyGroup, evolveGroup, groupStream, perimeter, type GroupEntity, type GroupState, type PerimeterEntry } from "./register.ts";
import type { Nature } from "./types.ts";
import type { LinkedTenants } from "./links.ts";

export class ConsolidationError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

/** The part of the identity module consolidation needs (the cell passes Identity). */
export interface ConsolidationGuard {
  /** Throws (403) unless `principal` may do `action` within `scope`. */
  authorize(tenant: string, principal: string, action: string, scope?: { book?: string; allBooks?: boolean }, tx?: TransactionSql): Promise<unknown>;
  /** The active membership (role, book scope; null books = every book), or null. */
  member(tenant: string, principal: string): Promise<{ role: string; books: string[] | null } | null>;
}

export interface ConsolidationDeps {
  store: EventStore; gl: GeneralLedger; reporting: Reporting; ops: Operations; guard: ConsolidationGuard;
  /** Legal entity of each registered party (the party master, FIN-MDM-03). */
  partyEntities: (tenant: string, partyIds: string[]) => Promise<Map<string, string>>;
  clock: () => string;
}

export interface RunRecord { runId: string; periodEnd: string; version: number; inputHash: string; registerVersion: number; status: "active" | "superseded";
  journals: { journalId: string; key: string; contentHash: string }[]; planId: string }
export interface Computation {
  group: GroupState; periodEnd: string; periodStart: string; perimeter: PerimeterEntry[];
  packs: Map<string, EntityPack>;
  /** In-perimeter entities with no pack at all (none certified and not readable live), with the reason. */
  missing: { entityId: string; reason: string }[];
  /** Entities outside the acting person's book scope: left out of everything, named. */
  outOfScope: { entityId: string; bookId: string }[];
  result: EngineResult;
}
export interface GroupSnapshotBody {
  groupId: string; periodEnd: string; registerVersion: number; rulesVersion: string; rulesHash: string; inputHash: string; runId: string;
  inputs: { entityId: string; method: string; source: string; packHash: string; ref: Record<string, unknown> }[];
  exclusions: { entityId: string; reason: string }[];
  eliminations: { key: string; contentHash: string }[];
  statements: unknown; nci: unknown; openIc: unknown;
}

const J = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const EXT = "consolidation";

export class Consolidation {
  /** Linked tenants (set by the cell after construction). */
  links!: LinkedTenants;
  constructor(readonly d: ConsolidationDeps) {}

  // ================================================================ register
  async group(tenant: string, groupId: string, tx?: TransactionSql): Promise<GroupState> {
    return (await this.d.store.readStream(tenant, groupStream(tenant, groupId), 0, tx)).reduce(evolveGroup, emptyGroup());
  }
  /** The register as it was at `version` (reproducing a certified close). */
  async groupAt(tenant: string, groupId: string, version: number): Promise<GroupState> {
    return (await this.d.store.readStream(tenant, groupStream(tenant, groupId))).filter((e) => e.streamVersion <= version).reduce(evolveGroup, emptyGroup());
  }
  async groupByBook(tenant: string, bookId: string): Promise<GroupState | null> {
    const [r] = await this.d.store.tenantTx(tenant, (tx) => tx<{ group_id: string }[]>`SELECT group_id FROM consolidation.groups WHERE tenant_id = ${tenant} AND book_id = ${bookId}`);
    return r ? this.group(tenant, r.group_id) : null;
  }
  async groups(tenant: string) {
    const keys = await this.d.store.keys(tenant);
    const rows = await this.d.store.tenantTx(tenant, (tx) => tx<{ group_id: string; book_id: string; parent_entity_id: string; name: string }[]>`
      SELECT group_id, book_id, parent_entity_id, name FROM consolidation.groups WHERE tenant_id = ${tenant} ORDER BY group_id`);
    return rows.map((r) => ({ groupId: r.group_id, bookId: r.book_id, parentEntityId: r.parent_entity_id, name: keys.openText(r.name, groupNameCtx(r.group_id)) }));
  }

  /**
   * Define a group and open its consolidation book (basis "consolidation", never statutory), in one
   * transaction. The book starts with no accounts: consolidation plans add the group accounts they post to.
   */
  async defineGroup(tenant: string, principal: string, g: { groupId: string; name: string; bookId: string; parentEntityId: string }) {
    await this.d.guard.authorize(tenant, principal, "book.open", { allBooks: true });
    const keys = await this.d.store.keys(tenant);
    await this.d.gl.transact(tenant, g.bookId, async (b) => {
      if (b.state.exists) throw new ConsolidationError("book_exists", `book ${g.bookId} already exists; a group needs a new consolidation book`);
      await b.execute({ kind: "OpenBook", bookId: g.bookId, entityId: `group-${g.groupId}`, entityType: "company", basis: "consolidation", accounts: [],
        legalEntityId: `group-${g.groupId}`, framework: "Consolidation" }, { principal });
      await this.d.store.append("consolidation", tenant, { streamId: groupStream(tenant, g.groupId), expected: "no_stream",
        events: [{ type: "GroupDefined", data: { groupId: g.groupId, name: g.name, bookId: g.bookId, parentEntityId: g.parentEntityId } }] }, { principal }, b.tx);
      await b.tx`INSERT INTO consolidation.groups (tenant_id, group_id, book_id, parent_entity_id, name, created_by)
        VALUES (${tenant}, ${g.groupId}, ${g.bookId}, ${g.parentEntityId}, ${keys.seal(g.name, groupNameCtx(g.groupId))}, ${principal})`;
    });
    return this.group(tenant, g.groupId);
  }

  /** Functional currency of an entity: its book's configuration when it has a book here, else the declared one. */
  async currencies(tenant: string, g: GroupState): Promise<(e: GroupEntity) => string> {
    const own = new Map<string, string>();
    for (const e of g.entities) if (e.bookId) { const s = await this.d.gl.state(tenant, e.bookId); if (s.exists) own.set(e.entityId, e.functionalCurrency !== "INR" ? e.functionalCurrency : s.config.functionalCurrency.code); }
    return (e) => own.get(e.entityId) ?? e.functionalCurrency;
  }

  // ================================================================ ext actions (run inside an ops commit)
  readonly extension: ExtensionHandler = async (tx, ctx, a) => {
    const p = a.payload as { groupId: string; registerVersion: number } & Record<string, unknown>;
    const g = await this.group(ctx.tenant, p.groupId, tx);
    if (!g.exists || g.bookId !== ctx.book) throw new OpsError("not_group_book", `this plan's book is not the consolidation book of group ${p.groupId}; nothing was applied`);
    const meta = { principal: ctx.principal, commandId: ctx.planId };
    const append = (events: NewEvent[], stream = groupStream(ctx.tenant, g.groupId), expected: number | "any" = "any") =>
      this.d.store.append("consolidation", ctx.tenant, { streamId: stream, expected, events }, meta, tx);
    // Register changes and runs are fenced on the register version they were simulated at.
    const fenced = () => { if (g.version !== p.registerVersion) throw new OpsError("stale", `the group register changed since this was simulated (version ${p.registerVersion} → ${g.version}); simulate again`); };
    switch (a.kind) {
      case "setEntities": {
        fenced();
        await append([{ type: "GroupEntitiesSet", data: { groupId: g.groupId, entities: p.entities as GroupEntity[], planId: ctx.planId } }], undefined, g.version);
        return `set ${(p.entities as unknown[]).length} group entities`;
      }
      case "setMapping": {
        fenced();
        const rows = p.mapping as { entityId: string; accountId: string; groupAccount: string; groupAccountName: string }[];
        await append(rows.map((m) => ({ type: "GroupMappingSet", data: { groupId: g.groupId, ...m, planId: ctx.planId } })), undefined, g.version);
        return `mapped ${rows.length} account(s) to the group chart`;
      }
      case "recordOwnership": {
        fenced();
        const r = p.record as Omit<EventData<"OwnershipRecorded">, "groupId" | "recordId" | "planId">;
        const recordId = stableId("ownership", `${ctx.tenant}/${g.groupId}/${ctx.planId}`);
        await append([{ type: "OwnershipRecorded", data: { groupId: g.groupId, recordId, ...r, planId: ctx.planId } }], undefined, g.version);
        return `recorded ownership ${r.parentEntityId} → ${r.childEntityId} from ${r.effectiveFrom}`;
      }
      case "linkParty": {
        fenced();
        const l = p.link as { entityId: string; partyId: string; counterpartyEntityId: string };
        await append([{ type: "IcPartyLinked", data: { groupId: g.groupId, ...l, planId: ctx.planId } }], undefined, g.version);
        await tx`INSERT INTO consolidation.ic_links (tenant_id, group_id, entity_id, party_id, counterparty_entity_id, plan_id)
          VALUES (${ctx.tenant}, ${g.groupId}, ${l.entityId}, ${l.partyId}, ${l.counterpartyEntityId}, ${ctx.planId})
          ON CONFLICT (tenant_id, group_id, entity_id, party_id) DO UPDATE SET counterparty_entity_id = EXCLUDED.counterparty_entity_id, plan_id = EXCLUDED.plan_id`;
        return `linked party ${l.partyId} of ${l.entityId} to entity ${l.counterpartyEntityId}`;
      }
      case "recordRun": {
        fenced();
        const r = p as unknown as { groupId: string; periodEnd: string; inputHash: string; registerVersion: number; journals: RunRecord["journals"]; supersedes: string[]; stock: unknown };
        const [{ v }] = await tx<{ v: number }[]>`SELECT COALESCE(max(version), 0)::int AS v FROM consolidation.runs
          WHERE tenant_id = ${ctx.tenant} AND group_id = ${g.groupId} AND period_end = ${r.periodEnd}` as unknown as [{ v: number }];
        const runId = stableId("consolidation-run", `${ctx.tenant}/${g.groupId}/${ctx.planId}`);
        if (r.supersedes.length) await tx`UPDATE consolidation.runs SET status = 'superseded' WHERE tenant_id = ${ctx.tenant} AND run_id IN ${tx(r.supersedes)}`;
        const keys = await this.d.store.keys(ctx.tenant);
        await tx`INSERT INTO consolidation.runs (tenant_id, run_id, group_id, period_end, version, input_hash, register_version, plan_id, status, journals, stock, created_by)
          VALUES (${ctx.tenant}, ${runId}, ${g.groupId}, ${r.periodEnd}, ${v + 1}, ${r.inputHash}, ${r.registerVersion}, ${ctx.planId}, 'active',
                  ${tx.json(r.journals as never)}, ${keys.sealJson(r.stock, runStockCtx(runId))}, ${ctx.approvedBy ?? ctx.principal})`;
        await append([{ type: "ConsolidationRunRecorded", data: { groupId: g.groupId, runId, periodEnd: r.periodEnd, version: v + 1, inputHash: r.inputHash,
          journals: r.journals, supersedes: r.supersedes, planId: ctx.planId } }], closeStream(ctx.tenant, g.groupId));
        return `recorded consolidation run v${v + 1} for ${r.periodEnd} (${r.journals.length} journal(s))`;
      }
      case "recordClose": {
        const c = p as unknown as { groupId: string; periodEnd: string; body: GroupSnapshotBody; contentHash: string };
        const [last] = await tx<{ snapshot_id: string; version: number; content_hash: string }[]>`SELECT snapshot_id, version, content_hash FROM consolidation.snapshots
          WHERE tenant_id = ${ctx.tenant} AND group_id = ${g.groupId} AND period_end = ${c.periodEnd} ORDER BY version DESC LIMIT 1 FOR UPDATE`;
        if (last?.content_hash === c.contentHash) return `already certified as version ${last.version} with the same content (${c.contentHash.slice(0, 12)}); no new version`;
        // Nothing may have moved since the simulation: the run it ties to must still be the active one.
        const [run] = await tx<{ status: string }[]>`SELECT status FROM consolidation.runs WHERE tenant_id = ${ctx.tenant} AND run_id = ${c.body.runId}`;
        if (run?.status !== "active") throw new OpsError("stale", "the consolidation run this close ties to is no longer active; simulate again");
        const snapshotId = stableId("group-close", `${ctx.tenant}/${g.groupId}/${ctx.planId}`), version = (last?.version ?? 0) + 1;
        const keys = await this.d.store.keys(ctx.tenant);
        await tx`INSERT INTO consolidation.snapshots (tenant_id, snapshot_id, group_id, period_end, version, content_hash, previous_snapshot_id, run_id, body, taken_by)
          VALUES (${ctx.tenant}, ${snapshotId}, ${g.groupId}, ${c.periodEnd}, ${version}, ${c.contentHash}, ${last?.snapshot_id ?? null}, ${c.body.runId},
                  ${keys.sealJson(c.body, groupSnapshotCtx(snapshotId))}, ${ctx.approvedBy ?? ctx.principal})`;
        await append([{ type: "GroupCloseCertified", data: { groupId: g.groupId, snapshotId, periodEnd: c.periodEnd, version, contentHash: c.contentHash,
          previousSnapshotId: last?.snapshot_id ?? null, runId: c.body.runId, planId: ctx.planId } }], closeStream(ctx.tenant, g.groupId));
        return `certified group close ${c.periodEnd} version ${version}${last ? ` (corrects version ${last.version})` : ""}: ${c.contentHash}`;
      }
      default: throw new OpsError("bad_action", `unknown consolidation action ${a.kind}`);
    }
  };

  // ================================================================ inputs
  /** The latest certified trial balance of a book as of `periodEnd`, verified against its content hash. */
  async certifiedTb(tenant: string, bookId: string, periodEnd: string): Promise<(CertifiedSnapshot & { verified: boolean }) | null> {
    const rows = (await this.d.reporting.listSnapshots(tenant, bookId)).filter((r) => r.kind === "trial-balance").reverse();
    for (const r of rows) {
      const s = await this.d.reporting.getSnapshot(tenant, r.snapshot_id);
      if (s && (s.params.asOf ?? s.params.to ?? null) === periodEnd) return s;
    }
    return null;
  }

  private tbFromState(s: BookState, periodEnd: string, upToSeq: number): TbRow[] {
    const bal = new Map<string, bigint>();
    let seq = 0;
    for (const j of s.journals.values()) {
      if (++seq > upToSeq) break;
      if (j.txnDate > periodEnd) continue;
      for (const l of j.lines) bal.set(l.accountId, (bal.get(l.accountId) ?? 0n) + BigInt(l.amount));
    }
    return this.rows(s, bal);
  }
  private rows(s: BookState, bal: Map<string, bigint>): TbRow[] {
    return [...bal].filter(([, v]) => v !== 0n).sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => {
      const a = s.accounts.get(id);
      return { accountId: id, name: a?.name ?? id, nature: (a?.nature ?? "asset") as Nature, taxonomyTag: a?.taxonomyTag ?? null, balance: v };
    });
  }

  /**
   * One entity's input for `periodEnd`. A book in this tenant: its latest certified trial balance for
   * the period (with the IC schedule at the same ledger position), else, unless `certifiedOnly`,
   * the live ledger (never certifiable). A linked entity: its latest readable published pack.
   */
  async packFor(tenant: string, g: GroupState, e: PerimeterEntry, periodEnd: string, periodStart: string, certifiedOnly: boolean): Promise<EntityPack | { missing: string }> {
    if (e.linkedTenant) {
      const lp = await this.links.latestPack(tenant, e.entityId, periodEnd);
      if (!lp) return { missing: `no certified pack for ${periodEnd} published by linked tenant ${e.linkedTenant}` };
      if (!lp.available) return { missing: `the pack from linked tenant ${e.linkedTenant} is unavailable: ${lp.reason}` };
      return lp.pack;
    }
    if (!e.bookId) return { missing: `${e.entityId} has no book in this tenant and no linked tenant: no pack can exist` };
    const s = await this.d.gl.state(tenant, e.bookId);
    if (!s.exists) return { missing: `book ${e.bookId} of ${e.entityId} does not exist` };
    const snap = await this.certifiedTb(tenant, e.bookId, periodEnd);
    if (snap && snap.verified) {
      // The certified statement gives the balances; the IC schedule is read at the same ledger position.
      const bal = new Map<string, bigint>(snap.statement.rows.map((r) => [r.accountId!, r.section === "Dr" ? BigInt(r.amount) : -BigInt(r.amount)]));
      const tb = this.rows(s, bal);
      const ic = icSchedule(e.entityId, s, g.icLinks, snap.seq, periodEnd, periodStart);
      const ref = { bookId: e.bookId, snapshotId: snap.snapshotId, contentHash: snap.contentHash, seq: snap.seq, ledgerHash: snap.ledgerHash };
      return { entityId: e.entityId, source: "certified", tb, ic, ref, packHash: packHashOf(e.entityId, ref, ic) };
    }
    if (certifiedOnly) return { missing: snap ? `the certified trial balance of ${e.bookId} for ${periodEnd} fails verification` : `no certified trial balance of ${e.bookId} as of ${periodEnd}` };
    const tb = this.tbFromState(s, periodEnd, s.seq), ic = icSchedule(e.entityId, s, g.icLinks, s.seq, periodEnd, periodStart);
    const ref = { bookId: e.bookId, live: true, seq: s.seq, ledgerHash: s.lastHash };
    return { entityId: e.entityId, source: "live", tb, ic, ref, packHash: packHashOf(e.entityId, ref, ic) };
  }

  /** Books the person may see (null: every book). The copilot acts within the person it works for. */
  async scopeOf(tenant: string, principal: string, onBehalfOf?: string): Promise<string[] | null> {
    const m = await this.d.guard.member(tenant, onBehalfOf ?? principal);
    return m ? m.books : [];
  }

  /**
   * Everything a consolidation needs for one group and period: the perimeter, each entity's pack
   * and the engine result. Entities outside `scope` are left out and named (the permitted subset).
   */
  async compute(tenant: string, g: GroupState, periodEnd: string, o: { stock?: StockInput[]; certifiedOnly?: boolean; scope?: string[] | null } = {}): Promise<Computation> {
    const parentBook = g.entities.find((e) => e.entityId === g.parentEntityId)?.bookId;
    const fyStartMonth = parentBook ? (await this.d.gl.state(tenant, parentBook)).config.fiscalYearStartMonth : 4;
    const periodStart = financialYear(periodEnd, fyStartMonth).from;
    const all = perimeter(g, periodEnd, await this.currencies(tenant, g));
    const scope = o.scope === undefined ? null : o.scope;
    const outOfScope = all.filter((p) => scope !== null && p.bookId !== null && !scope.includes(p.bookId)).map((p) => ({ entityId: p.entityId, bookId: p.bookId! }));
    const perim = all.filter((p) => !outOfScope.some((x) => x.entityId === p.entityId));
    const packs = new Map<string, EntityPack>(), missing: Computation["missing"] = [];
    for (const p of perim) {
      if (p.method === "excluded") continue;
      const r = await this.packFor(tenant, g, p, periodEnd, periodStart, !!o.certifiedOnly);
      if ("missing" in r) missing.push({ entityId: p.entityId, reason: r.missing }); else packs.set(p.entityId, r);
    }
    const result = consolidate(g, periodEnd, periodStart, perim, packs, o.stock ?? []);
    return { group: g, periodEnd, periodStart, perimeter: perim, packs, missing, outOfScope, result };
  }

  // ================================================================ runs and the consolidation book
  async runs(tenant: string, groupId: string): Promise<RunRecord[]> {
    const rows = await this.d.store.tenantTx(tenant, (tx) => tx<{ run_id: string; period_end: string; version: number; input_hash: string; register_version: number; status: RunRecord["status"]; journals: RunRecord["journals"]; plan_id: string }[]>`
      SELECT run_id, period_end::text, version, input_hash, register_version, status, journals, plan_id FROM consolidation.runs
      WHERE tenant_id = ${tenant} AND group_id = ${groupId} ORDER BY created_at, version`);
    return rows.map((r) => ({ runId: r.run_id, periodEnd: r.period_end, version: r.version, inputHash: r.input_hash, registerVersion: r.register_version, status: r.status, journals: r.journals, planId: r.plan_id }));
  }
  async runStock(tenant: string, runId: string): Promise<StockInput[]> {
    const [r] = await this.d.store.tenantTx(tenant, (tx) => tx<{ stock: string }[]>`SELECT stock FROM consolidation.runs WHERE tenant_id = ${tenant} AND run_id = ${runId}`);
    if (!r) return [];
    return ((await this.d.store.keys(tenant)).openJson<{ sellerEntityId: string; buyerEntityId: string; closingStockPaise: string; marginBp?: number; buyerInventoryAccount: string }[]>(r.stock, runStockCtx(runId)))
      .map((s) => ({ ...s, closingStockPaise: BigInt(s.closingStockPaise) }));
  }

  /** Consolidation book balances as of `periodEnd` (the active elimination set for that period), debit positive. */
  async bookBalances(tenant: string, bookId: string, periodEnd: string) {
    const s = await this.d.gl.state(tenant, bookId);
    const lines: { accountId: string; amount: bigint }[] = [];
    for (const j of s.journals.values()) if (j.txnDate <= periodEnd) for (const l of j.lines) lines.push({ accountId: l.accountId, amount: BigInt(l.amount) });
    return { state: s, lines };
  }

  /** Consolidated statements for a period: entity packs mapped and aggregated, plus the consolidation book as of that date. */
  async statements(tenant: string, bookId: string, periodEnd: string, scope: string[] | null) {
    const g = await this.groupByBook(tenant, bookId);
    if (!g) throw new ConsolidationError("no_group", `book ${bookId} is not a group's consolidation book`, 404);
    const c = await this.compute(tenant, g, periodEnd, { scope });
    const { state, lines } = await this.bookBalances(tenant, bookId, periodEnd);
    const accounts = new Map<string, GroupAccount>(c.result.groupAccounts);
    for (const a of state.accounts.values()) if (!accounts.has(a.accountId)) accounts.set(a.accountId, { accountId: a.accountId, name: a.name, nature: a.nature as Nature });
    // Out-of-scope entities: their eliminations cannot be shown without them either.
    const elim = c.outOfScope.length ? [] : lines;
    const bal = consolidatedBalances(c.result, elim);
    const active = (await this.runs(tenant, g.groupId)).filter((r) => r.status === "active");
    const run = active.find((r) => r.periodEnd === periodEnd) ?? null;
    return { computation: c, statements: statements(accounts, bal), run, runMatchesInputs: run?.inputHash === c.result.inputHash };
  }

  // ================================================================ intercompany
  async disputeViews(tenant: string, groupId: string): Promise<(IcDisputeView & { senderEntityId: string; receiverEntityId: string; positions: { entityId: string; principal: string; agreedPaise: string }[] })[]> {
    return this.d.store.tenantTx(tenant, async (tx) => {
      const ds = await tx<{ dispute_id: string; item_key: string; status: "open" | "resolved"; agreed_paise: string | null; sender_entity_id: string; receiver_entity_id: string }[]>`
        SELECT dispute_id, item_key, status, agreed_paise::text, sender_entity_id, receiver_entity_id FROM consolidation.disputes
        WHERE tenant_id = ${tenant} AND group_id = ${groupId} ORDER BY opened_at, dispute_id`;
      const ps = await tx<{ dispute_id: string; entity_id: string; principal: string; agreed_paise: string }[]>`
        SELECT dispute_id, entity_id, principal, agreed_paise::text FROM consolidation.dispute_positions WHERE tenant_id = ${tenant} ORDER BY recorded_at`;
      return ds.map((d) => ({ disputeId: d.dispute_id, itemKey: d.item_key, status: d.status, agreedPaise: d.agreed_paise, senderEntityId: d.sender_entity_id, receiverEntityId: d.receiver_entity_id,
        positions: ps.filter((p) => p.dispute_id === d.dispute_id).map((p) => ({ entityId: p.entity_id, principal: p.principal, agreedPaise: p.agreed_paise })) }));
    });
  }

  /** Matched, in-transit, mismatched and disputed IC items for a period, and the reciprocal balance check. */
  async mismatches(tenant: string, g: GroupState, periodEnd: string, scope: string[] | null) {
    const c = await this.compute(tenant, g, periodEnd, { scope });
    const disputes = await this.disputeViews(tenant, g.groupId);
    const txns = [...c.packs.values()].flatMap((p) => p.ic.txns).filter((t) => t.txnDate >= c.periodStart);
    const items = matchIc(txns, disputes);
    return { computation: c, items, balances: balancePairs([...c.packs.values()].flatMap((p) => p.ic.balances)), disputes };
  }

  async item(tenant: string, g: GroupState, key: string, periodEnd: string): Promise<IcItem | null> {
    return (await this.mismatches(tenant, g, periodEnd, null)).items.find((i) => i.key === key) ?? null;
  }

  private bookOf(g: GroupState, entityId: string) {
    const e = g.entities.find((x) => x.entityId === entityId);
    if (!e?.bookId) throw new ConsolidationError("no_book", `${entityId} has no book in this tenant: its position is recorded in its own tenant`);
    return e.bookId;
  }

  /** Put an IC difference in dispute: someone who may prepare plans in either side's book. */
  async openDispute(tenant: string, principal: string, groupId: string, i: { itemKey: string; periodEnd: string; reason: string }) {
    const g = await this.group(tenant, groupId);
    if (!g.exists) throw new ConsolidationError("no_group", `no group ${groupId}`, 404);
    const item = await this.item(tenant, g, i.itemKey, i.periodEnd);
    if (!item) throw new ConsolidationError("no_item", `no intercompany item ${i.itemKey} up to ${i.periodEnd}`, 404);
    if (item.status === "matched") throw new ConsolidationError("matched", "the item is matched: there is nothing to dispute");
    let ok = false;
    for (const e of [item.senderEntityId, item.receiverEntityId]) {
      try { await this.d.guard.authorize(tenant, principal, "plan.prepare", { book: this.bookOf(g, e) }); ok = true; break; } catch { /* try the other side */ }
    }
    if (!ok) throw new ConsolidationError("forbidden", `${principal} may prepare plans in neither ${item.senderEntityId} nor ${item.receiverEntityId}`, 403);
    const disputeId = uuid(), keys = await this.d.store.keys(tenant);
    await this.d.store.tenantTx(tenant, async (tx) => {
      await this.d.store.append("consolidation", tenant, { streamId: disputeStream(tenant, disputeId), expected: "no_stream", events: [{ type: "IcDisputeOpened", data: {
        disputeId, groupId, itemKey: item.key, senderEntityId: item.senderEntityId, receiverEntityId: item.receiverEntityId,
        sentPaise: item.sent.toString(), receivedPaise: item.received.toString(), classification: item.classification, reason: i.reason } }] }, { principal }, tx);
      try {
        await tx`INSERT INTO consolidation.disputes (tenant_id, dispute_id, group_id, item_key, sender_entity_id, receiver_entity_id, status, detail, opened_by)
          VALUES (${tenant}, ${disputeId}, ${groupId}, ${item.key}, ${item.senderEntityId}, ${item.receiverEntityId}, 'open',
                  ${keys.sealJson({ reason: i.reason, explanation: item.explanation, sent: item.sent.toString(), received: item.received.toString(), periodEnd: i.periodEnd }, disputeDetailCtx(disputeId))}, ${principal})`;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new ConsolidationError("dispute_open", `item ${item.key} already has an open dispute`);
        throw e;
      }
    });
    return { disputeId, itemKey: item.key, status: "open" as const };
  }

  /**
   * One side's approver records its position (the amount it agrees the document is). Resolution needs
   * both sides, recorded by two different people, agreeing on the amount. Nothing is posted anywhere:
   * each side then clears its own difference through a plan in its own book (ic_adjust).
   */
  async recordPosition(tenant: string, principal: string, disputeId: string, p: { entityId: string; agreedPaise: bigint; note: string }) {
    const [d] = await this.d.store.tenantTx(tenant, (tx) => tx<{ group_id: string; status: string; sender_entity_id: string; receiver_entity_id: string }[]>`
      SELECT group_id, status, sender_entity_id, receiver_entity_id FROM consolidation.disputes WHERE tenant_id = ${tenant} AND dispute_id = ${disputeId}`);
    if (!d) throw new ConsolidationError("no_dispute", `no dispute ${disputeId}`, 404);
    if (d.status !== "open") throw new ConsolidationError("resolved", "the dispute is already resolved");
    if (p.entityId !== d.sender_entity_id && p.entityId !== d.receiver_entity_id) throw new ConsolidationError("not_a_side", `${p.entityId} is not a side of this dispute`, 400);
    if (p.agreedPaise < 0n) throw new ConsolidationError("bad_amount", "the agreed amount cannot be negative", 400);
    const g = await this.group(tenant, d.group_id);
    // That side's approver: plan approval rights in that entity's book.
    await this.d.guard.authorize(tenant, principal, "plan.approve", { book: this.bookOf(g, p.entityId) });
    const keys = await this.d.store.keys(tenant);
    return this.d.store.tenantTx(tenant, async (tx) => {
      await tx`SELECT 1 FROM consolidation.disputes WHERE tenant_id = ${tenant} AND dispute_id = ${disputeId} FOR UPDATE`;
      const other = p.entityId === d.sender_entity_id ? d.receiver_entity_id : d.sender_entity_id;
      const [op] = await tx<{ principal: string; agreed_paise: string }[]>`SELECT principal, agreed_paise::text FROM consolidation.dispute_positions
        WHERE tenant_id = ${tenant} AND dispute_id = ${disputeId} AND entity_id = ${other}`;
      if (op && op.principal === principal) throw new ConsolidationError("same_person", `${principal} recorded ${other}'s position: the other side needs its own approver (bilateral resolution)`, 403);
      await tx`INSERT INTO consolidation.dispute_positions (tenant_id, dispute_id, entity_id, principal, agreed_paise, note)
        VALUES (${tenant}, ${disputeId}, ${p.entityId}, ${principal}, ${p.agreedPaise.toString()}, ${keys.seal(p.note, positionNoteCtx(disputeId, p.entityId))})
        ON CONFLICT (tenant_id, dispute_id, entity_id) DO UPDATE SET principal = EXCLUDED.principal, agreed_paise = EXCLUDED.agreed_paise, note = EXCLUDED.note, recorded_at = now()`;
      const events: NewEvent[] = [{ type: "IcDisputePositionRecorded", data: { disputeId, entityId: p.entityId, agreedPaise: p.agreedPaise.toString(), note: p.note } }];
      const resolved = !!op && BigInt(op.agreed_paise) === p.agreedPaise;
      if (resolved) {
        events.push({ type: "IcDisputeResolved", data: { disputeId, agreedPaise: p.agreedPaise.toString(),
          positions: [{ entityId: other, principal: op!.principal }, { entityId: p.entityId, principal }].sort((a, b) => a.entityId.localeCompare(b.entityId)) } });
        await tx`UPDATE consolidation.disputes SET status = 'resolved', agreed_paise = ${p.agreedPaise.toString()}, resolved_at = now() WHERE tenant_id = ${tenant} AND dispute_id = ${disputeId}`;
      }
      await this.d.store.append("consolidation", tenant, { streamId: disputeStream(tenant, disputeId), expected: "any", events }, { principal }, tx);
      return { disputeId, status: resolved ? "resolved" as const : "open" as const, waitingFor: resolved ? null : op ? `${other} recorded ${op.agreed_paise} paise; the positions differ` : `${other}'s approver` };
    });
  }

  async dispute(tenant: string, disputeId: string) {
    const [d] = await this.d.store.tenantTx(tenant, (tx) => tx<{ group_id: string; item_key: string; status: "open" | "resolved"; agreed_paise: string | null; sender_entity_id: string; receiver_entity_id: string; detail: string }[]>`
      SELECT group_id, item_key, status, agreed_paise::text, sender_entity_id, receiver_entity_id, detail FROM consolidation.disputes WHERE tenant_id = ${tenant} AND dispute_id = ${disputeId}`);
    if (!d) return null;
    const detail = (await this.d.store.keys(tenant)).openJson<{ reason: string; periodEnd: string; sent: string; received: string; explanation: string }>(d.detail, disputeDetailCtx(disputeId));
    return { disputeId, groupId: d.group_id, itemKey: d.item_key, status: d.status, agreedPaise: d.agreed_paise, senderEntityId: d.sender_entity_id, receiverEntityId: d.receiver_entity_id, ...detail };
  }

  /**
   * After a resolution, propose (never commit) one plan per side that must change, in that side's own
   * book, for that side's people to approve. `accounts`: per entity, the account the difference goes to.
   * Sides the person cannot prepare plans in are returned as skipped, named.
   */
  async proposeAdjustments(tenant: string, principal: string, disputeId: string, accounts: Record<string, string>, onBehalfOf?: string) {
    const d = await this.dispute(tenant, disputeId);
    if (!d) throw new ConsolidationError("no_dispute", `no dispute ${disputeId}`, 404);
    if (d.status !== "resolved") throw new ConsolidationError("not_resolved", "the dispute is not resolved: both sides must record the same position first");
    const g = await this.group(tenant, d.groupId);
    const plans = [], skipped: { entityId: string; reason: string }[] = [];
    for (const entityId of [d.senderEntityId, d.receiverEntityId]) {
      const account = accounts[entityId];
      if (!account) { skipped.push({ entityId, reason: "no account given for its adjustment" }); continue; }
      try {
        const p = await this.d.ops.plan(tenant, this.bookOf(g, entityId), principal, "ic_adjust", { disputeId, account }, onBehalfOf ? { onBehalfOf } : {});
        plans.push(p);
      } catch (e) { skipped.push({ entityId, reason: e instanceof Error ? e.message : String(e) }); }
    }
    return { plans, skipped };
  }

  // ================================================================ group closes (FIN-GRP-04)
  /** The snapshot a certification would record, from certified packs only; content hash over everything but identity and time. */
  snapshotBody(c: Computation, run: RunRecord, extra: { statements: unknown }): { body: GroupSnapshotBody; contentHash: string } {
    const body: GroupSnapshotBody = {
      groupId: c.group.groupId, periodEnd: c.periodEnd, registerVersion: c.group.version, rulesVersion: RULES_VERSION, rulesHash: c.result.rulesHash,
      inputHash: c.result.inputHash, runId: run.runId,
      inputs: c.perimeter.filter((p) => p.method !== "excluded").map((p) => ({ entityId: p.entityId, method: p.method, source: c.packs.get(p.entityId)?.source ?? "missing",
        packHash: c.packs.get(p.entityId)?.packHash ?? "", ref: c.packs.get(p.entityId)?.ref ?? {} })).sort((a, b) => a.entityId.localeCompare(b.entityId)),
      exclusions: c.result.exclusions,
      eliminations: c.result.journals.map((j) => ({ key: j.key, contentHash: j.contentHash })),
      statements: J(extra.statements), nci: J(c.result.nci), openIc: J(c.result.openIc),
    };
    // The run id is part of the body (it ties the close to the ledger) but not of the content hash, so a
    // rerun on identical packs and rules reproduces the same hash.
    const { runId: _r, ...content } = body;
    return { body, contentHash: sha256(canonical(content)) };
  }

  async closes(tenant: string, groupId: string) {
    return this.d.store.tenantTx(tenant, (tx) => tx<{ snapshot_id: string; period_end: string; version: number; content_hash: string; previous_snapshot_id: string | null; run_id: string; taken_by: string; taken_at: Date }[]>`
      SELECT snapshot_id, period_end::text, version, content_hash, previous_snapshot_id, run_id, taken_by, taken_at FROM consolidation.snapshots
      WHERE tenant_id = ${tenant} AND group_id = ${groupId} ORDER BY period_end, version`);
  }
  async close(tenant: string, snapshotId: string) {
    const [r] = await this.d.store.tenantTx(tenant, (tx) => tx<{ body: string; content_hash: string; version: number; previous_snapshot_id: string | null }[]>`
      SELECT body, content_hash, version, previous_snapshot_id FROM consolidation.snapshots WHERE tenant_id = ${tenant} AND snapshot_id = ${snapshotId}`);
    if (!r) return null;
    const body = (await this.d.store.keys(tenant)).openJson<GroupSnapshotBody>(r.body, groupSnapshotCtx(snapshotId));
    const { runId: _r, ...content } = body;
    return { snapshotId, version: r.version, previousSnapshotId: r.previous_snapshot_id, contentHash: r.content_hash, body, verified: sha256(canonical(content)) === r.content_hash };
  }

  /** Recompute a certified close from the same packs, register version and rules; compare hashes (FIN-GRP-04 rerun). */
  async reproduce(tenant: string, snapshotId: string) {
    const snap = await this.close(tenant, snapshotId);
    if (!snap) throw new ConsolidationError("no_snapshot", `no group close ${snapshotId}`, 404);
    const g = await this.groupAt(tenant, snap.body.groupId, snap.body.registerVersion);
    const stock = await this.runStock(tenant, snap.body.runId);
    const c = await this.compute(tenant, g, snap.body.periodEnd, { stock, certifiedOnly: true });
    const run = (await this.runs(tenant, g.groupId)).find((r) => r.runId === snap.body.runId)!;
    const st = statements(c.result.groupAccounts, consolidatedBalances(c.result, c.result.journals.flatMap((j) => j.lines)));
    const again = this.snapshotBody(c, run, { statements: st });
    return { snapshot: snap, contentHash: again.contentHash, matches: snap.verified && again.contentHash === snap.contentHash };
  }
}

/** Hash of an entity pack: the certified statement it rests on and its IC schedule at that position. */
export function packHashOf(entityId: string, ref: Record<string, unknown>, ic: EntityPack["ic"]) {
  return sha256(canonical({ entityId, ref, ic: J(ic) }));
}

export type { Envelope };
