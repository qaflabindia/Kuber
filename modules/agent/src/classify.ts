/**
 * Classification order (design section 4.2): the entity's explicit rules, then its own history
 * with the counterparty, then shared merchant knowledge, then the LLM, then suspense.
 *
 * The LLM step is optional and only runs when nothing deterministic matched. Its answer must be one
 * of the book's own accounts and its confidence is capped below every auto-posting threshold, so an
 * LLM classification always lands in the review queue as a draft; the person's approval then
 * becomes a rule and the LLM is not asked about that counterparty again.
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

/** Highest confidence an LLM suggestion can carry: below POL-502's 0.97, so it never auto-posts. */
export const LLM_MAX_CONFIDENCE = 0.9;

export interface ClassifierAccount { accountId: string; name: string; nature: string }
export interface ClassifierInput { tenantId: string; direction: "in" | "out"; narration: string; partyName: string | null; purpose?: string | undefined }
export interface LlmSuggestion { accountId: string; confidence: number; reason: string }

/** A language-model classifier. `name` identifies model and prompt version for the evidence trail (POL-502). */
export interface LlmClassifier {
  readonly name: string;
  /** Return null when unsure or unavailable; never throw for an expected failure. */
  suggest(input: ClassifierInput, accounts: ClassifierAccount[]): Promise<LlmSuggestion | null>;
}

export const accountNameCtx = (bookId: string, accountId: string) => `agent.accounts.name|${bookId}|${accountId}`;

export async function classify(tx: TransactionSql, tenantId: string, bookId: string, accounts: Set<string>, input: {
  direction: "in" | "out"; narration: string; partyId: string | null; partyName: string | null; purpose?: string | undefined;
}, keys?: TenantKeys, llm?: LlmClassifier): Promise<Classification> {
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

  if (llm) {
    const s = await suggestSafely(llm, tx, tenantId, bookId, input, keys);
    if (s) return s;
  }
  return { accountId: SUSPENSE, confidence: 0.3, source: "no rule, history or keyword matched" };
}

async function suggestSafely(llm: LlmClassifier, tx: TransactionSql, tenantId: string, bookId: string, input: {
  direction: "in" | "out"; narration: string; partyName: string | null; purpose?: string | undefined;
}, keys?: TenantKeys): Promise<Classification | null> {
  // Only accounts a transaction's other side can sensibly go to: not bank or cash, not suspense.
  const rows = await tx<{ account_id: string; nature: string; name: string }[]>`
    SELECT account_id, nature, name FROM agent.accounts
    WHERE tenant_id = ${tenantId} AND book_id = ${bookId} AND NOT is_cash_like AND account_id <> ${SUSPENSE} ORDER BY account_id`;
  const accounts = rows.map((r): ClassifierAccount => ({
    accountId: r.account_id, nature: r.nature,
    name: (keys && isToken(r.name) ? keys.openText(r.name, accountNameCtx(bookId, r.account_id)) : r.name) || r.account_id,
  }));
  if (!accounts.length) return null;
  let s: LlmSuggestion | null;
  try {
    s = await llm.suggest({ tenantId, direction: input.direction, narration: input.narration, partyName: input.partyName, purpose: input.purpose }, accounts);
  } catch (e) {
    // The pipeline must not stall on a model outage: fall through to suspense and let a person decide.
    console.warn(`llm classifier ${llm.name} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (!s || !accounts.some((a) => a.accountId === s.accountId)) return null;
  const confidence = Math.min(Math.max(s.confidence, 0), LLM_MAX_CONFIDENCE);
  return { accountId: s.accountId, confidence, source: `llm ${llm.name}: ${s.reason.replace(/\s+/g, " ").slice(0, 160)}` };
}
