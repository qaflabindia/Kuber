/**
 * Classification order (design section 4.2): the entity's explicit rules, then its own history
 * with the counterparty, then shared merchant knowledge, then suspense. The LLM classifier slot
 * sits between merchant knowledge and suspense and is empty in phase 0, so every decision here
 * is explainable and repeatable.
 */
import type { TransactionSql } from "postgres";
import { isToken, type TenantKeys } from "@kuber/crypto";

export const SUSPENSE = "SUSPENSE";

/** keyword -> [account when money goes out, account when money comes in] */
export const MERCHANTS: Record<string, [string | null, string | null]> = {
  swiggy: ["LIVING", null], zomato: ["LIVING", null], bigbasket: ["LIVING", null], blinkit: ["LIVING", null],
  zepto: ["LIVING", null], grocer: ["LIVING", null], grocery: ["LIVING", null], groceries: ["LIVING", null],
  uber: ["LIVING", null], ola: ["LIVING", null], rent: ["LIVING", null], electricity: ["LIVING", null],
  plumber: ["LIVING", null], netflix: ["LIVING", null], petrol: ["LIVING", null],
  salary: [null, "SALARY"], "sal cr": [null, "SALARY"], interest: [null, "OTHINC"], "int.pd": [null, "OTHINC"],
  dividend: [null, "OTHINC"], refund: [null, "OTHINC"],
  invoice: [null, "FEES"], fees: [null, "FEES"], consulting: [null, "FEES"],
  aws: ["BIZEXP", null], github: ["BIZEXP", null], adobe: ["BIZEXP", null], "google workspace": ["BIZEXP", null],
  hosting: ["BIZEXP", null], domain: ["BIZEXP", null], coworking: ["BIZEXP", null],
  "home loan emi": ["LOANS", null], "loan emi": ["LOANS", null],
};

export interface Classification { accountId: string; confidence: number; source: string }

export async function classify(tx: TransactionSql, tenantId: string, bookId: string, accounts: Set<string>, input: {
  direction: "in" | "out"; narration: string; partyId: string | null; partyName: string | null; purpose?: string | undefined;
}, keys?: TenantKeys): Promise<Classification> {
  const text = [input.narration, input.partyName ?? "", input.purpose ?? ""].join(" ").toLowerCase();

  const stored = await tx<{ pattern: string; pattern_idx: string | null; account_id: string }[]>`
    SELECT pattern, pattern_idx, account_id FROM agent.rules WHERE tenant_id = ${tenantId} ORDER BY rule_id DESC`;
  // Patterns are sealed; substring matching happens here, after decryption, never in SQL.
  const rules = stored.map((r) => ({ ...r, pattern: keys && isToken(r.pattern) ? keys.openText(r.pattern, `agent.rules.pattern|${r.pattern_idx}`) : r.pattern }));
  for (const r of rules) {
    if (text.includes(r.pattern) && accounts.has(r.account_id)) return { accountId: r.account_id, confidence: 0.99, source: `rule '${r.pattern}'` };
  }

  if (input.partyId) {
    const hist = await tx<{ account_id: string; n: number }[]>`
      SELECT account_id, n FROM agent.party_accounts
      WHERE tenant_id = ${tenantId} AND book_id = ${bookId} AND party_id = ${input.partyId} AND n > 0 ORDER BY n DESC`;
    if (hist.length) {
      const total = hist.reduce((s, h) => s + h.n, 0);
      const top = hist[0]!;
      const share = top.n / total;
      const confidence = top.n >= 3 && share >= 0.8 ? 0.98 : share >= 0.8 ? 0.9 : 0.7;
      return { accountId: top.account_id, confidence, source: `history (${top.n} of ${total} entries)` };
    }
  }

  for (const [kw, [outAcc, inAcc]] of Object.entries(MERCHANTS).sort((a, b) => b[0].length - a[0].length)) {
    if (!text.includes(kw)) continue;
    const acc = input.direction === "out" ? outAcc : inAcc;
    if (acc && accounts.has(acc)) return { accountId: acc, confidence: 0.85, source: `merchant keyword '${kw}'` };
  }
  return { accountId: SUSPENSE, confidence: 0.3, source: "no rule, history or keyword matched" };
}
