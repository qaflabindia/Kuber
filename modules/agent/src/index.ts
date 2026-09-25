/**
 * Agent module: turns extracted transactions into posting requests or drafts, under policy.
 *
 * Reacts to:  TransactionExtracted (channels), BookOpened / AccountAdded / JournalPosted /
 *             JournalReversed / PostingRejected (gl)
 * Emits:      PartyResolved, ProvisionalConfirmed, MatchReviewQueued, MatchReviewResolved, TransactionClassified, PolicyDecisionMade,
 *             PostingRequested, DraftQueued, DraftApproved, DraftRejected, RatificationRequested,
 *             Ratified, CorrectionRequested, RuleLearned, AutonomyLimited
 *
 * The agent never writes journals. It requests postings; the GL decides. A draft's lifecycle
 * follows the GL's answer: queued|awaiting_approval -> approved (posting requested) -> posted on
 * JournalPosted, or rejected_by_gl on PostingRejected, which puts it back in review with the reason.
 * Its own tables are updated in the same transaction as the events it appends.
 *
 * Authorization (F02, in depth): every command from a person (approve, reject, resolve a match,
 * ratify, correct, add a rule) checks its principal through the ModuleGuard (the identity module)
 * in its own transaction, whichever surface called it. A draft approval that is an action of an
 * ops plan is authorized by that plan's approval (PlanApproved by the same principal, same book,
 * same transaction), which the ops guard has already checked.
 */
import type { Sql, TransactionSql } from "postgres";
import {
  POLICY_CHECKER, addDays, draftLifecycle, journalIdForRequest, stableId, uuid,
  type CommandSignature, type Decision, type Envelope, type EventData, type Line, type RawTxn,
} from "@kuber/contracts";
import { DENY_ALL_GUARD, once, type EventStore, type MetaInput, type ModuleGuard, type NewEvent, type Projection } from "@kuber/eventstore";
import { isToken, type TenantKeys } from "@kuber/crypto";
import type { Level, PolicyEngine } from "@kuber/policy";
import { SUSPENSE, accountNameCtx, classify, type LlmClassifier } from "./classify.ts";
import { AgentError } from "./errors.ts";
import { SuspenseCases } from "./suspense.ts";

export { AGENT_MIGRATIONS } from "./migrations.ts";
export { LLM_MAX_CONFIDENCE, MERCHANTS, SUSPENSE, accountNameCtx } from "./classify.ts";
export type { ClassifierAccount, ClassifierInput, LlmClassifier, LlmSuggestion } from "./classify.ts";
export { AgentError } from "./errors.ts";
export { SuspenseCases, suspenseItemId, type RollForward, type SuspenseItem } from "./suspense.ts";

export const AGENT_PRINCIPAL = "agent:kuber";
const INGEST_EVENT = "EVT-TXN-INGESTED";
const DEDUPE_WINDOW_DAYS = 3;
const RATIFY_DAYS = 7;
const CORRECTION_LIMIT_DAYS = 30;
const KNOWN_AFTER = 3;
/** Draft states a person can act on: new, or returned by the GL with a reason. */
const REVIEWABLE = ["queued", "awaiting_approval", "rejected_by_gl"];
/** FIN-OPS-03: the reason recorded on decisions capped by the kill switch. */
const HALTED_REASON = "autonomy halted (kill switch): a person reviews this entry";

export class Agent {
  /** FIN-GL-05: suspense items as cases (source, owner, age, resolution). */
  readonly suspense: SuspenseCases;
  /**
   * Payment holds from the party master (FIN-MDM-03, POL-501): parties among `partyIds` with an
   * unreleased bank-detail change. A draft paying such a party cannot be approved. Set by the cell.
   */
  paymentHolds?: (tenantId: string, partyIds: string[], tx: TransactionSql) => Promise<{ partyId: string; changeId: string; status: string }[]>;

  constructor(private sql: Sql, private store: EventStore, private policies: PolicyEngine,
              private clock: () => string = () => new Date().toISOString().slice(0, 10),
              private llm?: LlmClassifier, private guard: ModuleGuard = DENY_ALL_GUARD) {
    this.suspense = new SuspenseCases(store, guard, () => this.clock(), (tx, t, p, b, planId) => this.mayDecide(tx, t, p, b, planId));
  }

  /**
   * May `principal` decide a draft or match review of `book`? A person needs draft.decide in that
   * book. `planId`: the decision is an action of that ops plan, which is authorized when this
   * principal's PlanApproved for the same book is in this transaction's view of the plan stream.
   */
  private async mayDecide(tx: TransactionSql, tenantId: string, principal: string, book: string, planId?: string) {
    if (planId) {
      const approved = (await this.store.readStream(tenantId, `${tenantId}/plan/${planId}`, 0, tx))
        .some((e) => e.type === "PlanApproved" && e.meta.principal === principal && (e.data as { bookId: string }).bookId === book);
      if (approved) return;
    }
    await this.guard.permit(tenantId, principal, "draft.decide", { book }, tx);
  }

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

  /**
   * The agent's read models of the ledger (accounts, journal index, party history), described for
   * `ops rebuild agent`. Only the GL-derived tables: drafts, rules, parties and ratifications are
   * the agent's own state, written with the events it emits, and TransactionExtracted is never
   * replayed (it has side effects). Confirmation of provisional journals comes from the agent's
   * own ProvisionalConfirmed events.
   */
  readonly projection: Projection = {
    name: "agent", consumer: "agent",
    tables: ["agent.accounts", "agent.journal_index", "agent.party_accounts"],
    replay: ["BookOpened", "AccountAdded", "JournalPosted", "JournalReversed", "ProvisionalConfirmed"],
    inboxTypes: ["BookOpened", "AccountAdded", "JournalPosted", "JournalReversed"],
    apply: async (tx, env) => {
      switch (env.type) {
        case "BookOpened": case "AccountAdded": return this.projectAccounts(tx, env);
        case "JournalPosted": return this.projectJournal(tx, env);
        case "JournalReversed": return this.projectReversal(tx, env);
        case "ProvisionalConfirmed":
          await tx`UPDATE agent.journal_index SET confirmed = true WHERE tenant_id = ${env.meta.tenantId}
                   AND journal_id = ${(env.data as EventData<"ProvisionalConfirmed">).journalId}`;
      }
    },
    fingerprint: async (tx, t) => ({
      accounts: await tx`SELECT book_id, account_id, nature, is_cash_like FROM agent.accounts WHERE tenant_id = ${t} ORDER BY 1, 2`,   // name is sealed
      journals: await tx`SELECT book_id, journal_id, principal, party_id, counter_account, instrument, amount, txn_date::text, provisional, confirmed, reversed
                         FROM agent.journal_index WHERE tenant_id = ${t} ORDER BY 2`,
      parties: await tx`SELECT book_id, party_id, account_id, n FROM agent.party_accounts WHERE tenant_id = ${t} ORDER BY 1, 2, 3`,
    }),
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
    await this.suspense.openFromJournal(tx, env, AGENT_PRINCIPAL);
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
    if (!r) {
      if (d.reason.startsWith("autonomy_halted:")) await this.haltedToReview(tx, env, d);
      return;
    }
    const keys = await this.store.keys(t);
    await tx`UPDATE agent.drafts SET status = 'rejected_by_gl', gl_rejection = ${keys.seal(d.reason, `agent.drafts.gl_rejection|${r.draft_id}`)}
             WHERE tenant_id = ${t} AND draft_id = ${r.draft_id}`;
  }

  /**
   * FIN-OPS-03: an autonomous posting the agent had queued was refused by the GL because the kill
   * switch was turned on before it executed. The entry becomes a draft for a person (same request
   * id, so approving it posts the journal it would have posted), and its ratification is withdrawn.
   */
  private async haltedToReview(tx: TransactionSql, env: Envelope, d: EventData<"PostingRejected">) {
    const t = env.meta.tenantId, stream = d.source;
    if (!stream?.startsWith(`${t}/txn/`)) return;
    const events = await this.store.readStream(t, stream, 0, tx);
    const req = events.find((e) => e.type === "PostingRequested" && (e.data as EventData<"PostingRequested">).requestId === d.requestId);
    const extracted = events.find((e) => e.type === "TransactionExtracted");
    const classified = [...events].reverse().find((e) => e.type === "TransactionClassified");
    const decided = [...events].reverse().find((e) => e.type === "PolicyDecisionMade");
    const party = [...events].reverse().find((e) => e.type === "PartyResolved");
    if (!req || !extracted || !classified) return;
    const p = req.data as EventData<"PostingRequested">, x = extracted.data as EventData<"TransactionExtracted">;
    const c = classified.data as EventData<"TransactionClassified">, pr = party?.data as EventData<"PartyResolved"> | undefined;
    const draftId = stableId("draft", `${t}/${x.txnId}`);
    const proposal = { txnDate: p.txnDate, narration: p.narration, voucherType: p.voucherType, lines: p.lines, provisional: p.provisional };
    const base = (decided?.data as EventData<"PolicyDecisionMade"> | undefined)?.decision;
    const decision: Decision = { policyIds: base?.policyIds ?? [], level: "L1", action: "draft", approver: base?.approver ?? "", reasons: [...(base?.reasons ?? []), HALTED_REASON] };
    const keys = await this.store.keys(t);
    const ins = await tx`INSERT INTO agent.drafts (tenant_id, draft_id, txn_id, book_id, status, proposal, decision)
      VALUES (${t}, ${draftId}, ${x.txnId}, ${p.bookId}, 'queued',
              ${tx.json({ $c: keys.sealJson({ ...proposal, accountId: c.accountId, confidence: c.confidence, classifiedBy: c.source, partyName: pr?.partyName ?? null,
                partyId: pr?.partyId ?? null, amount: x.txn.amount, direction: x.txn.direction }, `agent.drafts.proposal|${draftId}`) } as never)},
              ${tx.json(decision as never)}) ON CONFLICT DO NOTHING RETURNING 1`;
    if (!ins.length) return;
    await tx`UPDATE agent.ratifications SET status = 'withdrawn', resolved_by = ${AGENT_PRINCIPAL}, resolved_at = now()
             WHERE tenant_id = ${t} AND request_id = ${d.requestId} AND status = 'open'`;
    await this.store.append("agent", t, { streamId: stream, expected: "any", events: [{ type: "DraftQueued", data: { txnId: x.txnId, draftId, bookId: p.bookId,
      status: "queued", proposal, accountId: c.accountId, confidence: c.confidence, ...(pr?.partyName ? { partyName: pr.partyName } : {}),
      amount: x.txn.amount, direction: x.txn.direction } }] }, { principal: AGENT_PRINCIPAL, correlationId: env.meta.correlationId, causationId: env.eventId }, tx);
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

  private async onExtracted(tx: TransactionSql, env: Envelope, opts: { skipMatch?: boolean } = {}) {
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
    if (partyId && !opts.skipMatch) events.push({ type: "PartyResolved", data: { txnId: d.txnId, partyId, partyName: partyName!, isNew } });

    // 2. an authoritative line may confirm an earlier provisional entry instead of posting again,
    //    but only on real evidence (see matchProvisional); anything ambiguous waits for a person
    if (d.trust === "authoritative" && !opts.skipMatch) {
      const m = await this.matchProvisional(tx, t, d.bookId, txn, keys);
      if (m.kind === "confirm") {
        await tx`UPDATE agent.journal_index SET confirmed = true WHERE tenant_id = ${t} AND journal_id = ${m.journalId}`;
        events.push({ type: "ProvisionalConfirmed", data: { txnId: d.txnId, journalId: m.journalId, bookId: d.bookId, basis: m.basis } });
        await this.store.append("agent", t, { streamId: stream, expected: "any", events }, baseMeta, tx);
        return;
      }
      if (m.kind === "review") {
        const reviewId = stableId("match-review", `${t}/${d.txnId}`);
        await tx`INSERT INTO agent.match_reviews (tenant_id, review_id, txn_id, book_id, status, candidates, detail)
                 VALUES (${t}, ${reviewId}, ${d.txnId}, ${d.bookId}, 'open', ${tx.json(m.candidates as never)},
                         ${keys.sealJson({ txnDate: txn.txnDate, narration: txn.narration, amount: txn.amount, direction: txn.direction,
                           instrument: txn.instrument, reference: txn.reference ?? null, reason: m.reason }, matchReviewCtx(reviewId))})
                 ON CONFLICT DO NOTHING`;
        events.push({ type: "MatchReviewQueued", data: { txnId: d.txnId, reviewId, bookId: d.bookId, candidates: m.candidates, reason: m.reason } });
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
    if (provisional) await this.rememberProvisional(tx, t, d.txnId, journalIdForRequest(t, requestId), txn, keys);

    // 4. a person typed it: their statement is the approval
    if (d.trust === "user") {
      events.push({ type: "PostingRequested", data: { requestId, bookId: d.bookId, ...proposal, autonomy: "human", confidence: c.confidence, sourceStream: stream } });
      await this.store.append("agent", t, { streamId: stream, expected: "any", events }, { ...baseMeta, principal: env.meta.principal }, tx);
      return;
    }

    // 5. policy decides what the agent may do
    let decision = this.policies.decide({
      eventCode: INGEST_EVENT, on: this.clock(), amountPaise: BigInt(txn.amount), confidence: c.confidence,
      counterpartyKnown: await this.partyKnown(tx, t, partyId), overrideMax: await this.override(tx, t, c.accountId, partyId),
    });
    // FIN-OPS-03: with the kill switch on, nothing posts autonomously; a person reviews the draft.
    if ((decision.action === "post" || decision.action === "post_then_ratify") && (await this.guard.autonomyHalted?.(t, d.bookId, tx))) {
      decision = { ...decision, level: "L1", action: "draft", reasons: [...decision.reasons, HALTED_REASON] };
    }
    events.push({ type: "PolicyDecisionMade", data: { txnId: d.txnId, decision: decision as Decision } });
    const meta = { ...baseMeta, policyIds: decision.policyIds };

    if ((decision.action === "post" || decision.action === "post_then_ratify") && c.accountId !== SUSPENSE) {
      // Role model v2: the maker is this agent; the checker is the deterministic policy engine that cleared it (L3/L4), never a language model.
      events.push({ type: "PostingRequested", data: { requestId, bookId: d.bookId, ...proposal, autonomy: decision.level, confidence: c.confidence, sourceStream: stream,
        checker: POLICY_CHECKER } });
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
  /**
   * `opts.attest` (signed commands, design 16.4): verifies the person's signature over this approval
   * inside the transaction, just before the approval is recorded, and returns it for DraftApproved.
   */
  async approveDraft(tenantId: string, draftId: string, principal: string, accountId?: string, commandId?: string, inTx?: TransactionSql,
                     opts: { attest?: (tx: TransactionSql) => Promise<CommandSignature> } = {}) {
    const run = async (tx: TransactionSql) => {
      const keys = await this.store.keys(tenantId);
      const [row] = await tx<{ txn_id: string; book_id: string; status: string; proposal: unknown }[]>`
        SELECT txn_id, book_id, status, proposal FROM agent.drafts WHERE tenant_id = ${tenantId} AND draft_id = ${draftId} FOR UPDATE`;
      if (!row) throw new AgentError("not_found", `no draft ${draftId}`);
      await this.mayDecide(tx, tenantId, principal, row.book_id, commandId);
      const d = { ...row, proposal: openProposal(keys, draftId, row.proposal) };
      if (!REVIEWABLE.includes(d.status)) throw new AgentError("not_open", `draft ${draftId} is ${d.status}`);
      const final = accountId ?? d.proposal.accountId;
      const accounts = await this.accountSet(tx, tenantId, d.book_id);
      if (!accounts.has(final)) throw new AgentError("no_account", `unknown account ${final}`);
      const lines = d.proposal.lines.map((l) => (l.accountId === d.proposal.accountId ? { ...l, accountId: final } : l));
      if (d.proposal.direction === "out" && this.paymentHolds) {
        const held = await this.paymentHolds(tenantId, lines.map((l) => l.partyId).filter((p): p is string => !!p), tx);
        if (held.length) throw new AgentError("party_hold", `payments to ${held.map((h) => h.partyId).join(", ")} are held: bank details changed and not yet verified and released (POL-501)`);
      }
      // Same request id on a retry after a GL rejection: the journal id stays deterministic.
      const requestId = `req-${d.txn_id}`, journalId = journalIdForRequest(tenantId, requestId);
      const signature = opts.attest ? await opts.attest(tx) : undefined;
      const events: NewEvent[] = [
        { type: "DraftApproved", data: { draftId, accountId: final, ...(signature ? { signature } : {}) } },
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

  /** One draft, decrypted (signed commands render what an approval would post from it). */
  async draft(tenantId: string, draftId: string): Promise<{ draftId: string; bookId: string; status: string; proposal: Proposal } | null> {
    const [row] = await this.store.tenantTx(tenantId, (tx) => tx<{ book_id: string; status: string; proposal: unknown }[]>`
      SELECT book_id, status, proposal FROM agent.drafts WHERE tenant_id = ${tenantId} AND draft_id = ${draftId}`);
    if (!row) return null;
    return { draftId, bookId: row.book_id, status: row.status, proposal: openProposal(await this.store.keys(tenantId), draftId, row.proposal) };
  }

  /** The book of a posted journal, from the journal index (null until it is projected). */
  async journalBook(tenantId: string, journalId: string): Promise<string | null> {
    const [r] = await this.store.tenantTx(tenantId, (tx) => tx<{ book_id: string }[]>`
      SELECT book_id FROM agent.journal_index WHERE tenant_id = ${tenantId} AND journal_id = ${journalId}`);
    return r?.book_id ?? null;
  }

  async rejectDraft(tenantId: string, draftId: string, principal: string, reason: string) {
    return this.store.tenantTx(tenantId, async (tx) => {
      const [b] = await tx<{ book_id: string }[]>`SELECT book_id FROM agent.drafts WHERE tenant_id = ${tenantId} AND draft_id = ${draftId}`;
      if (!b) throw new AgentError("not_open", `draft ${draftId} is not open`);
      await this.mayDecide(tx, tenantId, principal, b.book_id);
      const [d] = await tx<{ txn_id: string }[]>`
        UPDATE agent.drafts SET status = 'rejected', resolved_by = ${principal}, resolved_at = now()
        WHERE tenant_id = ${tenantId} AND draft_id = ${draftId} AND status IN ${tx(REVIEWABLE)} RETURNING txn_id`;
      if (!d) throw new AgentError("not_open", `draft ${draftId} is not open`);
      await this.store.append("agent", tenantId, { streamId: `${tenantId}/txn/${d.txn_id}`, expected: "any",
        events: [{ type: "DraftRejected", data: { draftId, reason } }] }, { principal }, tx);
    });
  }

  /** Statement lines waiting for a person to say whether they are a provisional entry already in the books (every page). */
  async openMatchReviews(tenantId: string, opts: { bookIds?: string[] } = {}) {
    const out: MatchReviewRow[] = [];
    let after: string | undefined;
    for (;;) {
      const p = await this.matchReviewsPage(tenantId, { ...opts, limit: MAX_PAGE, after });
      out.push(...p.items);
      if (!p.next) return out;
      after = p.next;
    }
  }

  /**
   * Open match reviews in queue order (created_at, review_id), one keyset page after `after`, like
   * `queuePage`. `bookIds` narrows to those books in the index (a book-scoped member's books).
   */
  async matchReviewsPage(tenantId: string, opts: { bookIds?: string[]; limit?: number; after?: string } = {}): Promise<{ items: MatchReviewRow[]; next: string | null }> {
    const limit = pageSize(opts.limit);
    const cur = decodeCursor(opts.after);
    if (opts.bookIds && !opts.bookIds.length) return { items: [], next: null };
    const keys = await this.store.keys(tenantId);
    const rows = await this.store.tenantTx(tenantId, (tx) => tx<(Omit<MatchReviewRow, "detail"> & { detail: string; cur_ts: string })[]>`
      SELECT review_id, txn_id, book_id, candidates, detail, created_at, created_at::text AS cur_ts FROM agent.match_reviews
      WHERE tenant_id = ${tenantId} AND status = 'open'
        ${opts.bookIds ? tx`AND book_id IN ${tx(opts.bookIds)}` : tx``}
        ${cur ? tx`AND (created_at, review_id) > (${cur[0]}::text::timestamptz, ${cur[1]})` : tx``}
      ORDER BY created_at, review_id LIMIT ${limit + 1}`);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ cur_ts: _c, ...r }) => ({ ...r, detail: keys.openJson<MatchReviewDetail>(r.detail, matchReviewCtx(r.review_id)) })),
      next: more && last ? encodeCursor([last.cur_ts, last.review_id]) : null,
    };
  }

  /**
   * Resolve a match review. `journalId`: the statement line is that provisional entry (it is confirmed,
   * which the GL records). null: it is a different transaction and is classified and posted or drafted as new.
   */
  async resolveMatch(tenantId: string, reviewId: string, principal: string, journalId: string | null) {
    return this.store.tenantTx(tenantId, async (tx) => {
      const keys = await this.store.keys(tenantId);
      const [r] = await tx<{ txn_id: string; book_id: string; detail: string }[]>`
        SELECT txn_id, book_id, detail FROM agent.match_reviews WHERE tenant_id = ${tenantId} AND review_id = ${reviewId} AND status = 'open' FOR UPDATE`;
      if (!r) throw new AgentError("not_open", `no open match review ${reviewId}`);
      await this.mayDecide(tx, tenantId, principal, r.book_id);
      const det = keys.openJson<MatchReviewDetail>(r.detail, matchReviewCtx(reviewId));
      const stream = `${tenantId}/txn/${r.txn_id}`;
      if (journalId) {
        const signed = BigInt(det.amount) * (det.direction === "in" ? 1n : -1n);
        const [j] = await tx<{ journal_id: string }[]>`
          SELECT journal_id FROM agent.journal_index WHERE tenant_id = ${tenantId} AND journal_id = ${journalId} AND book_id = ${r.book_id}
            AND provisional AND NOT confirmed AND NOT reversed AND instrument = ${det.instrument} AND amount = ${signed.toString()} FOR UPDATE`;
        if (!j) throw new AgentError("not_matchable", `${journalId} is not an open provisional entry of the same account and amount`);
        await tx`UPDATE agent.journal_index SET confirmed = true WHERE tenant_id = ${tenantId} AND journal_id = ${journalId}`;
        await tx`UPDATE agent.match_reviews SET status = 'linked', journal_id = ${journalId}, resolved_by = ${principal}, resolved_at = now()
                 WHERE tenant_id = ${tenantId} AND review_id = ${reviewId}`;
        await this.store.append("agent", tenantId, { streamId: stream, expected: "any", events: [
          { type: "MatchReviewResolved", data: { reviewId, txnId: r.txn_id, journalId } },
          { type: "ProvisionalConfirmed", data: { txnId: r.txn_id, journalId, bookId: r.book_id, basis: "user" } },
        ] }, { principal }, tx);
        return { status: "linked" as const, journalId };
      }
      await tx`UPDATE agent.match_reviews SET status = 'separate', resolved_by = ${principal}, resolved_at = now()
               WHERE tenant_id = ${tenantId} AND review_id = ${reviewId}`;
      const [resolved] = await this.store.append("agent", tenantId, { streamId: stream, expected: "any",
        events: [{ type: "MatchReviewResolved", data: { reviewId, txnId: r.txn_id, journalId: null } }] }, { principal }, tx);
      const extracted = (await this.store.readStream(tenantId, stream, 0, tx)).find((e) => e.type === "TransactionExtracted");
      if (!extracted) throw new AgentError("not_found", `no extracted transaction for ${r.txn_id}`);
      await this.onExtracted(tx, { ...extracted, meta: { ...extracted.meta, correlationId: resolved!.meta.correlationId } }, { skipMatch: true });
      return { status: "separate" as const, journalId: null };
    });
  }

  /**
   * Existing databases: confirmations recorded only in agent.journal_index before confirmation was
   * propagated. Emits ProvisionalConfirmed (with the book) once per such journal so the GL records it.
   */
  async backfillConfirmations(tenantId: string, principal = AGENT_PRINCIPAL) {
    return this.store.tenantTx(tenantId, async (tx) => {
      const rows = await tx<{ journal_id: string; book_id: string }[]>`
        SELECT journal_id, book_id FROM agent.journal_index WHERE tenant_id = ${tenantId} AND provisional AND confirmed AND NOT reversed`;
      const done = await this.store.existingStreams(tenantId, rows.map((r) => `${tenantId}/confirmations/${r.journal_id}`));
      let n = 0;
      for (const r of rows) {
        const streamId = `${tenantId}/confirmations/${r.journal_id}`;
        if (done.has(streamId)) continue;
        await this.store.append("agent", tenantId, { streamId, expected: "no_stream",
          events: [{ type: "ProvisionalConfirmed", data: { txnId: "backfill", journalId: r.journal_id, bookId: r.book_id } }] }, { principal }, tx);
        n++;
      }
      return { emitted: n };
    });
  }

  /** `opts.attest`: as for approveDraft, the person's signature over this ratification (above the approval limit). */
  async ratify(tenantId: string, journalId: string, principal: string, opts: { attest?: (tx: TransactionSql) => Promise<CommandSignature> } = {}) {
    return this.store.tenantTx(tenantId, async (tx) => {
      await this.guard.permit(tenantId, principal, "journal.ratify", { allBooks: true }, tx);
      const [r] = await tx<{ txn_id: string }[]>`
        UPDATE agent.ratifications SET status = 'ratified', resolved_by = ${principal}, resolved_at = now()
        WHERE tenant_id = ${tenantId} AND journal_id = ${journalId} AND status = 'open' RETURNING txn_id`;
      if (!r) throw new AgentError("not_open", `no open ratification for ${journalId}`);
      const signature = opts.attest ? await opts.attest(tx) : undefined;
      await this.store.append("agent", tenantId, { streamId: `${tenantId}/txn/${r.txn_id}`, expected: "any",
        events: [{ type: "Ratified", data: { journalId, ...(signature ? { signature } : {}) } }] }, { principal }, tx);
    });
  }

  /**
   * Reclassify a posted journal: GL reverses and reposts; if the agent made the entry it limits itself
   * for that account and counterparty. A one-off correction (a client lunch on a food app) must not
   * rewrite the counterparty's rule, so learning is opt-in: pass `learn: true` for "always use this account".
   */
  async correct(tenantId: string, journalId: string, toAccount: string, principal: string, opts: { learn?: boolean } = {}) {
    return this.store.tenantTx(tenantId, async (tx) => {
      await this.guard.permit(tenantId, principal, "journal.ratify", { allBooks: true }, tx);
      const [j] = await tx<{ book_id: string; principal: string; party_id: string | null; counter_account: string | null; reversed: boolean }[]>`
        SELECT book_id, principal, party_id, counter_account, reversed FROM agent.journal_index WHERE tenant_id = ${tenantId} AND journal_id = ${journalId}`;
      if (!j) throw new AgentError("not_found", `no journal ${journalId} (it may not be projected yet)`);
      if (j.reversed) throw new AgentError("already_reversed", `${journalId} is already reversed`);
      if (!j.counter_account) throw new AgentError("no_counter", `${journalId} has no classifiable line`);
      if (j.counter_account === SUSPENSE) throw new AgentError("suspense_item", `${journalId} holds a suspense item: resolve the item (resolve_suspense) instead of correcting the journal`);
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
      await this.guard.permit(tenantId, principal, "rules.manage", { allBooks: true }, tx);
      const events = await this.learn(tx, tenantId, pattern, accountId, principal, await this.store.keys(tenantId));
      await this.store.append("agent", tenantId, { streamId: `${tenantId}/rules`, expected: "any", events }, { principal }, tx);
    });
  }

  // ------------------------------------------------------------------ queries
  /**
   * Open drafts in queue order (created_at, draft_id). With `limit` one keyset page (at most
   * MAX_PAGE rows) after the `after` cursor; without it every open draft, read page by page.
   * `bookId` narrows to one book in the index rather than after decryption.
   */
  async queue(tenantId: string, opts: QueueOptions = {}): Promise<QueueRow[]> {
    if (opts.limit !== undefined) return (await this.queuePage(tenantId, opts)).items;
    const out: QueueRow[] = [];
    let after = opts.after;
    for (;;) {
      const p = await this.queuePage(tenantId, { ...opts, limit: MAX_PAGE, after });
      out.push(...p.items);
      if (!p.next) return out;
      after = p.next;
    }
  }

  /**
   * Every draft of a book with its journal lifecycle state (FIN-GL-01): queued = draft,
   * awaiting_approval = submitted, approved = posting, posted, rejected_by_gl / rejected = failed.
   */
  async lifecycle(tenantId: string, bookId: string) {
    const keys = await this.store.keys(tenantId);
    const rows = await this.store.tenantTx(tenantId, (tx) => tx<{ draft_id: string; status: string; proposal: unknown; journal_id: string | null;
      gl_rejection: string | null; created_at: Date; resolved_by: string | null }[]>`
      SELECT draft_id, status, proposal, journal_id, gl_rejection, created_at, resolved_by FROM agent.drafts
      WHERE tenant_id = ${tenantId} AND book_id = ${bookId} ORDER BY created_at, draft_id`);
    return rows.map((r) => {
      const p = openProposal(keys, r.draft_id, r.proposal);
      return { id: r.draft_id, source: "draft" as const, storedStatus: r.status, state: draftLifecycle(r.status), txnDate: p.txnDate, narration: p.narration,
        journalId: r.journal_id, reason: r.gl_rejection ? openText(keys, r.gl_rejection, `agent.drafts.gl_rejection|${r.draft_id}`) : r.status === "rejected" ? "rejected by a reviewer" : null,
        at: r.created_at, by: r.resolved_by };
    });
  }

  /** Approved drafts whose posting the GL has not answered yet (period close must wait for them). */
  async inFlight(tenantId: string, bookId: string) {
    return this.store.tenantTx(tenantId, (tx) => tx<{ draft_id: string; journal_id: string }[]>`
      SELECT draft_id, journal_id FROM agent.drafts WHERE tenant_id = ${tenantId} AND book_id = ${bookId} AND status = 'approved'
      ORDER BY draft_id`);
  }

  async queuePage(tenantId: string, opts: QueueOptions = {}): Promise<{ items: QueueRow[]; next: string | null }> {
    const limit = pageSize(opts.limit);
    const cur = decodeCursor(opts.after);
    const keys = await this.store.keys(tenantId);
    const rows = await this.store.tenantTx(tenantId, (tx) => tx<(QueueRow & { cur_ts: string })[]>`
      SELECT draft_id, txn_id, book_id, status, proposal, decision, created_at, gl_rejection, created_at::text AS cur_ts FROM agent.drafts
      WHERE tenant_id = ${tenantId} AND status IN ('queued','awaiting_approval','rejected_by_gl')   -- REVIEWABLE, literal so the partial index applies
        ${opts.bookId !== undefined ? tx`AND book_id = ${opts.bookId}` : tx``}
        -- cursor values are bound as text: a timestamptz-typed parameter is rounded to milliseconds by the driver
        ${cur ? tx`AND (created_at, draft_id) > (${cur[0]}::text::timestamptz, ${cur[1]})` : tx``}
      ORDER BY created_at, draft_id LIMIT ${limit + 1}`);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ cur_ts: _c, ...r }): QueueRow => ({ ...r, proposal: openProposal(keys, r.draft_id, r.proposal),
        gl_rejection: r.gl_rejection ? openText(keys, r.gl_rejection, `agent.drafts.gl_rejection|${r.draft_id}`) : null })),
      next: more && last ? encodeCursor([last.cur_ts, last.draft_id]) : null,
    };
  }

  /** Counts of drafts in review (for badges): an index count, nothing decrypted. */
  async queueCounts(tenantId: string, bookId?: string): Promise<{ open: number; awaitingApproval: number }> {
    const [r] = await this.store.tenantTx(tenantId, (tx) => tx<{ open: number; awaiting: number }[]>`
      SELECT count(*)::int AS open, count(*) FILTER (WHERE status = 'awaiting_approval')::int AS awaiting FROM agent.drafts
      WHERE tenant_id = ${tenantId} AND status IN ('queued','awaiting_approval','rejected_by_gl') ${bookId !== undefined ? tx`AND book_id = ${bookId}` : tx``}`);
    return { open: r?.open ?? 0, awaitingApproval: r?.awaiting ?? 0 };
  }

  /** Open ratifications by due date; paged like `queue`. */
  async openRatifications(tenantId: string, opts: { limit?: number; after?: string } = {}) {
    if (opts.limit !== undefined) return (await this.ratificationsPage(tenantId, opts)).items;
    const out: Awaited<ReturnType<Agent["ratificationsPage"]>>["items"] = [];
    let after = opts.after;
    for (;;) {
      const p = await this.ratificationsPage(tenantId, { limit: MAX_PAGE, after });
      out.push(...p.items);
      if (!p.next) return out;
      after = p.next;
    }
  }

  async ratificationsPage(tenantId: string, opts: { limit?: number; after?: string } = {}) {
    const limit = pageSize(opts.limit);
    const cur = decodeCursor(opts.after);
    const keys = await this.store.keys(tenantId);
    const rows = await this.store.tenantTx(tenantId, (tx) => tx<{ request_id: string; journal_id: string; txn_id: string; due_by: string; narration: string }[]>`
      SELECT request_id, journal_id, txn_id, due_by::text AS due_by, narration FROM agent.ratifications
      WHERE tenant_id = ${tenantId} AND status = 'open'
        ${cur ? tx`AND (due_by, request_id) > (${cur[0]}::text::date, ${cur[1]})` : tx``}
      ORDER BY due_by, request_id LIMIT ${limit + 1}`);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({ ...r, narration: openText(keys, r.narration, `agent.ratifications.narration|${r.request_id}`) })),
      next: more && last ? encodeCursor([last.due_by, last.request_id]) : null,
    };
  }

  async openRatificationCount(tenantId: string): Promise<number> {
    const [r] = await this.store.tenantTx(tenantId, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agent.ratifications WHERE tenant_id = ${tenantId} AND status = 'open'`);
    return r?.n ?? 0;
  }

  // ------------------------------------------------------------------ provisional matching
  /** Keep what the person said about a provisional entry (sealed), so a statement line can be matched on it later. */
  private async rememberProvisional(tx: TransactionSql, tenantId: string, txnId: string, journalId: string, txn: RawTxn, keys: TenantKeys) {
    await tx`INSERT INTO agent.provisional_sources (tenant_id, txn_id, journal_id, detail)
             VALUES (${tenantId}, ${txnId}, ${journalId}, ${keys.sealJson({ hint: txn.counterpartyHint ?? null, narration: txn.narration,
               reference: txn.reference ?? null }, provisionalSourceCtx(txnId))}) ON CONFLICT DO NOTHING`;
  }

  /**
   * Does this authoritative line confirm an open provisional entry?
   *
   * Candidates: same book and instrument, same signed amount (so same direction), dated within
   * DEDUPE_WINDOW_DAYS. Each candidate is then compared on evidence:
   *   reference     a reference of the line (cheque/UTR) appears in what the person recorded
   *   counterparty  the counterparty the person named shares a significant word with the line
   *   different     both sides name a counterparty and they share nothing
   *   unknown       the entry names no counterparty (or it predates this record): cannot be told
   * Exactly one reference match, else exactly one counterparty match, confirms. Several matches,
   * or only unknown candidates, go to a person as a match review. Only "different" candidates:
   * the line is a new transaction. Amount and date alone never confirm.
   */
  private async matchProvisional(tx: TransactionSql, tenantId: string, bookId: string, txn: RawTxn, keys: TenantKeys): Promise<MatchOutcome> {
    const signed = BigInt(txn.amount) * (txn.direction === "in" ? 1n : -1n);
    const lo = addDays(txn.txnDate, -DEDUPE_WINDOW_DAYS), hi = addDays(txn.txnDate, DEDUPE_WINDOW_DAYS);
    const cands = await tx<{ journal_id: string; txn_id: string | null; detail: string | null }[]>`
      SELECT j.journal_id, s.txn_id, s.detail FROM agent.journal_index j
      LEFT JOIN agent.provisional_sources s ON s.tenant_id = j.tenant_id AND s.journal_id = j.journal_id
      WHERE j.tenant_id = ${tenantId} AND j.book_id = ${bookId} AND j.provisional AND NOT j.confirmed AND NOT j.reversed
        AND j.instrument = ${txn.instrument} AND j.amount = ${signed.toString()} AND j.txn_date BETWEEN ${lo} AND ${hi}
      ORDER BY abs(j.txn_date - ${txn.txnDate}::date), j.journal_id FOR UPDATE OF j`;
    if (!cands.length) return { kind: "none" };
    const lineWords = matchWords(txn.narration, txn.counterpartyHint);
    const lineRefs = refsOf(txn.reference, txn.narration);
    const judged = cands.map((c) => {
      const src = c.detail && c.txn_id ? keys.openJson<{ hint: string | null; narration: string; reference: string | null }>(c.detail, provisionalSourceCtx(c.txn_id)) : null;
      if (src && [...refsOf(src.reference ?? undefined, src.narration)].some((r) => lineRefs.has(r))) return { id: c.journal_id, v: "reference" as const };
      const theirs = src?.hint ? matchWords(src.hint) : new Set<string>();
      if (!theirs.size || !lineWords.size) return { id: c.journal_id, v: "unknown" as const };
      return { id: c.journal_id, v: wordsOverlap(theirs, lineWords) ? "counterparty" as const : "different" as const };
    });
    for (const basis of ["reference", "counterparty"] as const) {
      const hits = judged.filter((j) => j.v === basis);
      if (hits.length === 1) return { kind: "confirm", journalId: hits[0]!.id, basis };
      if (hits.length > 1) return { kind: "review", candidates: hits.map((h) => h.id), reason: `${hits.length} provisional entries match on ${basis}` };
    }
    const unknown = judged.filter((j) => j.v === "unknown");
    if (unknown.length) return { kind: "review", candidates: unknown.map((u) => u.id), reason: "same amount and date as a provisional entry whose counterparty cannot be compared" };
    return { kind: "none" };
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
  accountId: string; confidence: number; partyName?: string | null; partyId?: string | null; direction?: "in" | "out" }

export function narrationKey(narr: string): string | null {
  const stop = new Set(["upi", "neft", "imps", "rtgs", "txn", "ref", "the", "and", "paid", "payment", "transfer", "cash",
    "spent", "received", "via", "from", "for", "bank", "card", "pos", "ach"]);
  const words = (narr.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !stop.has(w));
  return words.length ? words.slice(0, 2).join(" ") : null;
}

/** Largest page any queue query returns. */
export const MAX_PAGE = 500;
export interface QueueOptions { bookId?: string; limit?: number; after?: string }
const pageSize = (n?: number) => Math.min(Math.max(Math.trunc(n ?? MAX_PAGE) || 1, 1), MAX_PAGE);
/** Opaque keyset cursor: the sort key of the last row returned. */
const encodeCursor = (k: [string, string]) => Buffer.from(JSON.stringify(k)).toString("base64url");
function decodeCursor(c?: string): [string, string] | null {
  if (!c) return null;
  try {
    const k = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Array.isArray(k) && k.length === 2 && k.every((x) => typeof x === "string")) return k as [string, string];
  } catch { /* fall through */ }
  throw new AgentError("bad_cursor", "invalid page cursor");
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

// ------------------------------------------------------------------ matching helpers
type MatchOutcome = { kind: "none" } | { kind: "confirm"; journalId: string; basis: "reference" | "counterparty" }
  | { kind: "review"; candidates: string[]; reason: string };
interface MatchReviewDetail { txnDate: string; narration: string; amount: string; direction: "in" | "out"; instrument: string; reference: string | null; reason: string }
export interface MatchReviewRow { review_id: string; txn_id: string; book_id: string; candidates: string[]; detail: MatchReviewDetail; created_at: Date }

export const matchReviewCtx = (reviewId: string) => `agent.match_reviews.detail|${reviewId}`;
export const provisionalSourceCtx = (txnId: string) => `agent.provisional_sources.detail|${txnId}`;

/** Words that say nothing about who the counterparty is: rails, banks, verbs, units, document words. */
const MATCH_STOP = new Set(["upi", "neft", "imps", "rtgs", "ach", "nach", "ecs", "txn", "ref", "reference", "the", "and", "paid", "payment",
  "transfer", "transferred", "cash", "spent", "received", "sent", "gave", "got", "credited", "debited", "collected", "earned", "bought",
  "via", "from", "for", "bank", "card", "pos", "atm", "p2m", "p2a", "lakh", "lakhs", "crore", "crores", "rupees", "inr", "using", "through",
  "with", "yesterday", "today", "gpay", "phonepe", "paytm", "netbanking", "hdfc", "icici", "sbi", "axis", "kotak", "invoice", "inv", "bill",
  "receipt", "order", "ltd", "pvt", "private", "limited", "llp", "inc", "mr", "mrs", "ms", "shri", "smt", "chq", "cheque", "online", "fund", "funds"]);

function matchWords(...texts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of (t ?? "").toLowerCase().replace(/@[a-z0-9.\-]+/g, " ").split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && !/^\d+$/.test(w) && !MATCH_STOP.has(w)) out.add(w);
    }
  }
  return out;
}

/** A shared word, or one word the start of the other (at least 4 letters: "acme" / "acmecorp"). */
function wordsOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) for (const y of b) {
    if (x === y) return true;
    const [s, l] = x.length <= y.length ? [x, y] : [y, x];
    if (s.length >= 4 && l.startsWith(s)) return true;
  }
  return false;
}

/** References worth matching: the reference column and long digit runs (UTR, cheque numbers). */
function refsOf(reference: string | undefined, narration: string): Set<string> {
  const out = new Set<string>();
  const r = (reference ?? "").trim().toLowerCase();
  if (r.length >= 6 && !/^0+$/.test(r)) out.add(r);
  for (const m of narration.toLowerCase().match(/\b[a-z]*\d{6,}\b/g) ?? []) if (!/^0+$/.test(m)) out.add(m);
  return out;
}
