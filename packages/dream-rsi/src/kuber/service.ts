/**
 * Dream-RSI in Kuber: run, propose, approve. Promotion is not deployment (design 7.2).
 *
 *   runAutonomy   extract the replay pool (opt-in required), dream per action type, write the
 *                 evidence report, and record a winning policy as a *proposal* (dream.proposals +
 *                 DreamProposalRecorded). Nothing the agent reads changes.
 *   approve       a person with autonomy.manage for the book approves a proposal: DreamProposalApproved
 *                 is appended, and only then does the agent apply the thresholds (agent.autonomy_tuning
 *                 + AutonomyTuningApplied), which every later autonomy decision reads. A proposal whose
 *                 incumbent is no longer the tuning in force is stale and refused.
 *   runRouting    dream over copilot turn records from an adapter and, on promotion, write a
 *                 versioned routing-policy artifact with approvedBy null; approving and locking it is a
 *                 separate human step through the prompt lock (ws5/agent-gov).
 */
import type { TransactionSql } from "postgres";
import { stableId } from "@kuber/contracts";
import { tenantRlsFor, type EventStore, type Migration, type ModuleGuard } from "@kuber/eventstore";
import type { AutonomyTuning, PolicyEngine } from "@kuber/policy";
import { DreamEngine, type DreamResult } from "../core/dreamer.ts";
import type { CandidateProposer } from "../core/proposer.ts";
import { hashOf, sha256Hex } from "../core/util.ts";
import { ACTION_TYPES, isExcluded, makeAutonomyFamily, type ActionType, type AutonomyParams } from "../autonomy/family.ts";
import { DEFAULT_ROUTING_PARAMS, makeRoutingFamily, type RoutingParams } from "../routing/family.ts";
import { routingPool, type TurnRecordAdapter } from "../routing/adapter.ts";
import { INGEST_EVENT, OptInRequired, extractAutonomyPool } from "./extract.ts";
import { finalizeReport, writeEvidence, writeRoutingArtifact, type DreamReport, type SegmentReport } from "./report.ts";

export const DREAM_MIGRATIONS: Migration[] = [{
  id: "dream-001-proposals",
  // Proposals from dream runs: thresholds, the evidence report and the diff against the tuning in
  // force. Features and hashes only; nothing personal, nothing sealed. History is in the dream streams.
  sql: `
CREATE SCHEMA IF NOT EXISTS dream;
CREATE TABLE dream.proposals (
  tenant_id TEXT NOT NULL, proposal_id TEXT NOT NULL, family TEXT NOT NULL CHECK (family IN ('autonomy')), book_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected')),
  segments JSONB NOT NULL, report JSONB NOT NULL, report_hash TEXT NOT NULL, pool_hash TEXT NOT NULL, seed INTEGER NOT NULL, evidence TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_by TEXT, decided_at TIMESTAMPTZ, decision_note TEXT,
  PRIMARY KEY (tenant_id, proposal_id));
CREATE INDEX proposals_open ON dream.proposals (tenant_id, created_at) WHERE status = 'proposed';
` + tenantRlsFor("dream"),
}];

export class DreamError extends Error {
  constructor(public code: string, message: string, public statusCode = 409) { super(message); }
}

/** The agent's side of an approval (Agent implements it). */
export interface TuningHost {
  autonomyTuning(tenant: string, book: string, tx?: TransactionSql): Promise<Partial<Record<ActionType, { tuning: AutonomyTuning; proposalId: string }>>>;
  applyAutonomyTuning(tx: TransactionSql, tenant: string, a: { bookId: string; actionType: ActionType; tuning: AutonomyTuning; proposalId: string; principal: string }): Promise<void>;
}

export interface DreamServiceDeps {
  store: EventStore;
  policies: PolicyEngine;
  guard: ModuleGuard;
  agent: TuningHost;
  /** Owner opt-in (identity.settings.optimisation_opt_in). */
  optIn: (tenant: string, tx: TransactionSql) => Promise<boolean>;
  clock: () => string;
  /** requirements/evidence */
  evidenceDir: string;
  /** agent/artifacts */
  artifactsDir: string;
}

export interface ProposalSegment {
  actionType: ActionType;
  params: AutonomyParams;
  incumbent: AutonomyParams;
  /** "policy" (no tuning in force) or the proposal id of the tuning in force when the run started. */
  incumbentSource: string;
  diff: { param: string; from: unknown; to: unknown }[];
  score: { incumbent: number; winner: number; ciLower: number; ciUpper: number };
}

export interface Proposal {
  proposalId: string; family: "autonomy"; bookId: string; status: "proposed" | "approved" | "rejected";
  segments: ProposalSegment[]; reportHash: string; poolHash: string; seed: number; evidence: string;
  createdBy: string; createdAt: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
}

export interface RunCommon { seed: number; iterations: number; episodes?: number; confidence?: number; write?: boolean }

export class DreamService {
  constructor(private d: DreamServiceDeps) {}

  // ------------------------------------------------------------------ family A: autonomy
  async runAutonomy(o: RunCommon & { tenant: string; book: string; from: string; to: string; unsafeCap?: number; by?: string;
    proposer?: CandidateProposer<AutonomyParams> }): Promise<{ report: DreamReport; files: { json: string; md: string } | null; proposal: Proposal | null }> {
    const by = o.by ?? "system:dream-rsi";
    const { pool, skipped } = await extractAutonomyPool(this.d.store, o.tenant, o.book, { from: o.from, to: o.to },
      { policies: this.d.policies, optIn: this.d.optIn, asOf: this.d.clock() > o.to ? this.d.clock() : o.to });
    const untuned = this.d.policies.untunedEquivalent(INGEST_EVENT, o.to);
    const bounds = { maxCeilingPaise: untuned.amountCeilingPaise };
    const family = makeAutonomyFamily(this.d.policies, bounds, { unsafeCap: o.unsafeCap });
    const inForce = await this.d.agent.autonomyTuning(o.tenant, o.book);
    const segments: SegmentReport[] = [];
    const winners: ProposalSegment[] = [];
    for (const actionType of ACTION_TYPES) {
      const slice = pool.filter(`actionType=${actionType}`, (x) => x.features.actionType === actionType);
      if (!slice.items.some((x) => !isExcluded(x))) { segments.push({ segment: actionType, skipped: `no eligible decisions (${slice.size} excluded)` }); continue; }
      const current = inForce[actionType];
      const incumbent = current ? current.tuning : untuned;
      const source = current ? `tuning:${current.proposalId}` : "policy";
      const r = await new DreamEngine(family, slice).run(incumbent, { seed: o.seed, iterations: o.iterations, episodes: o.episodes, confidence: o.confidence, proposer: o.proposer });
      segments.push({ segment: actionType, result: { ...r, incumbent: { ...r.incumbent, source } } as SegmentReport["result"] });
      if (r.decision === "promote") winners.push({ actionType, params: r.winner.params, incumbent, incumbentSource: source, diff: r.diff,
        score: { incumbent: r.incumbent.score, winner: r.winner.score, ciLower: r.improvement!.ciLower, ciUpper: r.improvement!.ciUpper } });
    }
    for (const x of pool.items) if (x.features.actionType === "plan") { segments.push({ segment: "plan", skipped: "period operations are never tuned (excluded class)" }); break; }
    const keys = await this.d.store.keys(o.tenant);
    const report = finalizeReport({
      kind: "kuber.dream-report", version: 1, family: "autonomy", tenant: o.tenant, book: o.book, range: { from: o.from, to: o.to }, date: this.d.clock(),
      seed: o.seed, iterations: o.iterations, episodes: o.episodes ?? 200, confidence: o.confidence ?? 0.95,
      pool: { kind: pool.kind, size: pool.size, sliceHash: pool.hash(), source: "event-store", skipped },
      segments, decision: winners.length ? "promote" : "keep_incumbent",
    }, (h) => keys.index("dream-report", h));
    const files = o.write === false ? null : writeEvidence(report, this.d.evidenceDir);
    if (!winners.length) return { report, files, proposal: null };

    const proposalId = stableId("dream-proposal", `${o.tenant}/${report.reportHash}`);
    const evidence = files ? files.json : `(not written) ${report.reportHash}`;
    await this.d.store.tenantTx(o.tenant, async (tx) => {
      const ins = await tx`INSERT INTO dream.proposals (tenant_id, proposal_id, family, book_id, status, segments, report, report_hash, pool_hash, seed, evidence, created_by)
        VALUES (${o.tenant}, ${proposalId}, 'autonomy', ${o.book}, 'proposed', ${tx.json(winners as never)}, ${tx.json(report as never)}, ${report.reportHash},
                ${pool.hash()}, ${o.seed}, ${evidence}, ${by}) ON CONFLICT DO NOTHING RETURNING 1`;
      if (!ins.length) return;
      await this.d.store.append("dream", o.tenant, { streamId: `${o.tenant}/dream/${proposalId}`, expected: "no_stream", events: [{ type: "DreamProposalRecorded",
        data: { proposalId, family: "autonomy", bookId: o.book, segments: winners.map((w) => w.actionType), seed: o.seed, poolHash: pool.hash(),
          reportHash: report.reportHash, evidence } }] }, { principal: by }, tx);
    });
    return { report, files, proposal: await this.proposal(o.tenant, proposalId) };
  }

  async proposals(tenant: string, status?: Proposal["status"]): Promise<Proposal[]> {
    const rows = await this.d.store.tenantTx(tenant, (tx) => tx<ProposalRow[]>`
      SELECT * FROM dream.proposals WHERE tenant_id = ${tenant} ${status ? tx`AND status = ${status}` : tx``} ORDER BY created_at, proposal_id`);
    return rows.map(toProposal);
  }

  async proposal(tenant: string, proposalId: string): Promise<Proposal | null> {
    const [r] = await this.d.store.tenantTx(tenant, (tx) => tx<ProposalRow[]>`
      SELECT * FROM dream.proposals WHERE tenant_id = ${tenant} AND proposal_id = ${proposalId}`);
    return r ? toProposal(r) : null;
  }

  /** Proposals of every tenant (operator listing; system scope). */
  async allProposals(status?: Proposal["status"]): Promise<(Proposal & { tenant: string })[]> {
    const rows = await this.d.store.systemTx((tx) => tx<(ProposalRow & { tenant_id: string })[]>`
      SELECT * FROM dream.proposals ${status ? tx`WHERE status = ${status}` : tx``} ORDER BY created_at, proposal_id`);
    return rows.map((r) => ({ ...toProposal(r), tenant: r.tenant_id }));
  }

  /** Approve: append DreamProposalApproved, then (and only then) apply the thresholds the agent reads. */
  async approve(tenant: string, proposalId: string, principal: string): Promise<Proposal> {
    await this.d.store.tenantTx(tenant, async (tx) => {
      const [r] = await tx<ProposalRow[]>`SELECT * FROM dream.proposals WHERE tenant_id = ${tenant} AND proposal_id = ${proposalId} FOR UPDATE`;
      if (!r) throw new DreamError("not_found", `no proposal ${proposalId}`, 404);
      // Until the Superuser role lands (roles branch), approval needs autonomy.manage for the book (owners, controllers).
      await this.d.guard.permit(tenant, principal, "autonomy.manage", { book: r.book_id }, tx);
      if (r.status !== "proposed") throw new DreamError("not_open", `proposal ${proposalId} is ${r.status}`);
      const p = toProposal(r);
      const inForce = await this.d.agent.autonomyTuning(tenant, p.bookId, tx);
      for (const s of p.segments) {
        const cur = inForce[s.actionType];
        const now = cur ? `tuning:${cur.proposalId}` : "policy";
        if (now !== s.incumbentSource || (cur && hashOf(cur.tuning) !== hashOf(s.incumbent))) {
          throw new DreamError("stale", `proposal ${proposalId} was computed against ${s.incumbentSource} for ${s.actionType}, but ${now} is in force: run the dream again`);
        }
      }
      await this.d.store.append("dream", tenant, { streamId: `${tenant}/dream/${proposalId}`, expected: "any", events: [{ type: "DreamProposalApproved",
        data: { proposalId, family: "autonomy", bookId: p.bookId, segments: p.segments.map((s) => s.actionType), reportHash: p.reportHash } }] }, { principal }, tx);
      for (const s of p.segments) {
        await this.d.agent.applyAutonomyTuning(tx, tenant, { bookId: p.bookId, actionType: s.actionType, tuning: s.params, proposalId, principal });
      }
      await tx`UPDATE dream.proposals SET status = 'approved', decided_by = ${principal}, decided_at = now() WHERE tenant_id = ${tenant} AND proposal_id = ${proposalId}`;
    });
    return (await this.proposal(tenant, proposalId))!;
  }

  async reject(tenant: string, proposalId: string, principal: string, reason: string): Promise<Proposal> {
    if (reason.trim().length < 3) throw new DreamError("bad_reason", "give a reason", 400);
    await this.d.store.tenantTx(tenant, async (tx) => {
      const [r] = await tx<ProposalRow[]>`SELECT * FROM dream.proposals WHERE tenant_id = ${tenant} AND proposal_id = ${proposalId} FOR UPDATE`;
      if (!r) throw new DreamError("not_found", `no proposal ${proposalId}`, 404);
      await this.d.guard.permit(tenant, principal, "autonomy.manage", { book: r.book_id }, tx);
      if (r.status !== "proposed") throw new DreamError("not_open", `proposal ${proposalId} is ${r.status}`);
      await this.d.store.append("dream", tenant, { streamId: `${tenant}/dream/${proposalId}`, expected: "any",
        events: [{ type: "DreamProposalRejected", data: { proposalId, reason: reason.trim() } }] }, { principal }, tx);
      await tx`UPDATE dream.proposals SET status = 'rejected', decided_by = ${principal}, decided_at = now(), decision_note = ${reason.trim()}
               WHERE tenant_id = ${tenant} AND proposal_id = ${proposalId}`;
    });
    return (await this.proposal(tenant, proposalId))!;
  }

  // ------------------------------------------------------------------ family B: routing
  async runRouting(o: RunCommon & { tenant: string; adapter: TurnRecordAdapter; from?: string; to?: string; incumbent?: RoutingParams;
    proposer?: CandidateProposer<RoutingParams> }): Promise<{ report: DreamReport; files: { json: string; md: string } | null; result: DreamResult<RoutingParams>; artifact: { path: string; version: number; sha256: string } | null }> {
    // Turn records from the tenant's own history need the owner's opt-in, like the autonomy pool; a fixture is not tenant data.
    if (o.adapter.name !== "fixture") {
      const ok = await this.d.store.tenantTx(o.tenant, (tx) => this.d.optIn(o.tenant, tx));
      if (!ok) throw new OptInRequired(`tenant ${o.tenant} has not opted in to offline policy optimisation`);
    }
    const pool = await routingPool(o.adapter, { tenant: o.tenant, from: o.from, to: o.to });
    const r = await new DreamEngine(makeRoutingFamily(), pool).run(o.incumbent ?? DEFAULT_ROUTING_PARAMS,
      { seed: o.seed, iterations: o.iterations, episodes: o.episodes, confidence: o.confidence, proposer: o.proposer });
    const report = finalizeReport({
      kind: "kuber.dream-report", version: 1, family: "routing", tenant: o.tenant, book: null, range: { from: o.from ?? null, to: o.to ?? null },
      date: this.d.clock(), seed: o.seed, iterations: o.iterations, episodes: r.episodes, confidence: r.confidence,
      pool: { kind: pool.kind, size: pool.size, sliceHash: pool.hash(), source: o.adapter.name },
      segments: [{ segment: "copilot", result: { ...r, incumbent: { ...r.incumbent, source: o.incumbent ? "given" : "router-defaults" } } as SegmentReport["result"] }],
      decision: r.decision,
    });
    const files = o.write === false ? null : writeEvidence(report, this.d.evidenceDir);
    let artifact: { path: string; version: number; sha256: string } | null = null;
    if (r.decision === "promote" && o.write !== false) {
      const w = writeRoutingArtifact(this.d.artifactsDir, { metric: r.metric, params: r.winner.params,
        evidence: { reportHash: report.reportHash, poolSliceHash: pool.hash(), seed: o.seed, report: files ? files.json.split("/").slice(-3).join("/") : "" } });
      artifact = { path: w.path, version: w.artifact.version, sha256: w.artifact.sha256 };
    }
    return { report, files, result: r, artifact };
  }
}

interface ProposalRow {
  proposal_id: string; family: "autonomy"; book_id: string; status: Proposal["status"]; segments: ProposalSegment[]; report_hash: string;
  pool_hash: string; seed: number; evidence: string; created_by: string; created_at: Date; decided_by: string | null; decided_at: Date | null; decision_note: string | null;
}
const toProposal = (r: ProposalRow): Proposal => ({
  proposalId: r.proposal_id, family: r.family, bookId: r.book_id, status: r.status, segments: r.segments, reportHash: r.report_hash, poolHash: r.pool_hash,
  seed: r.seed, evidence: r.evidence, createdBy: r.created_by, createdAt: r.created_at.toISOString(), decidedBy: r.decided_by,
  decidedAt: r.decided_at ? r.decided_at.toISOString() : null, decisionNote: r.decision_note,
});

/** Hash an id for a routing fixture or adapter (without tenant keys; use the keyed index for tenant data). */
export const plainIdHash = (kind: string, id: string) => sha256Hex(`${kind}|${id}`).slice(0, 32);
