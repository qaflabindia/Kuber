/**
 * The group register (FIN-GRP-03), as a pure event-sourced aggregate: stream `<tenant>/group/<groupId>`.
 *
 *   structure   the group's entities (book in this tenant, linked tenant, or outside Kuber) and the
 *               reporting book (the consolidation book, basis "consolidation")
 *   mapping     each entity account to a group account: by default the account's own statement
 *               mapping (taxonomy tag, FIN-MDM-02), overridden per entity and account here
 *   ownership   effective-dated: parent, child, ownership %, voting %, control assessment, method
 *               (full | equity | excluded, with the reason), acquisition facts and the stock margin
 *   IC links    a party of one entity's party master IS another entity of the group (FIN-GRP-01)
 *
 * The register version is the stream version: consolidation runs and group closes are recorded in
 * a separate stream (`<tenant>/group-close/<groupId>`), so certifying never changes the register.
 */
import type { Envelope, EventData } from "@kuber/contracts";

export type GroupEntity = EventData<"GroupEntitiesSet">["entities"][number];
export type OwnershipRecord = Omit<EventData<"OwnershipRecorded">, "groupId"> & { principal: string };
export interface IcLink { entityId: string; partyId: string; counterpartyEntityId: string }

export interface GroupState {
  exists: boolean; groupId: string; name: string; bookId: string; parentEntityId: string;
  entities: GroupEntity[];
  /** `${entityId}|${accountId}` -> group account override. */
  mapping: Map<string, { groupAccount: string; name: string }>;
  ownership: OwnershipRecord[];
  icLinks: IcLink[];
  version: number;
}

export const groupStream = (tenant: string, groupId: string) => `${tenant}/group/${groupId}`;
export const closeStream = (tenant: string, groupId: string) => `${tenant}/group-close/${groupId}`;
export const disputeStream = (tenant: string, disputeId: string) => `${tenant}/ic-dispute/${disputeId}`;
export const linkStream = (tenant: string, linkId: string) => `${tenant}/group-link/${linkId}`;

export const emptyGroup = (): GroupState => ({ exists: false, groupId: "", name: "", bookId: "", parentEntityId: "", entities: [], mapping: new Map(), ownership: [], icLinks: [], version: 0 });

export function evolveGroup(s: GroupState, e: Envelope): GroupState {
  const n = { ...s, version: e.streamVersion };
  switch (e.type) {
    case "GroupDefined": {
      const d = e.data as EventData<"GroupDefined">;
      return { ...n, exists: true, groupId: d.groupId, name: d.name, bookId: d.bookId, parentEntityId: d.parentEntityId };
    }
    case "GroupEntitiesSet": return { ...n, entities: (e.data as EventData<"GroupEntitiesSet">).entities };
    case "GroupMappingSet": {
      const d = e.data as EventData<"GroupMappingSet">;
      const mapping = new Map(s.mapping); mapping.set(`${d.entityId}|${d.accountId}`, { groupAccount: d.groupAccount, name: d.groupAccountName });
      return { ...n, mapping };
    }
    case "OwnershipRecorded": {
      const { groupId: _g, ...d } = e.data as EventData<"OwnershipRecorded">;
      return { ...n, ownership: [...s.ownership, { ...d, principal: e.meta.principal }] };
    }
    case "IcPartyLinked": {
      const d = e.data as EventData<"IcPartyLinked">;
      return { ...n, icLinks: [...s.icLinks.filter((l) => !(l.entityId === d.entityId && l.partyId === d.partyId)), { entityId: d.entityId, partyId: d.partyId, counterpartyEntityId: d.counterpartyEntityId }] };
    }
    default: return n;
  }
}

/** The ownership record in force on `date` for (parent, child): the latest one effective on or before it. */
export function ownershipOn(s: GroupState, date: string, childEntityId: string): OwnershipRecord | null {
  let best: OwnershipRecord | null = null;
  for (const r of s.ownership) {
    if (r.childEntityId !== childEntityId || r.effectiveFrom > date) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom || (r.effectiveFrom === best.effectiveFrom)) best = r;   // same date: the later record wins
  }
  return best;
}

/** An exact fraction (effective interest): shares are num/den, rounded only when applied to paise. */
export interface Fraction { num: bigint; den: bigint }
export const bp = (x: number): Fraction => ({ num: BigInt(x), den: 10000n });
export const mul = (a: Fraction, b: Fraction): Fraction => ({ num: a.num * b.num, den: a.den * b.den });
export const one: Fraction = { num: 1n, den: 1n };
export const minus = (a: Fraction, b: Fraction): Fraction => ({ num: a.num * b.den - b.num * a.den, den: a.den * b.den });
/** amount x fraction, rounded half away from zero to the paisa. */
export function share(amount: bigint, f: Fraction): bigint {
  const p = amount * f.num, neg = p < 0n, a = neg ? -p : p;
  const q = (a * 2n + f.den) / (2n * f.den);
  return neg ? -q : q;
}
export const pct = (f: Fraction) => `${(Number(f.num * 1000000n / f.den) / 10000).toFixed(2)}%`;

export type Method = "parent" | "full" | "equity" | "excluded";
export interface PerimeterEntry {
  entityId: string; name: string; bookId: string | null; linkedTenant: string | null; functionalCurrency: string;
  method: Method;
  /** Direct investor (the record's parent), null for the group parent. */
  investor: string | null;
  /** Effective group interest (ownership through the chain) and NCI (full method). */
  interest: Fraction; nci: Fraction;
  ownershipBp: number | null; votingBp: number | null; control: string | null;
  record: OwnershipRecord | null;
  /** Why an entity is out of the aggregation, shown as a visible exclusion line. */
  exclusion: string | null;
}

/**
 * The consolidation perimeter on `date`: every entity of the group with its method and effective
 * interest. `currencyOf` gives the functional currency (the book's configuration when it has a book).
 * Books are INR-only until FIN-GL-04: a non-INR entity is excluded with a visible line, never translated.
 */
export function perimeter(s: GroupState, date: string, currencyOf: (e: GroupEntity) => string = (e) => e.functionalCurrency): PerimeterEntry[] {
  const byId = new Map(s.entities.map((e) => [e.entityId, e]));
  const memo = new Map<string, Fraction | null>();
  const interestOf = (id: string, seen: Set<string>): Fraction | null => {
    if (id === s.parentEntityId) return one;
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return null;                                       // a cycle holds nothing
    const r = ownershipOn(s, date, id);
    const up = r && r.method !== "excluded" ? interestOf(r.parentEntityId, new Set([...seen, id])) : null;
    const v = r && up ? mul(up, bp(r.ownershipBp)) : null;
    memo.set(id, v);
    return v;
  };
  return s.entities.map((e): PerimeterEntry => {
    const ccy = currencyOf(e);
    const base = { entityId: e.entityId, name: e.name, bookId: e.bookId, linkedTenant: e.linkedTenant, functionalCurrency: ccy };
    const r = e.entityId === s.parentEntityId ? null : ownershipOn(s, date, e.entityId);
    const zero = { num: 0n, den: 1n };
    const excluded = (why: string): PerimeterEntry => ({ ...base, method: "excluded", investor: r?.parentEntityId ?? null, interest: zero, nci: zero,
      ownershipBp: r?.ownershipBp ?? null, votingBp: r?.votingBp ?? null, control: r?.control ?? null, record: r, exclusion: why });
    if (ccy !== "INR") return excluded(`functional currency ${ccy} is not INR: currency translation is not available until FIN-GL-04, so ${e.entityId} is outside the perimeter (never translated silently)`);
    if (e.entityId === s.parentEntityId) return { ...base, method: "parent", investor: null, interest: one, nci: zero, ownershipBp: 10000, votingBp: 10000, control: "control", record: null, exclusion: null };
    if (!r) return excluded(`no ownership record in force on ${date}`);
    if (r.method === "excluded") return excluded(`excluded by the register: ${r.exclusionReason ?? "no reason recorded"}`);
    const interest = interestOf(e.entityId, new Set());
    if (!interest) return excluded(`its investor ${r.parentEntityId} is not held by the group on ${date}`);
    if (r.parentEntityId !== s.parentEntityId && byId.get(r.parentEntityId) === undefined) return excluded(`investor ${r.parentEntityId} is not an entity of the group`);
    return { ...base, method: r.method, investor: r.parentEntityId, interest, nci: r.method === "full" ? minus(one, interest) : zero,
      ownershipBp: r.ownershipBp, votingBp: r.votingBp, control: r.control, record: r, exclusion: null };
  });
}

/** Register rules: the method must follow the control assessment; an exclusion needs its reason. */
export function ownershipProblems(r: Pick<OwnershipRecord, "method" | "control" | "exclusionReason" | "ownershipBp" | "votingBp" | "acquisition" | "parentEntityId" | "childEntityId">): string[] {
  const out: string[] = [];
  if (r.parentEntityId === r.childEntityId) out.push("an entity cannot own itself");
  if (r.method === "full" && r.control !== "control") out.push(`full consolidation needs control; the assessment says ${r.control}`);
  if (r.method === "equity" && !["significant_influence", "joint_control"].includes(r.control)) out.push(`the equity method needs significant influence or joint control; the assessment says ${r.control}`);
  if (r.method === "excluded" && !r.exclusionReason?.trim()) out.push("an excluded entity needs the reason for its exclusion");
  if (r.method !== "excluded" && r.control === "none") out.push("an entity without control or influence is excluded, with the reason");
  if (r.method === "full" && !r.acquisition) out.push("full consolidation needs the acquisition facts (cost, investment account, equity at acquisition) to eliminate the investment");
  return out;
}
