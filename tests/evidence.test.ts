/**
 * Evidence record (design 14.7, readiness 17.4): every committed action links source, decision,
 * execution, result, approval and exception data; retrieval works by source id and hash.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { uuid, type EventData } from "@kuber/contracts";
import { KeyAdmin, type Cell } from "@kuber/core";
import type { Evidence } from "@kuber/evidence";
import type { Plan } from "@kuber/ops";
import { ROOT, enrol, startCell } from "./helpers.ts";

const T = "meera", B = "main", OWNER = "owner:meera";
const clock = { value: "2026-10-25" };
let cell: Cell, stop: () => Promise<void>, ownerUrl: string;
const csv = (f: string) => readFileSync(join(ROOT, "samples", f), "utf8");
const plan = (op: string, input: unknown) => cell.ops.plan(T, B, OWNER, op, input);
const commit = (p: Plan) => cell.ops.commit(T, p.planId, OWNER, p.hash);
const all = async () => {
  const evs = await cell.store.readStream(T, `${T}/evidence/${B}`);
  return Promise.all(evs.map(async (e) => (await cell.evidence.get(T, (e.data as EventData<"EvidenceRecorded">).evidenceId))!));
};
const forJournal = async (pred: (e: Evidence) => boolean) => (await all()).filter((e) => e.record.subject.kind === "journal" && pred(e));
const narration = (e: Evidence) => String(e.record.result.narration);
let postPlan: Plan, recordPlan: Plan, closePlan: Plan;

beforeAll(async () => {
  let db: { ownerUrl: string };
  ({ cell, stop, db } = await startCell(clock));
  await enrol(cell, T, [OWNER]);                                   // the only person: explicit single-owner exception
  await cell.identity.setSettings(T, OWNER, { soloOwner: true, sodLimitPaise: null });
  ownerUrl = db.ownerUrl;
  await cell.gl.openBook(T, B, "meera", "freelancer", OWNER);
  await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: "Opening BANK", voucherType: "opening",
    lines: [{ accountId: "BANK", amount: "12500000", dimensions: {} }, { accountId: "OPENING", amount: "-12500000", dimensions: {} }] }, { principal: OWNER });
  await cell.channels.submitChat(T, B, "Paid 450 to the plumber in cash", OWNER, "2026-10-05");
  await cell.channels.submitStatement(T, B, csv("hdfc_2026_10.csv"), OWNER);
  await cell.settle();

  // one draft approved directly, the rest through an ops plan
  const loan = (await cell.agent.queue(T)).find((d) => (d.proposal as { narration: string }).narration.includes("LOAN"))!;
  await cell.agent.approveDraft(T, loan.draft_id as string, OWNER, "LOANS");
  await cell.settle();
  postPlan = await plan("post", {});
  await commit(postPlan);
  await cell.settle();

  // month two: known parties post under policy, some awaiting ratification
  clock.value = "2026-11-25";
  await cell.channels.submitStatement(T, B, csv("hdfc_2026_11.csv"), OWNER);
  await cell.settle();

  recordPlan = await plan("record", { narration: "Printer ink", amount: 1200, direction: "out", account: "BIZEXP", via: "CASH", date: "2026-11-26" });
  await commit(recordPlan);
  for (const d of await cell.agent.queue(T)) {
    if ((d.proposal as { txnDate: string }).txnDate <= "2026-10-31") await cell.agent.rejectDraft(T, d.draft_id as string, OWNER, "not mine");
  }
  closePlan = await plan("close", { periodEnd: "2026-10-31" });
  await commit(closePlan);
  await cell.settle();
});
afterAll(async () => { await stop(); });

describe("evidence record", () => {
  it("exists exactly once for every posted journal and every period lock", async () => {
    const book = await cell.store.readStream(T, `${T}/book/${B}`);
    const journals = book.filter((e) => e.type === "JournalPosted").map((e) => (e.data as EventData<"JournalPosted">).journalId);
    const locks = book.filter((e) => e.type === "PeriodLocked");
    const ev = await all();
    expect(journals.length).toBeGreaterThan(15);
    expect(ev.filter((e) => e.record.subject.kind === "journal").map((e) => e.record.subject.id).sort()).toEqual([...journals].sort());
    expect(ev.filter((e) => e.record.subject.kind === "period_lock")).toHaveLength(locks.length);
    expect(locks.length).toBeGreaterThan(0);
  });

  it("every record has all six parts, hashes to its recordHash, and cites events that still exist", async () => {
    for (const e of await all()) {
      const r = e.record;
      for (const part of [r.source, r.decision, r.execution, r.result, r.approval]) expect(Object.keys(part).length).toBeGreaterThan(0);
      expect(Array.isArray(r.exceptions)).toBe(true);
      expect(e.verified).toEqual({ recordHash: true, citations: true, signature: null });
      expect(r.cites.length).toBeGreaterThan(0);
    }
  });

  it("a directly approved draft: statement source, classification, the person's approval", async () => {
    const [e] = await forJournal((x) => narration(x).includes("LOAN"));
    const r = e!.record;
    expect(r.source).toMatchObject({ kind: "signal", channel: expect.any(String), contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(r.decision).toMatchObject({ classification: { accountId: expect.any(String), by: expect.any(String) }, level: expect.any(String) });
    expect(r.approval).toMatchObject({ kind: "draft", by: OWNER, role: "owner", accountChosen: "LOANS" });
    expect(r.execution).toMatchObject({ operation: "agent.pipeline", requestId: expect.any(String) });
    expect((r.result.balances as unknown[]).length).toBe(2);
  });

  it("drafts approved through a plan cite the plan, its hash and who prepared and approved it", async () => {
    const byPlan = await cell.evidence.find(T, postPlan.hash);
    expect(byPlan.length).toBe(postPlan.journals.length);
    for (const e of byPlan) {
      expect(e.record.execution).toMatchObject({ operation: "post", planId: postPlan.planId, planHash: postPlan.hash, basisSeq: postPlan.basisSeq });
      expect(e.record.approval).toMatchObject({ kind: "plan", by: OWNER, sod: { preparedBy: OWNER, approvedBy: OWNER, separate: false } });
      expect(e.record.source).toMatchObject({ kind: "signal" });                // the transaction behind each draft is still the source
    }
    expect((await cell.evidence.find(T, postPlan.planId)).length).toBe(byPlan.length);
  });

  it("a policy auto-post records the autonomy level and the open ratification", async () => {
    const auto = await forJournal((x) => x.record.approval.kind === "policy");
    expect(auto.length).toBeGreaterThan(0);
    const github = auto.find((x) => narration(x).includes("GITHUB"))!;
    expect(github.record.approval).toMatchObject({ by: "policy", authority: { level: "L3" } });
    expect(github.record.exceptions).toEqual([expect.objectContaining({ issue: expect.stringMatching(/ratification/), dueBy: expect.any(String), status: "open" })]);
  });

  it("a person's own statement is its approval; bank chat entries carry the provisional exception", async () => {
    const [cash] = await forJournal((x) => narration(x).toLowerCase().includes("plumber"));
    expect(cash!.record.approval).toMatchObject({ kind: "statement", by: OWNER });
    expect(cash!.record.source).toMatchObject({ kind: "signal", channel: "chat" });
    const [opening] = await forJournal((x) => narration(x) === "Opening BANK");
    expect(opening!.record.source).toEqual({ kind: "direct", principal: OWNER });
  });

  it("a recorded plan and a period close cite their plans; the close is gated to a person", async () => {
    const [ink] = await cell.evidence.find(T, recordPlan.hash);
    expect(ink!.record.result).toMatchObject({ narration: "Printer ink" });
    expect(ink!.record.result.balances).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: "BIZEXP" })]));
    const [lock] = await cell.evidence.find(T, closePlan.hash);
    expect(lock!.record.subject).toMatchObject({ kind: "period_lock" });
    expect(lock!.record.approval).toMatchObject({ kind: "plan", gate: "human", by: OWNER });
  });

  it("is found by signal, statement hash, transaction, journal id and hash, event id and record hash", async () => {
    const [e] = await forJournal((x) => narration(x).includes("LOAN"));
    const src = e!.record.source as { signalId: string; contentHash: string; txnId: string };
    const res = e!.record.result as { journalId: string; hash: string };
    const fromStatement = await cell.evidence.find(T, src.contentHash);
    expect(fromStatement.length).toBeGreaterThan(5);                           // every journal from that statement
    expect((await cell.evidence.find(T, src.signalId)).map((x) => x.evidenceId)).toEqual(fromStatement.map((x) => x.evidenceId));
    for (const q of [src.txnId, res.journalId, res.hash, e!.recordHash, e!.evidenceId, e!.record.cites[0]!.eventId]) {
      expect((await cell.evidence.find(T, q)).map((x) => x.evidenceId), q).toContain(e!.evidenceId);
    }
    expect(await cell.evidence.find(T, "0".repeat(64))).toEqual([]);
    expect(await cell.evidence.find("someone-else", res.hash)).toEqual([]);   // tenant-scoped
  });

  it("is sealed and chained like every other event", async () => {
    const v = await cell.store.verifyStorage({ tenantId: T, deep: true });
    expect(v.problems).toEqual([]);
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      const [r] = await owner<{ n: number; sealed: number }[]>`
        SELECT count(*)::int AS n, count(*) FILTER (WHERE data ? '$c')::int AS sealed FROM es.events WHERE type = 'EvidenceRecorded'`;
      expect(r!.n).toBeGreaterThan(0);
      expect(r!.sealed).toBe(r!.n);
      expect((await new KeyAdmin(owner, cell.keyring, cell.store).verify()).plaintext).toEqual({});
    } finally { await owner.end(); }
  });
});
