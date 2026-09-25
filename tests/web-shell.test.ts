/**
 * F15 in the web shell: a failed attention (or verification) call is shown as unavailable, never
 * as zero or as an empty queue. apps/web/src/routes/+layout.server.ts turns each failed call into
 * null and builds the shell with shellState; +layout.svelte renders waitingRail and integrityLabel.
 */
import { describe, expect, it } from "vitest";
import { integrityLabel, shellState, waitingRail, type ShellInputs } from "../apps/web/src/lib/shell.ts";

const ok: ShellInputs = {
  attention: { drafts: 3, awaitingApproval: 1, ratifications: 2, plans: 1 },
  journals: [{}], verify: { intact: true }, me: { role: "controller", permissions: ["members.read"] },
};

describe("F15: the web shell shows unavailable controls as unavailable", () => {
  it("a failed attention call is 'unavailable', with no counts, not an empty queue", () => {
    const sh = shellState({ ...ok, attention: null }, "owner");
    expect(sh).toMatchObject({ attentionAvailable: false, reviewCount: null, awaitingApproval: null, confirmCount: null, pendingPlans: null });
    expect(waitingRail(sh)).toEqual({ state: "unavailable" });
  });

  it("an answered attention call with nothing waiting is an empty queue, and counts show when there are some", () => {
    const empty = shellState({ ...ok, attention: { drafts: 0, awaitingApproval: 0, ratifications: 0, plans: 0 } }, "owner");
    expect(empty.attentionAvailable).toBe(true);
    expect(waitingRail(empty)).toEqual({ state: "items", items: [] });
    const rail = waitingRail(shellState(ok, "owner"));
    expect(rail.state === "items" && rail.items.map((i) => [i.href, i.count, i.tone])).toEqual([["/", 1, "brass"], ["/review", 3, "clay"], ["/confirm", 2, "brass"]]);
  });

  it("a failed verification is 'unavailable', distinct from verified and from a broken chain", () => {
    expect(shellState({ ...ok, verify: null }, "owner").intact).toBeNull();
    expect(integrityLabel(null)).toBe("Ledger check unavailable");
    expect(integrityLabel(true)).toBe("Ledger verified");
    expect(integrityLabel(false)).toBe("Ledger check failed");
  });

  it("the role falls back to the session's when the member call fails; members stay hidden", () => {
    expect(shellState({ ...ok, me: null, journals: null }, "preparer")).toMatchObject({ role: "preparer", canSeeMembers: false, hasJournals: false });
  });
});
