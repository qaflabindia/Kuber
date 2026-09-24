/**
 * Evidence record (design section 14.7): one record per committed action, assembled from events
 * that already exist. Nothing is collected by hand afterwards.
 *
 * A committed action is a posted journal or a period lock. When one arrives the module reads the
 * streams it came from (the plan, the transaction, the signal, a correction) and writes an
 * `EvidenceRecorded` event with the six parts: source, decision, execution, result, approval and
 * exceptions. The event is sealed with the tenant's key and linked into the hash chain like any
 * other; `recordHash` (SHA-256 over the canonical record) lets a copy be checked on its own.
 *
 * Retrieval is by any id or hash the record cites: journal id or hash, plan id or hash, signal
 * id, statement content hash, transaction id, draft id, event id, or the record hash itself.
 */
import type { TransactionSql } from "postgres";
import { canonical, sha256, stableId, type Envelope, type EventData, type EventType, type Line } from "@kuber/contracts";
import { once, tenantRlsFor, type EventStore, type Migration, type Projection } from "@kuber/eventstore";

export const EVIDENCE_MIGRATIONS: Migration[] = [{
  id: "evidence-001",
  sql: `
CREATE SCHEMA IF NOT EXISTS evidence;
-- Running balance per account, in journal order, so each record can state balances before and after.
CREATE TABLE evidence.balances (
  tenant_id TEXT NOT NULL, book_id TEXT NOT NULL, account_id TEXT NOT NULL, balance NUMERIC(22,0) NOT NULL,
  PRIMARY KEY (tenant_id, book_id, account_id));
CREATE TABLE evidence.records (
  tenant_id TEXT NOT NULL, evidence_id TEXT NOT NULL, book_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, record_hash TEXT NOT NULL,
  stream_id TEXT NOT NULL, stream_version INT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, evidence_id));
-- Ids and hashes only (no narrations or amounts), so nothing here needs sealing.
CREATE TABLE evidence.lookup (
  tenant_id TEXT NOT NULL, value TEXT NOT NULL, kind TEXT NOT NULL, evidence_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, value, evidence_id));
` + tenantRlsFor("evidence"),
}];

/** A cited event: enough to fetch it and check it against the stream's hash chain. */
export interface Citation { eventId: string; type: string; streamId: string; streamVersion: number }

export interface EvidenceRecord {
  version: 1;
  subject: { kind: "journal" | "period_lock"; id: string; bookId: string };
  source: Record<string, unknown>;
  decision: Record<string, unknown>;
  execution: Record<string, unknown>;
  result: Record<string, unknown>;
  approval: Record<string, unknown>;
  exceptions: { issue: string; owner: string; openedAt: string; dueBy?: string; status: "open" }[];
  cites: Citation[];
}

export interface Evidence {
  evidenceId: string; recordHash: string; recordedAt: string; record: EvidenceRecord;
  /** The record still hashes to recordHash, and every cited event is still in its stream. */
  verified: { recordHash: boolean; citations: boolean };
}

const SUSPENSE = "SUSPENSE";
const cite = (e: Envelope): Citation => ({ eventId: e.eventId, type: e.type, streamId: e.streamId, streamVersion: e.streamVersion });
const roleOf = (principal: string) => principal.split(":")[0]!;
const last = <T extends EventType>(evs: Envelope[], type: T, pred: (d: EventData<T>) => boolean = () => true) =>
  [...evs].reverse().find((e) => e.type === type && pred(e.data as EventData<T>)) as Envelope<T> | undefined;

export class EvidenceService {
  constructor(private store: EventStore) {}

  handler = async (env: Envelope): Promise<void> => {
    if (env.type !== "JournalPosted" && env.type !== "PeriodLocked") return;
    await once(this.store, "evidence", env, (tx) => this.record(tx, env));
  };

  // ------------------------------------------------------------------ assembly
  private async record(tx: TransactionSql, env: Envelope) {
    const t = env.meta.tenantId;
    // Only what happened before this event: a later retry or correction is its own record.
    const before = (evs: Envelope[]) => evs.filter((e) => BigInt(e.globalPosition) < BigInt(env.globalPosition));
    const read = async (stream: string) => before(await this.store.readStream(t, stream, 0, tx));
    const cites: Citation[] = [cite(env)];
    let draftId: string | undefined;

    // Execution through an ops plan: the approval of exactly this hash was recorded before any action ran.
    const planId = env.meta.commandId;
    const planEvt = planId ? last(await read(`${t}/plan/${planId}`), "PlanApproved") : undefined;
    if (planEvt) cites.push(cite(planEvt));

    let subject: EvidenceRecord["subject"], result: Record<string, unknown>;
    let source: Record<string, unknown> = planEvt ? { kind: "plan", planId: planEvt.data.planId } : { kind: "direct", principal: env.meta.principal };
    let decision: Record<string, unknown> = { principal: env.meta.principal, role: roleOf(env.meta.principal), policyIds: env.meta.policyIds ?? [] };
    let execution: Record<string, unknown> = planEvt
      ? { operation: planEvt.data.op, planId: planEvt.data.planId, planHash: planEvt.data.hash, basisSeq: planEvt.data.basisSeq, commandId: planId }
      : { operation: env.type === "PeriodLocked" ? "gl.lock" : "gl.post" };
    execution.correlationId = env.meta.correlationId;
    let approval: Record<string, unknown> = planEvt
      ? { kind: "plan", by: planEvt.meta.principal, role: roleOf(planEvt.meta.principal), at: planEvt.meta.occurredAt, gate: planEvt.data.gate,
          authority: planEvt.data.policy ? { policyIds: planEvt.data.policy.ids, level: planEvt.data.policy.level } : null,
          sod: { preparedBy: planEvt.data.preparedBy, approvedBy: planEvt.meta.principal, separate: planEvt.data.preparedBy !== planEvt.meta.principal } }
      : { kind: "statement", by: env.meta.principal, role: roleOf(env.meta.principal), at: env.meta.occurredAt };
    approval.signature = (planEvt ?? env).meta.signature ?? null;             // signed commands arrive in phase 1
    if (planEvt?.data.policy) decision = { ...decision, policyIds: planEvt.data.policy.ids, autonomy: planEvt.data.policy.level, reasons: planEvt.data.policy.reasons };
    const exceptions: EvidenceRecord["exceptions"] = [];
    const exception = (issue: string, owner: string, dueBy?: string) =>
      exceptions.push({ issue, owner, openedAt: env.meta.occurredAt, ...(dueBy ? { dueBy } : {}), status: "open" });

    if (env.type === "PeriodLocked") {
      const d = env.data as EventData<"PeriodLocked">;
      subject = { kind: "period_lock", id: `${d.bookId}:${d.periodEnd}:${d.level}`, bookId: d.bookId };
      result = { periodEnd: d.periodEnd, level: d.level, bookStream: env.streamId, seq: env.streamVersion };
    } else {
      const d = env.data as EventData<"JournalPosted">;
      subject = { kind: "journal", id: d.journalId, bookId: d.bookId };
      execution = { ...execution, idempotencyKey: d.journalId };
      result = { journalId: d.journalId, seq: d.seq, txnDate: d.txnDate, voucherType: d.voucherType, narration: d.narration,
        lines: d.lines, provisional: d.provisional, balances: await this.balances(tx, t, d.bookId, d.lines),
        hash: d.hash, prevHash: d.prevHash, ...(d.reverses ? { reverses: d.reverses } : {}) };
      if (d.provisional) exception("provisional: confirm against the bank statement", "agent:kuber");
      if (d.lines.some((l) => l.accountId === SUSPENSE)) exception("unclassified amount in suspense", "owner");

      // Source, decision and approval from the stream that asked for the posting (a transaction).
      if (d.source?.stream) {
        const src = await read(d.source.stream);
        const x = last(src, "TransactionExtracted"), req = src.find((e) => e.eventId === d.source!.eventId) as Envelope<"PostingRequested"> | undefined;
        const party = last(src, "PartyResolved"), cls = last(src, "TransactionClassified"), pol = last(src, "PolicyDecisionMade");
        const draft = last(src, "DraftQueued"), approved = last(src, "DraftApproved");
        const ratify = req ? last(src, "RatificationRequested", (r) => r.requestId === req.data.requestId) : undefined;
        for (const e of [x, party, cls, pol, draft, approved, req, ratify]) if (e) cites.push(cite(e));
        if (x) {
          const sig = last(await read(`${t}/signal/${x.data.signalId}`), "SignalReceived");
          if (sig) cites.push(cite(sig));
          source = { kind: "signal", channel: x.data.channel, trust: x.data.trust, signalId: x.data.signalId, txnId: x.data.txnId,
            contentHash: sig?.data.contentHash ?? null, receivedAt: sig?.recordedAt ?? x.recordedAt, reference: x.data.txn.reference ?? null,
            submittedBy: (sig ?? x).meta.principal };
        }
        decision = {
          ...decision,
          autonomy: d.autonomy ?? null, confidence: d.confidence ?? null,
          ...(cls ? { classification: { accountId: cls.data.accountId, confidence: cls.data.confidence, by: cls.data.source } } : {}),
          ...(party ? { party: { partyId: party.data.partyId, isNew: party.data.isNew } } : {}),
          ...(pol ? { policyIds: pol.data.decision.policyIds, level: pol.data.decision.level, action: pol.data.decision.action,
                      approver: pol.data.decision.approver, reasons: pol.data.decision.reasons } : {}),
        };
        if (req) execution = { ...execution, requestId: req.data.requestId, ...(planEvt ? {} : { operation: "agent.pipeline" }) };
        if (draft) draftId = draft.data.draftId;
        if (!planEvt) {
          if (approved) approval = { ...approval, kind: "draft", by: approved.meta.principal, role: roleOf(approved.meta.principal),
            at: approved.meta.occurredAt, draftId: approved.data.draftId, accountChosen: approved.data.accountId };
          else if (d.autonomy && d.autonomy !== "human") approval = { ...approval, kind: "policy", by: "policy", role: "policy",
            at: env.meta.occurredAt, authority: { policyIds: pol?.data.decision.policyIds ?? [], level: d.autonomy } };
        }
        if (ratify) exception("posted under policy; ratification by a person is due", pol?.data.decision.approver ?? "owner", ratify.data.dueBy);
      }
      if (d.reverses) {
        const corr = last(await read(`${t}/corrections/${d.reverses}`), "CorrectionRequested");
        if (corr) { cites.push(cite(corr)); approval = { ...approval, correctionRequestedBy: corr.meta.principal }; }
        exception(`reverses journal ${d.reverses}`, env.meta.principal);
      }
    }

    const record: EvidenceRecord = { version: 1, subject, source, decision, execution, result, approval, exceptions, cites };
    const recordHash = sha256(canonical(record));
    const evidenceId = stableId("evidence", `${t}/${subject.kind}/${subject.id}`);
    const stream = `${t}/evidence/${subject.bookId}`;
    const [written] = await this.store.append("evidence", t, { streamId: stream, expected: "any", events: [{ type: "EvidenceRecorded",
      data: { evidenceId, bookId: subject.bookId, subject: { kind: subject.kind, id: subject.id }, recordHash, record: record as unknown as Record<string, unknown> } }] },
      { principal: "system:evidence", correlationId: env.meta.correlationId, causationId: env.eventId }, tx);
    await this.index(tx, t, evidenceId, record, recordHash, stream, written!.streamVersion, draftId);
  }

  /** The retrieval rows of one record: derived from the record alone (plus its draft id), so a rebuild reproduces them. */
  private async index(tx: TransactionSql, t: string, evidenceId: string, record: EvidenceRecord, recordHash: string,
                      stream: string, version: number, draftId: string | undefined, recordedAt?: string) {
    const { subject, source, execution, result } = record;
    await tx`INSERT INTO evidence.records (tenant_id, evidence_id, book_id, subject_kind, subject_id, record_hash, stream_id, stream_version, recorded_at)
             VALUES (${t}, ${evidenceId}, ${subject.bookId}, ${subject.kind}, ${subject.id}, ${recordHash}, ${stream}, ${version}, ${recordedAt ?? new Date().toISOString()})
             ON CONFLICT DO NOTHING`;
    const lookup: [string, unknown][] = [["event", record.cites[0]?.eventId]];
    if (execution.planId) lookup.push(["plan", execution.planId], ["plan_hash", execution.planHash]);
    if (subject.kind === "journal") lookup.push(["journal", result.journalId], ["journal_hash", result.hash]);
    if (source.kind === "signal") lookup.push(["signal", source.signalId], ["txn", source.txnId], ["content_hash", source.contentHash]);
    if (draftId) lookup.push(["draft", draftId]);
    if (result.reverses) lookup.push(["journal", result.reverses]);
    lookup.push(["evidence", evidenceId], ["record_hash", recordHash]);
    for (const c of record.cites) lookup.push(["event", c.eventId]);
    const rows = new Map<string, [string, string]>();
    for (const [k, v] of lookup) if (typeof v === "string" && v) rows.set(`${k}\n${v}`, [k, v]);
    for (const [kind, value] of rows.values()) {
      await tx`INSERT INTO evidence.lookup VALUES (${t}, ${value}, ${kind}, ${evidenceId}) ON CONFLICT DO NOTHING`;
    }
  }

  /**
   * The evidence read models (running balances, record index, lookup), described for
   * `ops rebuild evidence`. They are rebuilt from the EvidenceRecorded events, never by re-running
   * the handler: that would append new records. Balances are the "after" figures of each record.
   */
  readonly projection: Projection = {
    name: "evidence", consumer: "evidence",
    tables: ["evidence.balances", "evidence.records", "evidence.lookup"],
    replay: ["EvidenceRecorded"], inboxTypes: [],
    apply: async (tx, env) => {
      const t = env.meta.tenantId;
      const d = env.data as EventData<"EvidenceRecorded">;
      const record = d.record as unknown as EvidenceRecord;
      const draft = record.cites.find((c) => c.type === "DraftQueued");
      const draftId = draft
        ? ((await this.store.readStream(t, draft.streamId, draft.streamVersion - 1, tx))[0]?.data as EventData<"DraftQueued"> | undefined)?.draftId
        : undefined;
      await this.index(tx, t, d.evidenceId, record, d.recordHash, env.streamId, env.streamVersion, draftId, env.recordedAt);
      for (const b of (record.result.balances ?? []) as { accountId: string; after: string }[]) {
        await tx`INSERT INTO evidence.balances VALUES (${t}, ${record.subject.bookId}, ${b.accountId}, ${b.after})
                 ON CONFLICT (tenant_id, book_id, account_id) DO UPDATE SET balance = EXCLUDED.balance`;
      }
    },
    fingerprint: async (tx, t) => ({
      balances: await tx`SELECT book_id, account_id, balance::text FROM evidence.balances WHERE tenant_id = ${t} ORDER BY 1, 2`,
      records: await tx`SELECT evidence_id, book_id, subject_kind, subject_id, record_hash, stream_id, stream_version FROM evidence.records WHERE tenant_id = ${t} ORDER BY 1`,
      lookup: await tx`SELECT value, kind, evidence_id FROM evidence.lookup WHERE tenant_id = ${t} ORDER BY 1, 2, 3`,
    }),
  };

  /** Balances (paise, debit positive) of the journal's accounts before and after it, in posting order. */
  private async balances(tx: TransactionSql, t: string, bookId: string, lines: Line[]) {
    const delta = new Map<string, bigint>();
    for (const l of lines) delta.set(l.accountId, (delta.get(l.accountId) ?? 0n) + BigInt(l.amount));
    const out: { accountId: string; before: string; after: string }[] = [];
    for (const [accountId, d] of [...delta.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [r] = await tx<{ balance: string }[]>`
        INSERT INTO evidence.balances VALUES (${t}, ${bookId}, ${accountId}, ${d.toString()})
        ON CONFLICT (tenant_id, book_id, account_id) DO UPDATE SET balance = evidence.balances.balance + EXCLUDED.balance
        RETURNING balance::text`;
      const after = BigInt(r!.balance);
      out.push({ accountId, before: (after - d).toString(), after: after.toString() });
    }
    return out;
  }

  // ------------------------------------------------------------------ retrieval
  /** Every record that cites this id or hash (journal, plan, signal, content hash, txn, draft, event, record). */
  async find(tenantId: string, value: string): Promise<Evidence[]> {
    const rows = await this.store.tenantTx(tenantId, (tx) => tx<{ evidence_id: string }[]>`
      SELECT DISTINCT l.evidence_id, r.recorded_at FROM evidence.lookup l JOIN evidence.records r USING (tenant_id, evidence_id)
      WHERE l.tenant_id = ${tenantId} AND l.value = ${value} ORDER BY r.recorded_at, l.evidence_id`);
    const out: Evidence[] = [];
    for (const r of rows) { const e = await this.get(tenantId, r.evidence_id); if (e) out.push(e); }
    return out;
  }

  async get(tenantId: string, evidenceId: string): Promise<Evidence | null> {
    const [r] = await this.store.tenantTx(tenantId, (tx) => tx<{ stream_id: string; stream_version: number; record_hash: string }[]>`
      SELECT stream_id, stream_version, record_hash FROM evidence.records WHERE tenant_id = ${tenantId} AND evidence_id = ${evidenceId}`);
    if (!r) return null;
    const [e] = await this.store.readStream(tenantId, r.stream_id, r.stream_version - 1);
    if (!e || e.type !== "EvidenceRecorded") return null;
    const d = e.data as EventData<"EvidenceRecorded">;
    const record = d.record as unknown as EvidenceRecord;
    const citations = await this.store.tenantTx(tenantId, async (tx) => {
      const ids = record.cites.map((c) => c.eventId);
      const found = await tx<{ event_id: string; stream_id: string; stream_version: number }[]>`
        SELECT event_id::text, stream_id, stream_version FROM es.events WHERE event_id IN ${tx(ids)}`;
      const at = new Map(found.map((f) => [f.event_id, `${f.stream_id}#${f.stream_version}`]));
      return record.cites.every((c) => at.get(c.eventId) === `${c.streamId}#${c.streamVersion}`);
    });
    return { evidenceId, recordHash: d.recordHash, recordedAt: e.recordedAt, record,
      verified: { recordHash: sha256(canonical(record)) === d.recordHash && d.recordHash === r.record_hash, citations } };
  }
}
