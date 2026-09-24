/**
 * Agent module: turns extracted transactions into posting requests or drafts, under policy.
 *
 * Reacts to:  TransactionExtracted (channels), BookOpened / AccountAdded / JournalPosted /
 *             JournalReversed / PostingRejected (gl)
 * Emits:      PartyResolved, ProvisionalConfirmed, TransactionClassified, PolicyDecisionMade,
 *             PostingRequested, DraftQueued, DraftApproved, DraftRejected, RatificationRequested,
 *             Ratified, CorrectionRequested, RuleLearned, AutonomyLimited
 *
 * The agent never writes journals. It requests postings; the GL decides. A draft's lifecycle
 * follows the GL's answer: queued|awaiting_approval -> approved (posting requested) -> posted on
 * JournalPosted, or rejected_by_gl on PostingRejected, which puts it back in review with the reason.
 * Its own tables are updated in the same transaction as the events it appends.
 */
import type { Sql, TransactionSql } from "postgres";
import {
  addDays, journalIdForRequest, stableId, uuid,
  type Decision, type Envelope, type EventData, type Line,
} from "@kuber/contracts";
import { once, type EventStore, type MetaInput, type NewEvent } from "@kuber/eventstore";
import { isToken, type TenantKeys } from "@kuber/crypto";
import type { Level, PolicyEngine } from "@kuber/policy";
import { SUSPENSE, accountNameCtx, classify, type LlmClassifier } from "./classify.ts";

export { AGENT_MIGRATIONS } from "./migrations.ts";
export { LLM_MAX_CONFIDENCE, MERCHANTS, SUSPENSE, accountNameCtx } from "./classify.ts";
export type { ClassifierAccount, ClassifierInput, LlmClassifier, LlmSuggestion } from "./classify.ts";

export const AGENT_PRINCIPAL = "agent:kuber";
const INGEST_EVENT = "EVT-TXN-INGESTED";
const DEDUPE_WINDOW_DAYS = 3;
const RATIFY_DAYS = 7;
const CORRECTION_LIMIT_DAYS = 30;
const KNOWN_AFTER = 3;
/** Draft states a person can act on: new, or returned by the GL with a reason. */
const REVIEWABLE = ["queued", "awaiting_approval", "rejected_by_gl"];

export class AgentError extends Error { constructor(public code: string, msg: string) { super(msg); } }

export class Agent {
  constructor(private sql: Sql, private store: EventStore, private policies: PolicyEngine,
              private clock: () => string = () => new Date().toISOString().slice(0, 10),
              private llm?: LlmClassifier) {}

  // ------------------------------------------------------------------ event handling
  handler = async (env: Envelope): Promise<void> => {
    switch (env.type) {
      case "BookOpened": case "AccountAdded": return void (await once(this.store, "agent", env, (tx) => this.projectAccounts(tx, env)));
      case "JournalPosted": return void (await once(this.store, "agent", env, (tx) => this.projectJournal(tx, env)));
      case "JournalReversed": return void (await once(this.store, "agent", env, (tx) => this.projectReversal(tx, env)));
      case "PostingRejected": return void (await once(this.store, "agent", env, (tx) => this.onRejected(tx, env)));
      case "TransactionExtracted": return void (await once(this.store, "agent", env, (tx) => this.onExtracted(tx, env)));
      default: return;
    }
  };

  private async projectAccounts(tx: TransactionSql, env: Envelope) {
    const t = env.meta.tenantId;
    const accs = env.type === "BookOpened"
      ? (env.data as EventData<"BookOpened">).accounts
      : [(env.data as EventData<"AccountAdded">).account];
    const bookId = (env.data as { bookId: string }).bookId;
    const keys = await this.store.keys(t);
    for (const a of accs) {
      await tx`INSERT INTO agent.accounts (tenant_id, book_id, account_id, nature, is_cash_like, name)
               VALUES (${t}, ${bookId}, ${a.accountId}, ${a.nature}, ${a.isCashLike}, ${keys.seal(a.name, accountNameCtx(bookId, a.accountId))})
               ON CONFLICT DO NOTHING`;
    }
  }

  private async projectJournal(tx: TransactionSql, env: Envelope) {
    const t = env.meta.tenantId;
    const d = env.data as EventData<"JournalPosted">;
    const cash = await this.cashLike(tx, t, d.bookId);
    const instrumentLine = d.lines.find((l) => cash.has(l.accountId));
    const counter = d.lines.find((l) => !cash.has(l.accountId));
    const party = d.lines.find((l) => l.partyId)?.partyId ?? null;
    await tx`INSERT INTO agent.journal_index VALUES (${t}, ${d.bookId}, ${d.journalId}, ${env.meta.principal}, ${party},
             ${counter?.accountId ?? null}, ${instrumentLine?.accountId ?? null}, ${instrumentLine?.amount ?? null}, ${d.txnDate},
             ${d.provisional}, false, false) ON CONFLICT DO NOTHING`;
    if (party && counter && !d.reverses) {
      await tx`INSERT INTO agent.party_accounts VALUES (${t}, ${d.bookId}, ${party}, ${counter.accountId}, 1)
               ON CONFLICT (tenant_id, book_id, party_id, account_id) DO UPDATE SET n = agent.party_accounts.n + 1`;
    }
    await this.draftPosted(tx, t, d.journalId);
  }

  /**
   * The GL accepted an approved draft's journal: only now is it posted, and only now does the
   * person's choice teach the classifier (a rejected posting must not raise future autonomy).
   */
  private async draftPosted(tx: TransactionSql, t: string, journalId: string) {
    const [r] = await tx<{ draft_id: string; txn_id: string; proposal: unknown; approved_account: string; resolved_by: string }[]>`
      UPDATE agent.drafts SET status = 'posted' WHERE tenant_id = ${t} AND journal_id = ${journalId} AND status = 'approved'
      RETURNING draft_id, txn_id, proposal, approved_account, resolved_by`;
    if (!r) return;
    const keys = await this.store.keys(t);
    const p = openProposal(keys, r.draft_id, r.proposal);
    if (r.approved_account === SUSPENSE || !p.partyName) return;
    const events = await this.learn(tx, t, p.partyName, r.approved_account, r.resolved_by, keys);
    if (p.partyId) await tx`UPDATE agent.parties SET confirmed = true WHERE tenant_id = ${t} AND party_id = ${p.partyId}`;
    if (events.length) await this.store.append("agent", t, { streamId: `${t}/txn/${r.txn_id}`, expected: "any", events }, { principal: r.resolved_by }, tx);
  }

  /** The GL refused an approved draft's posting: back to review, with the reason, for a person to fix or reject. */
  private async onRejected(tx: TransactionSql, env: Envelope) {
    const t = env.meta.tenantId;
    const d = env.data as EventData<"PostingRejected">;
    const [r] = await tx<{ draft_id: string }[]>`
      SELECT draft_id FROM agent.drafts WHERE tenant_id = ${t} AND request_id = ${d.requestId} AND book_id = ${d.bookId} AND status = 'approved' FOR UPDATE`;
    if (!r) return;
    const keys = await this.store.keys(t);
    await tx`UPDATE agent.drafts SET status = 'rejected_by_gl', gl_rejection = ${keys.seal(d.reason, `agent.drafts.gl_rejection|${r.draft_id}`)}
             WHERE tenant_id = ${t} AND draft_id = ${r.draft_id}`;
  }

  private async projectReversal(tx: TransactionSql, env: Envelope) {
    const t = env.meta.tenantId;
    const d = env.data as EventData<"JournalReversed">;
    const [j] = await tx<{ party_id: string | null; counter_account: string | null; book_id: string }[]>`
      UPDATE agent.journal_index SET reversed = true WHERE tenant_id = ${t} AND journal_id = ${d.journalId}
      RETURNING party_id, counter_account, book_id`;
    if (j?.party_id && j.counter_account) {
      await tx`UPDATE agent.party_accounts SET n = GREATEST(n - 1, 0)
               WHERE tenant_id = ${t} AND book_id = ${j.book_id} AND party_id = ${j.party_id} AND account_id = ${j.counter_account}`;
    }
  }

  private async onExtracted(tx: TransactionSql, env: Envelope) {
    const t = env.meta.tenantId;
    const d = env.data as EventData<"TransactionExtracted">;
    const txn = d.txn;
    const stream = `${t}/txn/${d.txnId}`;
    const signed = BigInt(txn.amount) * (txn.direction === "in" ? 1n : -1n);
    const baseMeta: MetaInput = { principal: AGENT_PRINCIPAL, correlationId: env.meta.correlationId, causationId: env.eventId };
    const events: NewEvent[] = [];
    const keys = await this.store.keys(t);

    // 1. party
    const { partyId, partyName, isNew } = await this.resolveParty(tx, t, txn.counterpartyHint ?? narrationKey(txn.narration), keys);
    if (partyId) events.push({ type: "PartyResolved", data: { txnId: d.txnId, partyId, partyName: partyName!, isNew } });

    // 2. an authoritative line may confirm an earlier provisional entry instead of posting again
    if (d.trust === "authoritative") {
      const lo = addDays(txn.txnDate, -DEDUPE_WINDOW_DAYS), hi = addDays(txn.txnDate, DEDUPE_WINDOW_DAYS);
      const [m] = await tx<{ journal_id: string }[]>`
        SELECT journal_id FROM agent.journal_index
        WHERE tenant_id = ${t} AND book_id = ${d.bookId} AND provisional AND NOT confirmed AND NOT reversed
          AND instrument = ${txn.instrument} AND amount = ${signed.toString()} AND txn_date BETWEEN ${lo} AND ${hi}
        ORDER BY abs(txn_date - ${txn.txnDate}::date) LIMIT 1 FOR UPDATE`;
      if (m) {
        await tx`UPDATE agent.journal_index SET confirmed = true WHERE tenant_id = ${t} AND journal_id = ${m.journal_id}`;
        events.push({ type: "ProvisionalConfirmed", data: { txnId: d.txnId, journalId: m.journal_id } });
        await this.store.append("agent", t, { streamId: stream, expected: "any", events }, baseMeta, tx);
        return;
      }
    }

    // 3. classify
    const accounts = await this.accountSet(tx, t, d.bookId);
    if (!accounts.has(txn.instrument)) throw new AgentError("unknown_instrument", `book ${d.bookId} has no account ${txn.instrument}`);
    const c = await classify(tx, t, d.bookId, accounts, { direction: txn.direction, narration: txn.narration, partyId, partyName, purpose: txn.purposeHint }, keys, this.llm);
    events.push({ type: "TransactionClassified", data: { txnId: d.txnId, accountId: c.accountId, confidence: c.confidence, source: c.source } });

    const provisional = d.trust === "provisional" || (d.trust === "user" && txn.instrument !== "CASH");
    const lines: Line[] = [
      { accountId: txn.instrument, amount: signed.toString(), dimensions: {} },
      { accountId: c.accountId, amount: (-signed).toString(), ...(partyId ? { partyId } : {}), dimensions: {} },
    ];
    const proposal = { txnDate: txn.txnDate, narration: txn.narration, voucherType: txn.direction === "in" ? "receipt" : "payment", lines, provisional };
    const requestId = `req-${d.txnId}`;

    // 4. a person typed it: their statement is the approval
    if (d.trust === "user") {
      events.push({ type: "PostingRequested", data: { requestId, bookId: d.bookId, ...proposal, autonomy: "human", confidence: c.confidence, sourceStream: stream } });
      await this.store.append("agent", t, { streamId: stream, expected: "any", events }, { ...baseMeta, principal: env.meta.principal }, tx);
      return;
    }

    // 5. policy decides what the agent may do
    const decision = this.policies.decide({
      eventCode: INGEST_EVENT, on: this.clock(), amountPaise: BigInt(txn.amount), confidence: c.confidence,
      counterpartyKnown: await this.partyKnown(tx, t, partyId), overrideMax: await this.override(tx, t, c.accountId, partyId),
    });
    events.push({ type: "PolicyDecisionMade", data: { txnId: d.txnId, decision: decision as Decision } });
    const meta = { ...baseMeta, policyIds: decision.policyIds };

    if ((decision.action === "post" || decision.action === "post_then_ratify") && c.accountId !== SUSPENSE) {
      events.push({ type: "PostingRequested", data: { requestId, bookId: d.bookId, ...proposal, autonomy: decision.level, confidence: c.confidence, sourceStream: stream } });
      if (decision.action === "post_then_ratify") {
        const dueBy = addDays(this.clock(), RATIFY_DAYS);
        events.push({ type: "RatificationRequested", data: { requestId, dueBy } });
        await tx`INSERT INTO agent.ratifications VALUES (${t}, ${requestId}, ${journalIdForRequest(t, requestId)}, ${d.txnId},
                 ${dueBy}, 'open', ${keys.seal(txn.narration, `agent.ratifications.narration|${requestId}`)}, null, null) ON CONFLICT DO NOTHING`;
      }
    } else {
      const draftId = stableId("draft", `${t}/${d.txnId}`);
      const status = decision.action === "await_approval" ? "awaiting_approval" : "queued";
      events.push({ type: "DraftQueued", data: { txnId: d.txnId, draftId, bookId: d.bookId, status, proposal, accountId: c.accountId,
        confidence: c.confidence, partyName: partyName ?? undefined, amount: txn.amount, direction: txn.direction } });
      await tx`INSERT INTO agent.drafts (tenant_id, draft_id, txn_id, book_id, status, proposal, decision)
               VALUES (${t}, ${draftId}, ${d.txnId}, ${d.bookId}, ${status},
                       ${tx.json({ $c: keys.sealJson({ ...proposal, accountId: c.accountId, confidence: c.confidence, classifiedBy: c.source, partyName, partyId, amount: txn.amount, direction: txn.direction }, `agent.drafts.proposal|${draftId}`) } as never)},
                       ${tx.json(decision as never)}) ON CONFLICT DO NOTHING`;
    }
    await this.store.append("agent", t, { streamId: stream, expected: "any", events }, meta, tx);
  }

  // ------------------------------------------------------------------ commands from people
  /**
   * Approve a draft: request its posting. The draft is 'approved' (not posted) until the GL answers.
   * `commandId` is the ops plan id when the approval comes from a committed plan; `inTx` lets that
   * plan approve its drafts atomically with its own commit.
   */
  async approveDraft(tenantId: string, draftId: string, principal: string, accountId?: string, commandId?: string, inTx?: TransactionSql) {
    const run = async (tx: TransactionSql) => {
      const keys = await this.store.keys(tenantId);
      const [row] = await tx<{ txn_id: string; book_id: string; status: string; proposal: unknown }[]>`
        SELECT txn_id, book_id, status, proposal FROM agent.drafts WHERE tenant_id = ${tenantId} AND draft_id = ${draftId} FOR UPDATE`;
      if (!row) throw new AgentError("not_found", `no draft ${draftId}`);
      const d = { ...row, proposal: openProposal(keys, draftId, row.proposal) };
      if (!REVIEWABLE.includes(d.status)) throw new AgentError("not_open", `draft ${draftId} is ${d.status}`);
      const final = accountId ?? d.proposal.accountId;
      const accounts = await this.accountSet(tx, tenantId, d.book_id);
      if (!accounts.has(final)) throw new AgentError("no_account", `unknown account ${final}`);
      const lines = d.proposal.lines.map((l) => (l.accountId === d.proposal.accountId ? { ...l, accountId: final } : l));
      // Same request id on a retry after a GL rejection: the journal id stays deterministic.
      const requestId = `req-${d.txn_id}`, journalId = journalIdForRequest(tenantId, requestId);
      const events: NewEvent[] = [
        { type: "DraftApproved", data: { draftId, accountId: final } },
        { type: "PostingRequested", data: { requestId, bookId: d.book_id, txnDate: d.proposal.txnDate, narration: d.proposal.narration,
          voucherType: d.proposal.voucherType, lines, provisional: d.proposal.provisional, autonomy: "human",
          confidence: d.proposal.confidence, sourceStream: `${tenantId}/txn/${d.txn_id}` } },
      ];
      await tx`UPDATE agent.drafts SET status = 'approved', request_id = ${requestId}, journal_id = ${journalId}, approved_account = ${final},
               gl_rejection = null, resolved_by = ${principal}, resolved_at = now() WHERE tenant_id = ${tenantId} AND draft_id = ${draftId}`;
      await this.store.append("agent", tenantId, { streamId: `${tenantId}/txn/${d.txn_id}`, expected: "any", events }, { principal, commandId }, tx);
      return { requestId, journalId, status: "approved" as const };
    };
    return inTx ? run(inTx) : this.store.tenantTx(tenantId, run);
  }

  async rejectDraft(tenantId: string, draftId: string, principal: string, reason: string) {
    return this.store.tenantTx(tenantId, async (tx) => {
      const [d] = await tx<{ txn_id: string }[]>`
        UPDATE agent.drafts SET status = 'rejected', resolved_by = ${principal}, resolved_at = now()
        WHERE tenant_id = ${tenantId} AND draft_id = ${draftId} AND status IN ${tx(REVIEWABLE)} RETURNING txn_id`;
      if (!d) throw new AgentError("not_open", `draft ${draftId} is not open`);
      await this.store.append("agent", tenantId, { streamId: `${tenantId}/txn/${d.txn_id}`, expected: "any",
        events: [{ type: "DraftRejected", data: { draftId, reason } }] }, { principal }, tx);
    });
  }

  async ratify(tenantId: string, journalId: string, principal: string) {
    return this.store.tenantTx(tenantId, async (tx) => {
      const [r] = await tx<{ txn_id: string }[]>`
        UPDATE agent.ratifications SET status = 'ratified', resolved_by = ${principal}, resolved_at = now()
        WHERE tenant_id = ${tenantId} AND journal_id = ${journalId} AND status = 'open' RETURNING txn_id`;
      if (!r) throw new AgentError("not_open", `no open ratification for ${journalId}`);
      await this.store.append("agent", tenantId, { streamId: `${tenantId}/txn/${r.txn_id}`, expected: "any",
        events: [{ type: "Ratified", data: { journalId } }] }, { principal }, tx);
    });
  }

  /**
   * Reclassify a posted journal: GL reverses and reposts; if the agent made the entry it limits itself
   * for that account and counterparty. A one-off correction (a client lunch on a food app) must not
   * rewrite the counterparty's rule, so learning is opt-in: pass `learn: true` for "always use this account".
   */
  async correct(tenantId: string, journalId: string, toAccount: string, principal: string, opts: { learn?: boolean } = {}) {
    return this.store.tenantTx(tenantId, async (tx) => {
      const [j] = await tx<{ book_id: string; principal: string; party_id: string | null; counter_account: string | null; reversed: boolean }[]>`
        SELECT book_id, principal, party_id, counter_account, reversed FROM agent.journal_index WHERE tenant_id = ${tenantId} AND journal_id = ${journalId}`;
      if (!j) throw new AgentError("not_found", `no journal ${journalId} (it may not be projected yet)`);
      if (j.reversed) throw new AgentError("already_reversed", `${journalId} is already reversed`);
      if (!j.counter_account) throw new AgentError("no_counter", `${journalId} has no classifiable line`);
      const requestId = `corr-${uuid()}`;
      const events: NewEvent[] = [{ type: "CorrectionRequested", data: { requestId, bookId: j.book_id, journalId, fromAccount: j.counter_account, toAccount } }];
      if (j.party_id && opts.learn) {
        const keys = await this.store.keys(tenantId);
        const [p] = await tx<{ name: string }[]>`SELECT name FROM agent.parties WHERE tenant_id = ${tenantId} AND party_id = ${j.party_id}`;
        if (p) events.push(...(await this.learn(tx, tenantId, openText(keys, p.name, `agent.parties.name|${j.party_id}`), toAccount, principal, keys)));
      }
      if (j.principal === AGENT_PRINCIPAL) {
        const until = addDays(this.clock(), CORRECTION_LIMIT_DAYS);
        const reason = `agent entry ${journalId} corrected by ${principal}`;
        for (const key of [`account:${j.counter_account}`, ...(j.party_id ? [`party:${j.party_id}`] : [])]) {
          await tx`INSERT INTO agent.overrides VALUES (${tenantId}, ${key}, 'L1', ${until}, ${reason})
                   ON CONFLICT (tenant_id, key) DO UPDATE SET max_level = 'L1', until = EXCLUDED.until, reason = EXCLUDED.reason`;
          events.push({ type: "AutonomyLimited", data: { key, maxLevel: "L1", until, reason } });
        }
      }
      await tx`UPDATE agent.ratifications SET status = 'corrected', resolved_by = ${principal}, resolved_at = now()
               WHERE tenant_id = ${tenantId} AND journal_id = ${journalId} AND status = 'open'`;
      await this.store.append("agent", tenantId, { streamId: `${tenantId}/corrections/${journalId}`, expected: "no_stream", events }, { principal }, tx);
      return { requestId, newJournalId: journalIdForRequest(tenantId, requestId) };
    });
  }

  async addRule(tenantId: string, pattern: string, accountId: string, principal: string) {
    return this.store.tenantTx(tenantId, async (tx) => {
      const events = await this.learn(tx, tenantId, pattern, accountId, principal, await this.store.keys(tenantId));
      await this.store.append("agent", tenantId, { streamId: `${tenantId}/rules`, expected: "any", events }, { principal }, tx);
    });
  }

  // ------------------------------------------------------------------ queries
  async queue(tenantId: string) {
    const keys = await this.store.keys(tenantId);
    const rows = await this.store.tenantTx(tenantId, (tx) => tx<QueueRow[]>`
      SELECT draft_id, txn_id, book_id, status, proposal, decision, created_at, gl_rejection FROM agent.drafts
      WHERE tenant_id = ${tenantId} AND status IN ${tx(REVIEWABLE)} ORDER BY created_at, draft_id`);
    return rows.map((r): QueueRow => ({ ...r, proposal: openProposal(keys, r.draft_id, r.proposal),
      gl_rejection: r.gl_rejection ? openText(keys, r.gl_rejection, `agent.drafts.gl_rejection|${r.draft_id}`) : null }));
  }

  /** Approved drafts whose posting the GL has not answered yet (period close must wait for them). */
  async inFlight(tenantId: string, bookId: string) {
    return this.store.tenantTx(tenantId, (tx) => tx<{ draft_id: string; journal_id: string }[]>`
      SELECT draft_id, journal_id FROM agent.drafts WHERE tenant_id = ${tenantId} AND book_id = ${bookId} AND status = 'approved'
      ORDER BY draft_id`);
  }

  async openRatifications(tenantId: string) {
    const keys = await this.store.keys(tenantId);
    const rows = await this.store.tenantTx(tenantId, (tx) => tx<{ request_id: string; journal_id: string; txn_id: string; due_by: string; narration: string }[]>`
      SELECT request_id, journal_id, txn_id, due_by::text AS due_by, narration FROM agent.ratifications
      WHERE tenant_id = ${tenantId} AND status = 'open' ORDER BY due_by, request_id`);
    return rows.map((r) => ({ ...r, narration: openText(keys, r.narration, `agent.ratifications.narration|${r.request_id}`) }));
  }

  // ------------------------------------------------------------------ helpers
  private async learn(tx: TransactionSql, tenantId: string, pattern: string, accountId: string, principal: string, keys: TenantKeys): Promise<NewEvent[]> {
    const p = pattern.toLowerCase().trim();
    const idx = keys.index("rule", p);
    const [last] = await tx<{ account_id: string }[]>`
      SELECT account_id FROM agent.rules WHERE tenant_id = ${tenantId} AND pattern_idx = ${idx} ORDER BY rule_id DESC LIMIT 1`;
    if (last?.account_id === accountId) return [];
    await tx`INSERT INTO agent.rules (tenant_id, pattern, pattern_idx, account_id, created_by)
             VALUES (${tenantId}, ${keys.seal(p, `agent.rules.pattern|${idx}`)}, ${idx}, ${accountId}, ${principal})`;
    return [{ type: "RuleLearned", data: { pattern: p, accountId } }];
  }

  private async resolveParty(tx: TransactionSql, tenantId: string, key: string | null, keys: TenantKeys) {
    const alias = (key ?? "").trim().toLowerCase();
    if (!alias) return { partyId: null, partyName: null, isNew: false };
    // Keyed pseudonym: without the tenant's index key a party id cannot be linked to a name.
    const partyId = `p.${keys.index("party", alias)}`;
    const ins = await tx`INSERT INTO agent.parties (tenant_id, party_id, name) VALUES (${tenantId}, ${partyId}, ${keys.seal(alias, `agent.parties.name|${partyId}`)})
                         ON CONFLICT DO NOTHING RETURNING party_id`;
    return { partyId, partyName: alias, isNew: ins.length > 0 };
  }

  private async partyKnown(tx: TransactionSql, tenantId: string, partyId: string | null) {
    if (!partyId) return false;
    const [p] = await tx<{ confirmed: boolean }[]>`SELECT confirmed FROM agent.parties WHERE tenant_id = ${tenantId} AND party_id = ${partyId}`;
    if (p?.confirmed) return true;
    const [c] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM agent.journal_index WHERE tenant_id = ${tenantId} AND party_id = ${partyId} AND NOT reversed`;
    return (c?.n ?? 0) >= KNOWN_AFTER;
  }

  private async override(tx: TransactionSql, tenantId: string, accountId: string, partyId: string | null): Promise<Level | null> {
    const rows = await tx<{ max_level: Level }[]>`
      SELECT max_level FROM agent.overrides WHERE tenant_id = ${tenantId} AND until >= ${this.clock()}
        AND key IN ${tx([`account:${accountId}`, `party:${partyId ?? "-"}`, "*"])} ORDER BY max_level LIMIT 1`;
    return rows[0]?.max_level ?? null;
  }

  private async accountSet(tx: TransactionSql, tenantId: string, bookId: string) {
    const rows = await tx<{ account_id: string }[]>`SELECT account_id FROM agent.accounts WHERE tenant_id = ${tenantId} AND book_id = ${bookId}`;
    return new Set(rows.map((r) => r.account_id));
  }

  private async cashLike(tx: TransactionSql, tenantId: string, bookId: string) {
    const rows = await tx<{ account_id: string }[]>`SELECT account_id FROM agent.accounts WHERE tenant_id = ${tenantId} AND book_id = ${bookId} AND is_cash_like`;
    return new Set(rows.map((r) => r.account_id));
  }
}

interface Proposal { txnDate: string; narration: string; voucherType: string; lines: Line[]; provisional: boolean;
  accountId: string; confidence: number; partyName?: string | null; partyId?: string | null }

export function narrationKey(narr: string): string | null {
  const stop = new Set(["upi", "neft", "imps", "rtgs", "txn", "ref", "the", "and", "paid", "payment", "transfer", "cash",
    "spent", "received", "via", "from", "for", "bank", "card", "pos", "ach"]);
  const words = (narr.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !stop.has(w));
  return words.length ? words.slice(0, 2).join(" ") : null;
}

/** Exposed for the API layer. */
export type AgentDecision = Decision;

/* eslint-disable @typescript-eslint/no-explicit-any -- proposal and decision are JSON documents */
interface QueueRow { draft_id: string; txn_id: string; book_id: string; status: string; proposal: any; decision: any; created_at: Date; gl_rejection: string | null }

// ------------------------------------------------------------------ sealed columns
/** Open a sealed text column; values written before encryption pass through (the migration seals them). */
function openText(keys: TenantKeys, v: string, ctx: string): string {
  return isToken(v) ? keys.openText(v, ctx) : v;
}

function openProposal(keys: TenantKeys, draftId: string, v: unknown): Proposal {
  const c = (v as { $c?: unknown } | null)?.$c;
  return (isToken(c) ? keys.openJson(c, `agent.drafts.proposal|${draftId}`) : v) as Proposal;
}
