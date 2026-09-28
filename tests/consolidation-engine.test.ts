import { describe, expect, it } from "vitest";
import { consolidate, emptyGroup, perimeter, type EntityPack, type GroupState } from "@kuber/consolidation";

function fixture() {
  const g: GroupState = { ...emptyGroup(), exists: true, groupId: "g", parentEntityId: "P", bookId: "group",
    entities: ["P", "A"].map(entityId => ({ entityId, name: entityId, bookId: entityId, linkedTenant: null, functionalCurrency: "INR" })),
    ownership: [{ recordId: "a", planId: "p", principal: "controller", parentEntityId: "P", childEntityId: "A", effectiveFrom: "2026-04-01", ownershipBp: 3000, votingBp: 3000, control: "significant_influence", method: "equity" }] };
  const packs = new Map<string, EntityPack>(["P", "A"].map(entityId => [entityId, { entityId, source: "certified", packHash: entityId, ref: {},
    tb: [{ accountId: "STOCK", name: "Stock", nature: "asset", taxonomyTag: "BS.inventories", balance: 2000000n },
      { accountId: "SALES", name: "Sales", nature: "income", taxonomyTag: "PL.revenue", balance: -4000000n }],
    ic: { entityId, balances: [], txns: [] } }]));
  return { g, packs };
}

describe("FIN-GRP-03 associate stock and ownership timing", () => {
  it("eliminates only 30% of downstream stock profit against the associate investment", () => {
    const { g, packs } = fixture();
    const r = consolidate(g, "2026-09-30", "2026-04-01", perimeter(g, "2026-09-30"), packs,
      [{ sellerEntityId: "P", buyerEntityId: "A", closingStockPaise: 2000000n, marginBp: 2000, buyerInventoryAccount: "STOCK" }]);
    expect(r.problems).toEqual([]);
    const j = r.journals.find(j => j.step === "urp-associate")!;
    // Stock ₹20,000 × 20% profit × 30% interest = ₹1,200.
    expect(j.lines.map(l => [l.accountId, l.amount])).toEqual([["GRP.unrealised_profit", 120000n], ["GRP.equity_investees", -120000n]]);
  });
  it("eliminates upstream profit from associate earnings and the parent's inventory", () => {
    const { g, packs } = fixture();
    const r = consolidate(g, "2026-09-30", "2026-04-01", perimeter(g, "2026-09-30"), packs,
      [{ sellerEntityId: "A", buyerEntityId: "P", closingStockPaise: 2000000n, marginBp: 2000, buyerInventoryAccount: "STOCK" }]);
    expect(r.problems).toEqual([]);
    expect(r.journals.find(j => j.step === "urp-associate")!.lines.map(l => [l.accountId, l.amount]))
      .toEqual([["GRP.share_of_associates", 120000n], ["BS.inventories", -120000n]]);
  });
  it("blocks whole-period treatment of a mid-period disposal", () => {
    const { g, packs } = fixture();
    g.ownership.push({ ...g.ownership[0]!, recordId: "dispose", effectiveFrom: "2026-08-01", method: "excluded", control: "none", exclusionReason: "disposed" });
    const r = consolidate(g, "2026-09-30", "2026-04-01", perimeter(g, "2026-09-30"), packs, []);
    expect(r.problems).toContainEqual(expect.stringContaining("mid-period ownership change"));
  });
  it("ignores future ownership changes when reproducing a historic period", () => {
    const { g, packs } = fixture();
    g.ownership.push({ ...g.ownership[0]!, recordId: "future", effectiveFrom: "2026-10-01", ownershipBp: 4000 });
    expect(consolidate(g, "2026-09-30", "2026-04-01", perimeter(g, "2026-09-30"), packs, []).problems).toEqual([]);
  });
});
