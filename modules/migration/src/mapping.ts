/**
 * Account mapping suggestions (FIN-MIG-01): source ledger -> Kuber account. A suggestion is only a
 * proposal; a person approves every mapping, and an unmapped ledger with a balance or a line blocks
 * the load. Suspense is never a mapping target: it cannot be used to hide a mapping gap.
 *
 * Scoring: party ledgers and receivable/payable control accounts go to the book's control account
 * of the same nature (the party is carried on each line). Anything else: token similarity of the
 * names (with accounting synonyms: debtors = receivable, creditors = payable, ...) plus the group,
 * only among accounts of the same nature. Below 0.5, a new account of that nature is proposed.
 */
import type { Account } from "@kuber/contracts";
import type { SrcAccount } from "./types.ts";

export interface NewAccountSpec { accountId: string; name: string; nature: Account["nature"]; isCashLike: boolean }
export interface Suggestion { accountId: string; newAccount: NewAccountSpec | null; score: number; reason: string }

const SYNONYMS: Record<string, string> = {
  debtors: "receivable", debtor: "receivable", receivables: "receivable", creditors: "payable", creditor: "payable", payables: "payable",
  purchases: "purchase", sales: "sale", revenue: "sale", income: "income", expenses: "expense", exp: "expense", charges: "expense",
  gst: "gst", cgst: "gst", sgst: "gst", igst: "gst", tds: "tds", capital: "capital", equity: "capital", reserves: "reserve", surplus: "reserve",
  investments: "investment", loans: "loan", borrowings: "loan", cash: "cash", hand: "cash", bank: "bank", fees: "fee", professional: "fee",
  suspense: "suspense", salaries: "salary", wages: "salary",
};
const STOP = new Set(["a", "c", "ac", "account", "accounts", "the", "of", "and", "in", "on", "sundry", "ltd", "a/c", "other", "misc", "general", "dr", "cr"]);
export const tokens = (s: string) => new Set(s.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t)).map((t) => SYNONYMS[t] ?? t.replace(/s$/, "")));
export function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const t of x) if (y.has(t)) common++;
  return common / (x.size + y.size - common);
}

/** A suspense account (never a mapping target). */
export const isSuspenseAccount = (a: Pick<Account, "accountId" | "taxonomyTag">) => a.taxonomyTag === "BS.suspense" || /suspense/i.test(a.accountId);

/** An id for a new Kuber account from a source name: upper-case, A-Z 0-9 _, prefixed M_, unique among `taken`. */
export function newAccountId(name: string, taken: ReadonlySet<string>): string {
  const base = `M_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 28) || "ACCOUNT"}`;
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}

/**
 * Suggest a target for every source account. `accounts`: the target book's chart (closed accounts
 * excluded by the caller). New-account ids are unique across the whole suggestion set.
 */
export function suggestMappings(sources: SrcAccount[], accounts: Account[]): Map<string, Suggestion> {
  const out = new Map<string, Suggestion>();
  const taken = new Set(accounts.map((a) => a.accountId));
  const usable = accounts.filter((a) => !isSuspenseAccount(a));
  const bankSources = sources.filter((s) => s.bank);
  for (const s of sources) {
    const role = s.party ?? (s.control === "receivable" ? "customer" : s.control === "payable" ? "vendor" : null);
    if (role) {
      const nature = role === "customer" ? "asset" : "liability";
      const ctl = usable.filter((a) => a.isControl && a.nature === nature).sort((a, b) => similarity(b.name, role === "customer" ? "trade receivable" : "trade payable") - similarity(a.name, role === "customer" ? "trade receivable" : "trade payable"))[0];
      if (ctl) { out.set(s.key, { accountId: ctl.accountId, newAccount: null, score: 0.95, reason: `${role} ledger: the ${nature} control account, with the party on each line` }); continue; }
    }
    if (s.bank && bankSources.length === 1) {
      const bank = usable.find((a) => a.accountId === "BANK");
      if (bank) { out.set(s.key, { accountId: "BANK", newAccount: null, score: 0.9, reason: "the only bank ledger: the book's bank account" }); continue; }
    }
    let best: { a: Account; score: number } | null = null;
    for (const a of usable) {
      if (a.isControl) continue;                                  // control accounts take party ledgers only
      if (s.nature && a.nature !== s.nature) continue;
      if (s.bank && !a.isCashLike) continue;
      const score = Math.max(similarity(s.name, a.name), 0.8 * similarity(s.group ?? "", a.name)) + (s.nature ? 0.05 : 0);
      if (!best || score > best.score) best = { a, score };
    }
    if (best && best.score >= 0.5 && !(s.bank && bankSources.length > 1)) {
      out.set(s.key, { accountId: best.a.accountId, newAccount: null, score: Math.min(Math.round(best.score * 100) / 100, 0.99), reason: `name and group similar to ${best.a.name}` });
    } else if (s.nature) {
      const id = newAccountId(s.name, taken);
      taken.add(id);
      out.set(s.key, { accountId: id, newAccount: { accountId: id, name: s.name.slice(0, 120), nature: s.nature, isCashLike: s.bank }, score: 0.5,
        reason: best ? `closest existing account ${best.a.name} is not similar enough: a new ${s.nature} account` : `no ${s.nature} account like it: a new account` });
    }
    // no nature known and nothing similar: no suggestion; a person maps it
  }
  return out;
}
