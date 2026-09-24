/** Pure in-memory fold benchmark; synthetic data, no database/network. Not an API load test. */
import { performance } from "node:perf_hooks";
import { emptyBook, evolve } from "../modules/gl/src/book.ts";
import type { Envelope } from "@kuber/contracts";

function run(n: number) {
  let state = emptyBook();
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    const event = { type: "JournalPosted", meta: { principal: "owner:synthetic" }, data: {
      journalId: `j-${i}`, seq: i + 1, txnDate: "2026-09-01", narration: "Synthetic replay",
      voucherType: "journal", provisional: false, hash: "0".repeat(64),
      lines: [{ accountId: "BANK", amount: "100", dimensions: {} }, { accountId: "OPENING", amount: "-100", dimensions: {} }],
    } } as Envelope;
    state = evolve(state, event);
  }
  return { journals: state.journals.size, foldMs: Math.round(performance.now() - start) };
}
run(200);
console.log(JSON.stringify({ node: process.version, benchmark: "synthetic cold fold; no SQL, crypto, I/O or hashing", samples: [1000, 3000, 10000].map(run) }, null, 2));
