/**
 * The certified close as the certification of mapped statements (FIN-RPT-01 × FIN-CLS-03/04).
 *
 * A period of a book that has a close record is certified exactly when its current close is
 * certified: the certification is that close (close.closes, its content hash and the ledger
 * position it was certified at, so a later back-dated posting still withdraws it in the
 * statements). Reopening the period withdraws the close and with it the statements'
 * certification. A period the close workflow has never certified falls back to the source it
 * replaces (reporting.snapshots of kind close/report), so books outside the close workflow keep
 * their behaviour.
 */
import type { Certification, CertificationSource } from "@kuber/reporting";

export interface CloseCertificationLookup {
  /** Every close record (certified and withdrawn) of the book's period, oldest version first. */
  closeRecordsFor(tenant: string, book: string, periodEnd: string): Promise<{ closeId: string; version: number; status: "certified" | "withdrawn"; closeSeq: number;
    contentHash: string; certifiedBy: string; certifiedAt: string }[]>;
}

export class CloseCertificationSource implements CertificationSource {
  constructor(private close: CloseCertificationLookup, private fallback: CertificationSource | null = null) {}

  async certifiedFor(tenantId: string, bookId: string, periodEnd: string): Promise<Certification | null> {
    const records = await this.close.closeRecordsFor(tenantId, bookId, periodEnd);
    if (!records.length) return this.fallback ? this.fallback.certifiedFor(tenantId, bookId, periodEnd) : null;
    const cur = records.filter((r) => r.status === "certified").at(-1);
    if (!cur) return null;   // the period's close was withdrawn (reopened): its statements are no longer certified
    return { source: "close.closes", snapshotId: cur.closeId, kind: "close", seq: cur.closeSeq, periodEnd, contentHash: cur.contentHash,
      takenBy: cur.certifiedBy, takenAt: cur.certifiedAt };
  }
}
