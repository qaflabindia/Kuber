/**
 * Replay pool extraction from Kuber's sealed event store (design 7.2 "the evolving world").
 *
 * Reads, through the store and the tenant keyring, in a tenant-scoped transaction (row-level
 * security: never another tenant's rows): the transaction pipeline (TransactionExtracted,
 * PartyResolved, TransactionClassified, PolicyDecisionMade, PostingRequested with its autonomy and
 * confidence, DraftQueued/Approved/Rejected, Ratified), corrections and reversals, the ledger's
 * JournalPosted (counterparty history), overrides (AutonomyLimited), the kill switch and period
 * operation plans (PlanApproved).
 *
 * Personal fields never leave this function: narrations, counterparty names and hints, account
 * names and reasons are read only to be dropped. The pool holds features (confidence, amount,
 * counts, levels, dates, enums) and outcomes, and every id is a keyed hash (the tenant's index key),
 * so it cannot be linked back to a transaction without the tenant's keys.
 *
 * Every feature is as of the decision: only events before the PolicyDecisionMade count (prefix
 * only). The relax counters mirror what the agent records at runtime in agent.autonomy_outcomes.
 *
 * Design 7.3 data use: extraction refuses unless the owner opted the tenant in
 * (identity.settings.optimisation_opt_in, recorded as OptimisationOptInChanged).
 */
import type { TransactionSql } from "postgres";
import { journalIdForRequest, type Envelope, type EventData } from "@kuber/contracts";
import type { EventStore } from "@kuber/eventstore";
import { SUSPENSE } from "@kuber/agent";
import { LEVELS, RELAX_LOOKBACK, amountZScore, relaxStatsFrom, type Level, type PolicyEngine } from "@kuber/policy";
import { ReplayPool } from "../core/pool.ts";
import { sha256Hex } from "../core/util.ts";
import { Z_UNBOUNDED, type AutonomyDecision, type AutonomyFeatures, type Truth } from "../autonomy/family.ts";

export const INGEST_EVENT = "EVT-TXN-INGESTED";
export const PERIOD_EVENT = "EVT-PERIOD-END";
export const PERIOD_OPS = new Set(["close", "carry_forward", "allocate", "rebalance"]);
/** An auto-posted (L4) entry nobody corrected for this many days counts as accepted (the agent's correction limit). */
export const CORRECTION_WINDOW_DAYS = 30;

export class OptInRequired extends Error {
  readonly statusCode = 403;
  readonly code = "optimisation_opt_in_required";
}

export interface ExtractRange { from: string; to: string }
export interface ExtractOptions {
  /** The policy library (amount limit for the above-limit class). */
  policies: PolicyEngine;
  /** Opt-in check; default: the tenant's latest OptimisationOptInChanged event. */
  optIn?: (tenant: string, tx: TransactionSql) => Promise<boolean>;
  /** Outcomes known as of this date (default: range.to). */
  asOf?: string;
}

export interface ExtractReport {
  pool: ReplayPool<AutonomyDecision>;
  skipped: { userEntered: number; matchReviews: number; outOfRange: number; pending: number };
}

const TYPES = ["BookOpened", "AccountAdded", "TransactionExtracted", "PartyResolved", "TransactionClassified", "PolicyDecisionMade",
  "PostingRequested", "DraftQueued", "DraftApproved", "DraftRejected", "Ratified", "CorrectionRequested", "JournalPosted",
  "JournalReversed", "AutonomyLimited", "AutonomyHalted", "AutonomyResumed", "PlanApproved"];

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const rank = (l: string) => LEVELS.indexOf(l as Level);

interface Txn {
  txnId: string; bookId: string; trust: string; amount: number; direction: "in" | "out"; txnDate: string;
  partyId: string | null; accountId?: string; confidence?: number; source?: string;
  decisionPos?: number; decisionOn?: string; autonomy?: string; journalId: string;
  draftId?: string; approvedAccount?: string; rejected?: boolean; ratified?: boolean; corrected?: boolean; reversed?: boolean;
  features?: Omit<AutonomyFeatures, "klass" | "classifier" | "confidence">;
}

/** The default opt-in check: the latest OptimisationOptInChanged in the tenant's identity stream. */
export async function optedInByEvents(store: EventStore, tenant: string, tx: TransactionSql): Promise<boolean> {
  const e = await store.lastEventOfType(tenant, `${tenant}/identity`, "OptimisationOptInChanged", 2 ** 31 - 1, tx);
  return !!(e?.data as EventData<"OptimisationOptInChanged"> | undefined)?.optIn;
}

export async function extractAutonomyPool(store: EventStore, tenant: string, book: string, range: ExtractRange, o: ExtractOptions): Promise<ExtractReport> {
  if (!(range.from <= range.to)) throw new Error("extract: from must not be after to");
  const keys = await store.keys(tenant);
  const hid = (kind: string, id: string) => sha256Hex(keys.index("dream-rsi", `${kind}|${id}`)).slice(0, 32);
  const asOf = o.asOf ?? range.to;
  const events = await store.tenantTx(tenant, async (tx) => {
    if (!(await (o.optIn ? o.optIn(tenant, tx) : optedInByEvents(store, tenant, tx)))) {
      throw new OptInRequired(`tenant ${tenant} has not opted in to offline policy optimisation (identity.settings.optimisation_opt_in)`);
    }
    const out: Envelope[] = [];
    for (let after = "0"; ;) {
      const page = await store.readEvents({ tenantId: tenant, types: TYPES, after, limit: 1000 }, tx);
      out.push(...page);
      if (page.length < 1000) return out;
      after = page[page.length - 1]!.globalPosition;
    }
  });

  const ceiling = o.policies.untunedEquivalent(INGEST_EVENT, range.to).amountCeilingPaise;
  const books = new Map<string, { entityType: string; cash: Set<string> }>();
  const txns = new Map<string, Txn>(), byDraft = new Map<string, Txn>(), byJournal = new Map<string, Txn>();
  const partyJournals = new Map<string, { journalId: string; bookId: string; amount: number; pos: number }[]>();
  const reversedAt = new Map<string, number>(), confirmedAt = new Map<string, number>();
  const overrides: { key: string; level: string; until: string; pos: number }[] = [];
  const switches: { book: string; halted: boolean; pos: number }[] = [];
  const observations = new Map<string, { pos: number; accepted: boolean }[]>();
  const plans: AutonomyDecision[] = [];
  const skipped = { userEntered: 0, matchReviews: 0, outOfRange: 0, pending: 0 };
  const observe = (t: Txn, pos: number, accepted: boolean) => {
    const k = `${t.bookId}|${t.direction === "in" ? "receipt" : "payment"}`;
    (observations.get(k) ?? observations.set(k, []).get(k)!).push({ pos, accepted });
  };

  // Features as of the decision (events strictly before `pos`).
  const featuresAt = (t: Txn, pos: number, on: string): Txn["features"] => {
    const standing = (j: { journalId: string; pos: number }) => j.pos < pos && !((reversedAt.get(j.journalId) ?? Infinity) < pos);
    const hist = t.partyId ? (partyJournals.get(t.partyId) ?? []).filter(standing) : [];
    const z = t.partyId ? amountZScore(t.amount, hist.filter((j) => j.bookId === t.bookId).map((j) => j.amount)) : null;
    const keysIn = new Set([`account:${t.accountId}`, `party:${t.partyId ?? "-"}`, "*"]);
    const latest = new Map<string, { level: string; until: string }>();
    for (const ov of overrides) if (ov.pos < pos && keysIn.has(ov.key)) latest.set(ov.key, ov);
    const active = [...latest.values()].filter((x) => x.until >= on).map((x) => x.level).sort((a, b) => rank(a) - rank(b));
    const sw = new Map<string, boolean>();
    for (const s of switches) if (s.pos < pos && (s.book === "*" || s.book === t.bookId)) sw.set(s.book, s.halted);
    const obs = (observations.get(`${t.bookId}|${t.direction === "in" ? "receipt" : "payment"}`) ?? []).filter((x) => x.pos < pos)
      .sort((a, b) => b.pos - a.pos).slice(0, RELAX_LOOKBACK).map((x) => x.accepted);
    return {
      eventCode: INGEST_EVENT, on, actionType: t.direction === "in" ? "receipt" : "payment",
      entitySegment: (books.get(t.bookId)?.entityType ?? "unknown").toLowerCase().replace(/[^a-z_]/g, "_"),
      amountPaise: t.amount, hasParty: !!t.partyId, partyPriorPostings: hist.length,
      partyConfirmed: !!t.partyId && (confirmedAt.get(t.partyId) ?? Infinity) < pos,
      amountZ: z === null ? null : Number.isFinite(z) ? Math.round(z * 1e6) / 1e6 : Z_UNBOUNDED,
      overrideMax: (active[0] as Level | undefined) ?? null, halted: [...sw.values()].some(Boolean), relax: relaxStatsFrom(obs),
    };
  };

  for (const e of events) {
    const pos = Number(e.globalPosition);
    switch (e.type) {
      case "BookOpened": {
        const d = e.data as EventData<"BookOpened">;
        books.set(d.bookId, { entityType: d.entityType, cash: new Set(d.accounts.filter((a) => a.isCashLike).map((a) => a.accountId)) });
        break;
      }
      case "AccountAdded": {
        const d = e.data as EventData<"AccountAdded">;
        if (d.account.isCashLike) books.get(d.bookId)?.cash.add(d.account.accountId);
        break;
      }
      case "TransactionExtracted": {
        const d = e.data as EventData<"TransactionExtracted">;
        const t: Txn = { txnId: d.txnId, bookId: d.bookId, trust: d.trust, amount: Number(d.txn.amount), direction: d.txn.direction,
          txnDate: d.txn.txnDate, partyId: null, journalId: journalIdForRequest(tenant, `req-${d.txnId}`) };
        txns.set(d.txnId, t); byJournal.set(t.journalId, t);
        break;
      }
      case "PartyResolved": { const d = e.data as EventData<"PartyResolved">; const t = txns.get(d.txnId); if (t) t.partyId = d.partyId; break; }
      case "TransactionClassified": {
        const d = e.data as EventData<"TransactionClassified">; const t = txns.get(d.txnId);
        if (t) { t.accountId = d.accountId; t.confidence = d.confidence; t.source = d.source; }
        break;
      }
      case "PolicyDecisionMade": {
        const d = e.data as EventData<"PolicyDecisionMade">; const t = txns.get(d.txnId);
        if (t && t.decisionPos === undefined) {
          t.decisionPos = pos; t.decisionOn = d.on ?? e.meta.occurredAt.slice(0, 10);
          t.features = featuresAt(t, pos, t.decisionOn);
        }
        break;
      }
      case "PostingRequested": {
        const d = e.data as EventData<"PostingRequested">;
        const t = txns.get(d.requestId.replace(/^req-/, ""));
        if (t && t.autonomy === undefined && (d.autonomy === "L3" || d.autonomy === "L4")) t.autonomy = d.autonomy;
        break;
      }
      case "DraftQueued": { const d = e.data as EventData<"DraftQueued">; const t = txns.get(d.txnId); if (t) { t.draftId = d.draftId; byDraft.set(d.draftId, t); } break; }
      case "DraftApproved": { const d = e.data as EventData<"DraftApproved">; const t = byDraft.get(d.draftId); if (t) t.approvedAccount = d.accountId; break; }
      case "DraftRejected": {
        const t = byDraft.get((e.data as EventData<"DraftRejected">).draftId);
        if (t) { t.rejected = true; observe(t, pos, false); }
        break;
      }
      case "Ratified": {
        const t = byJournal.get((e.data as EventData<"Ratified">).journalId);
        if (t) { t.ratified = true; observe(t, pos, true); }
        break;
      }
      case "CorrectionRequested": {
        const t = byJournal.get((e.data as EventData<"CorrectionRequested">).journalId);
        if (t && (t.autonomy || t.approvedAccount)) { t.corrected = true; observe(t, pos, false); }
        break;
      }
      case "JournalPosted": {
        const d = e.data as EventData<"JournalPosted">;
        const cash = books.get(d.bookId)?.cash ?? new Set<string>();
        const party = d.lines.find((l) => l.partyId)?.partyId;
        const inst = d.lines.find((l) => cash.has(l.accountId));
        if (party && inst) (partyJournals.get(party) ?? partyJournals.set(party, []).get(party)!).push({ journalId: d.journalId, bookId: d.bookId, amount: Math.abs(Number(inst.amount)), pos });
        const t = byJournal.get(d.journalId);
        // An approved draft posted: the person's choice counts (as agent.draftPosted records it), and the party is confirmed.
        if (t && t.approvedAccount !== undefined && !t.autonomy) {
          observe(t, pos, t.approvedAccount === t.accountId);
          if (t.partyId && t.approvedAccount !== SUSPENSE && !confirmedAt.has(t.partyId)) confirmedAt.set(t.partyId, pos);
        }
        break;
      }
      case "JournalReversed": {
        const d = e.data as EventData<"JournalReversed">;
        reversedAt.set(d.journalId, pos);
        const t = byJournal.get(d.journalId);
        if (t && !d.reason.startsWith("reclassified to")) t.reversed = true;
        break;
      }
      case "AutonomyLimited": { const d = e.data as EventData<"AutonomyLimited">; overrides.push({ key: d.key, level: d.maxLevel, until: d.until, pos }); break; }
      case "AutonomyHalted": case "AutonomyResumed": {
        const d = e.data as EventData<"AutonomyHalted">;
        switches.push({ book: d.bookId ?? "*", halted: e.type === "AutonomyHalted", pos });
        break;
      }
      case "PlanApproved": {
        const d = e.data as EventData<"PlanApproved">;
        const on = e.meta.occurredAt.slice(0, 10);
        if (d.bookId !== book || !PERIOD_OPS.has(d.op) || on < range.from || on > range.to) break;
        plans.push({ id: hid("plan", d.planId), seq: pos,
          features: { eventCode: PERIOD_EVENT, on, actionType: "plan", entitySegment: (books.get(d.bookId)?.entityType ?? "unknown").toLowerCase().replace(/[^a-z_]/g, "_"),
            klass: "period_ops", confidence: 1, classifier: "plan", amountPaise: 0, hasParty: false, partyPriorPostings: 0, partyConfirmed: false,
            amountZ: null, overrideMax: null, halted: false, relax: { consecutiveAccepted: 0, resolved: 0, accepted: 0 } },
          action: d.policy && (d.policy.level === "L3" || d.policy.level === "L4") && d.gate === "policy" && !d.needsPerson ? (d.policy.level === "L4" ? "auto_l4" : "auto_l3") : "person",
          outcome: { truth: "approved_unchanged" } });
        break;
      }
    }
  }

  const items: AutonomyDecision[] = [...plans];
  for (const t of txns.values()) {
    if (t.bookId !== book) continue;
    if (t.trust === "user") { skipped.userEntered++; continue; }
    if (t.decisionPos === undefined || !t.features || t.confidence === undefined) { skipped.matchReviews++; continue; }
    if (t.txnDate < range.from || t.txnDate > range.to) { skipped.outOfRange++; continue; }
    const truth = truthOf(t, asOf);
    if (truth === "pending") skipped.pending++;
    const src = t.source ?? "";
    items.push({
      id: hid("txn", t.txnId), seq: t.decisionPos,
      features: { ...t.features, klass: t.accountId === SUSPENSE ? "suspense" : t.amount > ceiling ? "above_limit" : "bookkeeping",
        confidence: t.confidence, classifier: src.startsWith("rule") ? "rule" : src.startsWith("history") ? "history" : src.startsWith("merchant") ? "merchant" : src.startsWith("llm") ? "llm" : "none" },
      action: t.autonomy === "L4" ? "auto_l4" : t.autonomy === "L3" ? "auto_l3" : "person",
      outcome: { truth },
    });
  }
  // Ordinal positions only: the pool never carries the store's global positions.
  const order = [...items].sort((a, b) => a.seq - b.seq).map((d, i) => ({ ...d, seq: i }));
  return {
    pool: new ReplayPool("kuber.autonomy", order, { tenant: hid("tenant", tenant).slice(0, 16), book: hid("book", book).slice(0, 16), from: range.from, to: range.to, asOf }),
    skipped,
  };
}

function truthOf(t: Txn, asOf: string): Truth {
  if (t.autonomy) {
    if (t.corrected) return "auto_corrected";
    if (t.reversed) return "auto_reversed";
    if (t.ratified) return "ratified";
    if (t.autonomy === "L4" && t.decisionOn && addDays(t.decisionOn, CORRECTION_WINDOW_DAYS) <= asOf) return "auto_uncorrected";
    return "pending";
  }
  if (t.approvedAccount !== undefined) {
    if (t.corrected || t.reversed) return "corrected_after_approval";
    return t.approvedAccount === t.accountId ? "approved_unchanged" : "edited";
  }
  if (t.rejected) return "rejected";
  return "pending";
}
