/** Formatting shared by server and browser. Amounts arrive as paise strings; no floating point. */

export function inr(paise: string | bigint, opts: { sign?: boolean; decimals?: boolean } = {}): string {
  const p = typeof paise === "bigint" ? paise : BigInt(paise || "0");
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const rupees = (abs / 100n).toString();
  const ps = (abs % 100n).toString().padStart(2, "0");
  let head = rupees.length > 3 ? rupees.slice(0, -3) : "";
  const tail = rupees.length > 3 ? rupees.slice(-3) : rupees;
  const groups: string[] = [];
  while (head.length > 2) { groups.unshift(head.slice(-2)); head = head.slice(0, -2); }
  if (head) groups.unshift(head);
  const body = [...groups, tail].join(",");
  const dec = opts.decimals === false ? "" : `.${ps}`;
  const sign = neg ? "−" : opts.sign && p > 0n ? "+" : "";
  return `${sign}₹${body}${dec}`;
}

/** Compact Indian units for headline figures: ₹1.18 L, ₹2.4 Cr. */
export function inrShort(paise: string | bigint): string {
  const p = typeof paise === "bigint" ? paise : BigInt(paise || "0");
  const neg = p < 0n, r = Number((neg ? -p : p) / 100n);
  const s = r >= 1e7 ? `${(r / 1e7).toFixed(2)} Cr` : r >= 1e5 ? `${(r / 1e5).toFixed(2)} L` : r.toLocaleString("en-IN");
  return `${neg ? "−" : ""}₹${s}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function date(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}
export function dateShort(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/** Turn bank narrations into something a person reads: "UPI/DR/4245.../SWIGGY/swiggy@icici" -> Swiggy, "UPI · swiggy@icici". */
export function prettyNarration(n: string): { title: string; detail: string } {
  const t = n.trim();
  const upi = /^UPI[/-](?:DR|CR)?[/-]?\d*[/-]?([^/]+)[/-]?(.*)$/i.exec(t);
  if (upi) return { title: titleCase(upi[1]!.trim()), detail: `UPI${upi[2] ? " · " + upi[2].trim() : ""}` };
  const neft = /^(NEFT|IMPS|RTGS|ACH)\s*(?:CR|DR)?-?\s*(.*)$/i.exec(t);
  if (neft) {
    const rest = neft[2]!.replace(/-/g, " · ").trim();
    const [who, ...more] = rest.split(" · ");
    return { title: titleCase(who ?? rest), detail: `${neft[1]!.toUpperCase()}${more.length ? " · " + more.join(" · ") : ""}` };
  }
  const ob = /^Opening balance declared: (.+)$/.exec(t);
  if (ob) return { title: "Opening balance", detail: ACCOUNT_HINT[ob[1]!] ?? ob[1]! };
  if (/^INT\.?PD/i.test(t)) return { title: "Interest credited", detail: t };
  return { title: t.length > 60 ? t.slice(0, 57) + "…" : t, detail: "" };
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Pvt|Ltd|Llp)\b/g, (m) => m);

export const NATURE_LABEL: Record<string, string> = { asset: "Assets", liability: "Liabilities", equity: "Equity", income: "Income", expense: "Expenses" };
export const levelLabel = (l: string) => ({ L0: "Inform", L1: "Needs you", L2: "Needs approval", L3: "Posted · confirm", L4: "Automatic" } as Record<string, string>)[l] ?? l;

const ACCOUNT_HINT: Record<string, string> = { BANK: "Bank account", CASH: "Cash in hand", CARD: "Credit card", LOANS: "Loans" };

/** Policy decisions are recorded in the policy engine's vocabulary; say the same thing plainly. */
export function humanReason(r: string): string {
  let m: RegExpExecArray | null;
  if (/no active policy for/i.test(r)) return "No rule of yours covers this yet, so Kuber asks by default.";
  if ((m = /amount above limit of (₹[\d,]+)/i.exec(r))) return `Above ${m[1]}, the most Kuber may post on its own.`;
  if ((m = /confidence ([\d.]+) below ([\d.]+)/i.exec(r))) return `Kuber is ${Math.round(+m[1]! * 100)}% sure; it needs ${Math.round(+m[2]! * 100)}% to post on its own.`;
  if (/counterparty not yet known/i.test(r)) return "First time Kuber has seen this payee.";
  if (/after a recent correction/i.test(r)) return "You corrected a similar entry recently, so Kuber is asking.";
  if (/policies apply; strictest/i.test(r)) return "Several of your policies apply; the strictest decides.";
  return r.replace(/: (draft only|needs approval)$/, "").replace(/^./, (c) => c.toUpperCase());
}
