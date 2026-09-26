/**
 * Party master (FIN-MDM-03): vendors and customers of a legal entity.
 *
 * Each party is an event-sourced aggregate, stream `<tenant>/party/<partyId>`, decided by the pure
 * `decideParty`/`evolveParty` below. The mdm.* tables are its query side, written in the same
 * transaction as the events (sealed where they hold names or bank details).
 *
 * - Identity (name), terms and tax status are effective-dated: `asOf(state, date)` gives the
 *   version in force on a date; earlier versions are kept.
 * - Beneficiary bank details change only through maker -> checker -> release (POL-501):
 *   `party.manage` requests, `party.bank.verify` records the out-of-band verification (a different
 *   person from the maker), `party.bank.release` gives the fresh approval (again not the maker).
 *   While a change is open (requested or verified) the party is on hold: payment plans and
 *   drafts paying it are blocked, including ones proposed before the change.
 * - The same bank account on two parties raises a review item for a person. Parties are never
 *   merged automatically.
 * Every write passes the module guard (identity permit) inside its transaction.
 */
import type { TransactionSql } from "postgres";
import { stableId, uuid, type BankDetails, type Envelope, type EventData } from "@kuber/contracts";
import { tenantRlsFor, type EventStore, type Migration, type ModuleGuard, type NewEvent } from "@kuber/eventstore";
import { DomainError } from "./book.ts";

type TenantKeys = Awaited<ReturnType<EventStore["keys"]>>;
type Terms = EventData<"PartyRegistered">["terms"];
type Tax = EventData<"PartyRegistered">["taxStatus"];

export const PARTY_MIGRATIONS: Migration[] = [{
  id: "mdm-001-parties",
  sql: `
CREATE SCHEMA IF NOT EXISTS mdm;
-- detail: sealed JSON of the effective-dated identity, terms and tax status history.
CREATE TABLE mdm.parties (
  tenant_id TEXT NOT NULL, party_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('vendor','customer','both')),
  detail TEXT NOT NULL, hold BOOLEAN NOT NULL DEFAULT false, version INT NOT NULL,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, party_id));
CREATE INDEX parties_hold ON mdm.parties (tenant_id) WHERE hold;
-- bank: sealed beneficiary details; account_idx: keyed blind index (shared-identifier checks without plaintext).
CREATE TABLE mdm.bank_changes (
  tenant_id TEXT NOT NULL, change_id TEXT NOT NULL, party_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','verified','released','rejected')),
  bank TEXT NOT NULL, account_idx TEXT NOT NULL, effective_from DATE NOT NULL,
  requested_by TEXT NOT NULL, verified_by TEXT, resolved_by TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, change_id));
CREATE INDEX bank_changes_idx ON mdm.bank_changes (tenant_id, account_idx);
CREATE INDEX bank_changes_party ON mdm.bank_changes (tenant_id, party_id);
CREATE TABLE mdm.reviews (
  tenant_id TEXT NOT NULL, review_id TEXT NOT NULL, party_id TEXT NOT NULL, other_party_id TEXT NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, review_id));
` + tenantRlsFor("mdm"),
}];

export const partyStream = (tenant: string, partyId: string) => `${tenant}/party/${partyId}`;
export const partyDetailCtx = (partyId: string) => `mdm.parties.detail|${partyId}`;
export const bankChangeCtx = (changeId: string) => `mdm.bank_changes.bank|${changeId}`;

// ------------------------------------------------------------------ the aggregate (pure)
export interface Dated<T> { from: string; value: T }
export interface BankChange {
  changeId: string; effectiveFrom: string; bank: BankDetails; accountIdx: string;
  status: "pending" | "verified" | "released" | "rejected"; requestedBy: string; verifiedBy?: string; resolvedBy?: string;
}
export interface PartyState {
  exists: boolean; partyId: string; entityId: string; kind: "vendor" | "customer" | "both";
  names: Dated<string>[]; terms: Dated<NonNullable<Terms>>[]; tax: Dated<NonNullable<Tax>>[];
  bankChanges: BankChange[]; version: number;
}
export const emptyParty = (): PartyState => ({ exists: false, partyId: "", entityId: "", kind: "vendor", names: [], terms: [], tax: [], bankChanges: [], version: 0 });

/** Insert a dated version, replacing one with the same date; kept in date order. */
const dated = <T>(xs: Dated<T>[], from: string, value: T | undefined) =>
  value === undefined ? xs : [...xs.filter((x) => x.from !== from), { from, value }].sort((a, b) => a.from.localeCompare(b.from));
const at = <T>(xs: Dated<T>[], date: string): T | null => { let v: T | null = null; for (const x of xs) if (x.from <= date) v = x.value; return v; };

export function evolveParty(s: PartyState, e: Envelope): PartyState {
  const n = { ...s, version: e.streamVersion };
  const setChange = (id: string, f: (c: BankChange) => BankChange) => n.bankChanges.map((c) => (c.changeId === id ? f(c) : c));
  switch (e.type) {
    case "PartyRegistered": {
      const d = e.data as EventData<"PartyRegistered">;
      return { ...n, exists: true, partyId: d.partyId, entityId: d.entityId, kind: d.kind, names: dated([], d.effectiveFrom, d.name),
        terms: dated([], d.effectiveFrom, d.terms), tax: dated([], d.effectiveFrom, d.taxStatus) };
    }
    case "PartyDetailsChanged": {
      const d = e.data as EventData<"PartyDetailsChanged">;
      return { ...n, names: dated(s.names, d.effectiveFrom, d.name), terms: dated(s.terms, d.effectiveFrom, d.terms), tax: dated(s.tax, d.effectiveFrom, d.taxStatus) };
    }
    case "BankChangeRequested": {
      const d = e.data as EventData<"BankChangeRequested">;
      return { ...n, bankChanges: [...s.bankChanges, { changeId: d.changeId, effectiveFrom: d.effectiveFrom, bank: d.bank, accountIdx: d.accountIdx,
        status: "pending", requestedBy: e.meta.principal }] };
    }
    case "BankChangeVerified": {
      const d = e.data as EventData<"BankChangeVerified">;
      return { ...n, bankChanges: setChange(d.changeId, (c) => ({ ...c, status: "verified", verifiedBy: e.meta.principal })) };
    }
    case "BankChangeReleased": {
      const d = e.data as EventData<"BankChangeReleased">;
      return { ...n, bankChanges: setChange(d.changeId, (c) => ({ ...c, status: "released", resolvedBy: e.meta.principal })) };
    }
    case "BankChangeRejected": {
      const d = e.data as EventData<"BankChangeRejected">;
      return { ...n, bankChanges: setChange(d.changeId, (c) => ({ ...c, status: "rejected", resolvedBy: e.meta.principal })) };
    }
    default:
      return n;
  }
}

/** Payments to the party are held while a bank-detail change is requested or verified but not released. */
export const openChange = (s: PartyState) => s.bankChanges.find((c) => c.status === "pending" || c.status === "verified") ?? null;
export const onHold = (s: PartyState) => openChange(s) !== null;

/** The party as in force on `date`: identity, terms, tax status and the released bank details effective then. */
export function asOf(s: PartyState, date: string) {
  let bank: BankDetails | null = null;
  for (const c of s.bankChanges) if (c.status === "released" && c.effectiveFrom <= date) bank = c.bank;
  return { partyId: s.partyId, entityId: s.entityId, kind: s.kind, name: at(s.names, date), terms: at(s.terms, date), taxStatus: at(s.tax, date), bank, hold: onHold(s) };
}

export type PartyCommand =
  | { kind: "RegisterParty"; partyId: string; entityId: string; partyKind: "vendor" | "customer" | "both"; name: string; effectiveFrom: string; terms?: Terms; taxStatus?: Tax }
  | { kind: "ChangePartyDetails"; effectiveFrom: string; name?: string; terms?: Terms; taxStatus?: Tax }
  | { kind: "RequestBankChange"; changeId: string; effectiveFrom: string; bank: BankDetails; accountIdx: string; source?: string }
  | { kind: "VerifyBankChange"; changeId: string; method: EventData<"BankChangeVerified">["method"]; reference: string }
  | { kind: "ReleaseBankChange"; changeId: string }
  | { kind: "RejectBankChange"; changeId: string; reason: string };

const isAgentPrincipal = (p: string) => /^(agent|system):/.test(p);

export function decideParty(s: PartyState, c: PartyCommand, principal: string): NewEvent[] {
  if (c.kind === "RegisterParty") {
    if (s.exists) throw new DomainError("party_exists", `party ${c.partyId} already exists`);
    return [{ type: "PartyRegistered", data: { partyId: c.partyId, entityId: c.entityId, kind: c.partyKind, name: c.name, effectiveFrom: c.effectiveFrom,
      ...(c.terms ? { terms: c.terms } : {}), ...(c.taxStatus ? { taxStatus: c.taxStatus } : {}) } }];
  }
  if (!s.exists) throw new DomainError("no_party", "party does not exist");
  const change = (id: string) => {
    const ch = s.bankChanges.find((x) => x.changeId === id);
    if (!ch) throw new DomainError("no_change", `no bank-detail change ${id}`);
    return ch;
  };
  switch (c.kind) {
    case "ChangePartyDetails": {
      if (c.name === undefined && c.terms === undefined && c.taxStatus === undefined) return [];
      return [{ type: "PartyDetailsChanged", data: { partyId: s.partyId, effectiveFrom: c.effectiveFrom,
        ...(c.name !== undefined ? { name: c.name } : {}), ...(c.terms ? { terms: c.terms } : {}), ...(c.taxStatus ? { taxStatus: c.taxStatus } : {}) } }];
    }
    case "RequestBankChange": {
      if (s.bankChanges.some((x) => x.changeId === c.changeId)) return [];          // idempotent retry
      const open = openChange(s);
      if (open) throw new DomainError("change_open", `bank-detail change ${open.changeId} is still ${open.status}; resolve it first`);
      return [{ type: "BankChangeRequested", data: { partyId: s.partyId, changeId: c.changeId, effectiveFrom: c.effectiveFrom, bank: c.bank,
        accountIdx: c.accountIdx, ...(c.source ? { source: c.source } : {}) } }];
    }
    case "VerifyBankChange": {
      const ch = change(c.changeId);
      if (ch.status !== "pending") throw new DomainError("not_pending", `bank-detail change ${c.changeId} is ${ch.status}`);
      if (isAgentPrincipal(principal)) throw new DomainError("forbidden", "an agent may never verify a bank-detail change (POL-501)");
      if (principal === ch.requestedBy) throw new DomainError("same_person", "the person who requested a bank-detail change cannot verify it");
      return [{ type: "BankChangeVerified", data: { partyId: s.partyId, changeId: c.changeId, method: c.method, reference: c.reference } }];
    }
    case "ReleaseBankChange": {
      const ch = change(c.changeId);
      if (ch.status === "released") return [];
      if (ch.status !== "verified") throw new DomainError("not_verified", `bank-detail change ${c.changeId} is ${ch.status}; it must be verified before release`);
      if (isAgentPrincipal(principal)) throw new DomainError("forbidden", "an agent may never approve a bank-detail change (POL-501)");
      if (principal === ch.requestedBy) throw new DomainError("same_person", "the person who requested a bank-detail change cannot release it");
      return [{ type: "BankChangeReleased", data: { partyId: s.partyId, changeId: c.changeId } }];
    }
    case "RejectBankChange": {
      const ch = change(c.changeId);
      if (ch.status === "rejected") return [];
      if (ch.status === "released") throw new DomainError("already_released", `bank-detail change ${c.changeId} is already released`);
      return [{ type: "BankChangeRejected", data: { partyId: s.partyId, changeId: c.changeId, reason: c.reason } }];
    }
  }
}

// ------------------------------------------------------------------ the service
/** The part of the policy engine the party master needs (the engine lives in @kuber/policy). */
export interface PartyPolicies { decide(i: { eventCode: string; on: string; confidence?: number }): { policyIds: string[]; level: string } }
export const BANK_CHANGE_EVENT = "EVT-VENDOR-BANK-CHANGE";

export interface PartyView extends ReturnType<typeof asOf> { version: number; openChange: Omit<BankChange, "bank"> | null }
export interface PartyHold { partyId: string; changeId: string; status: "pending" | "verified" }

const normalizeBank = (b: BankDetails) => `${b.ifsc.toUpperCase()}|${b.accountNumber.replace(/^0+/, "")}`;

export class PartyMaster {
  constructor(private store: EventStore, private guard: ModuleGuard, private policies?: PartyPolicies,
              private clock: () => string = () => new Date().toISOString().slice(0, 10)) {}

  /** Load, decide and append under the party lock, then update the query side, all in one transaction. */
  private async run(tenant: string, partyId: string, principal: string, action: string, c: PartyCommand,
                    extra: { policyIds?: string[] } = {}): Promise<{ state: PartyState; events: Envelope[] }> {
    const stream = partyStream(tenant, partyId);
    const keys = await this.store.keys(tenant);
    return this.store.tenantTx(tenant, async (tx) => {
      await this.guard.permit(tenant, principal, action, { allBooks: true, party: partyId }, tx);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${stream}, 0))`;
      const before = (await this.store.readStream(tenant, stream, 0, tx)).reduce(evolveParty, emptyParty());
      const events = decideParty(before, c, principal);
      if (!events.length) return { state: before, events: [] };
      const written = await this.store.append("gl", tenant, { streamId: stream, expected: before.version, events },
        { principal, ...(extra.policyIds ? { policyIds: extra.policyIds } : {}) }, tx);
      const state = written.reduce(evolveParty, before);
      await this.project(tx, tenant, state, written, keys, principal);
      return { state, events: written };
    });
  }

  private async project(tx: TransactionSql, tenant: string, s: PartyState, events: Envelope[], keys: TenantKeys, principal: string) {
    const detail = keys.sealJson({ names: s.names, terms: s.terms, tax: s.tax }, partyDetailCtx(s.partyId));
    await tx`INSERT INTO mdm.parties (tenant_id, party_id, entity_id, kind, detail, hold, version, created_by)
      VALUES (${tenant}, ${s.partyId}, ${s.entityId}, ${s.kind}, ${detail}, ${onHold(s)}, ${s.version}, ${principal})
      ON CONFLICT (tenant_id, party_id) DO UPDATE SET detail = EXCLUDED.detail, hold = EXCLUDED.hold, version = EXCLUDED.version, updated_at = now()`;
    for (const e of events) {
      if (e.type === "BankChangeRequested") {
        const d = e.data as EventData<"BankChangeRequested">;
        await tx`INSERT INTO mdm.bank_changes (tenant_id, change_id, party_id, status, bank, account_idx, effective_from, requested_by)
          VALUES (${tenant}, ${d.changeId}, ${d.partyId}, 'pending', ${keys.sealJson(d.bank, bankChangeCtx(d.changeId))}, ${d.accountIdx}, ${d.effectiveFrom}, ${e.meta.principal})`;
      } else if (e.type === "BankChangeVerified") {
        const d = e.data as EventData<"BankChangeVerified">;
        await tx`UPDATE mdm.bank_changes SET status = 'verified', verified_by = ${e.meta.principal} WHERE tenant_id = ${tenant} AND change_id = ${d.changeId}`;
      } else if (e.type === "BankChangeReleased" || e.type === "BankChangeRejected") {
        const d = e.data as { changeId: string };
        await tx`UPDATE mdm.bank_changes SET status = ${e.type === "BankChangeReleased" ? "released" : "rejected"}, resolved_by = ${e.meta.principal}, resolved_at = now()
          WHERE tenant_id = ${tenant} AND change_id = ${d.changeId}`;
      } else if (e.type === "PartyReviewRaised") {
        const d = e.data as EventData<"PartyReviewRaised">;
        await tx`INSERT INTO mdm.reviews (tenant_id, review_id, party_id, other_party_id, reason)
          VALUES (${tenant}, ${d.reviewId}, ${d.partyId}, ${d.otherPartyId}, ${d.reason}) ON CONFLICT DO NOTHING`;
      }
    }
  }

  async register(tenant: string, principal: string, p: { partyId: string; entityId: string; kind: "vendor" | "customer" | "both"; name: string;
    effectiveFrom?: string; terms?: Terms; taxStatus?: Tax }) {
    const r = await this.run(tenant, p.partyId, principal, "party.manage", { kind: "RegisterParty", partyId: p.partyId, entityId: p.entityId,
      partyKind: p.kind, name: p.name, effectiveFrom: p.effectiveFrom ?? this.clock(), terms: p.terms, taxStatus: p.taxStatus });
    return this.view(r.state, p.effectiveFrom ?? this.clock());
  }

  async changeDetails(tenant: string, principal: string, partyId: string, c: { effectiveFrom: string; name?: string; terms?: Terms; taxStatus?: Tax }) {
    const r = await this.run(tenant, partyId, principal, "party.manage", { kind: "ChangePartyDetails", ...c });
    return this.view(r.state, c.effectiveFrom);
  }

  /**
   * Maker: request new beneficiary bank details. Puts the party on hold (POL-501) and, when another
   * party already has the same account, raises a review item for each such party (never a merge).
   * `action`: `portal.supplier.bank_request` when the supplier itself asks through its portal (role
   * model v2); the guard then holds it to its own party, and the supplier, as requester, can never
   * verify or release its own change.
   */
  async requestBankChange(tenant: string, principal: string, partyId: string, c: { bank: BankDetails; effectiveFrom?: string; source?: string; changeId?: string },
                          opts: { action?: "party.manage" | "portal.supplier.bank_request" } = {}) {
    const keys = await this.store.keys(tenant);
    const changeId = c.changeId ?? uuid();
    const accountIdx = keys.index("party-bank", normalizeBank(c.bank));
    const on = c.effectiveFrom ?? this.clock();
    const decision = this.policies?.decide({ eventCode: BANK_CHANGE_EVENT, on: this.clock(), confidence: 1 });
    const stream = partyStream(tenant, partyId);
    const out = await this.store.tenantTx(tenant, async (tx) => {
      await this.guard.permit(tenant, principal, opts.action ?? "party.manage", { allBooks: true, party: partyId }, tx);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${stream}, 0))`;
      const before = (await this.store.readStream(tenant, stream, 0, tx)).reduce(evolveParty, emptyParty());
      const events = decideParty(before, { kind: "RequestBankChange", changeId, effectiveFrom: on, bank: c.bank, accountIdx, source: c.source }, principal);
      if (!events.length) return { state: before, reviews: [] as string[] };
      // Shared identifier: the same account on any other party (whatever the status, except rejected).
      const others = await tx<{ party_id: string }[]>`SELECT DISTINCT party_id FROM mdm.bank_changes
        WHERE tenant_id = ${tenant} AND account_idx = ${accountIdx} AND party_id <> ${partyId} AND status <> 'rejected' ORDER BY party_id`;
      for (const o of others) {
        events.push({ type: "PartyReviewRaised", data: { reviewId: stableId("party-review", `${tenant}/${changeId}/${o.party_id}`), partyId,
          otherPartyId: o.party_id, reason: "shared_bank_account" } });
      }
      const written = await this.store.append("gl", tenant, { streamId: stream, expected: before.version, events },
        { principal, ...(decision ? { policyIds: decision.policyIds } : {}) }, tx);
      const state = written.reduce(evolveParty, before);
      await this.project(tx, tenant, state, written, keys, principal);
      return { state, reviews: others.map((o) => o.party_id) };
    });
    return { changeId, status: "pending" as const, hold: onHold(out.state), sharedWith: out.reviews, policyIds: decision?.policyIds ?? [] };
  }

  /** Checker: record the out-of-band verification (call-back on a number on file, penny drop, ...). */
  async verifyBankChange(tenant: string, principal: string, partyId: string, changeId: string, v: { method: EventData<"BankChangeVerified">["method"]; reference: string }) {
    const r = await this.run(tenant, partyId, principal, "party.bank.verify", { kind: "VerifyBankChange", changeId, ...v });
    return { changeId, status: r.state.bankChanges.find((x) => x.changeId === changeId)!.status, hold: onHold(r.state) };
  }

  /** Fresh approval of a verified change: the new details apply from their effective date and the hold lifts. */
  async releaseBankChange(tenant: string, principal: string, partyId: string, changeId: string) {
    const r = await this.run(tenant, partyId, principal, "party.bank.release", { kind: "ReleaseBankChange", changeId });
    return { changeId, status: r.state.bankChanges.find((x) => x.changeId === changeId)!.status, hold: onHold(r.state) };
  }

  /** Verification failed: the change is rejected; the earlier approved details stay in force. */
  async rejectBankChange(tenant: string, principal: string, partyId: string, changeId: string, reason: string) {
    const r = await this.run(tenant, partyId, principal, "party.bank.verify", { kind: "RejectBankChange", changeId, reason });
    return { changeId, status: r.state.bankChanges.find((x) => x.changeId === changeId)!.status, hold: onHold(r.state) };
  }

  /** The party as in force on `date` (default today), from its event history. null when unknown. */
  async get(tenant: string, partyId: string, date?: string): Promise<PartyView | null> {
    const s = (await this.store.readStream(tenant, partyStream(tenant, partyId))).reduce(evolveParty, emptyParty());
    return s.exists ? this.view(s, date ?? this.clock()) : null;
  }

  private view(s: PartyState, date: string): PartyView {
    const oc = openChange(s);
    const { bank: _bank, ...open } = oc ?? ({} as BankChange);
    return { ...asOf(s, date), version: s.version, openChange: oc ? open : null };
  }

  /** Parties among `partyIds` whose payments are held (an unreleased bank-detail change). */
  async holds(tenant: string, partyIds: Iterable<string>, tx?: TransactionSql): Promise<PartyHold[]> {
    const ids = [...new Set(partyIds)];
    if (!ids.length) return [];
    const q = (t: TransactionSql) => t<PartyHold[]>`
      SELECT party_id AS "partyId", change_id AS "changeId", status FROM mdm.bank_changes
      WHERE tenant_id = ${tenant} AND party_id = ANY(${ids}) AND status IN ('pending', 'verified') ORDER BY party_id`;
    return tx ? q(tx) : this.store.tenantTx(tenant, q);
  }

  /**
   * Who verified the bank details of each party among `partyIds`: the latest verified or released
   * change per party (conflict matrix, role model v2: that person may not approve a payment to it).
   */
  async verifiers(tenant: string, partyIds: Iterable<string>, tx?: TransactionSql): Promise<{ partyId: string; principal: string }[]> {
    const ids = [...new Set(partyIds)];
    if (!ids.length) return [];
    const q = (t: TransactionSql) => t<{ partyId: string; principal: string }[]>`
      SELECT DISTINCT ON (party_id) party_id AS "partyId", verified_by AS principal FROM mdm.bank_changes
      WHERE tenant_id = ${tenant} AND party_id = ANY(${ids}) AND status IN ('verified', 'released') AND verified_by IS NOT NULL
      ORDER BY party_id, requested_at DESC`;
    return tx ? q(tx) : this.store.tenantTx(tenant, q);
  }

  /** Legal entity of each registered party among `partyIds` (unregistered ids are absent). */
  async entities(tenant: string, partyIds: Iterable<string>, tx?: TransactionSql): Promise<Map<string, string>> {
    const ids = [...new Set(partyIds)];
    if (!ids.length) return new Map();
    const q = (t: TransactionSql) => t<{ party_id: string; entity_id: string }[]>`
      SELECT party_id, entity_id FROM mdm.parties WHERE tenant_id = ${tenant} AND party_id = ANY(${ids})`;
    const rows = tx ? await q(tx) : await this.store.tenantTx(tenant, q);
    return new Map(rows.map((r) => [r.party_id, r.entity_id]));
  }

  /** Registered parties (ids, kind, legal entity, hold), by id; at most `limit` (default 200, at most 1000). Names and bank details: get(). */
  async list(tenant: string, opts: { kind?: "vendor" | "customer" | "both"; limit?: number } = {}) {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200) || 1, 1), 1000);
    return this.store.tenantTx(tenant, (tx) => tx<{ partyId: string; entityId: string; kind: string; hold: boolean }[]>`
      SELECT party_id AS "partyId", entity_id AS "entityId", kind, hold FROM mdm.parties
      WHERE tenant_id = ${tenant} ${opts.kind ? tx`AND kind = ${opts.kind}` : tx``} ORDER BY party_id LIMIT ${limit}`);
  }

  /** Open review items (shared identifiers), oldest first. */
  async reviews(tenant: string) {
    return this.store.tenantTx(tenant, (tx) => tx<{ reviewId: string; partyId: string; otherPartyId: string; reason: string }[]>`
      SELECT review_id AS "reviewId", party_id AS "partyId", other_party_id AS "otherPartyId", reason FROM mdm.reviews
      WHERE tenant_id = ${tenant} AND status = 'open' ORDER BY created_at, review_id`);
  }
}
