/**
 * Context integrity for statements (incident 2026-09-28): a balance sheet computed from a reporting
 * projection behind the ledger must be marked PARTIAL in journals, never "complete (1 of 1 lines)".
 */
import { describe, expect, it } from "vitest";
import { completenessLine, completenessNote, statementCompleteness } from "../apps/core/src/agent-tools.ts";

describe("statements from a lagging projection are partial", () => {
  it("a fresh projection is whole in the statement's lines", () => {
    const [c, noun] = statementCompleteness({ basis: { fresh: true, projectedSeq: 4, ledgerSeq: 4 } }, 5);
    expect(c).toEqual({ complete: true, returned: 5, total: 5 });
    expect(noun).toBe("lines");
  });

  it("a lagging projection is PARTIAL in journals, with the reason in the line and the note", () => {
    const [c, noun] = statementCompleteness({ basis: { fresh: false, projectedSeq: 0, ledgerSeq: 4 } }, 1);
    expect(c).toMatchObject({ complete: false, returned: 0, total: 4, truncatedBy: "projection_lag" });
    expect(completenessLine(c, noun)).toMatch(/^Completeness: PARTIAL, showing 0 of 4 journals \(the reporting projection is behind the ledger/);
    expect(completenessNote(c, noun)).toMatch(/not totals of the whole/);
  });
});
