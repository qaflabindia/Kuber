/**
 * Posting controls added for the finance requirements, kept out of book.ts so its changes stay
 * small. Each function is pure and throws DomainError when a posting must be refused.
 *
 *   FIN-GL-04  single currency: a journal naming any currency other than the book's (INR) is refused.
 *   FIN-GL-01  control accounts: a manual entry to a control account must be a controlled adjustment,
 *              flagged by an owner or controller, and every control line carries its party.
 *   FIN-GL-05  suspense: amounts leave suspense only through a suspense resolution (which reverses
 *              the original and posts its replacement), never through a balancing journal.
 */
import { BOOK_CURRENCY, CURRENCY_EXPONENT, isBookCurrency, type Account, type Line } from "@kuber/contracts";
import { DomainError, type BookState } from "./book.ts";
import { JournalMap } from "./journals.ts";

const PRIVILEGED = new Set(["owner", "controller"]);
const roleOf = (principal: string) => principal.split(":")[0] ?? "";

export function assertBookCurrency(currency: string | undefined) {
  if (isBookCurrency(currency)) return;
  throw new DomainError("currency_not_supported",
    `journal currency ${currency} is not supported: this book is ${BOOK_CURRENCY} only (amounts in paise, exponent ${CURRENCY_EXPONENT[BOOK_CURRENCY]}); foreign currency is deferred (FIN-GL-04)`);
}

/** A manual (person-entered) journal: control accounts only as a controlled adjustment by an owner or controller. */
export function checkManualControl(s: BookState, lines: Line[], principal: string, adjustment: { reason: string } | undefined) {
  const control = lines.filter((l) => s.accounts.get(l.accountId)?.isControl);
  if (!control.length) return;
  const ids = [...new Set(control.map((l) => l.accountId))].join(", ");
  if (!adjustment) {
    throw new DomainError("control_account_manual",
      `${ids} is a control account: it is posted from its subledger, not by a manual entry; a correction must be a controlled adjustment with the party`);
  }
  if (!adjustment.reason?.trim()) throw new DomainError("control_account_manual", "a controlled adjustment needs a reason");
  if (!PRIVILEGED.has(roleOf(principal))) throw new DomainError("forbidden", `only an owner or controller may make a controlled adjustment to ${ids}`);
  const missing = control.filter((l) => !l.partyId);
  if (missing.length) throw new DomainError("control_needs_party", `a controlled adjustment to ${ids} must name the party (subledger reference) on every control line`);
}

export const isSuspense = (a: Account | undefined) => !!a && (a.accountId === "SUSPENSE" || a.taxonomyTag === "BS.suspense");

export function suspenseLines(s: BookState, lines: Line[]) { return lines.filter((l) => isSuspense(s.accounts.get(l.accountId))); }

function balance(s: BookState, accountId: string): bigint {
  const fast = s.journals instanceof JournalMap ? s.journals.balances() : null;
  if (fast) return fast.get(accountId) ?? 0n;
  let b = 0n;
  for (const j of s.journals.values()) for (const l of j.lines) if (l.accountId === accountId) b += BigInt(l.amount);
  return b;
}

/**
 * A new suspense amount arises from an unexplained money movement, and each one is an item.
 * Clearing goes through ResolveSuspense. So:
 *   - a manual journal (a person's entry: API, ops) may pair suspense only with money accounts;
 *     moving amounts between suspense and anything else is a balancing entry: refused;
 *   - any journal that moves a suspense balance towards zero against anything other than money
 *     accounts would hide open items: refused.
 */
export function checkSuspenseClearing(s: BookState, lines: Line[], manual = false) {
  const sus = suspenseLines(s, lines);
  if (!sus.length) return;
  const others = lines.filter((l) => !sus.includes(l));
  const onlyMoney = others.every((l) => s.accounts.get(l.accountId)?.isCashLike);
  if (onlyMoney) return;
  if (manual) {
    throw new DomainError("suspense_unresolved",
      "a manual journal cannot move amounts between suspense and other accounts: suspense is cleared only by resolving its items (resolve_suspense)");
  }
  const delta = new Map<string, bigint>();
  for (const l of sus) delta.set(l.accountId, (delta.get(l.accountId) ?? 0n) + BigInt(l.amount));
  for (const [id, d] of delta) {
    const before = balance(s, id), after = before + d;
    const abs = (x: bigint) => (x < 0n ? -x : x);
    if (abs(after) < abs(before)) {
      throw new DomainError("suspense_unresolved",
        `this journal clears ${id} without resolving its items; resolve each suspense item (it reverses the original and posts the replacement)`);
    }
  }
}

/**
 * Correcting (reclassifying) a journal that put an amount in suspense would clear it back-dated to
 * the original date: only a suspense resolution may reclassify it. A plain reversal is allowed: it
 * resolves the item as reversed (the agent links it), dated as the reversal is.
 */
export function checkNotSuspenseOriginal(s: BookState, journalId: string) {
  const j = s.journals.get(journalId);
  if (j && suspenseLines(s, j.lines).length) {
    throw new DomainError("suspense_unresolved", `${journalId} holds a suspense item: resolve the item instead of reversing or correcting the journal`);
  }
}
