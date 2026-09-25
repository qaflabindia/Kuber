/**
 * Linked tenants (design 6.4, structure 2). A company that must stay a separate tenant links to the
 * group tenant by mutual consent:
 *
 *   request   the group's superuser (settings.manage; the owner role until ws5/roles lands)
 *   accept    the subsidiary's superuser (settings.manage in the subsidiary tenant)
 *   revoke    either side, at any time
 *
 * The consent record is a row and an event in BOTH tenants, written in one database transaction
 * (the transaction switches `kuber.tenant`, so row-level security still checks each write).
 *
 * Over an active link the subsidiary publishes certified packs: its certified trial balance (with
 * each account's statement mapping), its IC balances and schedule, and the ownership facts it
 * controls. A pack is hash-chained (prevPackHash) and signed, then copied into
 * `consolidation.linked_packs` in the group tenant:
 *
 *   inner   sealed with a key derived from the SUBSIDIARY's keyring (TenantKeys.deriveKey); the
 *           signature is an HMAC under another key derived the same way
 *   outer   sealed with the GROUP's tenant key
 *
 * The group reads only that table. It never reads the subsidiary's ledger, projections or events.
 * If the subsidiary is crypto-shredded its key material is gone, so the inner token cannot be
 * opened: the group shows the pack as unavailable, and it cannot count towards certification.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { TransactionSql } from "postgres";
import { canonical, GENESIS_HASH, sha256, uuid, type EventData } from "@kuber/contracts";
import { CryptoError, openWith, sealWith } from "@kuber/crypto";
import type { NewEvent } from "@kuber/eventstore";
import type { EntityPack, TbRow } from "./engine.ts";
import { icSchedule, type IcSchedule } from "./ic.ts";
import { linkedPackCtx } from "./migrations.ts";
import { linkStream, type IcLink } from "./register.ts";
import { ConsolidationError, packHashOf, type Consolidation } from "./service.ts";
import type { Nature } from "./types.ts";

export interface LinkRow {
  linkId: string; role: "group" | "subsidiary"; groupTenant: string; subsidiaryTenant: string; groupId: string; entityId: string;
  status: "requested" | "active" | "revoked"; requestedBy: string; acceptedBy: string | null; revokedBy: string | null; revokeReason: string | null;
}
export interface PackBody {
  linkId: string; packId: string; entityId: string; groupTenant: string; subsidiaryTenant: string; periodEnd: string;
  tb: (Omit<TbRow, "balance"> & { balance: string })[];
  ic: unknown;
  ownershipFacts: { childEntityId: string; ownershipBp: number; votingBp: number }[];
  snapshot: { snapshotId: string; contentHash: string; seq: number; ledgerHash: string | null };
  prevPackHash: string; publishedBy: string;
}
type LatestPack = { available: true; pack: EntityPack; packId: string } | { available: false; reason: string; packId: string };

const J = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const unJ = (ic: { balances: { balance: string }[]; txns: { control: string; tax: string; pl: string; plLines: { amount: string }[] }[] }): IcSchedule => ({
  balances: ic.balances.map((b) => ({ ...(b as never as IcSchedule["balances"][number]), balance: BigInt(b.balance) })),
  txns: ic.txns.map((t) => ({ ...(t as never as IcSchedule["txns"][number]), control: BigInt(t.control), tax: BigInt(t.tax), pl: BigInt(t.pl),
    plLines: t.plLines.map((l) => ({ ...(l as never as IcSchedule["txns"][number]["plLines"][number]), amount: BigInt(l.amount) })) })),
});
const packKeyCtx = (groupTenant: string, linkId: string) => `${groupTenant}|${linkId}`;

export class LinkedTenants {
  constructor(private c: Consolidation) {}
  private get store() { return this.c.d.store; }

  /** Run `fn` in one transaction, switching the tenant (RLS applies to every statement). */
  private both<T>(first: string, fn: (tx: TransactionSql, as: (tenant: string) => Promise<void>) => Promise<T>): Promise<T> {
    return this.store.tenantTx(first, (tx) => fn(tx, async (t) => { await tx`SELECT set_config('kuber.tenant', ${t}, true)`; }));
  }

  private async row(tenant: string, linkId: string, tx?: TransactionSql): Promise<LinkRow | null> {
    const q = (t: TransactionSql) => t<{ link_id: string; role: "group" | "subsidiary"; group_tenant: string; subsidiary_tenant: string; group_id: string; entity_id: string;
      status: LinkRow["status"]; requested_by: string; accepted_by: string | null; revoked_by: string | null; revoke_reason: string | null }[]>`
      SELECT link_id, role, group_tenant, subsidiary_tenant, group_id, entity_id, status, requested_by, accepted_by, revoked_by, revoke_reason
      FROM consolidation.links WHERE tenant_id = ${tenant} AND link_id = ${linkId}`;
    const [r] = tx ? await q(tx) : await this.store.tenantTx(tenant, q);
    return r ? { linkId: r.link_id, role: r.role, groupTenant: r.group_tenant, subsidiaryTenant: r.subsidiary_tenant, groupId: r.group_id, entityId: r.entity_id,
      status: r.status, requestedBy: r.requested_by, acceptedBy: r.accepted_by, revokedBy: r.revoked_by, revokeReason: r.revoke_reason } : null;
  }

  async list(tenant: string): Promise<LinkRow[]> {
    const rows = await this.store.tenantTx(tenant, (tx) => tx<{ link_id: string }[]>`SELECT link_id FROM consolidation.links WHERE tenant_id = ${tenant} ORDER BY requested_at, link_id`);
    return Promise.all(rows.map((r) => this.row(tenant, r.link_id).then((x) => x!)));
  }

  private async append(tx: TransactionSql, tenant: string, linkId: string, principal: string, events: NewEvent[]) {
    await this.store.append("consolidation", tenant, { streamId: linkStream(tenant, linkId), expected: "any", events }, { principal }, tx);
  }

  /** The group's superuser asks a subsidiary tenant to link as entity `entityId` of group `groupId`. */
  async request(groupTenant: string, principal: string, r: { subsidiaryTenant: string; groupId: string; entityId: string }) {
    if (r.subsidiaryTenant === groupTenant) throw new ConsolidationError("same_tenant", "a tenant cannot link to itself", 400);
    await this.c.d.guard.authorize(groupTenant, principal, "settings.manage", { allBooks: true });
    const g = await this.c.group(groupTenant, r.groupId);
    if (!g.exists) throw new ConsolidationError("no_group", `no group ${r.groupId}`, 404);
    const linkId = uuid();
    await this.both(groupTenant, async (tx, as) => {
      for (const [tenant, role] of [[groupTenant, "group"], [r.subsidiaryTenant, "subsidiary"]] as const) {
        await as(tenant);
        await tx`INSERT INTO consolidation.links (tenant_id, link_id, role, group_tenant, subsidiary_tenant, group_id, entity_id, status, requested_by)
          VALUES (${tenant}, ${linkId}, ${role}, ${groupTenant}, ${r.subsidiaryTenant}, ${r.groupId}, ${r.entityId}, 'requested', ${principal})`;
        await this.append(tx, tenant, linkId, tenant === groupTenant ? principal : "system:group-link", [{ type: "GroupLinkRequested", data: { linkId, role, groupTenant,
          subsidiaryTenant: r.subsidiaryTenant, groupId: r.groupId, entityId: r.entityId } }]);
      }
    });
    return { linkId, status: "requested" as const };
  }

  /** The subsidiary's superuser accepts; both records become active. */
  async accept(subsidiaryTenant: string, principal: string, linkId: string) {
    await this.c.d.guard.authorize(subsidiaryTenant, principal, "settings.manage", { allBooks: true });
    const own = await this.row(subsidiaryTenant, linkId);
    if (!own || own.role !== "subsidiary") throw new ConsolidationError("no_link", `no link request ${linkId} for this tenant to accept`, 404);
    if (own.status !== "requested") throw new ConsolidationError("not_requested", `the link is ${own.status}`);
    await this.both(subsidiaryTenant, async (tx, as) => {
      for (const [tenant, role] of [[subsidiaryTenant, "subsidiary"], [own.groupTenant, "group"]] as const) {
        await as(tenant);
        const n = await tx`UPDATE consolidation.links SET status = 'active', accepted_by = ${principal}, accepted_at = now()
          WHERE tenant_id = ${tenant} AND link_id = ${linkId} AND status = 'requested' RETURNING 1`;
        if (!n.length) throw new ConsolidationError("not_requested", `the ${role} record of the link is not awaiting acceptance`);
        await this.append(tx, tenant, linkId, tenant === subsidiaryTenant ? principal : "system:group-link", [{ type: "GroupLinkAccepted", data: { linkId, role } }]);
      }
    });
    return { linkId, status: "active" as const };
  }

  /** Either side's superuser revokes; both records are revoked. Packs already received stay, but no longer count. */
  async revoke(tenant: string, principal: string, linkId: string, reason: string) {
    await this.c.d.guard.authorize(tenant, principal, "settings.manage", { allBooks: true });
    const own = await this.row(tenant, linkId);
    if (!own) throw new ConsolidationError("no_link", `no link ${linkId} in this tenant`, 404);
    if (own.status === "revoked") return { linkId, status: "revoked" as const };
    const peer = own.role === "group" ? own.subsidiaryTenant : own.groupTenant;
    await this.both(tenant, async (tx, as) => {
      for (const [t, role] of [[tenant, own.role], [peer, own.role === "group" ? "subsidiary" : "group"]] as const) {
        await as(t);
        await tx`UPDATE consolidation.links SET status = 'revoked', revoked_by = ${principal}, revoke_reason = ${reason}, revoked_at = now()
          WHERE tenant_id = ${t} AND link_id = ${linkId}`;
        await this.append(tx, t, linkId, t === tenant ? principal : "system:group-link", [{ type: "GroupLinkRevoked", data: { linkId, role, reason } }]);
      }
    });
    return { linkId, status: "revoked" as const };
  }

  /**
   * The subsidiary publishes its certified pack for `periodEnd` over an active link. Runs as the
   * subsidiary's person, reading only the subsidiary's own books; the only write into the group
   * tenant is the sealed pack row and its event.
   */
  async publish(subsidiaryTenant: string, principal: string, linkId: string, p: { bookId: string; periodEnd: string;
    icParties?: Record<string, string>; ownershipFacts?: PackBody["ownershipFacts"] }) {
    await this.c.d.guard.authorize(subsidiaryTenant, principal, "plan.approve.period", { book: p.bookId });
    const link = await this.row(subsidiaryTenant, linkId);
    if (!link || link.role !== "subsidiary") throw new ConsolidationError("no_link", `no link ${linkId} in this tenant`, 404);
    if (link.status !== "active") throw new ConsolidationError("link_not_active", `the link is ${link.status}: nothing can be published`);
    const snap = await this.c.certifiedTb(subsidiaryTenant, p.bookId, p.periodEnd);
    if (!snap || !snap.verified) throw new ConsolidationError("no_certified_pack", `no verified certified trial balance of ${p.bookId} as of ${p.periodEnd}: certify it first`);
    const s = await this.c.d.gl.state(subsidiaryTenant, p.bookId);
    const links: IcLink[] = Object.entries(p.icParties ?? {}).map(([partyId, counterpartyEntityId]) => ({ entityId: link.entityId, partyId, counterpartyEntityId }));
    const fy = `${Number(p.periodEnd.slice(5, 7)) >= s.config.fiscalYearStartMonth ? p.periodEnd.slice(0, 4) : Number(p.periodEnd.slice(0, 4)) - 1}-${String(s.config.fiscalYearStartMonth).padStart(2, "0")}-01`;
    const ic = icSchedule(link.entityId, s, links, snap.seq, p.periodEnd, fy);
    const tb = snap.statement.rows.map((r) => {
      const a = s.accounts.get(r.accountId!);
      return { accountId: r.accountId!, name: a?.name ?? r.accountId!, nature: (a?.nature ?? "asset") as Nature, taxonomyTag: a?.taxonomyTag ?? null,
        balance: (r.section === "Dr" ? BigInt(r.amount) : -BigInt(r.amount)).toString() };
    }).sort((a, b) => a.accountId.localeCompare(b.accountId));
    // Hash chain: the previous pack this subsidiary published over this link (its own stream).
    const prev = (await this.store.readStream(subsidiaryTenant, linkStream(subsidiaryTenant, linkId))).filter((e) => e.type === "LinkedPackPublished").at(-1);
    const prevPackHash = prev ? (prev.data as EventData<"LinkedPackPublished">).packHash : GENESIS_HASH;
    const packId = uuid();
    const body: PackBody = { linkId, packId, entityId: link.entityId, groupTenant: link.groupTenant, subsidiaryTenant, periodEnd: p.periodEnd, tb, ic: J(ic),
      ownershipFacts: p.ownershipFacts ?? [], snapshot: { snapshotId: snap.snapshotId, contentHash: snap.contentHash, seq: snap.seq, ledgerHash: snap.ledgerHash },
      prevPackHash, publishedBy: principal };
    const packHash = sha256(canonical(body));
    const subKeys = await this.store.keys(subsidiaryTenant), groupKeys = await this.store.keys(link.groupTenant);
    const signature = createHmac("sha256", subKeys.deriveKey("linked-pack-sign", linkId)).update(packHash).digest("hex");
    const inner = sealWith(subKeys.deriveKey("linked-pack", packKeyCtx(link.groupTenant, linkId)), 1, JSON.stringify({ body, packHash, signature }), `${subsidiaryTenant}|linked-pack|${packId}`);
    const outer = groupKeys.seal(inner, linkedPackCtx(packId));
    await this.both(subsidiaryTenant, async (tx, as) => {
      await this.append(tx, subsidiaryTenant, linkId, principal, [{ type: "LinkedPackPublished", data: { linkId, packId, entityId: link.entityId, periodEnd: p.periodEnd, packHash, prevPackHash, role: "subsidiary" } }]);
      await as(link.groupTenant);
      const [g] = await tx<{ status: string }[]>`SELECT status FROM consolidation.links WHERE tenant_id = ${link.groupTenant} AND link_id = ${linkId} FOR UPDATE`;
      if (g?.status !== "active") throw new ConsolidationError("link_not_active", "the group's record of the link is not active");
      await tx`INSERT INTO consolidation.linked_packs (tenant_id, pack_id, link_id, entity_id, source_tenant, period_end, pack_hash, prev_pack_hash, body, published_by)
        VALUES (${link.groupTenant}, ${packId}, ${linkId}, ${link.entityId}, ${subsidiaryTenant}, ${p.periodEnd}, ${packHash}, ${prevPackHash}, ${outer}, ${principal})`;
      await this.append(tx, link.groupTenant, linkId, "system:group-link", [{ type: "LinkedPackPublished", data: { linkId, packId, entityId: link.entityId, periodEnd: p.periodEnd, packHash, prevPackHash, role: "group" } }]);
    });
    return { packId, packHash, prevPackHash };
  }

  /** Packs received in the group tenant (metadata only; the body is opened by `open`). */
  async packs(groupTenant: string) {
    return this.store.tenantTx(groupTenant, (tx) => tx<{ pack_id: string; link_id: string; entity_id: string; source_tenant: string; period_end: string; pack_hash: string; prev_pack_hash: string; published_at: Date }[]>`
      SELECT pack_id, link_id, entity_id, source_tenant, period_end::text, pack_hash, prev_pack_hash, published_at FROM consolidation.linked_packs
      WHERE tenant_id = ${groupTenant} ORDER BY published_at, pack_id`);
  }

  /**
   * Open a received pack: the group's key opens the outer layer; the subsidiary's derived key the inner.
   * A shredded subsidiary (or a tampered pack) makes it unavailable, with the reason.
   */
  async open(groupTenant: string, packId: string): Promise<{ available: true; body: PackBody; packHash: string } | { available: false; reason: string }> {
    const [r] = await this.store.tenantTx(groupTenant, (tx) => tx<{ body: string; source_tenant: string; link_id: string; pack_hash: string }[]>`
      SELECT body, source_tenant, link_id, pack_hash FROM consolidation.linked_packs WHERE tenant_id = ${groupTenant} AND pack_id = ${packId}`);
    if (!r) return { available: false, reason: `no pack ${packId}` };
    const inner = (await this.store.keys(groupTenant)).openText(r.body, linkedPackCtx(packId));
    let subKeys;
    try { subKeys = await this.store.keys(r.source_tenant); }
    catch (e) {
      if (e instanceof CryptoError && e.code === "shredded") return { available: false, reason: `subsidiary tenant ${r.source_tenant} was crypto-shredded: its packs are permanently unreadable` };
      throw e;
    }
    try {
      const x = JSON.parse(openWith(subKeys.deriveKey("linked-pack", packKeyCtx(groupTenant, r.link_id)), inner, `${r.source_tenant}|linked-pack|${packId}`).toString("utf8")) as { body: PackBody; packHash: string; signature: string };
      const want = createHmac("sha256", subKeys.deriveKey("linked-pack-sign", r.link_id)).update(x.packHash).digest();
      const ok = sha256(canonical(x.body)) === x.packHash && x.packHash === r.pack_hash && timingSafeEqual(Buffer.from(x.signature, "hex"), want);
      return ok ? { available: true, body: x.body, packHash: x.packHash } : { available: false, reason: "the pack's hash or signature does not verify" };
    } catch (e) {
      if (e instanceof CryptoError) return { available: false, reason: `the pack cannot be opened: ${e.message}` };
      throw e;
    }
  }

  /** The latest pack for an entity and period that counts: from a link that is active now. */
  async latestPack(groupTenant: string, entityId: string, periodEnd: string): Promise<LatestPack | null> {
    const [r] = await this.store.tenantTx(groupTenant, (tx) => tx<{ pack_id: string; status: string }[]>`
      SELECT p.pack_id, l.status FROM consolidation.linked_packs p JOIN consolidation.links l ON l.tenant_id = p.tenant_id AND l.link_id = p.link_id
      WHERE p.tenant_id = ${groupTenant} AND p.entity_id = ${entityId} AND p.period_end = ${periodEnd}
      ORDER BY p.published_at DESC, p.pack_id LIMIT 1`);
    if (!r) return null;
    if (r.status !== "active") return { available: false, reason: `the link is ${r.status}: its packs no longer count`, packId: r.pack_id };
    const o = await this.open(groupTenant, r.pack_id);
    if (!o.available) return { available: false, reason: o.reason, packId: r.pack_id };
    const b = o.body;
    const tb = b.tb.map((t) => ({ ...t, balance: BigInt(t.balance) }));
    const ic = unJ(b.ic as never);
    const ref = { linkId: b.linkId, packId: b.packId, subsidiaryTenant: b.subsidiaryTenant, snapshot: b.snapshot, linkedPackHash: o.packHash };
    return { available: true, packId: r.pack_id, pack: { entityId, source: "linked", tb, ic, ref, packHash: packHashOf(entityId, ref, ic) } };
  }
}
