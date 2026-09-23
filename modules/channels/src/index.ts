/**
 * Channels module: turns raw inputs into SignalReceived + TransactionExtracted events.
 *
 * Idempotency comes from the event store itself: each signal and each transaction has a
 * content-addressed stream that must not already exist. Re-uploading a statement, or two
 * overlapping statements, therefore never produces a second copy of a transaction.
 */
import { canonical, sha256, type RawTxn } from "@kuber/contracts";
import { ConcurrencyError, type AppendRequest, type EventStore } from "@kuber/eventstore";
import { parseBankCsv, parseChat } from "./parsers.ts";

export { parseBankCsv, parseChat, parseDate, readCsv } from "./parsers.ts";

export interface SubmitResult { signalId: string; duplicate: boolean; accepted: number; skipped: number; txnIds: string[] }

export class Channels {
  constructor(private store: EventStore) {}

  submitStatement(tenantId: string, bookId: string, csv: string, principal: string, instrument = "BANK") {
    return this.submit(tenantId, bookId, "statement_csv", "authoritative", csv, parseBankCsv(csv, instrument), principal);
  }

  /** Returns null when the text is not a transaction the rule parser understands. */
  async submitChat(tenantId: string, bookId: string, text: string, principal: string, on: string) {
    const t = parseChat(text, on);
    if (!t) return null;
    return this.submit(tenantId, bookId, "chat", "user", `${on}|${principal}|${text}`, [t], principal);
  }

  /** Adapters for SMS, email, notifications and AA call this with already-extracted transactions. */
  submitRaw(tenantId: string, bookId: string, channel: string, trust: "authoritative" | "provisional" | "user",
            content: string, txns: RawTxn[], principal: string) {
    return this.submit(tenantId, bookId, channel, trust, content, txns, principal);
  }

  private async submit(tenantId: string, bookId: string, channel: string, trust: "authoritative" | "provisional" | "user",
                       content: string, txns: RawTxn[], principal: string): Promise<SubmitResult> {
    const contentHash = sha256(`${bookId}|${channel}|${content}`);
    const signalId = contentHash.slice(0, 32);
    const signalStream = `${tenantId}/signal/${signalId}`;

    // content-address each transaction; identical lines inside one file are told apart by occurrence
    const seen = new Map<string, number>();
    const keyed = txns.map((t) => {
      const base = canonical({ bookId, instrument: t.instrument, txnDate: t.txnDate, amount: t.amount, direction: t.direction,
        narration: t.narration.toLowerCase(), reference: t.reference ?? null });
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
      const txnId = sha256(`${base}|${n}`).slice(0, 32);
      return { t, txnId, stream: `${tenantId}/txn/${txnId}` };
    });
    const existing = await this.store.existingStreams(tenantId, [signalStream, ...keyed.map((k) => k.stream)]);
    if (existing.has(signalStream)) return { signalId, duplicate: true, accepted: 0, skipped: txns.length, txnIds: [] };

    const fresh = keyed.filter((k) => !existing.has(k.stream));
    const reqs: AppendRequest[] = [
      { streamId: signalStream, expected: "no_stream",
        events: [{ type: "SignalReceived", data: { signalId, bookId, channel, trust, contentHash, lines: txns.length } }] },
      ...fresh.map((k) => ({ streamId: k.stream, expected: "no_stream" as const,
        events: [{ type: "TransactionExtracted" as const, data: { txnId: k.txnId, signalId, bookId, trust, channel, txn: k.t } }] })),
    ];
    try {
      await this.store.append("channels", tenantId, reqs, { principal });
    } catch (e) {
      // a concurrent upload of the same content won the race: report it as a duplicate
      if (e instanceof ConcurrencyError) return { signalId, duplicate: true, accepted: 0, skipped: txns.length, txnIds: [] };
      throw e;
    }
    return { signalId, duplicate: false, accepted: fresh.length, skipped: txns.length - fresh.length, txnIds: fresh.map((k) => k.txnId) };
  }
}
