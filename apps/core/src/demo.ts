/**
 * Walk-through of one cell, in-process: a freelancer's first two months.
 *   DATABASE_URL=postgres://... [MIGRATION_URL=postgres://owner...] [APP_ROLE=kuber_app] pnpm demo
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatINR, uuid } from "@kuber/contracts";
import { renderText } from "@kuber/reporting";
import { Cell } from "./cell.ts";
import { MemoryKms } from "@kuber/crypto";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const T = `demo-${Date.now().toString(36)}`, B = "main", OWNER = "owner:laksh";
const clock = { value: "2026-10-25" };

const cell = await Cell.start({
  databaseUrl: process.env.DATABASE_URL ?? "postgres://kuber@localhost:5432/kuber",
  migrationUrl: process.env.MIGRATION_URL, appRole: process.env.APP_ROLE,
  policyDir: join(ROOT, "policies"), clock: () => clock.value,
  // The demo uses a throwaway in-memory master key: its data is unreadable after the process exits.
  kms: new MemoryKms(),
});
const csv = (f: string) => readFileSync(join(ROOT, "samples", f), "utf8");
const say = (s: string) => console.log(`\n${s}`);

try {
  say(`1. Open a freelancer book for tenant ${T} and declare opening balances`);
  await cell.gl.openBook(T, B, "laksh", "freelancer", OWNER);
  for (const [acc, amt] of [["BANK", 12500000n], ["CASH", 500000n], ["LOANS", -240000000n]] as const) {
    await cell.gl.execute(T, B, { kind: "PostJournal", journalId: uuid(), txnDate: "2026-09-30", narration: `Opening ${acc}`, voucherType: "opening",
      lines: [{ accountId: acc, amount: amt.toString(), dimensions: {} }, { accountId: "OPENING", amount: (-amt).toString(), dimensions: {} }] }, { principal: OWNER });
  }

  say("2. Chat entries (the person's own statement is the approval; bank entries stay provisional)");
  await cell.channels.submitChat(T, B, "Paid 450 to the plumber in cash", OWNER, "2026-10-05");
  await cell.channels.submitChat(T, B, "Received 1.18 lakh from Acme for invoice 17 via bank", OWNER, "2026-10-01");
  await cell.settle();

  say("3. October statement: new counterparties, so the agent drafts and asks");
  await cell.channels.submitStatement(T, B, csv("hdfc_2026_10.csv"), OWNER);
  await cell.settle();
  for (const d of await cell.agent.queue(T)) {
    const p = d.proposal as { accountId: string; narration: string; confidence: number; amount: string };
    const dec = d.decision as { level: string; reasons: string[] };
    console.log(`  ${String(d.status).padEnd(18)} ${p.accountId.padEnd(9)} ${formatINR(BigInt(p.amount)).padStart(12)}  ${dec.level}  ${dec.reasons[0] ?? ""}`);
  }

  say("4. You approve the queue; approvals teach the agent. The unknown ₹75,000 stays open.");
  for (const d of await cell.agent.queue(T)) {
    const p = d.proposal as { accountId: string };
    if (p.accountId !== "SUSPENSE") await cell.agent.approveDraft(T, d.draft_id as string, OWNER);
  }
  await cell.settle();

  say("5. November statement (clock 2026-11-25): known counterparties post on their own under POL-502");
  clock.value = "2026-11-25";
  await cell.channels.submitStatement(T, B, csv("hdfc_2026_11.csv"), OWNER);
  await cell.settle();
  for (const r of await cell.agent.openRatifications(T)) console.log(`  posted, awaiting ratification by ${r.due_by}: ${r.narration}`);
  for (const d of await cell.agent.queue(T)) {
    const dec = d.decision as { level: string; reasons: string[] };
    console.log(`  ${String(d.status).padEnd(18)} ${dec.level}  ${(d.proposal as { narration: string }).narration.slice(0, 48)}  (${dec.reasons.join("; ")})`);
  }

  say("6. Weekly review: ratify, and correct one Swiggy order that was a client lunch (business, not living).");
  console.log("   GL reverses and reposts; the agent limits itself for Swiggy for 30 days. One correction does not rewrite the Swiggy rule.");
  const open = await cell.agent.openRatifications(T);
  const lunch = open.find((r) => String(r.narration).includes("431512345613"));
  for (const r of open) if (r !== lunch) await cell.agent.ratify(T, r.journal_id as string, OWNER);
  if (lunch) await cell.agent.correct(T, lunch.journal_id as string, "BIZEXP", OWNER);
  await cell.settle();
  await cell.channels.submitStatement(T, B, "Date,Narration,Withdrawal Amt,Deposit Amt\n28/11/2026,UPI/DR/433912345616/SWIGGY/swiggy@icici,395,\n", OWNER);
  await cell.settle();
  const next = (await cell.agent.queue(T)).find((d) => (d.proposal as { narration: string }).narration.includes("433912345616"));
  console.log(`  next Swiggy order: ${next?.status} as ${(next?.proposal as { accountId: string } | undefined)?.accountId} (${(next?.decision as { reasons: string[] } | undefined)?.reasons.join("; ")})`);

  console.log("\n" + renderText(await cell.reporting.trialBalance(T, B)));
  console.log("\n" + renderText(await cell.reporting.profitAndLoss(T, B, "2026-10-01", "2026-11-30")));
  console.log("\n" + renderText(await cell.reporting.balanceSheet(T, B)));
  console.log("\n" + renderText(await cell.reporting.statementOfAffairs(T, B, "2026-09-30", "2026-11-30")));
  console.log(`\nHash chain intact: ${(await cell.gl.verify(T, B)) === null}`);
} finally {
  await cell.close();
}
