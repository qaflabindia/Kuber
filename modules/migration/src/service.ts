/**
 * The migration service (FIN-MIG-01..03; design 16.7 legacy coexistence and migration).
 *
 * A migration project belongs to one Kuber book: its source system (tally | zoho | csv), cut-off date
 * and inventory scope. The waves of design 16.7 map onto it:
 *
 *   1 profile    importFile: source files are parsed by the adapter, retained sealed with their hash,
 *                and inventoried (masters, balances, open items, tax, stock, assets, commitments, history)
 *   2 map        mapping suggestions; a person approves each target (approveMapping). Unmapped ledgers
 *                with a balance, or with a line after the cut-off, block the load. Never to suspense.
 *   3 dry run    rehearse: the load into an isolated rehearsal book (`<book>.rh<n>`, basis "scenario"),
 *                reconciled to the source (trial balance by account, open items by party, counts)
 *   4 parallel   load (target book), delta imports of vouchers dated after the cut-off (idempotent),
 *                comparisons of Kuber's TB/P&L with the source's for a period, differences explained
 *   5 sign-off   goLive: a superuser signs the comparison and the checklist with a passkey; the book
 *                of record switches from the source to Kuber (the authority switch)
 *   6 cut over   after go-live, rollback is refused: recovery is the documented procedure (recovery())
 *
 * Rollback (FIN-MIG-03), two methods, by design:
 *   - a REHEARSAL is discarded whole: the rehearsal book is flagged discarded; it never touched the
 *     target book, so nothing needs reversing (its own immutable history stays in its own stream);
 *   - a TARGET load before go-live is voided as a batch with reversing entries dated like the
 *     originals: every journal the load and its delta imports posted is reversed, its open items and
 *     provenance are voided, so the target book's balances on every date return to what they were.
 *     Accounts the load added stay (with nil balances) and parties it registered stay in the party
 *     master (master data, listed in the provenance records).
 *
 * External effects (FIN-MIG-03): a rehearsal book is load-only. The cell registers `rehearsalGate`
 * as an ops book gate, so no operation that could issue an invoice, a payment or any other effect
 * outside Kuber (every write operation) runs in it. Documents and payments the source already issued
 * are recorded in the external-document register (externalDocument()) and never issued again.
 *
 * Every write passes the identity guard (`migration.manage` in the project's book; the go-live
 * `authority.manage`) inside its transaction, and every write appends to the project's sealed stream.
 */
import type { TransactionSql } from "postgres";
import { canonical, isIsoDate, sha256, stableId, type Account, type BankDetails, type CommandSignature, type CommandSummary, type EventData } from "@kuber/contracts";
import type { EventStore, ModuleGuard, NewEvent } from "@kuber/eventstore";
import { DomainError, type BookState, type BookTx, type GeneralLedger } from "@kuber/gl";
import { addDays, decodeUpload, kindsOf, mergeExtracts, parseSource, sha256Hex, MAX_FILE_CHARS } from "./adapters.ts";
import { isSuspenseAccount, suggestMappings, type NewAccountSpec } from "./mapping.ts";
import { comparisonBodyCtx, comparisonExplanationsCtx, decisionDetailCtx, fileExtractCtx, fileNameCtx, fileOriginalCtx, mappingDetailCtx, recordSourceCtx } from "./migrations.ts";
import { bookBalances, buildPlan, cutoffBalances, partyIdFor, type LoadPlan, type MappingRow } from "./plan.ts";
import { INVENTORY, MigrationError, type Extract, type SourceSystem, type SrcAccount } from "./types.ts";

type TenantKeys = Awaited<ReturnType<EventStore["keys"]>>;
const ID = /^[A-Za-z0-9_.:@+-]{1,200}$/;

/** The party master operations a load needs (the cell passes PartyMaster). */
export interface PartyPort {
  get(tenant: string, partyId: string): Promise<unknown | null>;
  register(tenant: string, principal: string, p: { partyId: string; entityId: string; kind: "vendor" | "customer" | "both"; name: string; effectiveFrom?: string;
    terms?: { creditDays: number }; taxStatus?: { gstin?: string; pan?: string; gstRegistered: boolean } }): Promise<unknown>;
  requestBankChange(tenant: string, principal: string, partyId: string, c: { bank: BankDetails; effectiveFrom?: string; source?: string; changeId?: string }): Promise<unknown>;
}
/** Statement lines per instrument (account) of a book: dates, for the bank coverage check. */
export type CoverageSource = (tenant: string, book: string) => Promise<Map<string, string[]>>;

/**
 * Statement-period coverage of a GL bank account from a bank-account register (modules/bank,
 * FIN-CASH-01): verified statements' declared periods over `from`..`to`, with their gaps. Null
 * when the account is not registered there; the line-date check applies to it instead.
 */
export type BankCoverageSource = (tenant: string, book: string, accountId: string, from: string, to: string) =>
  Promise<{ bankAccountId: string; complete: boolean; gaps: { from: string; to: string }[]; statements: number; held: number } | null>;
export interface MigrationDeps { store: EventStore; gl: GeneralLedger; parties: PartyPort; guard: ModuleGuard; clock: () => string; coverage?: CoverageSource; bankCoverage?: BankCoverageSource }

export interface ProjectRow { projectId: string; bookId: string; sourceSystem: SourceSystem; cutoff: string; scope: string[]; status: "open" | "live" | "closed";
  bookOfRecord: "source" | "kuber"; goLive: string | null; createdBy: string }
export interface LoadRow { loadId: string; projectId: string; bookId: string; kind: "rehearsal" | "target"; seq: number; status: "active" | "voided"; journalIds: string[];
  contentHash: string; reconciled: boolean; voidMethod: string | null; createdBy: string }

/** Operations the rehearsal gate lets through: read operations only (nothing is issued, paid or posted). */
export const REHEARSAL_POLICY = "a migration rehearsal book is load-only: no operation that could issue an invoice, a payment or any other effect outside Kuber runs in it (FIN-MIG-03)";
/** Problems that make a load impossible even as a rehearsal (the rest are reported by the rehearsal). */
const POSTING_BLOCKERS = new Set(["unmapped", "needs_control", "control_without_party", "suspense_target", "closed_target", "source_tb_unbalanced", "nothing_to_load",
  "bad_new_account", "open_items_do_not_explain_control", "multiple_control_accounts", "control_without_items"]);
export const EXPLANATION_CATEGORIES = ["timing", "process", "classification", "source_error", "kuber_error", "accepted"] as const;
const VOUCHER_TYPES: Record<string, string> = { sales: "sales", "sales invoice": "sales", purchase: "purchase", bill: "purchase", payment: "payment", receipt: "receipt",
  journal: "journal", contra: "contra", "credit note": "credit_note", "debit note": "debit_note" };
const J = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const s = (v: bigint) => v.toString();

/** The recovery procedure after cut-over (FIN-MIG-03): documented, not an automatic rollback. */
export const RECOVERY_PROCEDURE = [
  "1. Declare a financial incident (FIN-OPS-02) naming the book, the periods since go-live and the possible duplication; the incident owner leads recovery.",
  "2. Do not roll back: after go-live Kuber is the book of record and a posted journal can only be reversed. Post-cutover transactions stay in the book and are reconciled, never deleted.",
  "3. If the data is damaged, restore books, evidence, keys, policies and workflow states together into an isolated environment (FIN-OPS-01, scripts/restore-drill.sh) and compare with ops drill-compare; projections are rebuilt without repeating external actions.",
  "4. Fall back per the recorded fallback decision: each process runs in the system and with the operator the decision names until the incident closes.",
  "5. Documents and payments already issued outside Kuber are in the external-document register: they are recorded, never issued again, in either system.",
  "6. Correct with reversing or adjusting journals approved through ops plans; reconcile the book to bank statements and to the source's last trial balance for the affected periods.",
  "7. Close the incident only when the affected population is reconciled and the corrections are approved (FIN-OPS-02).",
];

export class Migration {
  constructor(readonly d: MigrationDeps) {}

  private stream = (tenant: string, projectId: string) => `${tenant}/migration/${projectId}`;
  private append(tx: TransactionSql, tenant: string, projectId: string, events: NewEvent[], principal: string, expected: number | "any" | "no_stream" = "any") {
    return this.d.store.append("migration", tenant, { streamId: this.stream(tenant, projectId), expected, events }, { principal }, tx);
  }
  private permit(tenant: string, principal: string, book: string, tx: TransactionSql, action = "migration.manage") {
    return this.d.guard.permit(tenant, principal, action, { book }, tx);
  }
  private idx(keys: TenantKeys, system: string, kind: string, id: string) { return keys.index("migration-source", `${system}|${kind}|${id}`); }

  // ================================================================ projects
  async createProject(tenant: string, principal: string, p: { projectId?: string; bookId: string; sourceSystem: SourceSystem; cutoff: string; scope?: string[] }): Promise<ProjectRow> {
    if (!isIsoDate(p.cutoff)) throw new MigrationError("bad_date", `cut-off ${p.cutoff} is not a real date`, 400);
    if (!["tally", "zoho", "csv"].includes(p.sourceSystem)) throw new MigrationError("bad_source", "source system is tally, zoho or csv", 400);
    const scope = p.scope ?? [...INVENTORY];
    const bad = scope.filter((c) => !(INVENTORY as readonly string[]).includes(c));
    if (bad.length) throw new MigrationError("bad_scope", `unknown inventory categories: ${bad.join(", ")} (known: ${INVENTORY.join(", ")})`, 400);
    const projectId = p.projectId ?? `mig-${p.bookId}-${p.cutoff}`;
    if (!ID.test(projectId)) throw new MigrationError("bad_id", "project id: letters, digits and _.:@+-", 400);
    const st = await this.d.gl.state(tenant, p.bookId);
    if (!st.exists) throw new MigrationError("no_book", `book ${p.bookId} does not exist: open it first`, 404);
    if (st.config.basis === "consolidation") throw new MigrationError("bad_book", "a consolidation book cannot be migrated into", 409);
    await this.d.store.tenantTx(tenant, async (tx) => {
      await this.permit(tenant, principal, p.bookId, tx);
      const [open] = await tx`SELECT project_id FROM migration.projects WHERE tenant_id = ${tenant} AND book_id = ${p.bookId} AND status = 'open'`;
      if (open) throw new MigrationError("project_open", `book ${p.bookId} already has an open migration project (${open.project_id})`);
      const [dup] = await tx`SELECT 1 FROM migration.projects WHERE tenant_id = ${tenant} AND project_id = ${projectId}`;
      if (dup) throw new MigrationError("project_exists", `migration project ${projectId} already exists`);
      await tx`INSERT INTO migration.projects (tenant_id, project_id, book_id, source_system, cutoff, scope, status, created_by)
        VALUES (${tenant}, ${projectId}, ${p.bookId}, ${p.sourceSystem}, ${p.cutoff}, ${tx.json(scope)}, 'open', ${principal})`;
      await this.append(tx, tenant, projectId, [{ type: "MigrationProjectCreated", data: { projectId, bookId: p.bookId, sourceSystem: p.sourceSystem, cutoff: p.cutoff, scope } }], principal, "no_stream");
    });
    return (await this.project(tenant, projectId))!;
  }

  async project(tenant: string, projectId: string, tx?: TransactionSql): Promise<ProjectRow | null> {
    const q = (t: TransactionSql) => t<{ project_id: string; book_id: string; source_system: SourceSystem; cutoff: string; scope: string[]; status: ProjectRow["status"];
      book_of_record: ProjectRow["bookOfRecord"]; go_live: string | null; created_by: string }[]>`
      SELECT project_id, book_id, source_system, cutoff::text, scope, status, book_of_record, go_live::text, created_by FROM migration.projects
      WHERE tenant_id = ${tenant} AND project_id = ${projectId}`;
    const [r] = tx ? await q(tx) : await this.d.store.tenantTx(tenant, q);
    return r ? { projectId: r.project_id, bookId: r.book_id, sourceSystem: r.source_system, cutoff: r.cutoff, scope: r.scope, status: r.status,
      bookOfRecord: r.book_of_record, goLive: r.go_live, createdBy: r.created_by } : null;
  }
  private async need(tenant: string, projectId: string, tx?: TransactionSql) {
    const p = await this.project(tenant, projectId, tx);
    if (!p) throw new MigrationError("no_project", `no migration project ${projectId}`, 404);
    return p;
  }
  private open(p: ProjectRow) {
    if (p.status !== "open") throw new MigrationError("post_cutover", `project ${p.projectId} went live on ${p.goLive}: Kuber is the book of record; use the recovery procedure (FIN-MIG-03)`);
  }

  async projects(tenant: string) {
    const rows = await this.d.store.tenantTx(tenant, (tx) => tx<{ project_id: string }[]>`SELECT project_id FROM migration.projects WHERE tenant_id = ${tenant} ORDER BY created_at, project_id`);
    return Promise.all(rows.map((r) => this.project(tenant, r.project_id) as Promise<ProjectRow>));
  }

  // ================================================================ files and inventory (FIN-MIG-01)
  async importFile(tenant: string, principal: string, projectId: string, f: { name: string; content: string; encoding?: "utf8" | "base64"; purpose?: "source" | "delta" | "comparison"; asOf?: string }) {
    const p = await this.need(tenant, projectId);
    this.open(p);
    const purpose = f.purpose ?? "source";
    if (f.asOf !== undefined && !isIsoDate(f.asOf)) throw new MigrationError("bad_date", `as-of ${f.asOf} is not a real date`, 400);
    if (purpose === "comparison" && !f.asOf) throw new MigrationError("as_of_required", "a comparison trial balance needs the date it is as at (asOf)", 400);
    if (f.content.length > MAX_FILE_CHARS * (f.encoding === "base64" ? 2 : 1)) throw new MigrationError("file_too_large", `the file is larger than ${MAX_FILE_CHARS} characters`, 413);
    const { text, bytes } = decodeUpload(f.content, f.encoding ?? "utf8");
    const hash = sha256Hex(bytes);
    const x = parseSource(p.sourceSystem, text, { fileHash: hash, purpose, asOf: f.asOf ?? null });
    const counts = kindsOf(x);
    if (!Object.keys(counts).length) throw new MigrationError("empty_file", `nothing readable in ${f.name}${x.problems.length ? `: ${x.problems.slice(0, 3).join("; ")}` : ""}`, 422, x.problems.slice(0, 50));
    x.files = [{ hash, name: f.name.slice(0, 200), bytes: bytes.length, kinds: Object.keys(counts), purpose, asOf: f.asOf ?? null }];
    const fileId = stableId("migration-file", `${tenant}/${projectId}/${hash}/${purpose}`);
    const keys = await this.d.store.keys(tenant);
    const duplicate = await this.d.store.tenantTx(tenant, async (tx) => {
      await this.permit(tenant, principal, p.bookId, tx);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${this.stream(tenant, projectId)}, 0))`;
      const [dup] = await tx`SELECT 1 FROM migration.files WHERE tenant_id = ${tenant} AND file_id = ${fileId}`;
      if (dup) return true;
      await tx`INSERT INTO migration.files (tenant_id, file_id, project_id, file_hash, purpose, as_of, byte_length, counts, problems, name, original, extract, uploaded_by)
        VALUES (${tenant}, ${fileId}, ${projectId}, ${hash}, ${purpose}, ${f.asOf ?? null}, ${bytes.length}, ${tx.json(counts)}, ${x.problems.length},
          ${keys.seal(f.name.slice(0, 200), fileNameCtx(fileId))}, ${keys.seal(bytes.toString("base64"), fileOriginalCtx(fileId))}, ${keys.sealJson(x, fileExtractCtx(fileId))}, ${principal})`;
      await this.append(tx, tenant, projectId, [{ type: "MigrationFileImported", data: { projectId, fileId, fileHash: hash, purpose, kinds: Object.keys(counts), counts } }], principal);
      if (purpose !== "comparison") await this.refreshSuggestions(tx, tenant, p, keys);
      return false;
    });
    return { fileId, fileHash: hash, duplicate, purpose, counts, problems: x.problems.slice(0, 100), inventory: await this.inventory(tenant, projectId) };
  }

  /** The project's files of the given purposes, merged into one extract (oldest first). */
  async extract(tenant: string, projectId: string, purposes: ("source" | "delta" | "comparison")[] = ["source", "delta"], tx?: TransactionSql): Promise<Extract> {
    const p = await this.need(tenant, projectId, tx);
    const keys = await this.d.store.keys(tenant);
    const q = (t: TransactionSql) => t<{ file_id: string; extract: string }[]>`SELECT file_id, extract FROM migration.files
      WHERE tenant_id = ${tenant} AND project_id = ${projectId} AND purpose IN ${t(purposes)} ORDER BY created_at, file_id`;
    const rows = tx ? await q(tx) : await this.d.store.tenantTx(tenant, q);
    return mergeExtracts(p.sourceSystem, rows.map((r) => keys.openJson<Extract>(r.extract, fileExtractCtx(r.file_id))));
  }

  async files(tenant: string, projectId: string) {
    const keys = await this.d.store.keys(tenant);
    const rows = await this.d.store.tenantTx(tenant, (tx) => tx<{ file_id: string; file_hash: string; purpose: string; as_of: string | null; byte_length: number; counts: Record<string, number>;
      problems: number; name: string; uploaded_by: string; created_at: Date }[]>`
      SELECT file_id, file_hash, purpose, as_of::text, byte_length, counts, problems, name, uploaded_by, created_at FROM migration.files
      WHERE tenant_id = ${tenant} AND project_id = ${projectId} ORDER BY created_at, file_id`);
    return rows.map((r) => ({ fileId: r.file_id, fileHash: r.file_hash, purpose: r.purpose, asOf: r.as_of, bytes: r.byte_length, counts: r.counts, problems: r.problems,
      name: keys.openText(r.name, fileNameCtx(r.file_id)), uploadedBy: r.uploaded_by, at: r.created_at.toISOString() }));
  }

  /** The original bytes of a retained source file, with its hash re-verified (evidence). */
  async original(tenant: string, projectId: string, fileId: string) {
    const keys = await this.d.store.keys(tenant);
    const [r] = await this.d.store.tenantTx(tenant, (tx) => tx<{ file_hash: string; original: string; purpose: string }[]>`
      SELECT file_hash, original, purpose FROM migration.files WHERE tenant_id = ${tenant} AND project_id = ${projectId} AND file_id = ${fileId}`);
    if (!r) return null;
    const bytes = Buffer.from(keys.openText(r.original, fileOriginalCtx(fileId)), "base64");
    return { fileId, fileHash: r.file_hash, purpose: r.purpose, contentBase64: bytes.toString("base64"), bytes: bytes.length, verified: sha256Hex(bytes) === r.file_hash };
  }

  /** Inventory (FIN-MIG-01): what the source holds per category, and whether the project's scope takes it. */
  async inventory(tenant: string, projectId: string) {
    const p = await this.need(tenant, projectId);
    const x = await this.extract(tenant, projectId);
    const bal = cutoffBalances(x, p.cutoff);
    const val = (xs: { value: string | null }[]) => s(xs.reduce((a, v) => a + (v.value ? BigInt(v.value) : 0n), 0n));
    const sched = (k: string) => x.schedules.filter((v) => v.kind === k);
    const rows: Record<string, { count: number; detail: Record<string, unknown> }> = {
      masters: { count: x.accounts.length + x.parties.length, detail: { accounts: x.accounts.length, groups: x.groups.length, parties: x.parties.length,
        partiesWithBankDetails: x.parties.filter((q) => q.bank).length, customers: x.parties.filter((q) => q.kind !== "vendor").length, vendors: x.parties.filter((q) => q.kind !== "customer").length } },
      opening_balances: { count: [...bal.values()].filter((v) => v !== 0n).length, detail: { cutoff: p.cutoff, basis: x.openingAsOf,
        debits: s([...bal.values()].filter((v) => v > 0n).reduce((a, v) => a + v, 0n)), credits: s(-[...bal.values()].filter((v) => v < 0n).reduce((a, v) => a + v, 0n)) } },
      open_items: { count: x.openItems.length, detail: { receivables: x.openItems.filter((i) => i.kind === "receivable").length, payables: x.openItems.filter((i) => i.kind === "payable").length } },
      tax: { count: sched("tax").length + x.parties.filter((q) => q.gstin).length, detail: { taxLedgers: sched("tax").length, partyGstins: x.parties.filter((q) => q.gstin).length } },
      stock: { count: sched("stock").length, detail: { value: val(sched("stock")) } },
      assets: { count: sched("assets").length, detail: { value: val(sched("assets")) } },
      commitments: { count: sched("commitments").length, detail: { value: val(sched("commitments")) } },
      history: { count: x.vouchers.filter((v) => v.date <= p.cutoff).length, detail: { vouchersAfterCutoff: x.vouchers.filter((v) => v.date > p.cutoff && !v.cancelled).length,
        cancelled: x.vouchers.filter((v) => v.cancelled).length } },
    };
    return { cutoff: p.cutoff, sourceSystem: p.sourceSystem, files: x.files.length, problems: x.problems.length,
      categories: INVENTORY.map((c) => ({ category: c, inScope: p.scope.includes(c), ...rows[c]! })) };
  }

  // ================================================================ mapping (FIN-MIG-01)
  private async refreshSuggestions(tx: TransactionSql, tenant: string, p: ProjectRow, keys: TenantKeys) {
    const x = await this.extract(tenant, p.projectId, ["source", "delta"], tx);
    const st = await this.d.gl.state(tenant, p.bookId);
    const chart = [...st.accounts.values()].filter((a) => !st.closed.has(a.accountId));
    const sug = suggestMappings(x.accounts, chart);
    for (const a of x.accounts) {
      const si = this.idx(keys, p.sourceSystem, "ledger", a.key);
      const g = sug.get(a.key) ?? null;
      const detail = keys.sealJson({ key: a.key, name: a.name, group: a.group, nature: a.nature, party: a.party, control: a.control ?? null, bank: a.bank, code: a.code ?? null,
        reason: g?.reason ?? null }, mappingDetailCtx(p.projectId, si));
      const partyId = a.party ? partyIdFor(p.sourceSystem, a.key) : null;
      await tx`INSERT INTO migration.mappings (tenant_id, project_id, source_idx, detail, status, account_id, party_id, new_account, suggested_account_id, score)
        VALUES (${tenant}, ${p.projectId}, ${si}, ${detail}, 'suggested', ${g?.accountId ?? null}, ${partyId}, ${g?.newAccount ? tx.json(g.newAccount as never) : null}, ${g?.accountId ?? null}, ${g?.score ?? null})
        ON CONFLICT (tenant_id, project_id, source_idx) DO UPDATE SET detail = EXCLUDED.detail, account_id = EXCLUDED.account_id, party_id = EXCLUDED.party_id,
          new_account = EXCLUDED.new_account, suggested_account_id = EXCLUDED.suggested_account_id, score = EXCLUDED.score
        WHERE migration.mappings.status = 'suggested'`;
    }
  }

  private async mappingRows(tenant: string, projectId: string, keys: TenantKeys, tx?: TransactionSql) {
    const q = (t: TransactionSql) => t<{ source_idx: string; detail: string; status: "suggested" | "approved"; account_id: string | null; party_id: string | null;
      new_account: NewAccountSpec | null; suggested_account_id: string | null; score: string | null; approved_by: string | null }[]>`
      SELECT source_idx, detail, status, account_id, party_id, new_account, suggested_account_id, score::text, approved_by FROM migration.mappings
      WHERE tenant_id = ${tenant} AND project_id = ${projectId}`;
    const rows = tx ? await q(tx) : await this.d.store.tenantTx(tenant, q);
    return rows.map((r) => ({ ...r, d: keys.openJson<{ key: string; name: string; group: string | null; nature: string | null; party: string | null; control: string | null; bank: boolean; code: string | null; reason: string | null }>(r.detail, mappingDetailCtx(projectId, r.source_idx)) }));
  }
  private async mappingMap(tenant: string, projectId: string, keys: TenantKeys, tx?: TransactionSql): Promise<Map<string, MappingRow>> {
    return new Map((await this.mappingRows(tenant, projectId, keys, tx)).map((r) => [r.d.key, { sourceKey: r.d.key, accountId: r.account_id, partyId: r.party_id, newAccount: r.new_account, status: r.status }]));
  }

  /** Every source ledger with its suggestion or approved target, its cut-off balance and whether it is used after the cut-off. */
  async mapping(tenant: string, projectId: string) {
    const p = await this.need(tenant, projectId);
    const keys = await this.d.store.keys(tenant);
    const x = await this.extract(tenant, projectId);
    const bal = cutoffBalances(x, p.cutoff);
    const used = new Set(x.vouchers.filter((v) => v.date > p.cutoff && !v.cancelled).flatMap((v) => v.lines.map((l) => l.accountKey)));
    const rows = (await this.mappingRows(tenant, projectId, keys)).map((r) => ({ sourceKey: r.d.key, name: r.d.name, group: r.d.group, nature: r.d.nature, party: r.d.party, control: r.d.control,
      bank: r.d.bank, cutoffBalance: s(bal.get(r.d.key) ?? 0n), usedAfterCutoff: used.has(r.d.key), status: r.status, accountId: r.account_id, partyId: r.party_id, newAccount: r.new_account,
      suggestion: r.suggested_account_id ? { accountId: r.suggested_account_id, score: r.score === null ? null : Number(r.score), reason: r.d.reason } : null, approvedBy: r.approved_by }))
      .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
    const needed = rows.filter((r) => r.cutoffBalance !== "0" || r.usedAfterCutoff);
    return { rows, summary: { total: rows.length, approved: rows.filter((r) => r.status === "approved").length, needed: needed.length,
      unmapped: needed.filter((r) => r.status !== "approved").length } };
  }

  /**
   * A person approves targets: an existing account (`accountId`), a new account (`newAccount`), or
   * the suggestion as shown (`acceptSuggested`: true for every suggestion, or the source keys).
   * Refused: suspense, closed or unknown accounts, a nature different from the source's, a party or
   * control ledger to a non-control account and an ordinary ledger to a control account.
   */
  async approveMapping(tenant: string, principal: string, projectId: string, input: { rows?: { sourceKey: string; accountId?: string; newAccount?: NewAccountSpec; partyId?: string }[];
    acceptSuggested?: true | string[] }) {
    const p = await this.need(tenant, projectId);
    this.open(p);
    const keys = await this.d.store.keys(tenant);
    const st = await this.d.gl.state(tenant, p.bookId);
    return this.d.store.tenantTx(tenant, async (tx) => {
      await this.permit(tenant, principal, p.bookId, tx);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${this.stream(tenant, projectId)}, 0))`;
      const rows = await this.mappingRows(tenant, projectId, keys, tx);
      const byKey = new Map(rows.map((r) => [r.d.key, r]));
      const wanted: { sourceKey: string; accountId?: string; newAccount?: NewAccountSpec; partyId?: string; suggested: boolean }[] = (input.rows ?? []).map((r) => ({ ...r, suggested: false }));
      if (input.acceptSuggested) {
        const pick = input.acceptSuggested === true ? rows.filter((r) => r.status === "suggested" && r.account_id).map((r) => r.d.key) : input.acceptSuggested;
        for (const k of pick) {
          const r = byKey.get(k);
          if (!r || !r.account_id) throw new MigrationError("no_suggestion", `no suggestion for ${k}`, 404);
          wanted.push({ sourceKey: k, ...(r.new_account ? { newAccount: r.new_account } : { accountId: r.account_id }), suggested: true });
        }
      }
      const newIds = new Map<string, NewAccountSpec>();
      for (const r of rows) if (r.status === "approved" && r.new_account) newIds.set(r.new_account.accountId, r.new_account);
      const events: NewEvent[] = [];
      for (const w of wanted) {
        const r = byKey.get(w.sourceKey);
        if (!r) throw new MigrationError("unknown_source", `no source ledger ${w.sourceKey} in this project`, 404);
        let account: Pick<Account, "accountId" | "nature" | "isControl" | "taxonomyTag">;
        let newAccount: NewAccountSpec | null = null;
        if (w.newAccount) {
          const n = w.newAccount;
          if (!ID.test(n.accountId) || !n.name?.trim() || !["asset", "liability", "equity", "income", "expense"].includes(n.nature)) throw new MigrationError("bad_new_account", `new account ${n.accountId} needs an id, a name and a nature`, 400);
          if (st.accounts.has(n.accountId)) throw new MigrationError("account_exists", `account ${n.accountId} already exists: map to it instead`, 409);
          const other = newIds.get(n.accountId);
          if (other && (other.nature !== n.nature || other.name !== n.name)) throw new MigrationError("account_conflict", `new account ${n.accountId} is already proposed differently`, 409);
          newAccount = { accountId: n.accountId, name: n.name.trim().slice(0, 120), nature: n.nature, isCashLike: !!n.isCashLike };
          newIds.set(n.accountId, newAccount);
          account = { accountId: n.accountId, nature: n.nature, isControl: false };
        } else {
          const a = w.accountId ? st.accounts.get(w.accountId) : undefined;
          if (!a) throw new MigrationError("no_account", `account ${w.accountId ?? "(none)"} is not in book ${p.bookId}`, 404);
          if (st.closed.has(a.accountId)) throw new MigrationError("account_closed", `account ${a.accountId} is closed`, 409);
          account = a;
        }
        if (isSuspenseAccount(account)) throw new MigrationError("suspense_target", "suspense is not a mapping target: a mapping gap cannot be hidden there (FIN-MIG-01)", 422);
        if (r.d.nature && r.d.nature !== account.nature) throw new MigrationError("nature_mismatch", `${w.sourceKey} is ${r.d.nature} in the source; ${account.accountId} is ${account.nature}`, 422);
        const role = r.d.party ?? (r.d.control ? "control" : null);
        if (role && !account.isControl) throw new MigrationError("needs_control", `${w.sourceKey} is a ${role === "control" ? "control account" : `${role} ledger`}: map it to a control account`, 422);
        if (!role && account.isControl) throw new MigrationError("control_without_party", `${w.sourceKey} is not a party ledger: it cannot go to control account ${account.accountId}`, 422);
        const partyId = r.d.party ? (w.partyId ?? r.party_id ?? partyIdFor(p.sourceSystem, w.sourceKey)) : null;
        if (partyId !== null && !ID.test(partyId)) throw new MigrationError("bad_party", `party id ${partyId} is not valid`, 400);
        await tx`UPDATE migration.mappings SET status = 'approved', account_id = ${account.accountId}, new_account = ${newAccount ? tx.json(newAccount as never) : null},
          party_id = ${partyId}, approved_by = ${principal}, approved_at = now() WHERE tenant_id = ${tenant} AND project_id = ${projectId} AND source_idx = ${r.source_idx}`;
        events.push({ type: "MigrationMappingApproved", data: { projectId, sourceIdx: r.source_idx, accountId: account.accountId, ...(partyId ? { partyId } : {}), newAccount: !!newAccount, suggested: w.suggested } });
      }
      if (events.length) await this.append(tx, tenant, projectId, events, principal);
      return { approved: events.length };
    }).then(async (r) => ({ ...r, summary: (await this.mapping(tenant, projectId)).summary }));
  }

  // ================================================================ load plan and loads
  /** The load plan against the target book's chart (FIN-MIG-01): lines, open items, parties, problems. */
  async plan(tenant: string, projectId: string): Promise<LoadPlan> {
    const p = await this.need(tenant, projectId);
    const keys = await this.d.store.keys(tenant);
    const st = await this.d.gl.state(tenant, p.bookId);
    return buildPlan(await this.extract(tenant, projectId, ["source"]), p.cutoff, await this.mappingMap(tenant, projectId, keys), st.accounts, st.closed, p.scope);
  }
  planView(plan: LoadPlan) {
    return J({ cutoff: plan.cutoff, blocked: plan.blocked, problems: plan.problems, lines: plan.lines.map((l) => ({ accountId: l.accountId, partyId: l.partyId, amount: l.amount, sources: l.sources.length })),
      openItems: plan.openItems.length, parties: plan.parties.length, newAccounts: plan.newAccounts, schedules: plan.schedules, sourceTotals: plan.sourceTotals,
      sourceTbChecks: plan.sourceTbChecks.map((c) => ({ asOf: c.asOf, file: c.file, rows: c.rows, mismatches: c.mismatches.length })) });
  }

  private async nextSeq(tx: TransactionSql, tenant: string, projectId: string) {
    const [r] = await tx<{ n: number }[]>`SELECT coalesce(max(seq), 0)::int + 1 AS n FROM migration.loads WHERE tenant_id = ${tenant} AND project_id = ${projectId}`;
    return r!.n;
  }

  /** FIN-MIG-02: rehearse the load in an isolated rehearsal book and reconcile it to the source. */
  async rehearse(tenant: string, principal: string, projectId: string) {
    const p = await this.need(tenant, projectId);
    this.open(p);
    const plan = await this.plan(tenant, projectId);
    const blockers = plan.problems.filter((q) => q.blocking && POSTING_BLOCKERS.has(q.code));
    if (blockers.length) throw new MigrationError("load_blocked", `the rehearsal cannot load: ${blockers.slice(0, 5).map((q) => q.message).join("; ")}`, 409, blockers);
    const target = await this.d.gl.state(tenant, p.bookId);
    const seq = await this.d.store.tenantTx(tenant, (tx) => this.nextSeq(tx, tenant, projectId));
    const book = `${p.bookId}.rh${seq}`;
    const loadId = await this.d.gl.transact(tenant, book, async (b) => {
      await this.permit(tenant, principal, p.bookId, b.tx);
      if (b.state.exists) throw new MigrationError("book_exists", `rehearsal book ${book} already exists`);
      const c = target.config;
      await b.execute({ kind: "OpenBook", bookId: book, entityId: target.entityId, entityType: c.entityType, basis: "scenario",
        accounts: [...target.accounts.values()].filter((a) => !target.closed.has(a.accountId)),
        legalEntityId: c.legalEntityId, framework: c.framework, fiscalYearStartMonth: c.fiscalYearStartMonth, purpose: c.purpose }, { principal });
      const id = await this.applyLoad(b, tenant, principal, p, plan, "rehearsal", seq);
      await b.tx`INSERT INTO migration.rehearsal_books (tenant_id, book_id, project_id, load_id, status) VALUES (${tenant}, ${book}, ${projectId}, ${id}, 'active')`;
      return id;
    });
    return { loadId, bookId: book, kind: "rehearsal" as const, reconciliation: await this.reconciliation(tenant, projectId, loadId), plan: this.planView(plan) };
  }

  /** FIN-MIG-01: load the target book (pre-cutover): parties, one opening journal, open items (no GL repost). */
  async load(tenant: string, principal: string, projectId: string) {
    const p = await this.need(tenant, projectId);
    this.open(p);
    const plan = await this.plan(tenant, projectId);
    if (plan.blocked) throw new MigrationError("load_blocked", `the load is blocked: ${plan.problems.filter((q) => q.blocking).slice(0, 5).map((q) => q.message).join("; ")}`, 409, plan.problems.filter((q) => q.blocking));
    const st = await this.d.gl.state(tenant, p.bookId);
    const early = [...bookBalances(st.journals.values(), p.cutoff).byAccount].filter(([, v]) => v !== 0n);
    if (early.length) throw new MigrationError("book_not_empty", `book ${p.bookId} already has balances on or before the cut-off (${early.map(([a]) => a).slice(0, 5).join(", ")}): the opening would count them twice`, 409);
    // Parties first (the party master's own transaction and guard); bank details go through its maker-checker.
    const entityId = st.config.legalEntityId;
    const bankPending: string[] = [];
    for (const party of plan.parties) {
      if (!(await this.d.parties.get(tenant, party.partyId))) {
        await this.d.parties.register(tenant, principal, { partyId: party.partyId, entityId, kind: party.kind, name: party.name, effectiveFrom: p.cutoff,
          ...(party.creditDays !== undefined ? { terms: { creditDays: party.creditDays } } : {}),
          ...(party.gstin || party.pan ? { taxStatus: { gstRegistered: !!party.gstin, ...(party.gstin ? { gstin: party.gstin } : {}), ...(party.pan ? { pan: party.pan } : {}) } } : {}) });
      }
      if (party.bank) {
        await this.d.parties.requestBankChange(tenant, principal, party.partyId, { bank: party.bank, effectiveFrom: p.cutoff, source: `migration:${projectId}`,
          changeId: stableId("migration-bank", `${tenant}/${projectId}/${party.partyId}`) });
        bankPending.push(party.partyId);
      }
    }
    const seq = await this.d.store.tenantTx(tenant, (tx) => this.nextSeq(tx, tenant, projectId));
    const loadId = await this.d.gl.transact(tenant, p.bookId, (b) => this.permit(tenant, principal, p.bookId, b.tx).then(() => this.applyLoad(b, tenant, principal, p, plan, "target", seq)));
    return { loadId, bookId: p.bookId, kind: "target" as const, bankDetailsAwaitingVerification: bankPending,
      reconciliation: await this.reconciliation(tenant, projectId, loadId), plan: this.planView(plan) };
  }

  /** Accounts, the opening journal, open items and provenance, in the book's transaction. */
  private async applyLoad(b: BookTx, tenant: string, principal: string, p: ProjectRow, plan: LoadPlan, kind: "rehearsal" | "target", seq: number): Promise<string> {
    const keys = await this.d.store.keys(tenant);
    const book = b.state.bookId;
    const loadId = stableId("migration-load", `${tenant}/${p.projectId}/${seq}`);
    const stream = this.stream(tenant, p.projectId);
    const records: Record<string, unknown>[] = [];
    const rec = (k: string, targetId: string, src: { key: string; file: string; row: number; ref?: string }, content: unknown) => {
      const recordId = stableId("migration-record", `${tenant}/${loadId}/${k}/${targetId}/${src.key}`);
      records.push({ tenant_id: tenant, record_id: recordId, project_id: p.projectId, load_id: loadId, book_id: book, kind: k, target_id: targetId, source_system: p.sourceSystem,
        file_hash: src.file, source_row: src.row, source_idx: this.idx(keys, p.sourceSystem, k, src.key), source: keys.sealJson({ sourceId: src.key, ...(src.ref ? { ref: src.ref } : {}) }, recordSourceCtx(recordId)),
        content_hash: sha256(canonical(J(content))), status: "active" });
    };
    try {
      for (const a of plan.newAccounts) {
        if (b.state.accounts.has(a.accountId)) continue;
        await b.execute({ kind: "AddAccount", account: { accountId: a.accountId, name: a.name, nature: a.nature, isControl: false, isCashLike: a.isCashLike, requiredDims: [] } }, { principal });
      }
      const journalId = stableId("migration-opening", `${tenant}/${book}/${loadId}`);
      await b.execute({ kind: "PostJournal", journalId, txnDate: p.cutoff, narration: `Opening balances at ${p.cutoff} migrated from ${p.sourceSystem} (project ${p.projectId})`,
        voucherType: "opening", autonomy: "human", source: { stream },
        lines: plan.lines.map((l) => ({ accountId: l.accountId, amount: s(l.amount), ...(l.partyId ? { partyId: l.partyId } : {}), dimensions: {} })) }, { principal, commandId: loadId });
      // Provenance: each opening line from the source ledgers it carries; each new account from the ledger that asked for it.
      plan.lines.forEach((l, i) => { for (const src of l.sources) rec("opening_line", `${journalId}#${i + 1}`, src, { accountId: l.accountId, partyId: l.partyId, amount: src.amount }); });
      for (const a of plan.newAccounts) if (a.source) rec("account", a.accountId, a.source, { accountId: a.accountId, name: a.name, nature: a.nature });
      for (const party of plan.parties) rec("party", party.partyId, { key: party.key, file: party.file, row: party.row }, { partyId: party.partyId, kind: party.kind, registered: kind === "target" });
      // The subledger: open items, never posted.
      const items = plan.openItems.map((i) => {
        const itemId = stableId("migration-item", `${tenant}/${loadId}/${i.key}`);
        rec("open_item", itemId, { key: i.key, file: i.file, row: i.row, ref: i.docNo }, { partyId: i.partyId, docNo: i.docNo, amount: s(i.amount) });
        return { tenant_id: tenant, item_id: itemId, project_id: p.projectId, load_id: loadId, book_id: book, party_id: i.partyId, account_id: i.accountId, doc_no: i.docNo,
          doc_date: i.docDate, due_date: i.dueDate, amount_paise: s(i.amount), kind: i.kind, on_account: i.onAccount, status: "open" };
      });
      if (items.length) for (let k = 0; k < items.length; k += 500) await b.tx`INSERT INTO migration.open_items ${b.tx(items.slice(k, k + 500) as never)}`;
      // Documents the source issued before the cut-off (open invoices and bills): recorded, never issued again.
      for (const i of plan.openItems) {
        if (i.onAccount) continue;
        await b.tx`INSERT INTO migration.external_documents (tenant_id, source_system, doc_kind, doc_no, project_id, doc_date, amount_paise, source_idx)
          VALUES (${tenant}, ${p.sourceSystem}, ${i.kind === "receivable" ? "invoice" : "bill"}, ${i.docNo}, ${p.projectId}, ${i.docDate}, ${s(i.amount < 0n ? -i.amount : i.amount)},
            ${this.idx(keys, p.sourceSystem, "open_item", i.key)}) ON CONFLICT DO NOTHING`;
      }
      const x = await this.extract(tenant, p.projectId, ["source"], b.tx);
      for (const sc of x.schedules) if (p.scope.includes(sc.kind)) rec("schedule", `${sc.kind}:${sc.key}`, { key: `${sc.kind}:${sc.key}`, file: sc.file, row: sc.row }, sc);
      for (let k = 0; k < records.length; k += 500) await b.tx`INSERT INTO migration.records ${b.tx(records.slice(k, k + 500) as never)}`;
      const recon = this.reconcileState(plan, b.state, items.map((i) => ({ accountId: i.account_id, partyId: i.party_id, amount: BigInt(i.amount_paise) })), [journalId]);
      const contentHash = sha256(canonical(J({ lines: plan.lines.map((l) => ({ a: l.accountId, p: l.partyId, v: l.amount })), items: items.map((i) => [i.item_id, i.amount_paise]) })));
      await b.tx`INSERT INTO migration.loads (tenant_id, load_id, project_id, book_id, kind, seq, status, journal_ids, content_hash, reconciled, created_by)
        VALUES (${tenant}, ${loadId}, ${p.projectId}, ${book}, ${kind}, ${seq}, 'active', ${b.tx.json([journalId])}, ${contentHash}, ${recon.reconciled}, ${principal})`;
      await this.append(b.tx, tenant, p.projectId, [{ type: "MigrationLoadRecorded", data: { projectId: p.projectId, loadId, bookId: book, kind, journalIds: [journalId],
        openItems: items.length, records: records.length, reconciled: recon.reconciled, contentHash } }], principal);
      return loadId;
    } catch (e) {
      if (e instanceof DomainError) throw new MigrationError(e.code, `the ${kind} load was refused by the ledger, nothing was loaded: ${e.message}`, 422);
      if ((e as { code?: string }).code === "23505") throw new MigrationError("load_exists", "another load of this project or book is already active", 409);
      throw e;
    }
  }

  async loads(tenant: string, projectId: string): Promise<LoadRow[]> {
    const rows = await this.d.store.tenantTx(tenant, (tx) => tx<{ load_id: string; project_id: string; book_id: string; kind: LoadRow["kind"]; seq: number; status: LoadRow["status"];
      journal_ids: string[]; content_hash: string; reconciled: boolean; void_method: string | null; created_by: string }[]>`
      SELECT load_id, project_id, book_id, kind, seq, status, journal_ids, content_hash, reconciled, void_method, created_by FROM migration.loads
      WHERE tenant_id = ${tenant} AND project_id = ${projectId} ORDER BY seq`);
    return rows.map((r) => ({ loadId: r.load_id, projectId: r.project_id, bookId: r.book_id, kind: r.kind, seq: r.seq, status: r.status, journalIds: r.journal_ids,
      contentHash: r.content_hash, reconciled: r.reconciled, voidMethod: r.void_method, createdBy: r.created_by }));
  }
  private async needLoad(tenant: string, projectId: string, loadId?: string): Promise<LoadRow> {
    const all = await this.loads(tenant, projectId);
    const l = loadId ? all.find((x) => x.loadId === loadId) : all.filter((x) => x.status === "active").sort((a, b) => (a.kind === b.kind ? b.seq - a.seq : a.kind === "target" ? -1 : 1))[0];
    if (!l) throw new MigrationError("no_load", loadId ? `no load ${loadId} in project ${projectId}` : `project ${projectId} has no active load: rehearse or load first`, 404);
    return l;
  }

  // ================================================================ reconciliation (FIN-MIG-01 acceptance)
  /** Source against target: trial balance by account and totals, open items by party against the control accounts, counts. */
  private reconcileState(plan: LoadPlan, st: BookState, items: { accountId: string; partyId: string; amount: bigint }[], openingJournals: string[]) {
    const book = bookBalances(st.journals.values(), plan.cutoff);
    const src = new Map<string, bigint>();
    for (const l of plan.lines) src.set(l.accountId, (src.get(l.accountId) ?? 0n) + l.amount);
    const ids = [...new Set([...src.keys(), ...[...book.byAccount].filter(([, v]) => v !== 0n).map(([k]) => k)])].sort();
    const tb = ids.map((accountId) => { const a = src.get(accountId) ?? 0n, t = book.byAccount.get(accountId) ?? 0n; return { accountId, name: st.accounts.get(accountId)?.name ?? accountId, source: a, target: t, difference: t - a }; });
    const tot = (xs: bigint[]) => ({ debits: xs.filter((v) => v > 0n).reduce((a, v) => a + v, 0n), credits: -xs.filter((v) => v < 0n).reduce((a, v) => a + v, 0n) });
    const targetTotals = tot([...book.byAccount.values()]);
    // Open items per control account and party must equal the GL control balance at the cut-off.
    const itemSum = new Map<string, bigint>();
    for (const i of items) itemSum.set(`${i.accountId}|${i.partyId}`, (itemSum.get(`${i.accountId}|${i.partyId}`) ?? 0n) + i.amount);
    const controls = new Set([...st.accounts.values()].filter((a) => a.isControl).map((a) => a.accountId));
    const partyKeys = [...new Set([...itemSum.keys(), ...[...book.byParty.keys()].filter((k) => controls.has(k.split("|")[0]!) && book.byParty.get(k) !== 0n)])].sort();
    const withItems = plan.openItems.length > 0 || items.length > 0;
    const openItems = withItems ? partyKeys.map((k) => { const [accountId, partyId] = k.split("|") as [string, string]; const o = itemSum.get(k) ?? 0n, g = book.byParty.get(k) ?? 0n;
      return { accountId, partyId, openItems: o, control: g, difference: g - o }; }) : [];
    const controlTotals = [...controls].map((accountId) => ({ accountId, openItems: items.filter((i) => i.accountId === accountId).reduce((a, i) => a + i.amount, 0n), control: book.byAccount.get(accountId) ?? 0n }))
      .filter((c) => c.openItems !== 0n || c.control !== 0n);
    // Nothing but the opening journal(s) is in the book up to the cut-off: the open items did not post.
    const glJournals = [...st.journals.entries()].filter(([, j]) => j.txnDate <= plan.cutoff && !j.reversedBy && !j.narration.startsWith("Reversal of ")).map(([id]) => id);
    const counts = { sourceLedgers: plan.sourceTotals.ledgers, loadedLedgers: new Set(plan.lines.flatMap((l) => l.sources.map((x) => x.key))).size,
      sourceOpenItems: plan.openItems.length, loadedOpenItems: items.length, parties: plan.parties.length, openingJournals: openingJournals.length, journalsToCutoff: glJournals.length };
    const checks = {
      trialBalance: tb.every((r) => r.difference === 0n),
      totals: plan.sourceTotals.debits === targetTotals.debits && plan.sourceTotals.credits === targetTotals.credits,
      openItemsByParty: openItems.every((r) => r.difference === 0n) && (!withItems || controlTotals.every((c) => c.openItems === c.control)),
      counts: counts.sourceLedgers === counts.loadedLedgers && counts.sourceOpenItems === counts.loadedOpenItems,
      noGlRepost: glJournals.every((id) => openingJournals.includes(id)) && glJournals.length === openingJournals.length,
      sourceTotals: plan.sourceTbChecks.every((c) => c.mismatches.length === 0),
      schedules: plan.schedules.every((t) => t.ties),
    };
    return { cutoff: plan.cutoff, reconciled: Object.values(checks).every(Boolean), checks, trialBalance: tb, totals: { source: { debits: plan.sourceTotals.debits, credits: plan.sourceTotals.credits }, target: targetTotals },
      openItems, controlTotals, counts, schedules: plan.schedules, sourceTbChecks: plan.sourceTbChecks, problems: plan.problems };
  }

  /** The reconciliation of a load against its book as the book stands now. */
  async reconciliation(tenant: string, projectId: string, loadId?: string) {
    const l = await this.needLoad(tenant, projectId, loadId);
    const p = await this.need(tenant, projectId);
    const keys = await this.d.store.keys(tenant);
    const target = await this.d.gl.state(tenant, p.bookId);
    const st = await this.d.gl.state(tenant, l.bookId);
    const mapping = await this.mappingMap(tenant, projectId, keys);
    const plan = buildPlan(await this.extract(tenant, projectId, ["source"]), p.cutoff, mapping, new Map([...target.accounts, ...st.accounts]), target.closed, p.scope);
    const items = await this.d.store.tenantTx(tenant, (tx) => tx<{ account_id: string; party_id: string; amount_paise: string }[]>`
      SELECT account_id, party_id, amount_paise::text FROM migration.open_items WHERE tenant_id = ${tenant} AND load_id = ${l.loadId} AND status = 'open'`);
    const r = this.reconcileState(plan, st, items.map((i) => ({ accountId: i.account_id, partyId: i.party_id, amount: BigInt(i.amount_paise) })), l.status === "active" ? l.journalIds : []);
    return J({ loadId: l.loadId, bookId: l.bookId, kind: l.kind, status: l.status, ...r });
  }

  /** Provenance records of a load (sources opened): kind, target, source system, file hash, source id and row. */
  async provenance(tenant: string, projectId: string, loadId: string, opts: { kind?: string; limit?: number } = {}) {
    const keys = await this.d.store.keys(tenant);
    const rows = await this.d.store.tenantTx(tenant, (tx) => tx<{ record_id: string; kind: string; target_id: string; source_system: string; file_hash: string; source_row: number; source: string; content_hash: string; status: string }[]>`
      SELECT record_id, kind, target_id, source_system, file_hash, source_row, source, content_hash, status FROM migration.records
      WHERE tenant_id = ${tenant} AND project_id = ${projectId} AND load_id = ${loadId} ${opts.kind ? tx`AND kind = ${opts.kind}` : tx``}
      ORDER BY kind, target_id LIMIT ${Math.min(Math.max(opts.limit ?? 1000, 1), 10_000)}`);
    return rows.map((r) => ({ recordId: r.record_id, kind: r.kind, targetId: r.target_id, sourceSystem: r.source_system, fileHash: r.file_hash, sourceRow: r.source_row,
      ...keys.openJson<{ sourceId: string; ref?: string }>(r.source, recordSourceCtx(r.record_id)), contentHash: r.content_hash, status: r.status }));
  }

  /** Open items of a load (the migrated subledger). */
  async openItems(tenant: string, projectId: string, loadId: string) {
    return this.d.store.tenantTx(tenant, (tx) => tx<{ itemId: string; partyId: string; accountId: string; docNo: string; docDate: string; dueDate: string | null; amount: string; kind: string; onAccount: boolean; status: string }[]>`
      SELECT item_id AS "itemId", party_id AS "partyId", account_id AS "accountId", doc_no AS "docNo", doc_date::text AS "docDate", due_date::text AS "dueDate",
        amount_paise::text AS amount, kind, on_account AS "onAccount", status FROM migration.open_items
      WHERE tenant_id = ${tenant} AND project_id = ${projectId} AND load_id = ${loadId} ORDER BY party_id, doc_date, doc_no`);
  }

  // ================================================================ delta import (FIN-MIG-02)
  /**
   * Import vouchers dated after the cut-off (up to `asOf`) into a load's book. Idempotent: each
   * voucher's journal id derives from the load and the source key (Tally GUID, Zoho id), and a
   * voucher already imported is a duplicate; one changed in the source since is reported as a
   * difference to resolve, never overwritten. Source numbers are kept (narration and provenance
   * reference) and the numbering per voucher type is checked for gaps and duplicates.
   */
  async delta(tenant: string, principal: string, projectId: string, o: { loadId?: string; asOf?: string } = {}) {
    const p = await this.need(tenant, projectId);
    this.open(p);
    if (o.asOf !== undefined && !isIsoDate(o.asOf)) throw new MigrationError("bad_date", `as-of ${o.asOf} is not a real date`, 400);
    const l = await this.needLoad(tenant, projectId, o.loadId);
    if (l.status !== "active") throw new MigrationError("load_voided", `load ${l.loadId} was rolled back`);
    const keys = await this.d.store.keys(tenant);
    const x = await this.extract(tenant, projectId, ["source", "delta"]);
    const mapping = await this.mappingMap(tenant, projectId, keys);
    const srcBy = new Map<string, SrcAccount>(x.accounts.map((a) => [a.key, a]));
    const vouchers = x.vouchers.filter((v) => v.date > p.cutoff && (!o.asOf || v.date <= o.asOf) && !v.cancelled)
      .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number, undefined, { numeric: true }) || a.key.localeCompare(b.key));
    const partyOf = (line: { accountKey: string; partyKey?: string }) => {
      const src = srcBy.get(line.accountKey);
      if (src?.party) return { key: line.accountKey, id: mapping.get(line.accountKey)?.partyId ?? partyIdFor(p.sourceSystem, line.accountKey), kind: src.party };
      if (line.partyKey) return { key: line.partyKey, id: partyIdFor(p.sourceSystem, line.partyKey), kind: (src?.control === "payable" ? "vendor" : "customer") as "customer" | "vendor" };
      return null;
    };
    // In the target book, parties named after the cut-off are registered like the load's (the party master's maker-checker for bank details).
    if (l.kind === "target") {
      const st = await this.d.gl.state(tenant, l.bookId);
      const partyBy = new Map(x.parties.map((q) => [q.key, q]));
      const seen = new Set<string>();
      for (const v of vouchers) for (const line of v.lines) {
        const pt = partyOf(line);
        if (!pt || seen.has(pt.id)) continue;
        seen.add(pt.id);
        if (await this.d.parties.get(tenant, pt.id)) continue;
        const src = partyBy.get(pt.key);
        await this.d.parties.register(tenant, principal, { partyId: pt.id, entityId: st.config.legalEntityId, kind: src?.kind ?? pt.kind, name: src?.name ?? pt.key, effectiveFrom: v.date });
      }
    }
    return this.d.gl.transact(tenant, l.bookId, async (b) => {
      await this.permit(tenant, principal, p.bookId, b.tx);
      await b.tx`SELECT pg_advisory_xact_lock(hashtextextended(${this.stream(tenant, projectId)}, 0))`;
      const existing = new Map((await b.tx<{ source_idx: string; content_hash: string }[]>`SELECT source_idx, content_hash FROM migration.records
        WHERE tenant_id = ${tenant} AND load_id = ${l.loadId} AND kind = 'voucher'`).map((r) => [r.source_idx, r.content_hash]));
      let created = 0, duplicates = 0;
      const changed: { number: string; type: string; date: string }[] = [], held: { number: string; type: string; date: string; reason: string }[] = [];
      const records: Record<string, unknown>[] = [];
      for (const v of vouchers) {
        const si = this.idx(keys, p.sourceSystem, "voucher", v.key);
        const content = sha256(canonical({ date: v.date, number: v.number, type: v.type, lines: v.lines.map((q) => [q.accountKey, q.partyKey ?? null, q.amount]) }));
        const prior = existing.get(si);
        if (prior !== undefined) { if (prior === content) duplicates++; else changed.push({ number: v.number, type: v.type, date: v.date }); continue; }
        const hold = (reason: string) => held.push({ number: v.number, type: v.type, date: v.date, reason });
        const lines: { accountId: string; amount: string; partyId?: string; dimensions: Record<string, string> }[] = [];
        let why: string | null = null;
        for (const q of v.lines) {
          const m = mapping.get(q.accountKey);
          const accountId = m?.status === "approved" ? (m.newAccount?.accountId ?? m.accountId) : null;
          if (!accountId) { why = `ledger ${q.accountKey} has no approved mapping`; break; }
          const acc = b.state.accounts.get(accountId);
          if (!acc) { why = `account ${accountId} is not in book ${l.bookId} (load the mapping's new accounts first)`; break; }
          const pt = partyOf(q);
          if (acc.isControl && !pt) { why = `a line on control account ${accountId} names no party`; break; }
          lines.push({ accountId, amount: q.amount, ...(acc.isControl && pt ? { partyId: pt.id } : {}), dimensions: {} });
        }
        if (why) { hold(why); continue; }
        if (lines.reduce((a, q) => a + BigInt(q.amount), 0n) !== 0n) { hold("the voucher does not balance"); continue; }
        const journalId = stableId("migration-voucher", `${tenant}/${l.bookId}/${l.loadId}/${v.key}`);
        try {
          await b.execute({ kind: "PostJournal", journalId, txnDate: v.date, narration: `${v.type} ${v.number}${v.narration ? `: ${v.narration}` : ""}`.slice(0, 500),
            voucherType: VOUCHER_TYPES[v.type.toLowerCase()] ?? "journal", autonomy: "human", source: { stream: this.stream(tenant, projectId) }, lines }, { principal, commandId: l.loadId });
        } catch (e) {
          if (e instanceof DomainError) { hold(`${e.code}: ${e.message}`); continue; }
          throw e;
        }
        created++;
        const recordId = stableId("migration-record", `${tenant}/${l.loadId}/voucher/${journalId}/${v.key}`);
        records.push({ tenant_id: tenant, record_id: recordId, project_id: projectId, load_id: l.loadId, book_id: l.bookId, kind: "voucher", target_id: journalId,
          source_system: p.sourceSystem, file_hash: v.file, source_row: v.row, source_idx: si, source: keys.sealJson({ sourceId: v.key, ref: `${v.type} ${v.number}` }, recordSourceCtx(recordId)),
          content_hash: content, status: "active" });
        existing.set(si, content);
        if (v.external && v.number) {
          const total = v.lines.reduce((a, q) => (BigInt(q.amount) > 0n ? a + BigInt(q.amount) : a), 0n);
          await b.tx`INSERT INTO migration.external_documents (tenant_id, source_system, doc_kind, doc_no, project_id, doc_date, amount_paise, source_idx)
            VALUES (${tenant}, ${p.sourceSystem}, ${v.external}, ${v.number}, ${projectId}, ${v.date}, ${s(total)}, ${si}) ON CONFLICT DO NOTHING`;
        }
      }
      for (let k = 0; k < records.length; k += 500) await b.tx`INSERT INTO migration.records ${b.tx(records.slice(k, k + 500) as never)}`;
      await this.append(b.tx, tenant, projectId, [{ type: "MigrationDeltaImported", data: { projectId, loadId: l.loadId, bookId: l.bookId, created, duplicates, changed: changed.length, held: held.length } }], principal);
      return { loadId: l.loadId, bookId: l.bookId, vouchers: vouchers.length, created, duplicates, changed, held, numbering: numbering(x.vouchers) };
    });
  }

  // ================================================================ bank coverage (FIN-MIG-02)
  /**
   * Statements from the cut-off onward for every bank ledger of the source: each bank account's
   * statement lines (channels imports into the target book) must start within `toleranceDays` after
   * the cut-off and reach `asOf`; long silences are listed as possible gaps. An account registered in
   * the bank module (bankCoverage) is checked on its verified statements' periods instead: they must
   * cover every day from the day after the cut-off to `asOf`, with no gap (held statements do not count).
   */
  async coverage(tenant: string, projectId: string, o: { asOf?: string; toleranceDays?: number } = {}) {
    const p = await this.need(tenant, projectId);
    const asOf = o.asOf ?? this.d.clock();
    const tol = o.toleranceDays ?? 7;
    const keys = await this.d.store.keys(tenant);
    const rows = await this.mappingRows(tenant, projectId, keys);
    const banks = [...new Set(rows.filter((r) => r.d.bank && r.status === "approved" && r.account_id).map((r) => r.new_account?.accountId ?? r.account_id!))].sort();
    const lines = await (this.d.coverage ?? this.eventCoverage)(tenant, p.bookId);
    const registered = new Map<string, Awaited<ReturnType<BankCoverageSource>>>();
    if (this.d.bankCoverage && asOf > p.cutoff) for (const accountId of banks) registered.set(accountId, await this.d.bankCoverage(tenant, p.bookId, accountId, addDays(p.cutoff, 1), asOf));
    const accounts = banks.map((accountId) => {
      const reg = registered.get(accountId);
      if (reg) {
        const dates = (lines.get(accountId) ?? []).filter((d) => d > p.cutoff && d <= asOf).sort();
        return { accountId, source: "bank" as const, bankAccountId: reg.bankAccountId, lines: dates.length, first: dates[0] ?? null, last: dates.at(-1) ?? null, gaps: reg.gaps, ok: reg.complete,
          reason: reg.complete ? null : reg.statements === 0 ? `no verified statement of ${reg.bankAccountId} covers ${addDays(p.cutoff, 1)}..${asOf}${reg.held ? ` (${reg.held} held)` : ""}`
            : `verified statements of ${reg.bankAccountId} leave ${reg.gaps.map((g) => `${g.from}..${g.to}`).join(", ")} uncovered` };
      }
      const dates = (lines.get(accountId) ?? []).filter((d) => d > p.cutoff && d <= asOf).sort();
      const first = dates[0] ?? null, last = dates.at(-1) ?? null;
      const gaps: { from: string; to: string }[] = [];
      for (let i = 1; i < dates.length; i++) if (addDays(dates[i - 1]!, 2 * tol) < dates[i]!) gaps.push({ from: dates[i - 1]!, to: dates[i]! });
      const ok = !!first && first <= addDays(p.cutoff, tol) && !!last && last >= addDays(asOf, -tol);
      return { accountId, source: "statement-lines" as const, lines: dates.length, first, last, gaps, ok, reason: ok ? null : !first ? `no statement lines after the cut-off ${p.cutoff}` : first > addDays(p.cutoff, tol) ? `statements start ${first}, more than ${tol} days after the cut-off` : `statements end ${last}, more than ${tol} days before ${asOf}` };
    });
    return { cutoff: p.cutoff, asOf, toleranceDays: tol, accounts, ok: accounts.length > 0 && accounts.every((a) => a.ok), note: accounts.length ? null : "no approved bank ledger in the mapping" };
  }
  /** Default coverage: statement lines extracted by the channels module for the book (TransactionExtracted events, authoritative). */
  private eventCoverage: CoverageSource = async (tenant, book) => {
    const out = new Map<string, string[]>();
    let after = "0";
    for (let page = 0; page < 1000; page++) {
      const evs = await this.d.store.tenantTx(tenant, (tx) => this.d.store.readEvents({ tenantId: tenant, types: ["TransactionExtracted"], after, limit: 1000 }, tx));
      if (!evs.length) break;
      after = evs.at(-1)!.globalPosition;
      for (const e of evs) {
        const d = e.data as EventData<"TransactionExtracted">;
        if (d.bookId !== book || d.trust !== "authoritative") continue;
        const list = out.get(d.txn.instrument) ?? [];
        list.push(d.txn.txnDate);
        out.set(d.txn.instrument, list);
      }
    }
    return out;
  };

  // ================================================================ decisions (authority switch, fallback)
  async recordDecision(tenant: string, principal: string, projectId: string, d: { kind: "authority" | "fallback"; processes: Record<string, string>[]; note?: string; until?: string }) {
    const p = await this.need(tenant, projectId);
    if (d.kind === "authority") this.open(p);
    if (!d.processes.length) throw new MigrationError("bad_decision", "name at least one process", 400);
    for (const r of d.processes) {
      if (!r.process?.trim()) throw new MigrationError("bad_decision", "every row names its process", 400);
      if (d.kind === "authority" && !(["source", "kuber"].includes(r.duringParallel ?? "") && ["source", "kuber", "provider"].includes(r.afterCutover ?? "")))
        throw new MigrationError("bad_decision", "authority rows: duringParallel source|kuber, afterCutover source|kuber|provider", 400);
      if (d.kind === "fallback" && !(["source", "kuber", "provider"].includes(r.system ?? "") && r.operator?.trim()))
        throw new MigrationError("bad_decision", "fallback rows: system source|kuber|provider and the operator (who runs it)", 400);
    }
    if (d.until !== undefined && !isIsoDate(d.until)) throw new MigrationError("bad_date", "until is not a real date", 400);
    const decisionId = stableId("migration-decision", `${tenant}/${projectId}/${d.kind}/${sha256(canonical(d))}/${Date.now()}`);
    const keys = await this.d.store.keys(tenant);
    const detail = { processes: d.processes, ...(d.note ? { note: d.note } : {}), ...(d.until ? { until: d.until } : {}), bookOfRecord: p.bookOfRecord };
    await this.d.store.tenantTx(tenant, async (tx) => {
      await this.permit(tenant, principal, p.bookId, tx);
      await tx`INSERT INTO migration.decisions (tenant_id, decision_id, project_id, kind, detail, principal)
        VALUES (${tenant}, ${decisionId}, ${projectId}, ${d.kind}, ${keys.sealJson(detail, decisionDetailCtx(decisionId))}, ${principal})`;
      await this.append(tx, tenant, projectId, [{ type: "MigrationDecisionRecorded", data: { projectId, decisionId, kind: d.kind, detail } }], principal);
    });
    return { decisionId, kind: d.kind, ...detail };
  }
  async decisions(tenant: string, projectId: string) {
    const keys = await this.d.store.keys(tenant);
    const rows = await this.d.store.tenantTx(tenant, (tx) => tx<{ decision_id: string; kind: string; detail: string; principal: string; created_at: Date }[]>`
      SELECT decision_id, kind, detail, principal, created_at FROM migration.decisions WHERE tenant_id = ${tenant} AND project_id = ${projectId} ORDER BY created_at, decision_id`);
    return rows.map((r) => ({ decisionId: r.decision_id, kind: r.kind, principal: r.principal, at: r.created_at.toISOString(), ...keys.openJson<Record<string, unknown>>(r.detail, decisionDetailCtx(r.decision_id)) }));
  }
  /** The latest decision of each kind (the one in force). */
  private latest = (ds: Awaited<ReturnType<Migration["decisions"]>>, kind: string) => ds.filter((x) => x.kind === kind).at(-1) ?? null;

  // ================================================================ parallel-run comparison (FIN-MIG-02)
  /**
   * Kuber's trial balance at `to` and P&L for [from, to] against the source's for the same period, by
   * Kuber account through the approved mapping. The source trial balance at `to` is a comparison
   * file with that as-of date; the source position at the day before `from` is the cut-off balance
   * when `from` is the day after the cut-off, else another comparison file. Every difference is
   * listed with the process it most likely comes from, open until a person explains it.
   */
  async compare(tenant: string, principal: string, projectId: string, o: { from: string; to: string; loadId?: string }) {
    const p = await this.need(tenant, projectId);
    this.open(p);
    if (!isIsoDate(o.from) || !isIsoDate(o.to) || o.from > o.to) throw new MigrationError("bad_period", "from and to are real dates, from on or before to", 400);
    if (o.from <= p.cutoff) throw new MigrationError("bad_period", `a parallel period starts after the cut-off ${p.cutoff}`, 400);
    const l = await this.needLoad(tenant, projectId, o.loadId);
    if (l.status !== "active") throw new MigrationError("load_voided", `load ${l.loadId} was rolled back`);
    const keys = await this.d.store.keys(tenant);
    const mapping = await this.mappingMap(tenant, projectId, keys);
    const cmp = await this.extract(tenant, projectId, ["comparison"]);
    const tbAt = (date: string) => cmp.trialBalances.filter((t) => t.asOf === date).at(-1) ?? null;
    const endTb = tbAt(o.to);
    if (!endTb) throw new MigrationError("source_tb_required", `import the source's trial balance as at ${o.to} (purpose comparison) first`, 409);
    const before = addDays(o.from, -1);
    let startBal: Map<string, bigint>;
    if (before === p.cutoff) startBal = cutoffBalances(await this.extract(tenant, projectId, ["source"]), p.cutoff);
    else {
      const t = tbAt(before);
      if (!t) throw new MigrationError("source_tb_required", `import the source's trial balance as at ${before} (purpose comparison) first`, 409);
      startBal = new Map(); for (const r of t.rows) startBal.set(r.accountKey, (startBal.get(r.accountKey) ?? 0n) + BigInt(r.amount));
    }
    const endBal = new Map<string, bigint>(); for (const r of endTb.rows) endBal.set(r.accountKey, (endBal.get(r.accountKey) ?? 0n) + BigInt(r.amount));
    const st = await this.d.gl.state(tenant, l.bookId);
    const targetOf = (key: string) => { const m = mapping.get(key); return m?.status === "approved" ? (m.newAccount?.accountId ?? m.accountId) : null; };
    const unmapped: { key: string; amount: bigint }[] = [];
    const toKuber = (bal: Map<string, bigint>, collect: boolean) => {
      const out = new Map<string, bigint>();
      for (const [k, v] of bal) { const a = targetOf(k); if (!a) { if (collect && v !== 0n) unmapped.push({ key: k, amount: v }); continue; } out.set(a, (out.get(a) ?? 0n) + v); }
      return out;
    };
    const sEnd = toKuber(endBal, true), sStart = toKuber(startBal, false);
    const kEnd = bookBalances(st.journals.values(), o.to).byAccount, kStart = bookBalances(st.journals.values(), before).byAccount;
    const nature = (id: string) => st.accounts.get(id)?.nature ?? "asset";
    const ids = [...new Set([...sEnd.keys(), ...kEnd.keys()])].sort();
    const process = (id: string) => {
      const a = st.accounts.get(id);
      if (a?.isCashLike) return { process: "Bank and cash entries", suggestion: "timing: Kuber records bank lines from statements; the source has not recorded them yet, or the reverse" };
      if (a?.isControl) return { process: "Receivables and payables", suggestion: "a sales invoice, bill, receipt or payment recorded in one system only" };
      if (a?.nature === "income") return { process: "Sales invoices and other income", suggestion: "an invoice or income entry in one system only, or classified differently" };
      if (a?.nature === "expense") return { process: "Purchase bills and expenses", suggestion: "a bill or expense in one system only, or classified differently" };
      if (/gst|tax|tds/i.test(`${id} ${a?.name ?? ""}`)) return { process: "GST and TDS", suggestion: "tax computed or rounded differently" };
      return { process: "Journals", suggestion: "a journal in one system only" };
    };
    const tb = ids.map((accountId) => ({ accountId, name: st.accounts.get(accountId)?.name ?? accountId, nature: nature(accountId), source: s(sEnd.get(accountId) ?? 0n), kuber: s(kEnd.get(accountId) ?? 0n),
      difference: s((kEnd.get(accountId) ?? 0n) - (sEnd.get(accountId) ?? 0n)) }));
    const plIds = ids.filter((id) => nature(id) === "income" || nature(id) === "expense");
    const pl = plIds.map((accountId) => { const sv = (sEnd.get(accountId) ?? 0n) - (sStart.get(accountId) ?? 0n), kv = (kEnd.get(accountId) ?? 0n) - (kStart.get(accountId) ?? 0n);
      return { accountId, name: st.accounts.get(accountId)?.name ?? accountId, nature: nature(accountId), source: s(sv), kuber: s(kv), difference: s(kv - sv) }; });
    const total = (rows: typeof pl, side: "source" | "kuber", n: string) => rows.filter((r) => r.nature === n).reduce((a, r) => a + BigInt(r[side]), 0n);
    const pnl = { source: { income: s(-total(pl, "source", "income")), expense: s(total(pl, "source", "expense")), net: s(-total(pl, "source", "income") - total(pl, "source", "expense")) },
      kuber: { income: s(-total(pl, "kuber", "income")), expense: s(total(pl, "kuber", "expense")), net: s(-total(pl, "kuber", "income") - total(pl, "kuber", "expense")) } };
    const differences = [
      ...tb.filter((r) => r.difference !== "0").map((r) => ({ key: `tb:${r.accountId}`, section: "trial_balance", accountId: r.accountId, name: r.name, source: r.source, kuber: r.kuber, difference: r.difference, ...process(r.accountId) })),
      ...pl.filter((r) => r.difference !== "0").map((r) => ({ key: `pnl:${r.accountId}`, section: "profit_and_loss", accountId: r.accountId, name: r.name, source: r.source, kuber: r.kuber, difference: r.difference, ...process(r.accountId) })),
      ...unmapped.map((u) => ({ key: `unmapped:${this.idx(keys, p.sourceSystem, "ledger", u.key)}`, section: "mapping", accountId: null, name: u.key, source: s(u.amount), kuber: "0", difference: s(-u.amount),
        process: "Mapping", suggestion: "a ledger created in the source after mapping: map it, then compare again" })),
    ];
    const body = { projectId, loadId: l.loadId, bookId: l.bookId, from: o.from, to: o.to, sourceFile: endTb.file, trialBalance: tb, profitAndLoss: pl, pnl, differences };
    const contentHash = sha256(canonical(body));
    const comparisonId = stableId("migration-comparison", `${tenant}/${projectId}/${contentHash}`);
    await this.d.store.tenantTx(tenant, async (tx) => {
      await this.permit(tenant, principal, p.bookId, tx);
      const [dup] = await tx`SELECT 1 FROM migration.comparisons WHERE tenant_id = ${tenant} AND comparison_id = ${comparisonId}`;
      if (dup) return;
      await tx`INSERT INTO migration.comparisons (tenant_id, comparison_id, project_id, load_id, period_from, period_to, content_hash, body, explanations, differences, open_differences, created_by)
        VALUES (${tenant}, ${comparisonId}, ${projectId}, ${l.loadId}, ${o.from}, ${o.to}, ${contentHash}, ${keys.sealJson(body, comparisonBodyCtx(comparisonId))},
          ${keys.sealJson({}, comparisonExplanationsCtx(comparisonId))}, ${differences.length}, ${differences.length}, ${principal})`;
      await this.append(tx, tenant, projectId, [{ type: "MigrationComparisonRecorded", data: { projectId, comparisonId, from: o.from, to: o.to, contentHash, differences: differences.length } }], principal);
    });
    return this.comparison(tenant, projectId, comparisonId);
  }

  async comparison(tenant: string, projectId: string, comparisonId: string, tx?: TransactionSql) {
    const keys = await this.d.store.keys(tenant);
    const q = (t: TransactionSql) => t<{ content_hash: string; body: string; explanations: string; created_by: string; created_at: Date }[]>`
      SELECT content_hash, body, explanations, created_by, created_at FROM migration.comparisons WHERE tenant_id = ${tenant} AND project_id = ${projectId} AND comparison_id = ${comparisonId}`;
    const [r] = tx ? await q(tx) : await this.d.store.tenantTx(tenant, q);
    if (!r) throw new MigrationError("no_comparison", `no comparison ${comparisonId} in project ${projectId}`, 404);
    const body = keys.openJson<ComparisonBody>(r.body, comparisonBodyCtx(comparisonId));
    const explanations = keys.openJson<Record<string, { category: string; note: string; by: string }>>(r.explanations, comparisonExplanationsCtx(comparisonId));
    const differences = body.differences.map((d) => ({ ...d, status: explanations[d.key] ? "explained" : "open", explanation: explanations[d.key] ?? null }));
    return { comparisonId, contentHash: r.content_hash, createdBy: r.created_by, at: r.created_at.toISOString(), ...body, differences, open: differences.filter((d) => d.status === "open").length };
  }
  async comparisons(tenant: string, projectId: string) {
    return this.d.store.tenantTx(tenant, (tx) => tx<{ comparisonId: string; from: string; to: string; differences: number; open: number; contentHash: string }[]>`
      SELECT comparison_id AS "comparisonId", period_from::text AS "from", period_to::text AS "to", differences, open_differences AS open, content_hash AS "contentHash"
      FROM migration.comparisons WHERE tenant_id = ${tenant} AND project_id = ${projectId} ORDER BY created_at, comparison_id`);
  }

  /** A person explains one difference (category and note); the go-live needs every difference explained. */
  async explain(tenant: string, principal: string, projectId: string, comparisonId: string, e: { key: string; category: string; note: string }) {
    const p = await this.need(tenant, projectId);
    this.open(p);
    if (!(EXPLANATION_CATEGORIES as readonly string[]).includes(e.category)) throw new MigrationError("bad_category", `category is one of ${EXPLANATION_CATEGORIES.join(", ")}`, 400);
    if (e.note.trim().length < 3) throw new MigrationError("note_required", "explain the difference in a few words", 400);
    const keys = await this.d.store.keys(tenant);
    await this.d.store.tenantTx(tenant, async (tx) => {
      await this.permit(tenant, principal, p.bookId, tx);
      const [row] = await tx<{ explanations: string }[]>`SELECT explanations FROM migration.comparisons WHERE tenant_id = ${tenant} AND project_id = ${projectId} AND comparison_id = ${comparisonId} FOR UPDATE`;
      if (!row) throw new MigrationError("no_comparison", `no comparison ${comparisonId}`, 404);
      const c = await this.comparison(tenant, projectId, comparisonId, tx);
      if (!c.differences.some((d) => d.key === e.key)) throw new MigrationError("no_difference", `no difference ${e.key} in this comparison`, 404);
      const ex = keys.openJson<Record<string, unknown>>(row.explanations, comparisonExplanationsCtx(comparisonId));
      ex[e.key] = { category: e.category, note: e.note.trim().slice(0, 2000), by: principal };
      const open = c.differences.filter((d) => !ex[d.key]).length;
      await tx`UPDATE migration.comparisons SET explanations = ${keys.sealJson(ex, comparisonExplanationsCtx(comparisonId))}, open_differences = ${open}
        WHERE tenant_id = ${tenant} AND comparison_id = ${comparisonId}`;
      await this.append(tx, tenant, projectId, [{ type: "MigrationDifferenceExplained", data: { projectId, comparisonId, key: e.key, category: e.category, note: e.note.trim().slice(0, 2000) } }], principal);
    });
    return this.comparison(tenant, projectId, comparisonId);
  }

  // ================================================================ go-live (FIN-MIG-02 sign-off, authority switch)
  /**
   * What the superuser signs: the comparison (content hash and explanations) and the go-live
   * checklist, rendered from the project itself. Deterministic for the same state, so the summary
   * shown at signing is the one verified when the command runs.
   */
  async goLiveIntent(tenant: string, projectId: string, comparisonId: string) {
    const p = await this.need(tenant, projectId);
    const c = await this.comparison(tenant, projectId, comparisonId);
    const loads = await this.loads(tenant, projectId);
    const target = loads.find((l) => l.kind === "target" && l.status === "active") ?? null;
    const map = await this.mapping(tenant, projectId);
    const recon = target ? await this.reconciliation(tenant, projectId, target.loadId) : null;
    const cov = await this.coverage(tenant, projectId, { asOf: c.to });
    const ds = await this.decisions(tenant, projectId);
    const checklist = [
      { label: "Every source ledger in use is mapped and approved", ok: map.summary.unmapped === 0, detail: `${map.summary.unmapped} unmapped` },
      { label: "The target book is loaded and reconciles to the source at the cut-off", ok: !!recon?.reconciled, detail: target ? (recon?.reconciled ? "reconciled" : "not reconciled") : "no target load" },
      { label: "The comparison is of the active target load", ok: !!target && c.loadId === target.loadId, detail: String(c.loadId) },
      { label: "Every parallel-run difference is explained", ok: c.open === 0, detail: `${c.open} open of ${c.differences.length}` },
      { label: `Bank statements cover the cut-off ${p.cutoff} to ${c.to}`, ok: cov.ok, detail: cov.accounts.map((a) => `${a.accountId}: ${a.ok ? "covered" : a.reason}`).join("; ") || (cov.note ?? "") },
      { label: "The system of record per process is decided", ok: !!this.latest(ds, "authority"), detail: this.latest(ds, "authority")?.decisionId ?? "none" },
      { label: "Fallback operators are named", ok: !!this.latest(ds, "fallback"), detail: this.latest(ds, "fallback")?.decisionId ?? "none" },
      { label: "The project has not gone live", ok: p.status === "open", detail: p.status },
    ];
    const goLive = this.d.clock();
    const subject = `${projectId}:${comparisonId}`;
    const explanations = c.differences.map((d) => [d.key, d.explanation]);
    const subjectHash = sha256(canonical({ kind: "migration.golive", projectId, comparisonId, contentHash: c.contentHash, explanations, checklist: checklist.map((x) => [x.label, x.ok]), goLive, book: p.bookId }));
    const summary: CommandSummary = { action: "migration.golive", title: `Go live: Kuber becomes the book of record for ${p.bookId}`, book: p.bookId, amountPaise: null, payees: [], accounts: [],
      periods: [{ periodEnd: c.to, level: "parallel run" }],
      lines: [`Cut over book ${p.bookId} from ${p.sourceSystem} to Kuber on ${goLive}`, `Cut-off ${p.cutoff}; parallel run ${c.from} to ${c.to}`,
        `Comparison ${comparisonId} (content ${c.contentHash.slice(0, 12)}): ${c.differences.length} difference(s), ${c.differences.length - c.open} explained`,
        "After this, the source is no longer the book of record and pre-cutover rollback is closed (FIN-MIG-03)", ...checklist.map((x) => `${x.ok ? "✓" : "✗"} ${x.label}`)] };
    return { book: p.bookId, subject, subjectHash, summary, checklist, ready: checklist.every((x) => x.ok), goLive };
  }

  /** The signed cut-over. `attest` verifies the superuser's passkey signature over exactly `intent` inside this transaction. */
  async goLive(tenant: string, principal: string, projectId: string, comparisonId: string, intent: { subjectHash: string }, attest: (tx: TransactionSql) => Promise<CommandSignature>) {
    const now = await this.goLiveIntent(tenant, projectId, comparisonId);
    if (!now.ready) throw new MigrationError("not_ready", `not ready to go live: ${now.checklist.filter((x) => !x.ok).map((x) => x.label).join("; ")}`, 409, now.checklist);
    if (now.subjectHash !== intent.subjectHash) throw new MigrationError("changed", "the comparison or checklist changed since it was shown for signing: review and sign again", 409);
    const p = await this.need(tenant, projectId);
    await this.d.store.tenantTx(tenant, async (tx) => {
      await this.permit(tenant, principal, p.bookId, tx, "authority.manage");
      const [cur] = await tx<{ status: string }[]>`SELECT status FROM migration.projects WHERE tenant_id = ${tenant} AND project_id = ${projectId} FOR UPDATE`;
      if (cur?.status !== "open") throw new MigrationError("post_cutover", "the project has already gone live");
      const signature = await attest(tx);
      await tx`UPDATE migration.projects SET status = 'live', book_of_record = 'kuber', go_live = ${now.goLive} WHERE tenant_id = ${tenant} AND project_id = ${projectId}`;
      const keys = await this.d.store.keys(tenant);
      const decisionId = stableId("migration-decision", `${tenant}/${projectId}/golive`);
      await tx`INSERT INTO migration.decisions (tenant_id, decision_id, project_id, kind, detail, principal)
        VALUES (${tenant}, ${decisionId}, ${projectId}, 'golive', ${keys.sealJson({ comparisonId, subjectHash: now.subjectHash, goLive: now.goLive, bookOfRecord: "kuber", checklist: now.checklist }, decisionDetailCtx(decisionId))}, ${principal})`;
      await this.append(tx, tenant, projectId, [{ type: "MigrationWentLive", data: { projectId, bookId: p.bookId, comparisonId, subjectHash: now.subjectHash, goLive: now.goLive, signature } }], principal);
    });
    return { projectId, status: "live" as const, bookOfRecord: "kuber" as const, goLive: now.goLive };
  }

  // ================================================================ rollback and recovery (FIN-MIG-03)
  /** Pre-cutover rollback of one load: a rehearsal book is discarded; a target load is voided with reversing entries. */
  async rollback(tenant: string, principal: string, projectId: string, o: { loadId: string; reason: string }) {
    const p = await this.need(tenant, projectId);
    this.open(p);
    if (o.reason.trim().length < 3) throw new MigrationError("reason_required", "give the reason for the rollback", 400);
    const l = await this.needLoad(tenant, projectId, o.loadId);
    if (l.status !== "active") throw new MigrationError("load_voided", `load ${l.loadId} is already rolled back`);
    const finish = async (tx: TransactionSql, method: "discard_book" | "reversing_entries", reversals: string[]) => {
      await tx`UPDATE migration.loads SET status = 'voided', void_method = ${method}, voided_by = ${principal}, voided_at = now() WHERE tenant_id = ${tenant} AND load_id = ${l.loadId}`;
      await tx`UPDATE migration.records SET status = 'voided' WHERE tenant_id = ${tenant} AND load_id = ${l.loadId}`;
      await tx`UPDATE migration.open_items SET status = 'voided' WHERE tenant_id = ${tenant} AND load_id = ${l.loadId}`;
      if (method === "discard_book") await tx`UPDATE migration.rehearsal_books SET status = 'discarded' WHERE tenant_id = ${tenant} AND book_id = ${l.bookId}`;
      await this.append(tx, tenant, projectId, [{ type: "MigrationLoadVoided", data: { projectId, loadId: l.loadId, bookId: l.bookId, method, reversals, reason: o.reason.trim() } }], principal);
    };
    if (l.kind === "rehearsal") {
      await this.d.store.tenantTx(tenant, async (tx) => { await this.permit(tenant, principal, p.bookId, tx); await finish(tx, "discard_book", []); });
      return { loadId: l.loadId, bookId: l.bookId, method: "discard_book" as const, reversals: [] };
    }
    const reversals = await this.d.gl.transact(tenant, l.bookId, async (b) => {
      await this.permit(tenant, principal, p.bookId, b.tx);
      const vouchers = (await b.tx<{ target_id: string }[]>`SELECT target_id FROM migration.records WHERE tenant_id = ${tenant} AND load_id = ${l.loadId} AND kind = 'voucher' AND status = 'active'`).map((r) => r.target_id);
      const out: string[] = [];
      for (const journalId of [...vouchers.reverse(), ...l.journalIds]) {
        const j = b.state.journals.get(journalId);
        if (!j || j.reversedBy) continue;
        const reversalJournalId = stableId("migration-void", `${tenant}/${l.loadId}/${journalId}`);
        try {
          await b.execute({ kind: "ReverseJournal", journalId, reversalJournalId, reason: `migration rollback: ${o.reason.trim()}`.slice(0, 500) }, { principal, commandId: l.loadId });
        } catch (e) {
          if (e instanceof DomainError) throw new MigrationError(e.code, `the load cannot be rolled back, nothing was reversed: ${e.message}`, 422);
          throw e;
        }
        out.push(reversalJournalId);
      }
      await finish(b.tx, "reversing_entries", out);
      return out;
    });
    return { loadId: l.loadId, bookId: l.bookId, method: "reversing_entries" as const, reversals };
  }

  /** Post-cutover recovery: the documented procedure, with the facts it relies on. */
  async recovery(tenant: string, projectId: string) {
    const p = await this.need(tenant, projectId);
    const ds = await this.decisions(tenant, projectId);
    const st = await this.d.gl.state(tenant, p.bookId);
    const postCutover = p.goLive ? [...st.journals.values()].filter((j) => j.txnDate > p.goLive!).length : 0;
    const [ext] = await this.d.store.tenantTx(tenant, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM migration.external_documents WHERE tenant_id = ${tenant} AND project_id = ${projectId}`);
    return { projectId, status: p.status, bookOfRecord: p.bookOfRecord, goLive: p.goLive, rollbackAvailable: p.status === "open",
      procedure: p.status === "open" ? ["Before go-live: roll back a rehearsal (the rehearsal book is discarded) or the target load (voided with reversing entries): POST …/rollback."] : RECOVERY_PROCEDURE,
      fallback: this.latest(ds, "fallback"), authority: this.latest(ds, "authority"), postCutoverJournals: postCutover, externalDocuments: ext?.n ?? 0 };
  }

  /** Documents and payments the source issued outside Kuber (recorded, never issued again). */
  async externalDocuments(tenant: string, projectId: string) {
    return this.d.store.tenantTx(tenant, (tx) => tx<{ sourceSystem: string; docKind: string; docNo: string; docDate: string; amount: string }[]>`
      SELECT source_system AS "sourceSystem", doc_kind AS "docKind", doc_no AS "docNo", doc_date::text AS "docDate", amount_paise::text AS amount
      FROM migration.external_documents WHERE tenant_id = ${tenant} AND project_id = ${projectId} ORDER BY doc_kind, doc_date, doc_no`);
  }
  /** Was this document already issued by a source system? Anything that issues invoices or payments asks first. */
  async externalDocument(tenant: string, docKind: "invoice" | "bill" | "payment" | "receipt", docNo: string) {
    const [r] = await this.d.store.tenantTx(tenant, (tx) => tx<{ source_system: string; project_id: string }[]>`
      SELECT source_system, project_id FROM migration.external_documents WHERE tenant_id = ${tenant} AND doc_kind = ${docKind} AND doc_no = ${docNo} LIMIT 1`);
    return r ? { sourceSystem: r.source_system, projectId: r.project_id } : null;
  }

  // ================================================================ the rehearsal gate (FIN-MIG-03)
  /** Is `book` a migration rehearsal book (active or discarded)? */
  async rehearsalBook(tenant: string, book: string): Promise<{ projectId: string; status: string } | null> {
    const [r] = await this.d.store.tenantTx(tenant, (tx) => tx<{ project_id: string; status: string }[]>`
      SELECT project_id, status FROM migration.rehearsal_books WHERE tenant_id = ${tenant} AND book_id = ${book}`);
    return r ? { projectId: r.project_id, status: r.status } : null;
  }
  /** Ops book gate: refuse every write operation in a rehearsal book, and everything in a discarded one. */
  readonly rehearsalGate = async (tenant: string, book: string, op: { name: string; kind: "read" | "write" }): Promise<string | null> => {
    const r = await this.rehearsalBook(tenant, book);
    if (!r) return null;
    if (r.status === "discarded") return `${book} is a discarded migration rehearsal book (project ${r.projectId}): nothing runs in it`;
    return op.kind === "write" ? `${op.name} refused in ${book}: ${REHEARSAL_POLICY}` : null;
  };

  // ================================================================ the project view
  async view(tenant: string, projectId: string) {
    const p = await this.need(tenant, projectId);
    const [files, inventory, mapping, loads, decisions, comparisons] = await Promise.all([this.files(tenant, projectId), this.inventory(tenant, projectId),
      this.mapping(tenant, projectId), this.loads(tenant, projectId), this.decisions(tenant, projectId), this.comparisons(tenant, projectId)]);
    return { ...p, files, inventory, mapping: mapping.summary, loads, decisions, comparisons };
  }
}

interface CmpRow { accountId: string; name: string; nature: string; source: string; kuber: string; difference: string }
interface ComparisonBody {
  projectId: string; loadId: string; bookId: string; from: string; to: string; sourceFile: string; trialBalance: CmpRow[]; profitAndLoss: CmpRow[];
  pnl: Record<"source" | "kuber", { income: string; expense: string; net: string }>;
  differences: { key: string; section: string; accountId: string | null; name: string; source: string; kuber: string; difference: string; process: string; suggestion: string }[];
}

/** Numbering per voucher type: first and last number, gaps and duplicates in the numeric part. */
export function numbering(vouchers: { type: string; number: string }[]) {
  const by = new Map<string, { n: number; raw: string }[]>();
  for (const v of vouchers) {
    const m = /(\d+)\D*$/.exec(v.number);
    if (!m) continue;
    const list = by.get(v.type) ?? [];
    list.push({ n: Number(m[1]), raw: v.number });
    by.set(v.type, list);
  }
  return [...by].map(([type, list]) => {
    const sorted = [...list].sort((a, b) => a.n - b.n);
    const seen = new Map<string, number>();
    for (const x of list) seen.set(x.raw, (seen.get(x.raw) ?? 0) + 1);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length && gaps.length < 50; i++) for (let k = sorted[i - 1]!.n + 1; k < sorted[i]!.n && gaps.length < 50; k++) gaps.push(k);
    return { type, count: list.length, first: sorted[0]?.raw ?? null, last: sorted.at(-1)?.raw ?? null, gaps, duplicates: [...seen].filter(([, n]) => n > 1).map(([raw]) => raw) };
  }).sort((a, b) => a.type.localeCompare(b.type));
}
