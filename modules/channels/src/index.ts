/**
 * Channels module: turns raw inputs into SignalReceived + TransactionExtracted events, and keeps
 * the source original.
 *
 * Idempotency and completeness (F05):
 * - A signal is the exact upload (book + channel + bytes). Re-uploading it is a duplicate.
 * - Each source line gets a stable identity (see `lineIdentity`): account, date, direction, amount,
 *   reference, running balance and normalised narration, plus its occurrence among identical lines
 *   in the same file. Its transaction stream `<tenant>/txn/<id>` exists at most once.
 * - Imports into one book are serialised by a transaction-scoped advisory lock and existence is
 *   decided inside that transaction, so an overlapping import adds exactly the lines not already
 *   stored and reports every row as accepted, duplicate or skipped. Nothing is acknowledged that
 *   was not written.
 *
 * Source originals (F18): the uploaded bytes are stored sealed with the tenant key in
 * channels.signals, with their hash, the parser version, row count, control totals and the
 * disposition of every row; `original(signalId)` returns them for evidence. A statement whose
 * control totals do not reconcile is refused unless the caller explicitly accepts it (then it is
 * flagged in the signal and its record).
 */
import { canonical, sha256, type RawTxn } from "@kuber/contracts";
import { tenantRlsFor, type AppendRequest, type EventStore, type Migration } from "@kuber/eventstore";
import { STATEMENT_PARSER, parseBankStatement, parseChat, type ControlTotals, type DeclaredTotals, type SkippedRow } from "./parsers.ts";

export { STATEMENT_PARSER, parseBankCsv, parseBankStatement, parseChat, parseDate, readCsv } from "./parsers.ts";
export type { ControlTotals, DeclaredTotals, ParsedStatement, SkippedRow } from "./parsers.ts";

export const CHANNELS_MIGRATIONS: Migration[] = [{
  id: "channels-001-signals",
  sql: `
CREATE SCHEMA IF NOT EXISTS channels;
-- One row per accepted upload. original and detail are sealed with the tenant key; the hash is of
-- the plaintext bytes, so a retrieved original can be proven to be the one that was ingested.
CREATE TABLE channels.signals (
  tenant_id TEXT NOT NULL, signal_id TEXT NOT NULL, book_id TEXT NOT NULL, channel TEXT NOT NULL,
  content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL, parser TEXT NOT NULL,
  row_count INTEGER NOT NULL, accepted INTEGER NOT NULL, duplicates INTEGER NOT NULL, skipped INTEGER NOT NULL,
  control_status TEXT NOT NULL CHECK (control_status IN ('reconciled','unverifiable','mismatch','not_applicable')),
  original TEXT NOT NULL, detail TEXT NOT NULL,
  uploaded_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, signal_id));
` + tenantRlsFor("channels"),
}];

/** Originals are immutable for the application: only key rotation (owner role) rewrites them. */
export const channelsGrants = (role: string) => `REVOKE UPDATE, DELETE ON channels.signals FROM ${role};`;

export const signalOriginalCtx = (signalId: string) => `channels.signals.original|${signalId}`;
export const signalDetailCtx = (signalId: string) => `channels.signals.detail|${signalId}`;

export class IngestionError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) { super(message); }
}

export interface RowDisposition { row: number; disposition: "accepted" | "duplicate" | "skipped"; txnId?: string; reason?: string }

export interface SubmitResult {
  signalId: string;
  /** The same upload was already ingested: nothing new was written. */
  duplicate: boolean;
  /** Source rows (for a statement: data rows of the file). rows = accepted + duplicates + skipped. */
  rows: number;
  accepted: number;
  /** Rows whose transaction was already stored by an earlier (possibly overlapping) upload. */
  duplicates: number;
  /** Rows that are not transactions (no amount, or ambiguous), with reasons in `dispositions`. */
  skipped: number;
  txnIds: string[];
  controls?: ControlTotals;
  dispositions: RowDisposition[];
  warnings: string[];
}

export interface StatementOptions {
  instrument?: string;
  /** Totals printed on the statement (or entered by the uploader); each one given must agree. */
  declared?: DeclaredTotals;
  /** Accept a file whose control totals do not reconcile; it is flagged, not refused. */
  allowUnreconciled?: boolean;
}

interface Keyed { t: RawTxn; txnId: string; stream: string; row: number }

/** Normalised narration: case, spacing and punctuation differences between downloads do not matter. */
const normNarration = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Placeholder references ("0000000", "-", "NA") identify nothing. */
const normRef = (s: string | undefined) => {
  const r = (s ?? "").trim().toLowerCase();
  return !r || /^[0\s-]*$/.test(r) || ["na", "n/a", "nil", "none"].includes(r) ? null : r;
};

/**
 * Stable identity of one bank line. With a running balance two otherwise identical lines always
 * differ; without one, identical lines are told apart only by their occurrence within the file.
 */
export function lineIdentity(bookId: string, t: RawTxn): string {
  return canonical({ v: 2, bookId, instrument: t.instrument, txnDate: t.txnDate, direction: t.direction, amount: t.amount,
    reference: normRef(t.reference), balance: t.balance ?? null, narration: normNarration(t.narration) });
}

/** The identity used before v2 (occurrence per file, narration only lower-cased): still checked so old imports are not duplicated. */
function legacyIdentity(bookId: string, t: RawTxn): string {
  return canonical({ bookId, instrument: t.instrument, txnDate: t.txnDate, amount: t.amount, direction: t.direction,
    narration: t.narration.toLowerCase(), reference: t.reference ?? null });
}

export class Channels {
  constructor(private store: EventStore) {}

  /**
   * Submit a bank statement CSV. The fifth argument is the instrument account (default BANK) or options.
   * Throws IngestionError("control_totals") when the file's own figures do not add up.
   */
  async submitStatement(tenantId: string, bookId: string, csv: string, principal: string, opts: string | StatementOptions = "BANK") {
    const o: StatementOptions = typeof opts === "string" ? { instrument: opts } : opts;
    const parsed = parseBankStatement(csv, o.instrument ?? "BANK", o.declared ?? {});
    if (parsed.controls.status === "mismatch" && !o.allowUnreconciled) {
      throw new IngestionError("control_totals", `statement does not reconcile: ${parsed.controls.problems.join("; ")}`, parsed.controls);
    }
    const warnings: string[] = [];
    if (!parsed.hasBalance) warnings.push("no running balance column: identical lines on the same day in different files cannot be told apart");
    if (parsed.controls.status === "mismatch") warnings.push("control totals do not reconcile; accepted as flagged");
    return this.submit(tenantId, bookId, "statement_csv", "authoritative", csv, parsed.txns, principal,
      { rows: parsed.rows, skipped: parsed.skipped, controls: parsed.controls, parser: STATEMENT_PARSER, warnings });
  }

  /** Returns null when the text is not a transaction the rule parser understands. */
  async submitChat(tenantId: string, bookId: string, text: string, principal: string, on: string) {
    const t = parseChat(text, on);
    if (!t) return null;
    return this.submit(tenantId, bookId, "chat", "user", `${on}|${principal}|${text}`, [{ ...t, sourceRow: 1 }], principal, { parser: "chat-rules/1" });
  }

  /** Adapters for SMS, email, notifications and AA call this with already-extracted transactions. */
  submitRaw(tenantId: string, bookId: string, channel: string, trust: "authoritative" | "provisional" | "user",
            content: string, txns: RawTxn[], principal: string) {
    return this.submit(tenantId, bookId, channel, trust, content, txns.map((t, i) => ({ ...t, sourceRow: t.sourceRow ?? i + 1 })), principal, { parser: `${channel}/adapter` });
  }

  /** The retained original of a signal, opened, with its hash re-verified. */
  async original(tenantId: string, signalId: string) {
    const keys = await this.store.keys(tenantId);
    const [r] = await this.store.tenantTx(tenantId, (tx) => tx<SignalRow[]>`
      SELECT signal_id, book_id, channel, content_hash, byte_length, parser, row_count, accepted, duplicates, skipped, control_status,
             original, detail, uploaded_by, created_at FROM channels.signals WHERE tenant_id = ${tenantId} AND signal_id = ${signalId}`);
    if (!r) return null;
    const content = keys.openText(r.original, signalOriginalCtx(signalId));
    const detail = keys.openJson<{ controls?: ControlTotals; dispositions: RowDisposition[]; warnings: string[] }>(r.detail, signalDetailCtx(signalId));
    return {
      signalId, bookId: r.book_id, channel: r.channel, contentHash: r.content_hash, verified: sha256(content) === r.content_hash,
      byteLength: r.byte_length, parser: r.parser, rows: r.row_count, accepted: r.accepted, duplicates: r.duplicates, skipped: r.skipped,
      controlStatus: r.control_status, uploadedBy: r.uploaded_by, createdAt: r.created_at.toISOString(), content, ...detail,
    };
  }

  private async submit(tenantId: string, bookId: string, channel: string, trust: "authoritative" | "provisional" | "user",
                       content: string, txns: RawTxn[], principal: string,
                       src: { rows?: number; skipped?: SkippedRow[]; controls?: ControlTotals; parser: string; warnings?: string[] }): Promise<SubmitResult> {
    const signalId = sha256(`${bookId}|${channel}|${content}`).slice(0, 32);
    const signalStream = `${tenantId}/signal/${signalId}`;
    const originalHash = sha256(content);
    const skipped = src.skipped ?? [];
    const rows = src.rows ?? txns.length;

    // identity per line; identical lines inside one file are told apart by occurrence
    const seen = new Map<string, number>(), seenLegacy = new Map<string, number>();
    const keyed: (Keyed & { legacy: string })[] = txns.map((t, i) => {
      const base = lineIdentity(bookId, t);
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
      const lb = legacyIdentity(bookId, t);
      const ln = (seenLegacy.get(lb) ?? 0) + 1; seenLegacy.set(lb, ln);
      const txnId = sha256(`${base}|${n}`).slice(0, 32);
      return { t, txnId, stream: `${tenantId}/txn/${txnId}`, row: t.sourceRow ?? i + 1, legacy: `${tenantId}/txn/${sha256(`${lb}|${ln}`).slice(0, 32)}` };
    });
    const keys = await this.store.keys(tenantId);

    return this.store.tenantTx(tenantId, async (tx) => {
      // One import per book at a time; existence is decided after the lock, so it sees every committed import.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}/ingest/${bookId}`}, 0))`;
      const candidates = [signalStream, ...keyed.flatMap((k) => [k.stream, k.legacy])];
      const existing = new Set((await tx<{ stream_id: string }[]>`
        SELECT DISTINCT stream_id FROM es.events WHERE stream_id IN ${tx(candidates)}`).map((r) => r.stream_id));
      const skippedDisp: RowDisposition[] = skipped.map((s) => ({ row: s.row, disposition: "skipped", reason: s.reason }));
      if (existing.has(signalStream)) {
        return { signalId, duplicate: true, rows, accepted: 0, duplicates: keyed.length, skipped: skipped.length, txnIds: [],
          controls: src.controls, warnings: src.warnings ?? [],
          dispositions: sortRows([...keyed.map((k): RowDisposition => ({ row: k.row, disposition: "duplicate", txnId: k.txnId })), ...skippedDisp]) };
      }
      const fresh = keyed.filter((k) => !existing.has(k.stream) && !existing.has(k.legacy));
      const freshIds = new Set(fresh.map((k) => k.txnId));
      const dispositions = sortRows([
        ...keyed.map((k): RowDisposition => ({ row: k.row, disposition: freshIds.has(k.txnId) ? "accepted" : "duplicate", txnId: k.txnId })),
        ...skippedDisp]);
      const result: SubmitResult = { signalId, duplicate: false, rows, accepted: fresh.length, duplicates: keyed.length - fresh.length,
        skipped: skipped.length, txnIds: fresh.map((k) => k.txnId), controls: src.controls, dispositions, warnings: src.warnings ?? [] };
      if (result.accepted + result.duplicates + result.skipped !== rows) throw new Error(`row dispositions do not add up for signal ${signalId}`);

      await tx`INSERT INTO channels.signals (tenant_id, signal_id, book_id, channel, content_hash, byte_length, parser, row_count,
                 accepted, duplicates, skipped, control_status, original, detail, uploaded_by)
               VALUES (${tenantId}, ${signalId}, ${bookId}, ${channel}, ${originalHash}, ${Buffer.byteLength(content, "utf8")}, ${src.parser}, ${rows},
                 ${result.accepted}, ${result.duplicates}, ${result.skipped}, ${src.controls?.status ?? "not_applicable"},
                 ${keys.seal(content, signalOriginalCtx(signalId))},
                 ${keys.sealJson({ controls: src.controls, dispositions, warnings: result.warnings }, signalDetailCtx(signalId))}, ${principal})`;
      const reqs: AppendRequest[] = [
        { streamId: signalStream, expected: "no_stream",
          events: [{ type: "SignalReceived", data: { signalId, bookId, channel, trust, contentHash: sha256(`${bookId}|${channel}|${content}`), lines: txns.length,
            rows, accepted: result.accepted, duplicates: result.duplicates, skipped: result.skipped, originalHash, parser: src.parser,
            ...(src.controls ? { controls: src.controls } : {}) } }] },
        ...fresh.map((k) => ({ streamId: k.stream, expected: "no_stream" as const,
          events: [{ type: "TransactionExtracted" as const, data: { txnId: k.txnId, signalId, bookId, trust, channel, txn: k.t } }] })),
      ];
      await this.store.append("channels", tenantId, reqs, { principal }, tx);
      return result;
    });
  }
}

const sortRows = (d: RowDisposition[]) => d.sort((a, b) => a.row - b.row);

interface SignalRow {
  signal_id: string; book_id: string; channel: string; content_hash: string; byte_length: number; parser: string; row_count: number;
  accepted: number; duplicates: number; skipped: number; control_status: string; original: string; detail: string; uploaded_by: string; created_at: Date;
}
