/**
 * FIN-MDM-05: periodic access and master-change review. The report is built from the tenant's
 * identity audit stream (every membership, invitation, passkey, session, settings, authority,
 * delegation, conflict and kill-switch change) and the membership table:
 *
 *   removed       members removed (MemberRemoved)
 *   dormant       active people with no sign-in (passkey use or bound session) for `dormantDays`
 *   roleChanges   role or book-scope changes (MemberRoleChanged)
 *   changes       every other identity change
 *
 * Each item has a stable id (the event id; `dormant:<principal>:<last sign-in>` for dormancy) and
 * the latest disposition recorded for it. A reviewer (access.review) records a disposition
 * (appropriate, revoke, investigate, accepted) with a note: an AccessReviewDisposed event plus the
 * latest-per-item row. Nobody reviews an item about themselves or a change they made.
 */
import type { TransactionSql } from "postgres";
import { Principal, type Envelope } from "@kuber/contracts";
import type { EventStore } from "@kuber/eventstore";
import type { IdentityHost } from "./authority.ts";
import { accessReviewNoteCtx } from "./fin-migrations.ts";

const DAY = 86_400_000;
const actorOf = (by: string) => (Principal.safeParse(by).success ? by : `system:${by.replace(/[^\w.@-]+/g, ".").replace(/^\.+|\.+$/g, "") || "unknown"}`);
export const REVIEW_DECISIONS = ["appropriate", "revoke", "investigate", "accepted"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface ReviewItem {
  itemId: string; kind: "removed" | "dormant" | "role_change" | "identity_change"; type: string;
  subject: string | null; actor: string | null; at: string; detail: Record<string, unknown>;
  disposition: { decision: ReviewDecision; note: string; reviewer: string; decidedAt: string } | null;
}
export interface AccessReviewReport {
  tenant: string; since: string; asOf: string; dormantDays: number;
  removed: ReviewItem[]; dormant: ReviewItem[]; roleChanges: ReviewItem[]; changes: ReviewItem[];
  unreviewed: number; items: number;
}

const kindOf = (type: string): ReviewItem["kind"] => (type === "MemberRemoved" ? "removed" : type === "MemberRoleChanged" ? "role_change" : "identity_change");
const subjectOf = (e: Envelope): string | null => {
  const d = e.data as Record<string, unknown>;
  const s = d.principal ?? d.grantee ?? null;
  return typeof s === "string" ? s : null;
};

export class AccessReview {
  constructor(private store: EventStore, private host: IdentityHost) {}

  /** The review report (read-only; the caller authorizes members.read). `since` defaults to `dormantDays` ago. */
  async report(tenant: string, o: { since?: string; dormantDays?: number } = {}): Promise<AccessReviewReport> {
    const now = this.host.now(), dormantDays = o.dormantDays ?? 90;
    const since = o.since ? new Date(o.since) : new Date(now - dormantDays * DAY);
    if (Number.isNaN(since.getTime())) throw this.host.error("bad_since", "since is a date (YYYY-MM-DD)");
    const keys = await this.store.keys(tenant);
    const { dispositions, members } = await this.store.tenantTx(tenant, async (tx) => ({
      dispositions: await tx<{ item_id: string; decision: ReviewDecision; note: string; reviewer: string; decided_at: Date }[]>`
        SELECT item_id, decision, note, reviewer, decided_at FROM identity.access_reviews WHERE tenant_id = ${tenant}`,
      members: await tx<{ principal: string; role: string; books: string[] | null; created_at: Date; last_seen: Date | null }[]>`
        SELECT m.principal, m.role, m.books, m.created_at,
               GREATEST((SELECT max(c.last_used_at) FROM identity.credentials c WHERE c.tenant_id = m.tenant_id AND c.principal = m.principal),
                        (SELECT max(s.created_at) FROM identity.sessions s WHERE s.tenant_id = m.tenant_id AND s.principal = m.principal AND s.revoked_at IS NULL)) AS last_seen
        FROM identity.members m WHERE m.tenant_id = ${tenant} AND m.status = 'active' AND m.role <> 'agent' ORDER BY m.principal`,
    }));
    const disp = new Map(dispositions.map((d) => [d.item_id, { decision: d.decision, note: keys.openText(d.note, accessReviewNoteCtx(d.item_id)),
      reviewer: d.reviewer, decidedAt: d.decided_at.toISOString() }]));
    const events = (await this.store.readStream(tenant, `${tenant}/identity`, 0))
      .filter((e) => e.type !== "AccessReviewDisposed" && new Date(e.recordedAt).getTime() >= since.getTime());
    const items: ReviewItem[] = events.map((e) => ({ itemId: e.eventId, kind: kindOf(e.type), type: e.type, subject: subjectOf(e), actor: e.meta.principal,
      at: new Date(e.recordedAt).toISOString(), detail: e.data as Record<string, unknown>, disposition: disp.get(e.eventId) ?? null }));
    const cutoff = now - dormantDays * DAY;
    const dormant: ReviewItem[] = members.filter((m) => (m.last_seen ?? m.created_at).getTime() < cutoff).map((m) => {
      const itemId = `dormant:${m.principal}:${m.last_seen ? m.last_seen.toISOString().slice(0, 10) : "never"}`;
      return { itemId, kind: "dormant" as const, type: "Dormant", subject: m.principal, actor: null, at: new Date(now).toISOString(),
        detail: { role: m.role, books: m.books, lastSignIn: m.last_seen?.toISOString() ?? null, memberSince: m.created_at.toISOString(),
          daysSinceSignIn: Math.floor((now - (m.last_seen ?? m.created_at).getTime()) / DAY) }, disposition: disp.get(itemId) ?? null };
    });
    const all = [...items, ...dormant];
    return {
      tenant, since: since.toISOString(), asOf: new Date(now).toISOString(), dormantDays,
      removed: items.filter((i) => i.kind === "removed"), dormant, roleChanges: items.filter((i) => i.kind === "role_change"),
      changes: items.filter((i) => i.kind === "identity_change"),
      unreviewed: all.filter((i) => !i.disposition).length, items: all.length,
    };
  }

  /** Record a reviewer's disposition of one item (access.review). */
  async dispose(tenant: string, reviewer: string, itemId: string, d: { decision: ReviewDecision; note: string }) {
    if (!REVIEW_DECISIONS.includes(d.decision)) throw this.host.error("bad_decision", `decision is one of ${REVIEW_DECISIONS.join(", ")}`);
    const note = d.note.trim();
    if (!note) throw this.host.error("bad_note", "a disposition needs a note");
    const keys = await this.store.keys(tenant);
    return this.store.tenantTx(tenant, async (tx: TransactionSql) => {
      await this.host.authorize(tenant, reviewer, "access.review", { allBooks: true }, tx);
      let kind: ReviewItem["kind"], subject: string | null, actor: string | null = null;
      const dm = /^dormant:([a-z_]+:[\w.@-]+):(never|\d{4}-\d{2}-\d{2})$/.exec(itemId);
      if (dm) { kind = "dormant"; subject = dm[1]!; }
      else {
        const e = (await this.store.readStream(tenant, `${tenant}/identity`, 0, tx)).find((x) => x.eventId === itemId && x.type !== "AccessReviewDisposed");
        if (!e) throw this.host.error("not_found", `no access-review item ${itemId}`, 404);
        kind = kindOf(e.type); subject = subjectOf(e); actor = e.meta.principal;
      }
      if (subject === reviewer || actor === reviewer) throw this.host.denied("a reviewer may not review their own access or a change they made");
      await tx`INSERT INTO identity.access_reviews (tenant_id, item_id, kind, subject, decision, note, reviewer)
        VALUES (${tenant}, ${itemId}, ${kind}, ${subject}, ${d.decision}, ${keys.seal(note, accessReviewNoteCtx(itemId))}, ${reviewer})
        ON CONFLICT (tenant_id, item_id) DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note, reviewer = EXCLUDED.reviewer, decided_at = now()`;
      await this.store.append("identity", tenant, { streamId: `${tenant}/identity`, expected: "any",
        events: [{ type: "AccessReviewDisposed", data: { itemId, kind, subject: subject && Principal.safeParse(subject).success ? subject : null, decision: d.decision, note } }] },
        { principal: actorOf(reviewer) }, tx);
      return { itemId, kind, subject, decision: d.decision, reviewer };
    });
  }
}
