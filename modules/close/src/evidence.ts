/**
 * Close evidence (FIN-CLS-01/02). A task or a substantiation cites evidence by reference only:
 * {kind, id, hash}. The content stays with the module that produced it, and a pluggable resolver
 * per kind says whether a reference is valid for the book and period, now: the hash must be that
 * of the current certified content, so a reference to a changed or withdrawn item stops resolving.
 *
 *   bank_reconciliation      a certified bank reconciliation (FIN-CASH, another workstream): no resolver
 *                            is built in. Until one is registered (registerResolver, at merge time), a
 *                            bank reconciliation cannot be cited and the bank task cannot complete:
 *                            an unsupported module is never represented as reconciled.
 *   schedule_reconciliation  the recognition schedules reconciled to the GL for the period (FIN-GL-03)
 *   suspense_roll_forward    the suspense roll-forward for the period, balanced (FIN-GL-05)
 *   document                 an uploaded document's SHA-256, registered for the book (close.documents)
 */
import type { TransactionSql } from "postgres";
import { canonical, sha256, type EventData } from "@kuber/contracts";

export type EvidenceKind = EventData<"CloseTaskCompleted">["evidence"][number]["kind"];
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["bank_reconciliation", "schedule_reconciliation", "suspense_roll_forward", "document"];
export interface EvidenceRef { kind: EvidenceKind; id: string; hash: string }

export interface EvidenceQuery {
  tenant: string; book: string; periodEnd: string; periodStart: string;
  /** Set when the reference supports one account's substantiation (a bank reconciliation names its account). */
  accountId?: string;
  /** The caller's transaction (commit), when there is one. */
  tx?: TransactionSql;
}

/**
 * What a resolver answers. `balancePaise`: the balance the evidence substantiates, debit positive
 * (a bank reconciliation: the adjusted statement balance that must equal the book). `accountId`
 * and `periodEnd`: what the evidence is for, checked against the query.
 */
export type EvidenceResult =
  | { ok: true; balancePaise?: string; accountId?: string; periodEnd?: string; certifiedAt?: string; detail?: string }
  | { ok: false; reason: string };

export type EvidenceResolver = (ref: EvidenceRef, q: EvidenceQuery) => Promise<EvidenceResult>;

/**
 * Withdraws certifications of `kind` dated in a reopened period (FIN-CLS-04): a bank reconciliation
 * module registers one so reopening withdraws its certifications visibly. Returns what it withdrew.
 */
export type EvidenceWithdrawer = (tx: TransactionSql, q: { tenant: string; book: string; periodEnd: string; refs: EvidenceRef[]; reason: string; planId: string }) => Promise<string[]>;

/** The hash a reference to computed content carries: SHA-256 over its canonical JSON. */
export const contentHash = (v: unknown) => sha256(canonical(v));

export const isEvidenceRef = (x: unknown): x is EvidenceRef => {
  const r = x as EvidenceRef | null;
  return !!r && typeof r === "object" && (EVIDENCE_KINDS as readonly string[]).includes(r.kind) && typeof r.id === "string" && r.id.length > 0
    && r.id.length <= 300 && typeof r.hash === "string" && /^[0-9a-f]{64}$/.test(r.hash);
};

export class EvidenceRegistry {
  private resolvers = new Map<EvidenceKind, EvidenceResolver>();
  private withdrawers = new Map<EvidenceKind, EvidenceWithdrawer>();

  /** Install (or replace) the resolver of a kind. FIN-CASH registers "bank_reconciliation" here. */
  registerResolver(kind: EvidenceKind, r: EvidenceResolver) { this.resolvers.set(kind, r); }
  registerWithdrawer(kind: EvidenceKind, w: EvidenceWithdrawer) { this.withdrawers.set(kind, w); }
  has(kind: EvidenceKind) { return this.resolvers.has(kind); }
  withdrawer(kind: EvidenceKind) { return this.withdrawers.get(kind); }

  /** Resolve one reference; a missing resolver, a thrown validation or a mismatch is a refusal with the reason. */
  async resolve(ref: EvidenceRef, q: EvidenceQuery): Promise<EvidenceResult> {
    if (!isEvidenceRef(ref)) return { ok: false, reason: "not an evidence reference {kind, id, hash}" };
    const r = this.resolvers.get(ref.kind);
    if (!r) {
      return { ok: false, reason: ref.kind === "bank_reconciliation"
        ? "no bank reconciliation service is installed (FIN-CASH): a certified bank reconciliation cannot be verified, so it cannot be cited"
        : `no resolver for ${ref.kind} evidence` };
    }
    const out = await r(ref, q);
    if (!out.ok) return out;
    if (q.accountId && out.accountId && out.accountId !== q.accountId) return { ok: false, reason: `the ${ref.kind} ${ref.id} is for account ${out.accountId}, not ${q.accountId}` };
    if (out.periodEnd && out.periodEnd !== q.periodEnd) return { ok: false, reason: `the ${ref.kind} ${ref.id} is for the period ending ${out.periodEnd}, not ${q.periodEnd}` };
    return out;
  }

  /** Resolve several; returns the refusals (empty when all resolve). */
  async problems(refs: EvidenceRef[], q: EvidenceQuery): Promise<string[]> {
    const out: string[] = [];
    for (const ref of refs) {
      const r = await this.resolve(ref, q);
      if (!r.ok) out.push(`${ref.kind} ${ref.id}: ${r.reason}`);
    }
    return out;
  }
}
