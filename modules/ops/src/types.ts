/**
 * The operation contract. Every operation (record, post, balance, reconcile, allocate, rebalance,
 * report, close, carry-forward, simulate, dashboard) is a typed input plus a deterministic plan.
 * A write plan is a simulation: it lists the exact journals and commands it would execute, the
 * before/after balance of every account it touches, the policy that governs it and pre-checks.
 * Committing re-verifies the plan hash and that the book has not moved since the simulation, so
 * what a person approves is exactly what is posted.
 */
import type { z } from "zod";
import type { Account } from "@kuber/contracts";
import type { BookCommand, BookState, GeneralLedger, PartyMaster } from "@kuber/gl";
import type { PolicyEngine } from "@kuber/policy";
import type { Agent } from "@kuber/agent";
import type { Reporting } from "@kuber/reporting";

export type OpName = "record" | "post" | "balance" | "reconcile" | "allocate" | "rebalance" | "report" | "close" | "carry_forward" | "simulate" | "dashboard"
  // finance requirements: recurring and recognition schedules (FIN-GL-02/03), suspense resolution (FIN-GL-05)
  | "schedule_approve" | "schedule_cancel" | "schedules" | "resolve_suspense" | "suspense";

export interface Services { gl: GeneralLedger; reporting: Reporting; agent: Agent; policies: PolicyEngine;
  /** Party master payment holds (FIN-MDM-03). Without it, no party is treated as held. */
  parties?: Pick<PartyMaster, "holds"> & Partial<Pick<PartyMaster, "entities" | "verifiers">>;
  /** Design 16.4: owners and controllers who have only one active passkey (the books-in-order check warns). */
  singlePasskeyPeople?: (tenant: string) => Promise<string[]> }

export interface OpContext {
  tenant: string; book: string; principal: string; today: string;
  /** Authoritative book state at `state.seq`; plans are computed from this, not from projections. */
  state: BookState;
  svc: Services;
  /** Schedules of this workspace (set by the Operations service; schedule operations need it). */
  schedules?: import("./schedules.ts").Schedules;
}

export type Action =
  | { type: "gl"; command: Extract<BookCommand, { kind: "PostJournal" | "LockPeriod" | "AddAccount" | "ResolveSuspense" }> }
  | { type: "approveDraft"; draftId: string; accountId: string }
  /** FIN-GL-02/03: the one approval of a schedule; later occurrences execute under it. */
  | { type: "approveSchedule"; scheduleId: string; hash: string; approvedAmount: string }
  /** FIN-GL-03: stop a schedule; `recognized`/`released`/`remaining` are the recalculated balance (paise). */
  | { type: "cancelSchedule"; scheduleId: string; effective: string; recognized: string; released: string; remaining: string }
  /** FIN-GL-05: record the item's resolution, linking original, reversal and replacement. */
  | { type: "resolveSuspenseItem"; itemId: string; bookId: string; reversalJournalId: string; replacementJournalId: string | null;
      toAccount: string | null; resolvedOn: string; note?: string };

export interface Check { label: string; ok: boolean; blocking: boolean; detail?: string }
export interface PlanLine { accountId: string; name: string; amount: string; dimensions?: Record<string, string> }
export interface PlanJournal { journalId: string; txnDate: string; narration: string; voucherType: string; lines: PlanLine[] }
export interface Effect { accountId: string; name: string; nature: string; before: string; after: string }
export interface Section {
  title: string;
  kind: "kv" | "table";
  columns?: string[];
  rows: (string | number | null)[][];
  /** Column indexes holding paise amounts, for formatting. */
  money?: number[];
}

/** What an operation returns; the service adds identity, policy, effects and the hash. */
export interface Draft {
  title: string;
  summary: string;
  actions: Action[];
  checks?: Check[];
  sections?: Section[];
  data?: unknown;
  /** Largest amount at stake (paise), for policy limits. */
  amountPaise?: bigint;
  notes?: string[];
  /** Drill-down links into views: [label, path]. */
  links?: [string, string][];
}

export interface Plan {
  planId: string; op: OpName; bookId: string; kind: "read" | "write"; gate: "policy" | "human";
  title: string; summary: string;
  policy: { ids: string[]; level: string; approver: string; reasons: string[] } | null;
  checks: Check[]; journals: PlanJournal[]; effects: Effect[]; sections: Section[]; data?: unknown;
  notes: string[]; links: [string, string][];
  /** Book event version the plan was simulated at (absent on plans made before it was recorded). */
  basisSeq: number; basisVersion?: number; createdAt: string; createdBy: string; hash: string;
  /** The person on whose instruction an agent (the copilot) prepared this plan; used for separation of duties. */
  requestedBy?: string;
  status: "preview" | "proposed" | "committed" | "discarded" | "stale";
  blocked: boolean;
  /** Who may commit: a person always; an agent only when policy grants L3+ and the gate is "policy". */
  needsPerson: boolean;
}

export interface OpDef<I = unknown> {
  name: OpName;
  title: string;
  /** Written for both people and language models: what it does, what it never does. */
  description: string;
  kind: "read" | "write";
  gate: "policy" | "human";
  event?: string;
  input: z.ZodType<I>;
  plan(ctx: OpContext, input: I): Promise<Draft>;
}

export type Accounts = Map<string, Account>;

/**
 * Authorization for the operations service (finding F02). Every plan, commit and discard is
 * checked before anything is read or written; the implementation (the identity module) resolves
 * the principal's membership, role and book scope and enforces separation of duties. Throws when
 * the step is not allowed.
 */
export type OpsStep = "plan" | "commit" | "discard" | "approve" | "execute";
export interface OpsGuardQuery {
  step: OpsStep; tenant: string; book: string; principal: string;
  op: Pick<OpDef, "name" | "kind" | "gate">;
  /** The stored plan (commit and discard). */
  plan?: Plan;
  /** When an agent acts for a person (the copilot), that person's principal. */
  onBehalfOf?: string;
  /**
   * FIN-MDM-04, step "execute": `principal` carries out a plan `approvedBy` approved earlier. The
   * approver's authority is checked again now (role, band, delegation, conflicts, separation).
   */
  approvedBy?: string;
  /** FIN-MDM-04: parties the plan's journals pay or receive from (related-party conflict rules). */
  parties?: string[];
  /**
   * Role model v2 conflict matrix: who verified the bank details of each party the plan pays. The
   * person who verified a party's bank change may not approve a payment to that party.
   */
  bankVerifiers?: { partyId: string; principal: string }[];
}
export interface OpsGuard {
  check(q: OpsGuardQuery): Promise<void>;
  /** FIN-OPS-03: is autonomous action halted (kill switch) for this tenant or book? Absent: never. */
  autonomyHalted?(tenant: string, book: string): Promise<boolean>;
  /**
   * Role model v2 (Agent Checker): why an agent may not commit this plan even though policy cleared
   * it, so a person must check it (amounts above the approval limit, ...), or null. Absent: only the
   * exclusions the operations service knows itself (period operations, payments) apply.
   */
  agentCheckerExclusion?(tenant: string, plan: Plan): Promise<string | null>;
}
