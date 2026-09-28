/**
 * Dream-RSI (design 7.2-7.3): offline policy improvement over recorded, sealed history.
 * Core engine determinism, bounds and promotion gates on synthetic pools; the autonomy and routing
 * families' hard constraints; and, in a test cell, extraction (opt-in, no personal text), a dream
 * run, a proposal, and an approval that changes what the agent decides.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuid, type EventData } from "@kuber/contracts";
import { LLM_MAX_CONFIDENCE } from "@kuber/agent";
import { PolicyEngine, TUNING_MIN_CONFIDENCE, type AutonomyTuning } from "@kuber/policy";
import {
  DEFAULT_ROUTING_PARAMS, DreamEngine, EXCLUDED_CLASSES, FixtureTurnAdapter, JsonCandidateProposer, MutationProposer, OptInRequired, ReplayPool,
  autonomyAction, autonomyParamsSchema, extractAutonomyPool, finalizeReport, hashOf, makeAutonomyFamily, makeRoutingFamily, reportHashOf,
  RoutingParamsSchema, SeededRng, sha256Hex, type AutonomyAction, type AutonomyDecision, type AutonomyFeatures, type AutonomyParams, type CandidateProposer,
  type DreamResult, type RoutingParams, type RoutingTurn, type Truth,
} from "@kuber/dream-rsi";
import type { Cell } from "@kuber/core";
import { POLICY_DIR, enrol, startCell } from "./helpers.ts";

const policies = PolicyEngine.fromDir(POLICY_DIR);
const ON = "2026-11-05";
const untuned = policies.untunedEquivalent("EVT-TXN-INGESTED", ON);
const bounds = { maxCeilingPaise: untuned.amountCeilingPaise };
const schema = autonomyParamsSchema(bounds);

let k = 0;
function item(f: Partial<AutonomyFeatures> = {}, truth: Truth = "approved_unchanged", action: AutonomyAction = "person"): AutonomyDecision {
  k++;
  return { id: sha256Hex(`item-${k}`).slice(0, 32), seq: k, action, outcome: { truth },
    features: { eventCode: "EVT-TXN-INGESTED", on: ON, actionType: "receipt", entitySegment: "freelancer", klass: "bookkeeping", confidence: 0.98,
      classifier: "history", amountPaise: 1_000_000, hasParty: true, partyPriorPostings: 5, partyConfirmed: true, amountZ: null, overrideMax: null,
      halted: false, relax: { consecutiveAccepted: 0, resolved: 0, accepted: 0 }, ...f } };
}
const many = (n: number, f: Partial<AutonomyFeatures>, truth: Truth = "approved_unchanged") => Array.from({ length: n }, () => item(f, truth));
const autonomyPool = (items: AutonomyDecision[]) => new ReplayPool("test.autonomy", items);
const dreamAutonomy = (items: AutonomyDecision[], o: { seed?: number; iterations?: number; cap?: number; incumbent?: AutonomyParams; proposer?: CandidateProposer<AutonomyParams> } = {}) =>
  new DreamEngine(makeAutonomyFamily(policies, bounds, { unsafeCap: o.cap }), autonomyPool(items))
    .run(o.incumbent ?? untuned, { seed: o.seed ?? 7, iterations: o.iterations ?? 150, episodes: 200, proposer: o.proposer });

/** A mixed pool: routine confident entries (L3 today), 0.95-confidence entries people approved, and a few wrong ones. */
function mixedPool() {
  return [...many(30, { confidence: 0.98 }), ...many(40, { confidence: 0.95 }), ...many(10, { confidence: 0.99 }, "ratified"),
    ...many(3, { confidence: 0.85 }, "edited"), ...many(5, { actionType: "receipt", klass: "suspense", confidence: 0.3 }, "edited")];
}

describe("Dream-RSI core engine", () => {
  it("is deterministic: the same pool and seed give the same winner and report hash", async () => {
    const items = mixedPool();
    const a = await dreamAutonomy(items, { seed: 7 }), b = await dreamAutonomy(items, { seed: 7 });
    expect(a.winner.paramsHash).toBe(b.winner.paramsHash);
    expect(hashOf(a)).toBe(hashOf(b));
    const report = (r: DreamResult<AutonomyParams>) => finalizeReport({ kind: "kuber.dream-report", version: 1, family: "autonomy", tenant: "t", book: "b",
      range: { from: null, to: null }, date: ON, seed: r.seed, iterations: r.iterations, episodes: r.episodes, confidence: r.confidence,
      pool: { ...r.pool, source: "test" }, segments: [{ segment: "receipt", result: { ...r, incumbent: { ...r.incumbent, source: "policy" } } as never }], decision: r.decision });
    const ra = report(a), rb = report(b);
    expect(ra.reportHash).toBe(rb.reportHash);
    expect(reportHashOf(ra)).toBe(ra.reportHash);
    expect(a.pool.sliceHash).toBe(autonomyPool(items).hash());
  });

  it("never evaluates a candidate outside the bounds, whoever proposes it; model proposals are JSON data, never code", async () => {
    const evaluated: AutonomyParams[] = [];
    const family = makeAutonomyFamily(policies, bounds);
    const spy = { ...family, act: (p: AutonomyParams, d: AutonomyDecision, i: number, c: unknown) => { if (i === 0) evaluated.push(p); return family.act(p, d, i, c as never); } };
    let n = 0;
    const wild: CandidateProposer<AutonomyParams> = { name: "wild", propose: (ctx) => (++n % 2 ? { ...ctx.best, l3MinConfidence: 0.5, amountCeilingPaise: 10 ** 12 } : new MutationProposer<AutonomyParams>().propose(ctx)) };
    const r = await new DreamEngine(spy, autonomyPool(mixedPool())).run(untuned, { seed: 3, iterations: 120, proposer: wild });
    expect(r.candidates.rejectedOutOfBounds).toBeGreaterThanOrEqual(60);
    expect(evaluated.length).toBeGreaterThan(10);
    for (const p of evaluated) {
      expect(schema.safeParse(p).success).toBe(true);
      expect(p.l3MinConfidence).toBeGreaterThanOrEqual(TUNING_MIN_CONFIDENCE);
      expect(p.amountCeilingPaise).toBeLessThanOrEqual(bounds.maxCeilingPaise);
    }
    // Mutation alone stays inside the bounds for every dimension, routing included.
    const rt = await new DreamEngine(makeRoutingFamily(), new ReplayPool("t", routingTurns())).run(DEFAULT_ROUTING_PARAMS, { seed: 5, iterations: 150 });
    expect(rt.candidates.rejectedOutOfBounds).toBe(0);
    expect(RoutingParamsSchema.safeParse(rt.winner.params).success).toBe(true);

    // A model's reply: code is never run, out-of-bounds JSON is refused, valid JSON is used as data.
    let executed = false;
    (globalThis as { __dreamPwned?: () => void }).__dreamPwned = () => { executed = true; };
    const replies = ["```js\nglobalThis.__dreamPwned()\n```", JSON.stringify({ ...untuned, l3MinConfidence: 0.2 }),
      `Here you go: ${JSON.stringify({ ...untuned, l3MinConfidence: 0.95 })}`];
    const proposer = new JsonCandidateProposer<AutonomyParams>(async () => replies.shift() ?? "no", schema as never);
    const out: unknown[] = [];
    const ctx = { incumbent: untuned, best: untuned, bestScore: 0, iteration: 1, rng: new SeededRng(1), space: family.space };
    for (let i = 0; i < 3; i++) out.push(await proposer.propose(ctx));
    expect(executed).toBe(false);
    expect(proposer.rejected).toBe(2);
    expect((out[2] as AutonomyParams).l3MinConfidence).toBe(0.95);
  });

  it("promotes only a strict improvement whose bootstrap confidence bound is above zero", async () => {
    // 40 entries at 0.95 that people approved unchanged: lowering the L3 threshold to 0.95 is a clear, safe gain.
    const clear = await dreamAutonomy([...many(60, { confidence: 0.98 }), ...many(40, { confidence: 0.95 })]);
    expect(clear.decision).toBe("promote");
    expect(clear.winner.params.l3MinConfidence).toBeLessThanOrEqual(0.95);
    expect(clear.winner.score).toBeGreaterThan(clear.incumbent.score);
    expect(clear.improvement!.ciLower).toBeGreaterThan(0);

    // One entry of 250 would gain: strictly better, but the interval includes zero, so the incumbent stays.
    const thin = await dreamAutonomy([...many(249, { confidence: 0.98 }, "pending"), item({ confidence: 0.95 })]);
    expect(thin.winner.score).toBeGreaterThan(thin.incumbent.score);
    expect(thin.improvement!.ciLower).toBeLessThanOrEqual(0);
    expect(thin.decision).toBe("keep_incumbent");
    expect(thin.reasons.join(" ")).toMatch(/interval/);

    // Nothing to gain: the incumbent stays and nothing is proposed.
    const flat = await dreamAutonomy(many(50, { confidence: 0.3, klass: "suspense" }, "edited"));
    expect(flat.decision).toBe("keep_incumbent");
    expect(flat.winner.paramsHash).toBe(flat.incumbent.paramsHash);
    expect(flat.diff).toEqual([]);
  });

  it("the families use separate metrics and evaluation sets (design 7.3, ASDGF A3)", () => {
    const a = makeAutonomyFamily(policies, bounds), r = makeRoutingFamily();
    expect(a.metric.id).not.toBe(r.metric.id);
    expect(a.id).not.toBe(r.id);
  });
});

describe("Dream-RSI autonomy family", () => {
  it("never promotes a laxer threshold that would auto-post entries people later corrected", async () => {
    // Lowering L3 to 0.95 would gain 50 approved entries but also auto-post 4 entries that were
    // later corrected or reversed: more unsafe auto-posts than the incumbent's zero.
    const items = [...many(40, { confidence: 0.98 }), ...many(50, { confidence: 0.95 }),
      ...many(2, { confidence: 0.95 }, "corrected_after_approval"), ...many(1, { confidence: 0.95 }, "edited"), ...many(1, { confidence: 0.95 }, "rejected")];
    const r = await dreamAutonomy(items, { iterations: 200 });
    expect(r.decision).toBe("keep_incumbent");
    expect(r.winner.params.l3MinConfidence).toBeGreaterThan(0.95);
    expect(r.winner.violations.unsafe_auto_post ?? 0).toBe(0);
    expect(r.candidates.infeasible).toBeGreaterThan(0);
    // With the same incentive, a lower threshold on an otherwise identical clean pool would win.
    const clean = await dreamAutonomy([...many(40, { confidence: 0.98 }), ...many(50, { confidence: 0.95 })], { iterations: 200 });
    expect(clean.decision).toBe("promote");

    // The owner's cap binds below the incumbent's count: the incumbent auto-posts 2 later-corrected entries at 0.98.
    const capped = await dreamAutonomy([...many(40, { confidence: 0.98 }), ...many(2, { confidence: 0.98 }, "auto_corrected"), ...many(30, { confidence: 0.95 })], { cap: 0, iterations: 200 });
    expect(capped.incumbent.violations.unsafe_auto_post).toBe(2);
    expect(capped.incumbent.feasible).toBe(false);
    expect(capped.decision).toBe("keep_incumbent");
  });

  it("excluded classes are never auto-postable, under any tuning; tuning never touches other event codes", () => {
    const permissive: AutonomyTuning = { l3MinConfidence: TUNING_MIN_CONFIDENCE, l4MinConfidence: 0.95, relaxAfterAcceptances: 10, accuracyFloor: 0.95,
      amountCeilingPaise: bounds.maxCeilingPaise, newCounterpartyKnownAfter: 3, amountZLimit: null };
    expect(schema.safeParse(permissive).success).toBe(true);
    const relax = { consecutiveAccepted: 500, resolved: 100, accepted: 100 };
    for (const klass of EXCLUDED_CLASSES) {
      const d = item({ klass, confidence: 0.999, relax }, "approved_unchanged");
      expect(autonomyAction(policies, permissive, d)).toBe("person");
      expect(autonomyAction(policies, null, d)).toBe("person");
    }
    // Above the policy limit, even an entry wrongly classed as bookkeeping and a ceiling pushed past the bound stays with a person (L2).
    const big = item({ amountPaise: bounds.maxCeilingPaise + 100, confidence: 0.999, relax });
    expect(autonomyAction(policies, { ...permissive, amountCeilingPaise: 10 ** 12 }, big)).toBe("person");
    expect(schema.safeParse({ ...permissive, amountCeilingPaise: bounds.maxCeilingPaise + 1 }).success).toBe(false);
    // The same entry, routine: the permissive tuning relaxes it to L4.
    expect(autonomyAction(policies, permissive, item({ confidence: 0.999, relax }))).toBe("auto_l4");
    // An LLM classification still never posts on its own: the tuning floor is above the LLM cap.
    expect(TUNING_MIN_CONFIDENCE).toBeGreaterThan(LLM_MAX_CONFIDENCE);
    expect(autonomyAction(policies, { ...permissive, l3MinConfidence: 0.5 }, item({ confidence: LLM_MAX_CONFIDENCE, classifier: "llm" }))).toBe("person");
    // Period operations, payments and master data keep their policy file whatever a tuning says.
    for (const eventCode of ["EVT-PERIOD-END", "EVT-GST-DUE", "EVT-VENDOR-BANK-CHANGE"]) {
      const inp = { eventCode, on: ON, amountPaise: 100n, confidence: 0.999, counterpartyKnown: true };
      expect(policies.decide({ ...inp, tuning: permissive, relax })).toEqual(policies.decide(inp));
    }
  });

  it("the untuned equivalent decides exactly as no tuning", () => {
    for (const confidence of [0.3, 0.85, 0.9, 0.95, 0.97, 0.98, 0.99])
      for (const amountPaise of [0n, 100_000n, 2_500_000n, 2_500_001n, 9_000_000n])
        for (const counterpartyKnown of [true, false])
          for (const overrideMax of [null, "L1" as const]) {
            const inp = { eventCode: "EVT-TXN-INGESTED", on: ON, amountPaise, confidence, counterpartyKnown, overrideMax };
            expect(policies.decide({ ...inp, tuning: untuned }).level).toBe(policies.decide(inp).level);
          }
  });
});

// ------------------------------------------------------------------ routing fixtures
const H = (s: string) => sha256Hex(s).slice(0, 32);
let tk = 0;
function turn(cands: [string, string, number][], truthTool: string | null, o: { path?: "router" | "model" | "clarify"; model?: RoutingTurn["outcome"]["model"];
  account?: { id: string; similarity: number }[]; truthAccount?: string | null } = {}): RoutingTurn {
  tk++;
  return { id: H(`turn-${tk}`), seq: tk,
    features: { router: { candidates: cands.map(([family, tool, score]) => ({ family: family as never, tool, score })) }, account: o.account ? { candidates: o.account } : null },
    action: { path: o.path ?? "router", tool: cands[0]?.[1] ?? null },
    outcome: { truth: { tool: truthTool, account: o.truthAccount ?? null }, model: o.model ?? null, nextAction: truthTool ? "accepted" : "rephrased" } };
}
function routingTurns(): RoutingTurn[] {
  tk = 0;
  const out: RoutingTurn[] = [];
  // Confident router hits.
  for (let i = 0; i < 20; i++) out.push(turn([["position", "dashboard", 0.95]], "dashboard"));
  // The router scores 0.72 and falls back to the model, which answered badly; the router's tool was right.
  for (let i = 0; i < 30; i++) out.push(turn([["report", "report", 0.72]], "report", { path: "model", model: { correct: false, grounded: true, guessedAccount: false } }));
  // Two candidates close together: the person wanted the report, not the simulation.
  for (let i = 0; i < 12; i++) out.push(turn([["simulate", "simulate", 0.86], ["report", "report", 0.85]], "report"));
  // Reconcile with two similar accounts; the best one was the person's.
  for (let i = 0; i < 10; i++) out.push(turn([["reconcile", "reconcile", 0.93]], "reconcile", { account: [{ id: H("BANK"), similarity: 0.95 }, { id: H("CARD"), similarity: 0.91 }], truthAccount: H("BANK") }));
  return out;
}

describe("Dream-RSI routing family", () => {
  it("improves correct resolution on a fixture pool with zero ungrounded answers and zero guessed accounts", async () => {
    const adapter = new FixtureTurnAdapter(routingTurns());
    const pool = new ReplayPool("copilot.routing", await adapter.load());
    const r = await new DreamEngine(makeRoutingFamily(), pool).run(DEFAULT_ROUTING_PARAMS, { seed: 7, iterations: 300 });
    expect(r.decision).toBe("promote");
    expect(r.winner.score).toBeGreaterThan(r.incumbent.score);
    expect(r.winner.metrics.correctResolutionShare).toBeGreaterThan(r.incumbent.metrics.correctResolutionShare!);
    expect(r.winner.constraints.every((c) => c.ok)).toBe(true);
    expect(r.winner.violations).toEqual({});
    expect(r.winner.params.resolveThreshold).toBeLessThanOrEqual(0.72);
    expect(() => new FixtureTurnAdapter([{ ...routingTurns()[0], features: { router: { candidates: [] }, account: null, narration: "paid acme" } }])).toThrow();
  });

  it("never promotes a candidate that would guess an account or give an ungrounded answer", async () => {
    const turns: RoutingTurn[] = [];
    // Lowering the fuzzy threshold to 0.86 would resolve 20 turns correctly ...
    for (let i = 0; i < 20; i++) turns.push(turn([["reconcile", "reconcile", 0.95]], "reconcile", { account: [{ id: H("BANK"), similarity: 0.86 }], truthAccount: H("BANK") }));
    // ... and commit to an account the person did not confirm in 3 others.
    for (let i = 0; i < 3; i++) turns.push(turn([["reconcile", "reconcile", 0.95]], "reconcile", { account: [{ id: H("CARD"), similarity: 0.87 }], truthAccount: null }));
    // Lowering the clarification threshold would answer 20 grounded model turns, and 3 ungrounded ones.
    // (the router's candidate there is the wrong tool: only the model answered those correctly)
    for (let i = 0; i < 20; i++) turns.push(turn([["report", "report", 0.6]], "simulate", { path: "model", model: { correct: true, grounded: true, guessedAccount: false } }));
    for (let i = 0; i < 3; i++) turns.push(turn([["report", "report", 0.6]], null, { path: "model", model: { correct: false, grounded: false, guessedAccount: false } }));
    for (let i = 0; i < 20; i++) turns.push(turn([["position", "dashboard", 0.95]], "dashboard"));
    const incumbent: RoutingParams = { ...DEFAULT_ROUTING_PARAMS, clarifyThreshold: 0.65 };
    const r = await new DreamEngine(makeRoutingFamily(), new ReplayPool("copilot.routing", turns)).run(incumbent, { seed: 7, iterations: 300 });
    expect(r.incumbent.feasible).toBe(true);
    expect(r.candidates.infeasible).toBeGreaterThan(0);
    expect(r.decision).toBe("keep_incumbent");
    expect(r.winner.violations.guessed_account ?? 0).toBe(0);
    expect(r.winner.violations.ungrounded_answer ?? 0).toBe(0);
  });
});

// ------------------------------------------------------------------ Kuber: extraction, run, proposal, approval
const T = "dreamco", B = "main", OWNER = "owner:dreamco", CONTROLLER = "controller:asha", PREPARER = "preparer:ravi";
const clock = { value: "2026-11-05" };
const outDir = mkdtempSync(join(tmpdir(), "kuber-dream-"));
const evidenceDir = join(outDir, "evidence"), artifactsDir = join(outDir, "artifacts");
let cell: Cell, stop: () => Promise<void>;
let n = 0;
const PERSONAL = ["acme", "ACME", "zeta", "ZETA", "swiggy", "SWIGGY", "zomato", "ZOMATO", "Professional fees", "Business expenses", "invoice", "INV"];

async function submit(lines: { name: string; hint: string; direction: "in" | "out"; amount: number; date: string }[]) {
  const txns = lines.map((l) => ({ txnDate: l.date, amount: String(l.amount), direction: l.direction, narration: `NEFT ${l.name} INV ${++n}`,
    instrument: "BANK", counterpartyHint: l.hint, reference: `REF${100000 + n}` }));
  await cell.channels.submitRaw(T, B, "aa", "authoritative", `batch-${n}-${uuid()}`, txns, OWNER);
  await cell.settle();
}
const acme = (count: number, day: number) => Array.from({ length: count }, (_, i) => ({ name: "ACME SOLUTIONS", hint: "acme solutions", direction: "in" as const,
  amount: 1_000_000 + 1000 * ((i * 7) % 13), date: `2026-10-${String(day).padStart(2, "0")}` }));
async function ratifyAll() { for (const r of await cell.agent.openRatifications(T)) await cell.agent.ratify(T, r.journal_id, OWNER); }
async function approveAll(edit?: string) { for (const d of await cell.agent.queue(T)) await cell.agent.approveDraft(T, d.draft_id, OWNER, edit); await cell.settle(); }
async function lastPosting() {
  const evs = await cell.store.readEvents({ tenantId: T, types: ["PostingRequested", "DraftQueued"] });
  return evs[evs.length - 1]!;
}

describe("Dream-RSI in Kuber", () => {
  beforeAll(async () => {
    ({ cell, stop } = await startCell(clock, { dream: { evidenceDir, artifactsDir } }));
    await enrol(cell, T, [OWNER, CONTROLLER, PREPARER]);
    await cell.gl.openBook(T, B, "dreamco", "freelancer", OWNER);
    await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: "Opening BANK", voucherType: "opening",
      lines: [{ accountId: "BANK", amount: "50000000", dimensions: {} }, { accountId: "OPENING", amount: "-50000000", dimensions: {} }] }, { principal: OWNER });
    await cell.agent.addRule(T, "acme", "FEES", OWNER);
    await cell.agent.addRule(T, "zeta", "BIZEXP", OWNER);
  }, 120_000);
  afterAll(async () => { await stop(); });

  it("extraction refuses without the owner's opt-in, and only an owner can opt in", async () => {
    await expect(extractAutonomyPool(cell.store, T, B, { from: "2026-10-01", to: "2026-10-31" }, { policies })).rejects.toBeInstanceOf(OptInRequired);
    await expect(cell.dream.runAutonomy({ tenant: T, book: B, from: "2026-10-01", to: "2026-10-31", seed: 7, iterations: 5 })).rejects.toBeInstanceOf(OptInRequired);
    await expect(cell.identity.setOptimisationOptIn(T, CONTROLLER, true)).rejects.toThrow(/may not authority.manage/);   // role model v2: a superuser decision
    expect(await cell.identity.optimisationOptIn(T)).toBe(false);
  });

  let pool: ReplayPool<AutonomyDecision>;
  it("seeded end to end, part 1: journals, drafts, approvals, ratifications and corrections in a test cell extract to a replay pool", async () => {
    // Receipts: a first draft a person approves (the counterparty becomes known), then 31 routine
    // entries the agent posts at L3 and a person ratifies, then 15 more, ratified too.
    await submit(acme(1, 1)); await approveAll();
    await submit(acme(31, 5)); await ratifyAll();
    await submit(acme(15, 12)); await ratifyAll();
    // Payments: a draft approved, auto-posts of which two are corrected, merchant drafts edited and rejected.
    await submit([{ name: "ZETA HOSTING", hint: "zeta hosting", direction: "out", amount: 250_000, date: "2026-10-02" }]); await approveAll();
    await submit(Array.from({ length: 5 }, (_, i) => ({ name: "ZETA HOSTING", hint: "zeta hosting", direction: "out" as const, amount: 250_000 + i * 100, date: "2026-10-15" })));
    const zeta = await cell.agent.openRatifications(T);
    for (const r of zeta.slice(0, 2)) await cell.agent.correct(T, r.journal_id, "LIVING", OWNER, { reason: { codes: ["wrong_account"] } });
    await ratifyAll();
    await cell.settle();
    await submit([{ name: "SWIGGY", hint: "swiggy", direction: "out", amount: 64_200, date: "2026-10-20" }]); await approveAll("BIZEXP");
    await submit([{ name: "ZOMATO", hint: "zomato", direction: "out", amount: 38_900, date: "2026-10-21" }]);
    for (const d of await cell.agent.queue(T)) await cell.agent.rejectDraft(T, d.draft_id, OWNER, "duplicate");

    await cell.identity.setOptimisationOptIn(T, OWNER, true);
    const x = await extractAutonomyPool(cell.store, T, B, { from: "2026-10-01", to: "2026-10-31" }, { policies, asOf: clock.value });
    pool = x.pool; const skipped = x.skipped;
    expect(pool.size).toBe(1 + 31 + 15 + 1 + 5 + 2);
    expect(skipped.pending).toBe(0);
    const truths = pool.items.map((d) => d.outcome.truth);
    expect(truths.filter((t) => t === "ratified").length).toBe(31 + 15 + 3);
    expect(truths.filter((t) => t === "auto_corrected").length).toBe(2);
    expect(truths).toEqual(expect.arrayContaining(["approved_unchanged", "edited", "rejected"]));
    // Relax counters as of the decision: the last batch of receipts saw 32 accepted outcomes.
    const lastReceipt = pool.items.filter((d) => d.features.actionType === "receipt").at(-1)!;
    expect(lastReceipt.features.relax.consecutiveAccepted).toBeGreaterThanOrEqual(32);
  }, 180_000);

  it("the extracted pool contains no personal text: features and outcomes only, keyed-hash ids", () => {
    // The pool holds features and outcomes only: no narration, name, hint or account name; ids are keyed hashes.
    const text = JSON.stringify(pool);
    for (const s of PERSONAL) expect(text).not.toContain(s);
    const strings: string[] = [];
    JSON.parse(text, (_k, v) => { if (typeof v === "string") strings.push(v); return v; });
    expect(strings.length).toBeGreaterThan(100);
    for (const s of strings) expect(s).toMatch(/^([0-9a-f]{16,64}|EVT-[A-Z-]+|\d{4}-\d{2}-\d{2}|receipt|payment|plan|freelancer|bookkeeping|suspense|above_limit|rule|history|merchant|llm|none|auto_l3|auto_l4|person|L[0-4]|kuber\.autonomy|actionType=\w+|approved_unchanged|edited|rejected|ratified|auto_corrected|auto_reversed|auto_uncorrected|corrected_after_approval|pending)$/);

  });

  it("seeded end to end, part 2: dream and propose; a proposal changes nothing until approved, and approval changes the thresholds the agent's decision reads", async () => {
    // Dream: deterministic, and the receipt segment's winner relaxes routine receipts to L4.
    const run = await cell.dream.runAutonomy({ tenant: T, book: B, from: "2026-10-01", to: "2026-10-31", seed: 7, iterations: 200 });
    const again = await cell.dream.runAutonomy({ tenant: T, book: B, from: "2026-10-01", to: "2026-10-31", seed: 7, iterations: 200, write: false });
    expect(again.report.reportHash).toBe(run.report.reportHash);
    expect(run.report.signature?.value).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const receipt = run.report.segments.find((s) => s.segment === "receipt")!.result!;
    expect(receipt.decision).toBe("promote");
    expect(receipt.winner.params).toMatchObject({ l4MinConfidence: expect.any(Number) });
    expect(receipt.winner.constraints.every((c) => c.ok)).toBe(true);
    expect(run.proposal?.status).toBe("proposed");
    const proposal = run.proposal!;
    expect(proposal.segments.find((s) => s.actionType === "receipt")!.diff.map((d) => d.param)).toContain("l4MinConfidence");
    // Evidence on disk: pool slice hash, seed, candidates, scores, interval, constraints, decision.
    const ev = JSON.parse(readFileSync(run.files!.json, "utf8"));
    expect(run.files!.json).toBe(join(evidenceDir, `dream-autonomy-${T}-${clock.value}.json`));
    expect(ev).toMatchObject({ seed: 7, decision: "promote", pool: { sliceHash: pool.hash() }, reportHash: run.report.reportHash });
    expect(ev.segments[0].result).toHaveProperty("improvement.ciLower");
    expect(ev.segments[0].result.candidates.evaluated).toBeGreaterThan(0);
    expect(readFileSync(run.files!.md, "utf8")).toMatch(/Constraint \| Winner/);
    const recorded = await cell.store.readStream(T, `${T}/dream/${proposal.proposalId}`);
    expect(recorded.map((e) => e.type)).toEqual(["DreamProposalRecorded"]);

    // Not deployed: a new routine receipt still posts at L3, and the agent reads no tuning.
    expect(await cell.agent.autonomyTuning(T, B)).toEqual({});
    await submit(acme(1, 28).map((x) => ({ ...x, date: "2026-11-02" })));
    const before = await lastPosting();
    expect(before.type).toBe("PostingRequested");
    expect((before.data as EventData<"PostingRequested">).autonomy).toBe("L3");

    // Approval: a preparer may not; a controller (autonomy.manage) may. The approval event comes first, then the thresholds apply.
    await expect(cell.dream.approve(T, proposal.proposalId, PREPARER)).rejects.toThrow(/may not autonomy.manage/);
    const approved = await cell.dream.approve(T, proposal.proposalId, CONTROLLER);
    expect(approved).toMatchObject({ status: "approved", decidedBy: CONTROLLER });
    await expect(cell.dream.approve(T, proposal.proposalId, CONTROLLER)).rejects.toThrow(/is approved/);
    const evs = await cell.store.readEvents({ tenantId: T, types: ["DreamProposalApproved", "AutonomyTuningApplied"] });
    expect(evs[0]!.type).toBe("DreamProposalApproved");
    expect(evs.slice(1).every((e) => e.type === "AutonomyTuningApplied")).toBe(true);
    const inForce = await cell.agent.autonomyTuning(T, B);
    expect(inForce.receipt?.tuning).toEqual(proposal.segments.find((s) => s.actionType === "receipt")!.params);

    // Deployed: the next routine receipt posts without ratification (L4), read from the approved tuning.
    await submit(acme(1, 28).map((x) => ({ ...x, amount: 1_004_000, date: "2026-11-03" })));
    const after = await lastPosting();
    expect((after.data as EventData<"PostingRequested">).autonomy).toBe("L4");
    const decision = (await cell.store.readEvents({ tenantId: T, types: ["PolicyDecisionMade"] })).at(-1)!.data as EventData<"PolicyDecisionMade">;
    expect(decision.decision.reasons.join(" ")).toMatch(/relaxed to L4/);
  }, 180_000);

  it("routing: a winning policy becomes a versioned, unapproved artifact with its sha256", async () => {
    const r = await cell.dream.runRouting({ tenant: T, adapter: new FixtureTurnAdapter(routingTurns()), seed: 7, iterations: 300 });
    expect(r.report.decision).toBe("promote");
    expect(r.artifact!.path).toBe(join(artifactsDir, "routing-policy.1.json"));
    const a = JSON.parse(readFileSync(r.artifact!.path, "utf8"));
    expect(a).toMatchObject({ kind: "kuber.routing-policy", version: 1, approvedBy: null, locked: false, evidence: { reportHash: r.report.reportHash } });
    const { sha256, ...body } = a;
    expect(hashOf(body)).toBe(sha256);
    expect(RoutingParamsSchema.safeParse(a.params).success).toBe(true);
    expect(existsSync(join(evidenceDir, `dream-routing-${T}-${clock.value}.json`))).toBe(true);
    const second = await cell.dream.runRouting({ tenant: T, adapter: new FixtureTurnAdapter(routingTurns()), seed: 7, iterations: 300 });
    expect(second.artifact!.version).toBe(2);
    expect(second.artifact!.sha256).not.toBe(r.artifact!.sha256);          // the version is part of the hashed body
    expect(second.report.reportHash).toBe(r.report.reportHash);
  });
});
