/**
 * Intercompany (FIN-GRP-01/02), pure functions.
 *
 * Tagging: a journal is intercompany when a line on a control account (receivables, payables)
 * carries a party that the register links to another entity of the group. Its reciprocal
 * identifier is the IC reference field (line dimension `ic_ref`, on any line of the journal);
 * without one the journal matches only in the "(no reference)" bucket of its counterparty and period.
 *
 * Matching pairs the two entities' IC journals by counterparty, document (ic_ref), currency and
 * period, and gives each document one status:
 *   matched     both sides recorded the same amount in the same period and currency
 *   in_transit  the sender recorded more than the receiver has so far (nothing, or part): the
 *               difference stays open and visible with its explanation; nothing is plugged
 *   mismatch    anything else, classified: period, fx, tax or amount
 *   disputed / resolved   a dispute is open on the document, or both sides agreed its resolution
 * A match never creates an entry anywhere: differences are cleared only by each entity's own
 * people approving a plan in their own book (ic_adjust).
 */
import type { BookState } from "@kuber/gl";
import type { IcLink } from "./register.ts";

/** Dimension carrying the reciprocal identifier (document / IC reference). */
export const IC_REF = "ic_ref";
/** Optional dimension stating the document currency of an intercompany document (FIN-GL-04 pending: INR only). */
export const IC_CURRENCY = "ic_currency";
export const NO_REF = "(no reference)";

export interface IcTxn {
  entityId: string; counterpartyEntityId: string; journalId: string; seq: number; txnDate: string; period: string;
  docRef: string; currency: string;
  /** Control-account lines with the counterparty's party (debit positive: a receivable from it). */
  control: bigint;
  /** Lines on statutory (tax) accounts, and on income/expense accounts, of the same journal. */
  tax: bigint; pl: bigint;
  /** Income / expense lines by account (signed), for the P&L elimination. */
  plLines: { accountId: string; nature: "income" | "expense"; amount: bigint }[];
}
export interface IcBalance { entityId: string; counterpartyEntityId: string; accountId: string; balance: bigint }
export interface IcSchedule { balances: IcBalance[]; txns: IcTxn[] }

const isTax = (tag: string | undefined) => !!tag && /^BS\.statutory/.test(tag);

/**
 * The IC schedule of one entity's book as of journal `upToSeq` and date `asOf`: control-account
 * balances with each counterparty entity, and every IC journal (txnDate from `from`, if given).
 * The n-th journal of the book is journal seq n (the GL numbers journals contiguously), so the
 * schedule at a certified pack's seq is reproducible from the hash-chained ledger.
 */
export function icSchedule(entityId: string, s: BookState, links: IcLink[], upToSeq: number, asOf: string, from: string | null = null): IcSchedule {
  const party = new Map(links.filter((l) => l.entityId === entityId).map((l) => [l.partyId, l.counterpartyEntityId]));
  const bal = new Map<string, IcBalance>();
  const txns: IcTxn[] = [];
  let seq = 0;
  for (const [journalId, j] of s.journals) {
    seq++;
    if (seq > upToSeq) break;
    if (j.txnDate > asOf) continue;
    const ic = j.lines.filter((l) => l.partyId && party.has(l.partyId) && s.accounts.get(l.accountId)?.isControl);
    if (!ic.length) continue;
    const byCp = new Map<string, bigint>();
    for (const l of ic) {
      const cp = party.get(l.partyId!)!;
      byCp.set(cp, (byCp.get(cp) ?? 0n) + BigInt(l.amount));
      const k = `${cp}|${l.accountId}`;
      const b = bal.get(k) ?? { entityId, counterpartyEntityId: cp, accountId: l.accountId, balance: 0n };
      b.balance += BigInt(l.amount); bal.set(k, b);
    }
    if (from && j.txnDate < from) continue;
    const ref = j.lines.map((l) => l.dimensions?.[IC_REF]).find((r) => !!r?.trim()) ?? NO_REF;
    const ccy = j.lines.map((l) => l.dimensions?.[IC_CURRENCY]).find((r) => !!r?.trim()) ?? "INR";
    const others = j.lines.filter((l) => !ic.includes(l));
    const tax = others.filter((l) => isTax(s.accounts.get(l.accountId)?.taxonomyTag)).reduce((a, l) => a + BigInt(l.amount), 0n);
    const plLines = others.filter((l) => ["income", "expense"].includes(s.accounts.get(l.accountId)?.nature ?? ""))
      .map((l) => ({ accountId: l.accountId, nature: s.accounts.get(l.accountId)!.nature as "income" | "expense", amount: BigInt(l.amount) }));
    for (const [cp, control] of byCp) {
      // A journal naming two counterparties is split by its control amounts; P&L and tax go with the first.
      txns.push({ entityId, counterpartyEntityId: cp, journalId, seq, txnDate: j.txnDate, period: j.txnDate.slice(0, 7), docRef: ref, currency: ccy, control,
        tax: cp === [...byCp.keys()][0] ? tax : 0n, pl: cp === [...byCp.keys()][0] ? plLines.reduce((a, l) => a + l.amount, 0n) : 0n,
        plLines: cp === [...byCp.keys()][0] ? plLines : [] });
    }
  }
  return { balances: [...bal.values()].filter((b) => b.balance !== 0n).sort((a, b) => `${a.counterpartyEntityId}|${a.accountId}`.localeCompare(`${b.counterpartyEntityId}|${b.accountId}`)), txns };
}

export type IcStatus = "matched" | "in_transit" | "mismatch" | "disputed" | "resolved";
export interface IcItem {
  /** sender>receiver|document|currency: stable across runs (disputes refer to it). */
  key: string; senderEntityId: string; receiverEntityId: string; docRef: string; currency: string;
  senderPeriods: string[]; receiverPeriods: string[];
  sent: bigint; received: bigint; matched: bigint; difference: bigint;
  status: IcStatus; classification: "none" | "period" | "fx" | "tax" | "amount" | "not_recorded_by_receiver" | "not_recorded_by_sender";
  explanation: string; journals: { entityId: string; journalId: string; txnDate: string; amount: bigint }[];
  disputeId?: string;
}
export interface IcDisputeView { disputeId: string; itemKey: string; status: "open" | "resolved"; agreedPaise: string | null }

const rs = (p: bigint) => { const n = p < 0n ? -p : p; return `${p < 0n ? "-" : ""}₹${(n / 100n).toLocaleString("en-IN")}.${String(n % 100n).padStart(2, "0")}`; };

/**
 * Match two sides' IC journals. The sender of a document is the side whose control line is a
 * debit (it holds the receivable: it sent goods, services or cash); the receiver owes it.
 */
export function matchIc(txns: IcTxn[], disputes: IcDisputeView[] = []): IcItem[] {
  const groups = new Map<string, IcTxn[]>();
  for (const t of txns) {
    // Orient by the document's sender: a debit control line means this entity sent.
    const [sender, receiver] = t.control > 0n ? [t.entityId, t.counterpartyEntityId] : [t.counterpartyEntityId, t.entityId];
    const key = `${sender}>${receiver}|${t.docRef}|${t.currency}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const out: IcItem[] = [];
  for (const [key, ts] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [pair, docRef, currency] = key.split("|") as [string, string, string];
    const [senderEntityId, receiverEntityId] = pair.split(">") as [string, string];
    const s = ts.filter((t) => t.entityId === senderEntityId), r = ts.filter((t) => t.entityId === receiverEntityId);
    const sent = s.reduce((a, t) => a + t.control, 0n), received = -r.reduce((a, t) => a + t.control, 0n);
    const senderPeriods = [...new Set(s.map((t) => t.period))].sort(), receiverPeriods = [...new Set(r.map((t) => t.period))].sort();
    const matched = sent > 0n && received > 0n ? (sent < received ? sent : received) : 0n;
    const difference = sent - received;
    const sTax = s.reduce((a, t) => a + t.tax, 0n), rTax = r.reduce((a, t) => a + t.tax, 0n);
    const currencies = new Set(ts.map((t) => t.currency));
    let status: IcStatus, classification: IcItem["classification"], explanation: string;
    const periodsDiffer = s.length > 0 && r.length > 0 && senderPeriods.join() !== receiverPeriods.join();
    if (difference === 0n && !periodsDiffer && currency === "INR") {
      status = "matched"; classification = "none"; explanation = `${rs(sent)} sent by ${senderEntityId} and received by ${receiverEntityId}`;
    } else if (difference === 0n && periodsDiffer) {
      status = "mismatch"; classification = "period";
      explanation = `same amount ${rs(sent)}, but ${senderEntityId} recorded it in ${senderPeriods.join(", ")} and ${receiverEntityId} in ${receiverPeriods.join(", ")}`;
    } else if (currency !== "INR" || currencies.size > 1) {
      status = "mismatch"; classification = "fx";
      explanation = `document currency ${[...currencies].join("/")}: foreign-currency intercompany documents cannot be matched until FIN-GL-04; ${rs(difference)} open`;
    } else if (r.length === 0) {
      status = "in_transit"; classification = "not_recorded_by_receiver";
      explanation = `${rs(sent)} sent by ${senderEntityId}, not yet received by ${receiverEntityId}`;
    } else if (s.length === 0) {
      status = "mismatch"; classification = "not_recorded_by_sender";
      explanation = `${receiverEntityId} recorded ${rs(received)} that ${senderEntityId} has not recorded`;
    } else if (difference !== 0n && (sTax !== 0n || rTax !== 0n) && difference === -sTax - rTax) {
      // The sender's tax is a credit (output tax, negative), the receiver's a debit (input credit): the
      // difference is exactly the tax one side recorded and the other did not.
      status = "mismatch"; classification = "tax";
      explanation = `${rs(difference)} difference equals the tax recorded differently (${senderEntityId} output tax ${rs(-sTax)}, ${receiverEntityId} input tax ${rs(rTax)})`;
    } else if (difference > 0n) {
      status = "in_transit"; classification = "amount";
      explanation = `${rs(sent)} sent by ${senderEntityId}, ${rs(received)} received by ${receiverEntityId}: ${rs(difference)} open (sent, not received); no plug entry`;
    } else {
      status = "mismatch"; classification = "amount";
      explanation = `${receiverEntityId} recorded ${rs(received)}, more than the ${rs(sent)} ${senderEntityId} sent: ${rs(-difference)} open`;
    }
    const d = disputes.find((x) => x.itemKey === key);
    if (d && status !== "matched") status = d.status === "open" ? "disputed" : "resolved";
    out.push({ key, senderEntityId, receiverEntityId, docRef, currency, senderPeriods, receiverPeriods, sent, received, matched, difference, status, classification,
      explanation: d?.status === "resolved" ? `${explanation}; resolved bilaterally at ${rs(BigInt(d.agreedPaise ?? "0"))}, awaiting each entity's own adjustment` : explanation,
      journals: ts.map((t) => ({ entityId: t.entityId, journalId: t.journalId, txnDate: t.txnDate, amount: t.control })), ...(d ? { disputeId: d.disputeId } : {}) });
  }
  return out;
}

/** Reciprocal balance check per pair: A's IC balance with B against B's with A (should be equal and opposite). */
export function balancePairs(balances: IcBalance[]) {
  const net = new Map<string, bigint>();
  for (const b of balances) net.set(`${b.entityId}>${b.counterpartyEntityId}`, (net.get(`${b.entityId}>${b.counterpartyEntityId}`) ?? 0n) + b.balance);
  const pairs = new Set([...net.keys()].map((k) => k.split(">").sort().join("|")));
  return [...pairs].sort().map((p) => {
    const [a, b] = p.split("|") as [string, string];
    const ab = net.get(`${a}>${b}`) ?? 0n, ba = net.get(`${b}>${a}`) ?? 0n;
    return { a, b, aWithB: ab, bWithA: ba, difference: ab + ba };
  });
}
