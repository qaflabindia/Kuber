/** Pure tests: money, GL aggregate invariants (property-based), policy engine, parsers. No database. */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatINR, parseAmount, uuid, type Envelope, type Line, type Meta } from "@kuber/contracts";
import { DomainError, SEEDS, verifyChain } from "@kuber/gl";
import { decide, emptyBook, evolve, type BookCommand, type BookState } from "../modules/gl/src/book.ts";
import { PolicyEngine, parsePolicy } from "@kuber/policy";
import { parseBankCsv, parseChat } from "@kuber/channels";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY_DIR, ROOT } from "./helpers.ts";

const meta = (principal = "owner:laksh"): Meta => ({ tenantId: "t1", cellId: "local", correlationId: uuid(), principal, occurredAt: "" });

/** Apply a command to state the way the event store would: decide, then evolve with envelopes. */
function apply(s: BookState, c: BookCommand, principal = "owner:laksh"): { state: BookState; events: Envelope[] } {
  const evs = decide(s, c, principal).map((e, i) => ({ eventId: uuid(), globalPosition: "0", streamId: "t1/book/b", streamVersion: i,
    type: e.type, schemaVersion: 1, data: JSON.parse(JSON.stringify(e.data)), meta: meta(principal), recordedAt: "" }) as Envelope);
  return { state: evs.reduce(evolve, s), events: evs };
}
const opened = () => apply(emptyBook(), { kind: "OpenBook", bookId: "b", entityId: "e", entityType: "freelancer", accounts: SEEDS.freelancer! });
const L = (accountId: string, amount: bigint, partyId?: string): Line => ({ accountId, amount: amount.toString(), dimensions: {}, ...(partyId ? { partyId } : {}) });

describe("money", () => {
  it("parses Indian formats exactly and rounds half-up", () => {
    expect(parseAmount("1,20,000.50")).toBe(12000050n);
    expect(parseAmount("₹450")).toBe(45000n);
    expect(parseAmount("(1,000)")).toBe(-100000n);
    expect(parseAmount("0.005")).toBe(1n);
    expect(parseAmount("0.004")).toBe(0n);
    expect(() => parseAmount("abc")).toThrow();
    expect(formatINR(1234567890n)).toBe("₹1,23,45,678.90");
    expect(formatINR(-45000n)).toBe("-₹450.00");
  });
});

describe("GL book invariants", () => {
  const accs = ["CASH", "BANK", "LIVING", "BIZEXP", "FEES", "OTHINC", "LOANS"];
  const balancedJournal = fc.array(fc.tuple(fc.constantFrom(...accs), fc.bigInt({ min: 1n, max: 10n ** 12n })), { minLength: 1, maxLength: 6 })
    .map((legs) => {
      const lines = legs.map(([a, v]) => L(a, v));
      const total = legs.reduce((s, [, v]) => s + v, 0n);
      return [...lines, L("SUSPENSE", -total)];
    });

  it("accepts any balanced journal and keeps the hash chain verifiable", () => {
    fc.assert(fc.property(fc.array(balancedJournal, { minLength: 1, maxLength: 15 }), (journals) => {
      let { state, events } = opened();
      const all = [...events];
      journals.forEach((lines, i) => {
        const r = apply(state, { kind: "PostJournal", journalId: `j${i}`, txnDate: "2026-10-01", narration: "x", lines });
        state = r.state; all.push(...r.events);
      });
      expect(state.seq).toBe(journals.length);
      expect(verifyChain(all)).toBeNull();
    }), { numRuns: 100 });
  });

  it("rejects any unbalanced journal", () => {
    fc.assert(fc.property(balancedJournal, fc.bigInt({ min: 1n, max: 10n ** 9n }), (lines, err) => {
      const { state } = opened();
      const bad = [...lines.slice(0, -1), L("SUSPENSE", BigInt(lines.at(-1)!.amount) - err)];
      expect(() => decide(state, { kind: "PostJournal", journalId: "j", txnDate: "2026-10-01", narration: "x", lines: bad }, "owner:x"))
        .toThrow(/does not balance/);
    }), { numRuns: 100 });
  });

  it("reversal nets every account to zero and cannot be repeated", () => {
    let { state } = opened();
    state = apply(state, { kind: "PostJournal", journalId: "j1", txnDate: "2026-10-02", narration: "x", lines: [L("LIVING", 50000n), L("BANK", -50000n)] }).state;
    const r = apply(state, { kind: "ReverseJournal", journalId: "j1", reversalJournalId: "r1", reason: "wrong" });
    const posted = r.events.find((e) => e.type === "JournalPosted")!.data as { lines: Line[] };
    expect(posted.lines.map((l) => l.amount)).toEqual(["-50000", "50000"]);
    expect(() => decide(r.state, { kind: "ReverseJournal", journalId: "j1", reversalJournalId: "r2", reason: "again" }, "owner:x")).toThrow(/already reversed/);
  });

  it("is idempotent on journal id", () => {
    let { state } = opened();
    state = apply(state, { kind: "PostJournal", journalId: "j1", txnDate: "2026-10-02", narration: "x", lines: [L("LIVING", 1n), L("BANK", -1n)] }).state;
    expect(decide(state, { kind: "PostJournal", journalId: "j1", txnDate: "2026-10-02", narration: "x", lines: [L("LIVING", 1n), L("BANK", -1n)] }, "owner:x")).toEqual([]);
  });

  it("requires a party on control accounts, known accounts, and non-zero lines", () => {
    const { state } = opened();
    const post = (lines: Line[]) => () => decide(state, { kind: "PostJournal", journalId: "j", txnDate: "2026-10-02", narration: "x", lines }, "owner:x");
    expect(post([L("DEBTORS", 100n), L("FEES", -100n)])).toThrow(/control account/);
    expect(post([L("DEBTORS", 100n, "p1"), L("FEES", -100n)])).not.toThrow();
    expect(post([L("NOPE", 100n), L("FEES", -100n)])).toThrow(/unknown account/);
    expect(post([L("LIVING", 0n), L("BANK", 0n)])).toThrow(/zero-amount/);
  });

  it("enforces soft and hard period locks by role", () => {
    let { state } = opened();
    expect(() => decide(state, { kind: "LockPeriod", periodEnd: "2026-09-30", level: "soft" }, "agent:kuber")).toThrow(DomainError);
    state = apply(state, { kind: "LockPeriod", periodEnd: "2026-09-30", level: "soft" }).state;
    const c: BookCommand = { kind: "PostJournal", journalId: "late", txnDate: "2026-09-15", narration: "late", lines: [L("LIVING", 100n), L("BANK", -100n)] };
    expect(() => decide(state, c, "agent:kuber")).toThrow(/soft-locked/);
    expect(decide(state, c, "controller:ca")).toHaveLength(1);
    state = apply(state, { kind: "LockPeriod", periodEnd: "2026-09-30", level: "hard" }).state;
    expect(() => decide(state, c, "owner:laksh")).toThrow(/hard-locked/);
  });

  it("detects tampering with posted history", () => {
    let { state, events } = opened();
    const all = [...events];
    for (const id of ["a", "b", "c"]) {
      const r = apply(state, { kind: "PostJournal", journalId: id, txnDate: "2026-10-03", narration: id, lines: [L("LIVING", 100n), L("BANK", -100n)] });
      state = r.state; all.push(...r.events);
    }
    expect(verifyChain(all)).toBeNull();
    (all[2]!.data as { lines: Line[] }).lines[0]!.amount = "999";
    expect(verifyChain(all)).toBe("b");
  });

  it("correction reverses and reposts to the new account", () => {
    let { state } = opened();
    state = apply(state, { kind: "PostJournal", journalId: "j1", txnDate: "2026-10-02", narration: "github", lines: [L("BANK", -168000n), L("LIVING", 168000n, "p")] }).state;
    const r = apply(state, { kind: "CorrectJournal", journalId: "j1", fromAccount: "LIVING", toAccount: "BIZEXP", reversalJournalId: "r", newJournalId: "n" });
    expect(r.events.map((e) => e.type)).toEqual(["JournalPosted", "JournalReversed", "JournalPosted"]);
    const repost = r.events[2]!.data as { lines: Line[] };
    expect(repost.lines.find((l) => l.accountId === "BIZEXP")?.amount).toBe("168000");
  });
});

describe("policy engine", () => {
  const pe = PolicyEngine.fromDir(POLICY_DIR);
  const ON = "2026-10-25";

  it("loads the library and applies the global default to unknown events", () => {
    expect(pe.policies.length).toBe(27);
    const d = pe.decide({ eventCode: "EVT-SOMETHING-NEW", on: ON });
    expect(d).toMatchObject({ policyIds: ["POL-000"], level: "L1", action: "draft" });
  });

  it("only ever lowers autonomy at runtime", () => {
    const base = { eventCode: "EVT-TXN-INGESTED", on: ON, confidence: 0.99, counterpartyKnown: true };
    expect(pe.decide({ ...base, amountPaise: 50000n }).level).toBe("L3");
    expect(pe.decide({ ...base, amountPaise: 3000000n }).level).toBe("L2");
    expect(pe.decide({ ...base, amountPaise: 50000n, confidence: 0.8 }).level).toBe("L1");
    expect(pe.decide({ ...base, amountPaise: 50000n, counterpartyKnown: false }).level).toBe("L1");
    expect(pe.decide({ ...base, amountPaise: 50000n, overrideMax: "L1" }).level).toBe("L1");
  });

  it("falls back to the default before a policy's effective date", () => {
    expect(pe.decide({ eventCode: "EVT-TXN-INGESTED", on: "2026-09-01" }).policyIds).toEqual(["POL-000"]);
  });

  it("applies the strictest of several matching policies", () => {
    const txt = readFileSync(join(POLICY_DIR, "POL-201-budgeted-vendor-payment.md"), "utf8");
    const a = parsePolicy(txt);
    const b = parsePolicy(txt.replace("policy_id: POL-201", "policy_id: POL-999").replace("autonomy: L3", "autonomy: L1"));
    const def = parsePolicy(readFileSync(join(POLICY_DIR, "POL-000-global-default-for-unmatched-events.md"), "utf8"));
    const d = new PolicyEngine([a, b, def]).decide({ eventCode: "EVT-VENDOR-BILL-DUE", on: ON, amountPaise: 100n });
    expect(d.level).toBe("L1");
    expect(d.policyIds.sort()).toEqual(["POL-201", "POL-999"]);
  });
});

describe("parsers", () => {
  it("reads the HDFC-style CSV", () => {
    const t = parseBankCsv(readFileSync(join(ROOT, "samples", "hdfc_2026_10.csv"), "utf8"));
    expect(t).toHaveLength(10);
    expect(t[0]).toMatchObject({ direction: "in", amount: "11800000", txnDate: "2026-10-01" });
    expect(t[1]).toMatchObject({ counterpartyHint: "swiggy@icici", reference: "424512345601" });
  });

  it("reads amount + Dr/Cr layouts and quoted fields", () => {
    const t = parseBankCsv('Txn Date,Description,Amount,Dr/Cr\n2026-10-01,"Coffee, beans",120.00,DR\n01-Oct-2026,Refund,50,CR');
    expect(t.map((x) => [x.direction, x.amount, x.narration])).toEqual([["out", "12000", "Coffee, beans"], ["in", "5000", "Refund"]]);
  });

  it.each([
    ["Paid 450 to the plumber in cash", "out", "45000", "CASH"],
    ["Received 1.18 lakh from Acme for invoice 17 via bank", "in", "11800000", "BANK"],
    ["Spent 1,200 on groceries by card", "out", "120000", "CARD"],
    ["got 2k from mom via upi", "in", "200000", "BANK"],
  ])("chat: %s", (text, direction, amount, instrument) => {
    expect(parseChat(text, "2026-10-25")).toMatchObject({ direction, amount, instrument });
  });

  it("declines what it cannot read", () => {
    expect(parseChat("what's my balance?", "2026-10-25")).toBeNull();
  });
});
