/**
 * F15 in the web shell: a failed attention (or verification) call is shown as unavailable, never
 * as zero or as an empty queue. apps/web/src/routes/+layout.server.ts turns each failed call into
 * null and builds the shell with shellState; +layout.svelte renders waitingRail and integrityLabel.
 */
import { describe, expect, it } from "vitest";
import { integrityLabel, isCurrent, navSections, searchNav, shellState, waitingRail, type ShellInputs } from "../apps/web/src/lib/shell.ts";

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

describe("navigation menu: role-aware, with waiting counts as badges", () => {
  const perms = (xs: string[]) => shellState({ ...ok, me: { role: "x", permissions: xs } }, "x");
  const hrefs = (xs: string[]) => navSections(perms(xs)).flatMap((s) => s.items.map((i) => i.href));

  it("a reader sees the books, cash, close and reports, but not import or administration", () => {
    const h = hrefs(["read"]);
    expect(h).toEqual(expect.arrayContaining(["/", "/cfo", "/review", "/confirm", "/ledger", "/bank", "/close", "/statements", "/reports/balance-sheet"]));
    expect(h).not.toContain("/import");
    expect(h).not.toContain("/settings/members");
    expect(h).not.toContain("/migration");
  });

  it("administration appears only with its permissions; a system owner is not shown the books", () => {
    expect(hrefs(["read", "capture", "members.read", "migration.manage"])).toEqual(expect.arrayContaining(["/import", "/settings/members", "/migration"]));
    expect(hrefs(["self", "agent.system", "agent.turns.read"])).toEqual(["/"]);
  });

  it("a failed member call falls back to reading pages, never administration", () => {
    const sh = shellState({ ...ok, me: null }, "superuser");
    expect(sh.permissions).toBeNull();
    const h = navSections(sh).flatMap((s) => s.items.map((i) => i.href));
    expect(h).toContain("/ledger");
    expect(h).not.toContain("/settings/members");
  });

  it("waiting counts become badges on the page that holds them; zero shows no badge", () => {
    const sh = shellState({ ...ok, attention: { drafts: 3, awaitingApproval: 1, ratifications: 0, plans: 2, closeTasksOverdue: 1 }, me: { role: "controller", permissions: ["read"] } }, "x");
    const items = navSections(sh).flatMap((s) => s.items);
    const b = (h: string) => items.find((i) => i.href === h)?.badge;
    expect(b("/")).toEqual({ count: 2, tone: "brass" });
    expect(b("/review")).toEqual({ count: 3, tone: "clay" });
    expect(b("/close")).toEqual({ count: 1, tone: "clay" });
    expect(b("/confirm")).toBeUndefined();
  });

  it("the current item follows the path; the Canvas only at /", () => {
    const items = navSections(perms(["read", "members.read"])).flatMap((s) => s.items);
    const on = (p: string) => items.filter((i) => isCurrent(i, p)).map((i) => i.href);
    expect(on("/")).toEqual(["/"]);
    expect(on("/ledger/1100")).toEqual(["/ledger"]);
    expect(on("/settings/members")).toEqual(["/settings/members"]);
    expect(on("/ledgerx")).toEqual([]);
  });

  it("the palette search matches labels and keywords, label matches first", () => {
    const secs = navSections(perms(["read"]));
    expect(searchNav(secs, "bal")[0]?.href).toBe("/reports/balance-sheet");
    expect(searchNav(secs, "p&l").map((i) => i.href)).toEqual(["/reports/profit-and-loss"]);
    expect(searchNav(secs, "tally")).toEqual([]);
    expect(searchNav(secs, "").length).toBe(secs.flatMap((s) => s.items).length);
  });
});
