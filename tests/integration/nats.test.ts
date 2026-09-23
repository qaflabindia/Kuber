/**
 * Integration: the same flow over real NATS JetStream with the outbox relay running as a loop,
 * as in production. Skipped unless KUBER_INTEGRATION=1 and a NATS server is reachable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Cell } from "@kuber/core";
import { startCell } from "../helpers.ts";

const enabled = process.env.KUBER_INTEGRATION === "1";
const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

describe.skipIf(!enabled)("over NATS JetStream", () => {
  let cell: Cell, stop: () => Promise<void>, relay: Promise<void>;
  const cellId = `it${Date.now().toString(36)}`;

  beforeAll(async () => {
    ({ cell, stop } = await startCell({ value: "2026-10-25" }, { bus: { natsUrl: NATS_URL }, cellId }));
    relay = cell.relay.run(20);
  });
  afterAll(async () => { cell.relay.stop(); await relay; await stop(); });

  const until = async <T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await f(); if (ok(v)) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); }
  };

  it("carries a statement through channels, agent, GL and reporting", async () => {
    await cell.gl.openBook("t", "b", "t", "freelancer", "owner:t");
    await cell.channels.submitStatement("t", "b", "Date,Narration,Withdrawal Amt,Deposit Amt\n02/10/2026,UPI/DR/1/SWIGGY/swiggy@icici,642,\n", "owner:t");
    const drafts = await until(() => cell.agent.queue("t"), (q) => q.length === 1);
    await cell.agent.approveDraft("t", drafts[0]!.draft_id as string, "owner:t");
    const tb = await until(() => cell.reporting.trialBalance("t", "b"), (s) => s.rows.some((r) => r.label.startsWith("LIVING")));
    expect(tb.totals["Difference (must be 0)"]).toBe(0n);
    expect(await cell.gl.verify("t", "b")).toBeNull();
  });
});
