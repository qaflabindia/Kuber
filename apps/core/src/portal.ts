/**
 * External roles (role model v2, implementation design 6.3): what customers, suppliers, investors
 * and guests may read, filtered HERE, at the module boundary, never only in the interface.
 *
 *   Customer   its own open items, statement and payments received, derived from journals whose
 *              lines carry its party id on control accounts; it may raise a query (a case, recorded
 *              as an event on the party's portal stream)
 *   Supplier   its own bills and their payment status; it may request a bank-detail change, which
 *              enters the FIN-MDM-03 flow (POL-501 hold) with the supplier as requester, so it can
 *              never verify or release its own request
 *   Investor   certified report snapshots published to investors, nothing else
 *   Guest      items explicitly shared with it, until the share expires
 *
 * The party is always the one the membership is bound to (identity.boundParty), never one named in
 * the request. Every read goes through the identity module's authorization first.
 */
import type { BankDetails } from "@kuber/contracts";
import type { CertifiableKind } from "@kuber/reporting";
import { IdentityError } from "@kuber/identity";
import type { Cell } from "./cell.ts";

export interface PortalLine { bookId: string; journalId: string; date: string; voucherType: string; accountId: string; amount: string }
export interface OpenItem extends PortalLine { open: string; status: "open" | "partly_paid" | "paid" }
export interface PartyStatement { partyId: string; name: string | null; balance: string; lines: (PortalLine & { balance: string })[] }

const REPORT_KINDS: CertifiableKind[] = ["trial-balance", "profit-and-loss", "balance-sheet"];

export class Portal {
  constructor(private cell: Cell) {}

  /** Every line naming `partyId` on a control account, in every book of the party's legal entity, in date order. */
  private async partyLines(tenant: string, partyId: string): Promise<{ name: string | null; lines: (PortalLine & { cash: boolean })[] }> {
    const party = await this.cell.parties.get(tenant, partyId);
    const out: (PortalLine & { cash: boolean })[] = [];
    for (const bookId of await this.cell.reporting.bookIds(tenant)) {
      const s = await this.cell.gl.state(tenant, bookId);
      // A party belongs to one legal entity (FIN-MDM-01): only that entity's books can carry it.
      if (!s.exists || (party && party.entityId !== (s.config?.legalEntityId ?? s.entityId))) continue;
      for (const [journalId, j] of s.journals) {
        const own = j.lines.filter((l) => l.partyId === partyId && s.accounts.get(l.accountId)?.isControl);
        if (!own.length) continue;
        const cash = j.lines.some((l) => s.accounts.get(l.accountId)?.isCashLike);
        for (const l of own) out.push({ bookId, journalId, date: j.txnDate, voucherType: j.voucherType, accountId: l.accountId, amount: l.amount, cash });
      }
    }
    out.sort((a, b) => a.date.localeCompare(b.date) || a.bookId.localeCompare(b.bookId));
    return { name: party?.name ?? null, lines: out };
  }

  private statementOf(partyId: string, name: string | null, lines: PortalLine[], sign: 1n | -1n): PartyStatement {
    let bal = 0n;
    const rows = lines.map((l) => { bal += BigInt(l.amount) * sign; return { ...stripCash(l), amount: (BigInt(l.amount) * sign).toString(), balance: bal.toString() }; });
    return { partyId, name, balance: bal.toString(), lines: rows };
  }

  /**
   * Open items, oldest first: `sign` turns the party's control lines into "owed" (positive) and
   * "settled" (negative) amounts; settlements are applied to the oldest items first.
   */
  private items(lines: PortalLine[], sign: 1n | -1n): OpenItem[] {
    const items = lines.filter((l) => BigInt(l.amount) * sign > 0n).map((l) => ({ ...stripCash(l), amount: (BigInt(l.amount) * sign).toString(), left: BigInt(l.amount) * sign }));
    let settled = lines.filter((l) => BigInt(l.amount) * sign < 0n).reduce((a, l) => a - BigInt(l.amount) * sign, 0n);
    for (const it of items) { const take = settled < it.left ? settled : it.left; it.left -= take; settled -= take; }
    return items.map(({ left, ...it }) => ({ ...it, open: left.toString(), status: left === 0n ? "paid" : left === BigInt(it.amount) ? "open" : "partly_paid" }));
  }

  // ---------------------------------------------------------------- customer
  /** portal.customer.read: the customer's own statement, open invoices and payments received. */
  async customer(tenant: string, principal: string) {
    const partyId = await this.cell.identity.boundParty(tenant, principal, "portal.customer.read");
    const { name, lines } = await this.partyLines(tenant, partyId);
    // A receivable is a debit on the control account; a payment received credits it (with a cash-like line in the journal).
    return {
      statement: this.statementOf(partyId, name, lines, 1n),
      openItems: this.items(lines, 1n).filter((i) => i.status !== "paid"),
      paymentsReceived: lines.filter((l) => BigInt(l.amount) < 0n && l.cash).map((l) => ({ ...stripCash(l), amount: (-BigInt(l.amount)).toString() })),
    };
  }

  /** portal.customer.query: raise a query (a case) about the customer's own records. */
  query(tenant: string, principal: string, q: { subject: string; message: string; reference?: string }) {
    return this.cell.identity.openPortalQuery(tenant, principal, q);
  }

  queries(tenant: string, principal: string) { return this.cell.identity.portalQueries(tenant, principal); }

  // ---------------------------------------------------------------- supplier
  /** portal.supplier.read: the supplier's own bills with their payment status, payments made, and any open bank-detail change. */
  async supplier(tenant: string, principal: string) {
    const partyId = await this.cell.identity.boundParty(tenant, principal, "portal.supplier.read");
    const { name, lines } = await this.partyLines(tenant, partyId);
    const party = await this.cell.parties.get(tenant, partyId);
    // A bill credits the payable; a payment debits it (with a cash-like credit in the journal).
    return {
      statement: this.statementOf(partyId, name, lines, -1n),
      bills: this.items(lines, -1n),
      payments: lines.filter((l) => BigInt(l.amount) > 0n && l.cash).map(stripCash),
      bankChange: party?.openChange ? { changeId: party.openChange.changeId, status: party.openChange.status, effectiveFrom: party.openChange.effectiveFrom } : null,
      paymentsHeld: party?.hold ?? false,
    };
  }

  /**
   * portal.supplier.bank_request: the supplier asks for new beneficiary bank details. It enters the
   * FIN-MDM-03 flow with the supplier as requester: payments are held (POL-501) until a person
   * verifies it out of band and another releases it. The supplier can do neither.
   */
  async bankRequest(tenant: string, principal: string, b: { bank: BankDetails; effectiveFrom?: string }) {
    const partyId = await this.cell.identity.boundParty(tenant, principal, "portal.supplier.bank_request");
    return this.cell.parties.requestBankChange(tenant, principal, partyId, { bank: b.bank, effectiveFrom: b.effectiveFrom, source: "supplier-portal" },
      { action: "portal.supplier.bank_request" });
  }

  // ---------------------------------------------------------------- investor
  /** investor.read: certified snapshots published to investors (metadata). */
  async investorSnapshots(tenant: string, principal: string) {
    await this.cell.identity.authorize(tenant, principal, "investor.read");
    return (await this.cell.reporting.listSnapshots(tenant, undefined, { publishedOnly: true })).map((s) => ({ snapshotId: s.snapshot_id, bookId: s.book_id,
      kind: s.kind, seq: s.seq, contentHash: s.content_hash, takenAt: s.taken_at.toISOString() }));
  }

  /** investor.read: one published snapshot; an unpublished one is as if it did not exist. */
  async investorSnapshot(tenant: string, principal: string, snapshotId: string) {
    await this.cell.identity.authorize(tenant, principal, "investor.read");
    if (!(await this.cell.reporting.isPublished(tenant, snapshotId))) throw new IdentityError("not_found", `no published snapshot ${snapshotId}`, 404);
    return this.cell.reporting.getSnapshot(tenant, snapshotId);
  }

  /** snapshot.publish: publish a certified snapshot to investors, or withdraw it (audited in the identity stream). */
  async publish(tenant: string, principal: string, snapshotId: string, published: boolean) {
    const r = await this.cell.reporting.publishSnapshot(tenant, snapshotId, principal, published,
      (tx, bookId) => this.cell.identity.recordSnapshotPublication(tx, tenant, principal, { snapshotId, bookId, published }));
    if (!r) throw new IdentityError("not_found", `no snapshot ${snapshotId}`, 404);
    return r;
  }

  // ---------------------------------------------------------------- guest
  /** share.read: the guest's current shares. */
  shares(tenant: string, principal: string) { return this.cell.identity.sharesFor(tenant, principal); }

  /** share.read: the shared item itself, while the share is current. */
  async shared(tenant: string, principal: string, shareId: string) {
    const s = await this.cell.identity.shareFor(tenant, principal, shareId);
    if (s.itemType === "snapshot") {
      const snap = await this.cell.reporting.getSnapshot(tenant, s.itemId);
      if (!snap) throw new IdentityError("not_found", `the shared snapshot ${s.itemId} no longer exists`, 404);
      return { share: s, snapshot: snap };
    }
    const [book, kind] = s.itemId.split("/") as [string, CertifiableKind];
    if (!book || !REPORT_KINDS.includes(kind)) throw new IdentityError("bad_item", `shared report ${s.itemId} is not <book>/<${REPORT_KINDS.join("|")}>`, 400);
    const st = await this.cell.reporting.statement(tenant, book, kind, {});
    return { share: s, report: { bookId: book, kind, title: st.title, rows: st.rows.map((r) => ({ ...r, amount: r.amount.toString() })),
      totals: Object.fromEntries(Object.entries(st.totals).map(([k, v]) => [k, v.toString()])) } };
  }
}

/** The line as the party sees it (without the internal cash-like marker). */
const stripCash = (l: PortalLine & { cash?: boolean }): PortalLine =>
  ({ bookId: l.bookId, journalId: l.journalId, date: l.date, voucherType: l.voucherType, accountId: l.accountId, amount: l.amount });
