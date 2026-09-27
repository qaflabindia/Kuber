/** Matching evidence shared by provisional matching and bank settlement matching (FIN-CASH-02). */
/** Words that say nothing about who the counterparty is: rails, banks, verbs, units, document words. */
export const MATCH_STOP = new Set(["upi", "neft", "imps", "rtgs", "ach", "nach", "ecs", "txn", "ref", "reference", "the", "and", "paid", "payment",
  "transfer", "transferred", "cash", "spent", "received", "sent", "gave", "got", "credited", "debited", "collected", "earned", "bought",
  "via", "from", "for", "bank", "card", "pos", "atm", "p2m", "p2a", "lakh", "lakhs", "crore", "crores", "rupees", "inr", "using", "through",
  "with", "yesterday", "today", "gpay", "phonepe", "paytm", "netbanking", "hdfc", "icici", "sbi", "axis", "kotak", "invoice", "inv", "bill",
  "receipt", "order", "ltd", "pvt", "private", "limited", "llp", "inc", "mr", "mrs", "ms", "shri", "smt", "chq", "cheque", "online", "fund", "funds"]);

export function matchWords(...texts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of (t ?? "").toLowerCase().replace(/@[a-z0-9.\-]+/g, " ").split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && !/^\d+$/.test(w) && !MATCH_STOP.has(w)) out.add(w);
    }
  }
  return out;
}

/** A shared word, or one word the start of the other (at least 4 letters: "acme" / "acmecorp"). */
export function wordsOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) for (const y of b) {
    if (x === y) return true;
    const [s, l] = x.length <= y.length ? [x, y] : [y, x];
    if (s.length >= 4 && l.startsWith(s)) return true;
  }
  return false;
}

/** References worth matching: the reference column and long digit runs (UTR, cheque numbers). */
export function refsOf(reference: string | undefined, narration: string): Set<string> {
  const out = new Set<string>();
  const r = (reference ?? "").trim().toLowerCase();
  if (r.length >= 6 && !/^0+$/.test(r)) out.add(r);
  for (const m of narration.toLowerCase().match(/\b[a-z]*\d{6,}\b/g) ?? []) if (!/^0+$/.test(m)) out.add(m);
  return out;
}
