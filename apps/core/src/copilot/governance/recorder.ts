/**
 * Turn recorder (TAGOF TOL-05 tool-use audit log, AGT-07 action chain audit, Domain 14 logging;
 * enforcement point EP-7) and misuse detection (TOL-07).
 *
 * Each copilot turn is appended as a sealed `AgentTurnRecorded` event to `<tenant>/agent-turns/<book>`
 * (chained, tamper-evident, LOG-02) and indexed in `agent.copilot_turns` in the same transaction.
 * Neither holds text: questions, tool inputs and tool outputs are SHA-256 hashes, so personal data
 * in them is not duplicated (an investigator matches a hash against the sealed source record).
 *
 * The index holds ids, hashes and counts only (nothing to seal); it is purged on crypto-shredding
 * (RETENTION "purge") while the sealed events stay (Tier 1 retention, LOG-03). It serves the
 * paged query (GET …/agent/turns, `ops agent-turns`) and the monitoring signals in `ops status`.
 */
import type { TransactionSql } from "postgres";
import type { EventStore, Migration } from "@kuber/eventstore";
import type { Envelope } from "@kuber/contracts";
import { rlsForTables } from "@kuber/identity";
import type { Reversibility, TurnRecord } from "./contracts.ts";
import { sha256 } from "./prompts.ts";
import type { ToolRegister } from "./register.ts";

export const AGENT_GOVERNANCE_MIGRATIONS: Migration[] = [{
  id: "agent-gov-001-copilot-turns",
  sql: `
CREATE TABLE agent.copilot_turns (
  tenant_id TEXT NOT NULL, turn_id TEXT NOT NULL, book_id TEXT NOT NULL, session_hash TEXT, on_behalf_of TEXT NOT NULL,
  engine TEXT NOT NULL, prompt_version TEXT NOT NULL, outcome TEXT NOT NULL,
  input_ok BOOLEAN NOT NULL, input_category TEXT,
  tool_calls INT NOT NULL, tool_denials INT NOT NULL, injection_flags INT NOT NULL,
  grounding_ok BOOLEAN NOT NULL, ungrounded INT NOT NULL, plans INT NOT NULL,
  hitl_bypass BOOLEAN NOT NULL, anomalies TEXT[] NOT NULL DEFAULT '{}', steps INT NOT NULL, ms INT NOT NULL,
  event_id TEXT NOT NULL, stream_version INT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, turn_id));
CREATE INDEX copilot_turns_book_time ON agent.copilot_turns (tenant_id, book_id, recorded_at DESC, turn_id);
CREATE INDEX copilot_turns_time ON agent.copilot_turns (tenant_id, recorded_at);
` + rlsForTables("agent", ["copilot_turns"]),
}];

export const turnStream = (tenant: string, book: string) => `${tenant}/agent-turns/${book}`;
const EXECUTABLE = new Set<Reversibility>(["none", "simulation"]);

// ------------------------------------------------------------------ TOL-07 rate limits
export interface RateLimits {
  /** Turns per session per minute. */
  sessionTurnsPerMinute: number;
  /** Turns per person per hour (all sessions). */
  principalTurnsPerHour: number;
  /** Tool calls per person per minute. */
  principalToolCallsPerMinute: number;
  /** Tool calls in one turn (above the core's step bound means the loop misbehaved). */
  toolCallsPerTurn: number;
}
export const DEFAULT_LIMITS: RateLimits = { sessionTurnsPerMinute: 20, principalTurnsPerHour: 300, principalToolCallsPerMinute: 60, toolCallsPerTurn: 16 };

/** Sliding-window counters, in process (one core instance; see the register row for the multi-instance gap). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(readonly limits: RateLimits = DEFAULT_LIMITS, private now: () => number = Date.now) {}

  private window(key: string, ms: number): number[] {
    const t = this.now(), arr = (this.hits.get(key) ?? []).filter((x) => x > t - ms);
    this.hits.set(key, arr);
    return arr;
  }
  private add(key: string) { (this.hits.get(key) ?? this.hits.set(key, []).get(key)!).push(this.now()); }
  private count(key: string, ms: number) { return this.window(key, ms).length; }

  /** Before a turn starts: refused when the session or person is already at a limit. */
  admitTurn(ctx: { tenant: string; sessionId: string | null; onBehalfOf: string }): { ok: boolean; reason?: string } {
    if (ctx.sessionId && this.count(`st|${ctx.tenant}|${ctx.sessionId}`, 60_000) >= this.limits.sessionTurnsPerMinute) {
      return { ok: false, reason: `rate limit: more than ${this.limits.sessionTurnsPerMinute} turns a minute in this session` };
    }
    if (this.count(`pt|${ctx.tenant}|${ctx.onBehalfOf}`, 3_600_000) >= this.limits.principalTurnsPerHour) {
      return { ok: false, reason: `rate limit: more than ${this.limits.principalTurnsPerHour} turns an hour` };
    }
    return { ok: true };
  }

  /** Each tool authorization counts; refused at the limit. */
  toolCall(ctx: { tenant: string; onBehalfOf: string }): { ok: boolean; reason?: string } {
    const key = `pc|${ctx.tenant}|${ctx.onBehalfOf}`;
    if (this.count(key, 60_000) >= this.limits.principalToolCallsPerMinute) return { ok: false, reason: `rate limit: more than ${this.limits.principalToolCallsPerMinute} tool calls a minute` };
    this.add(key);
    return { ok: true };
  }

  /** At record time: count the turn and return the anomalies it shows (limits exceeded). */
  turnRecorded(t: { tenant: string; sessionId: string | null; onBehalfOf: string; toolCalls: number; toolLimitDenials: number }): string[] {
    const out: string[] = [];
    if (t.sessionId) {
      this.add(`st|${t.tenant}|${t.sessionId}`);
      if (this.count(`st|${t.tenant}|${t.sessionId}`, 60_000) > this.limits.sessionTurnsPerMinute) out.push("rate:session_turns");
    }
    this.add(`pt|${t.tenant}|${t.onBehalfOf}`);
    if (this.count(`pt|${t.tenant}|${t.onBehalfOf}`, 3_600_000) > this.limits.principalTurnsPerHour) out.push("rate:principal_turns");
    if (t.toolLimitDenials > 0 || this.count(`pc|${t.tenant}|${t.onBehalfOf}`, 60_000) >= this.limits.principalToolCallsPerMinute) out.push("rate:principal_tool_calls");
    if (t.toolCalls > this.limits.toolCallsPerTurn) out.push("rate:turn_tool_calls");
    return out;
  }
}

// ------------------------------------------------------------------ recorder
export interface TurnRow {
  turnId: string; book: string; sessionHash: string | null; onBehalfOf: string; engine: string; promptVersion: string; outcome: string;
  inputOk: boolean; inputCategory: string | null; toolCalls: number; toolDenials: number; injectionFlags: number;
  groundingOk: boolean; ungrounded: number; plans: number; hitlBypass: boolean; anomalies: string[]; steps: number; ms: number;
  eventId: string; streamVersion: number; recordedAt: string;
}
type DbRow = { turn_id: string; book_id: string; session_hash: string | null; on_behalf_of: string; engine: string; prompt_version: string; outcome: string;
  input_ok: boolean; input_category: string | null; tool_calls: number; tool_denials: number; injection_flags: number; grounding_ok: boolean; ungrounded: number;
  plans: number; hitl_bypass: boolean; anomalies: string[]; steps: number; ms: number; event_id: string; stream_version: number; recorded_at: Date };
const toRow = (r: DbRow): TurnRow => ({ turnId: r.turn_id, book: r.book_id, sessionHash: r.session_hash, onBehalfOf: r.on_behalf_of, engine: r.engine,
  promptVersion: r.prompt_version, outcome: r.outcome, inputOk: r.input_ok, inputCategory: r.input_category, toolCalls: r.tool_calls, toolDenials: r.tool_denials,
  injectionFlags: r.injection_flags, groundingOk: r.grounding_ok, ungrounded: r.ungrounded, plans: r.plans, hitlBypass: r.hitl_bypass, anomalies: r.anomalies,
  steps: r.steps, ms: r.ms, eventId: r.event_id, streamVersion: r.stream_version, recordedAt: r.recorded_at.toISOString() });

export const isDenialFlag = (f: string) => f.startsWith("denied");
export const isInjectionFlag = (f: string) => f.startsWith("instruction_like:") || f === "role_marker_neutralised";

export interface AgentPeriodStats {
  period: string; turns: number; refusedInputs: Record<string, number>; injectionFlags: number; toolDenials: number;
  groundingFailures: number; plansProposed: number; engine: { model: number; rules: number; modelShare: number };
  p95LatencyMs: number | null; hitlBypass: number; anomalies: number; halted: number; errors: number;
}

export class TurnRecorder {
  /** Tool denials authorizeTool saw per (tenant|book|person) since that person's last recorded turn. */
  private pendingDenials = new Map<string, { denials: number; rate: number }>();

  constructor(private store: EventStore, private register: ToolRegister, readonly limiter: RateLimiter) {}

  noteDenial(ctx: { tenant: string; book: string; onBehalfOf: string }, rateLimited: boolean) {
    const k = `${ctx.tenant}|${ctx.book}|${ctx.onBehalfOf}`, p = this.pendingDenials.get(k) ?? { denials: 0, rate: 0 };
    p.denials++; if (rateLimited) p.rate++;
    this.pendingDenials.set(k, p);
  }

  /**
   * HITL bypass (MON-09): a tool that ran (ok) although it is not a read or a simulation, by its
   * record or by the register, or is not registered at all. Refused attempts are denials, not
   * bypasses. authorizeTool refuses all of these, so this is 0 by construction; it is counted
   * independently so a core that skipped authorizeTool would show up.
   */
  hitlBypass(turn: Pick<TurnRecord, "tools">): boolean {
    return turn.tools.some((t) => {
      if (!t.ok) return false;
      const reg = this.register.get(t.tool);
      return !reg || !EXECUTABLE.has(t.reversibility) || !EXECUTABLE.has(reg.reversibility);
    });
  }

  async record(turn: TurnRecord, artifacts: { id: string; version: string; hash: string }[] = []): Promise<void> {
    const k = `${turn.tenant}|${turn.book}|${turn.onBehalfOf}`, pending = this.pendingDenials.get(k);
    this.pendingDenials.delete(k);
    const flagged = turn.tools.filter((t) => t.flags.some(isDenialFlag)).length;
    const toolDenials = flagged || pending?.denials || 0;
    const injectionFlags = (turn.input.category === "injection" ? 1 : 0) + turn.tools.reduce((n, t) => n + t.flags.filter(isInjectionFlag).length, 0);
    const anomalies = this.limiter.turnRecorded({ tenant: turn.tenant, sessionId: turn.sessionId, onBehalfOf: turn.onBehalfOf,
      toolCalls: turn.tools.length, toolLimitDenials: pending?.rate ?? 0 });
    const hitlBypass = this.hitlBypass(turn);
    if (hitlBypass) anomalies.push("hitl_bypass");
    const sessionHash = turn.sessionId ? sha256(`session|${turn.sessionId}`) : null;
    const data = {
      turnId: turn.turnId, bookId: turn.book, sessionHash, principal: turn.principal, onBehalfOf: turn.onBehalfOf, engine: turn.engine,
      prompt: { id: turn.promptId, version: turn.promptVersion, hash: turn.promptHash }, artifacts,
      input: { ok: turn.input.ok, ...(turn.input.category ? { category: turn.input.category } : {}), ...(turn.input.reason ? { reason: turn.input.reason.slice(0, 500) } : {}) },
      inputHash: turn.inputHash,
      tools: turn.tools.map((t) => ({ tool: t.tool, inputHash: t.inputHash, outputHash: t.outputHash, ok: t.ok, reversibility: t.reversibility, flags: t.flags,
        ms: t.ms, ...(t.planId ? { planId: t.planId } : {}) })),
      planIds: turn.planIds,
      grounding: { ok: turn.grounding.ok, ungrounded: turn.grounding.ungrounded.length, ungroundedHashes: turn.grounding.ungrounded.map((u) => sha256(u)) },
      outcome: turn.outcome, steps: turn.steps,
      ...(turn.tokensIn !== undefined ? { tokensIn: turn.tokensIn } : {}), ...(turn.tokensOut !== undefined ? { tokensOut: turn.tokensOut } : {}),
      ms: turn.ms, toolDenials, injectionFlags, anomalies, hitlBypass,
    };
    await this.store.tenantTx(turn.tenant, async (tx) => {
      const [dup] = await tx`SELECT 1 FROM agent.copilot_turns WHERE tenant_id = ${turn.tenant} AND turn_id = ${turn.turnId}`;
      if (dup) return;                                        // a retried record: the turn is already in the log
      const [env] = await this.store.append("agent", turn.tenant, { streamId: turnStream(turn.tenant, turn.book), expected: "any",
        events: [{ type: "AgentTurnRecorded", data }] }, { principal: turn.principal }, tx);
      await tx`INSERT INTO agent.copilot_turns (tenant_id, turn_id, book_id, session_hash, on_behalf_of, engine, prompt_version, outcome, input_ok, input_category,
          tool_calls, tool_denials, injection_flags, grounding_ok, ungrounded, plans, hitl_bypass, anomalies, steps, ms, event_id, stream_version)
        VALUES (${turn.tenant}, ${turn.turnId}, ${turn.book}, ${sessionHash}, ${turn.onBehalfOf}, ${turn.engine}, ${turn.promptVersion}, ${turn.outcome},
          ${turn.input.ok}, ${turn.input.category ?? null}, ${turn.tools.length}, ${toolDenials}, ${injectionFlags}, ${turn.grounding.ok},
          ${turn.grounding.ungrounded.length}, ${turn.planIds.length}, ${hitlBypass}, ${anomalies}, ${turn.steps}, ${Math.round(turn.ms)}, ${env!.eventId}, ${env!.streamVersion})`;
    });
  }

  /** Newest first, keyset-paged by (recorded_at, turn_id). */
  async query(tenant: string, q: { book?: string; since?: string; limit?: number; before?: string } = {}): Promise<{ turns: TurnRow[]; next: string | null }> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const [bAt, bId] = q.before ? decodeCursor(q.before) : [null, null];
    const rows = await this.store.tenantTx(tenant, (tx) => tx<DbRow[]>`
      SELECT * FROM agent.copilot_turns WHERE tenant_id = ${tenant}
        ${q.book ? tx`AND book_id = ${q.book}` : tx``}
        ${q.since ? tx`AND recorded_at >= ${q.since}::timestamptz` : tx``}
        ${bAt ? tx`AND (recorded_at, turn_id) < (${bAt}::timestamptz, ${bId})` : tx``}
      ORDER BY recorded_at DESC, turn_id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit).map(toRow);
    const last = page[page.length - 1];
    return { turns: page, next: rows.length > limit && last ? encodeCursor(last.recordedAt, last.turnId) : null };
  }

  /** The sealed event of one turn (opened with the tenant's key), for an investigation. */
  async event(tenant: string, turnId: string): Promise<Envelope<"AgentTurnRecorded"> | null> {
    const [r] = await this.store.tenantTx(tenant, (tx) => tx<{ book_id: string; stream_version: number }[]>`
      SELECT book_id, stream_version FROM agent.copilot_turns WHERE tenant_id = ${tenant} AND turn_id = ${turnId}`);
    if (!r) return null;
    const [e] = await this.store.readStream(tenant, turnStream(tenant, r.book_id), r.stream_version - 1);
    return (e as Envelope<"AgentTurnRecorded">) ?? null;
  }

  /** TAGOF Part VII / Deliverable E signals per calendar month (UTC). */
  async stats(tenant: string, q: { since?: string; book?: string } = {}, tx?: TransactionSql): Promise<AgentPeriodStats[]> {
    const run = async (t: TransactionSql) => {
      const where = t`tenant_id = ${tenant} ${q.book ? t`AND book_id = ${q.book}` : t``} ${q.since ? t`AND recorded_at >= ${q.since}::timestamptz` : t``}`;
      const base = await t<{ period: string; turns: number; injection: number; denials: number; grounding: number; plans: number; model: number; rules: number;
        p95: number | null; bypass: number; anomalies: number; halted: number; errors: number }[]>`
        SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM') AS period, count(*)::int AS turns,
          sum(injection_flags)::int AS injection, sum(tool_denials)::int AS denials, count(*) FILTER (WHERE NOT grounding_ok)::int AS grounding,
          sum(plans)::int AS plans, count(*) FILTER (WHERE engine <> 'rules')::int AS model, count(*) FILTER (WHERE engine = 'rules')::int AS rules,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
          count(*) FILTER (WHERE hitl_bypass)::int AS bypass, count(*) FILTER (WHERE cardinality(anomalies) > 0)::int AS anomalies,
          count(*) FILTER (WHERE outcome = 'halted')::int AS halted, count(*) FILTER (WHERE outcome = 'error')::int AS errors
        FROM agent.copilot_turns WHERE ${where} GROUP BY 1 ORDER BY 1`;
      const refused = await t<{ period: string; category: string; n: number }[]>`
        SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM') AS period, coalesce(input_category, 'unknown') AS category, count(*)::int AS n
        FROM agent.copilot_turns WHERE ${where} AND NOT input_ok GROUP BY 1, 2 ORDER BY 1, 2`;
      return base.map((b) => ({
        period: b.period, turns: b.turns,
        refusedInputs: Object.fromEntries(refused.filter((r) => r.period === b.period).map((r) => [r.category, r.n])),
        injectionFlags: b.injection, toolDenials: b.denials, groundingFailures: b.grounding, plansProposed: b.plans,
        engine: { model: b.model, rules: b.rules, modelShare: b.turns ? Math.round((b.model / b.turns) * 1000) / 1000 : 0 },
        p95LatencyMs: b.p95 === null ? null : Math.round(Number(b.p95)), hitlBypass: b.bypass, anomalies: b.anomalies, halted: b.halted, errors: b.errors,
      }));
    };
    return tx ? run(tx) : this.store.tenantTx(tenant, run);
  }
}

const encodeCursor = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString("base64url");
function decodeCursor(c: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string" && !Number.isNaN(Date.parse(v[0]))) return [v[0], v[1]];
  } catch { /* fall through */ }
  throw Object.assign(new Error("bad cursor"), { statusCode: 400 });
}
