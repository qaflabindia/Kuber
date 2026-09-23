/**
 * Deterministic intent router: turns common instructions into operation calls without a language
 * model. Used when no model is configured, and as a fast path for unambiguous commands.
 * It never guesses an account: when a phrase does not name one, it asks.
 */
export interface Intent { op: string; input: Record<string, unknown>; note?: string }
export type Routed = { kind: "op"; intents: Intent[] } | { kind: "chat"; text: string } | { kind: "help"; text: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

/** "1.2 lakh", "90k", "₹1,30,206.50", "2 cr" -> rupees as a decimal string. */
export function amountIn(text: string): string | null {
  const m = /(?:₹|rs\.?\s*|inr\s*)?(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|l\b|k\b|thousand|crores?|cr\b)?/i.exec(text);
  if (!m) return null;
  const n = m[1]!.replace(/,/g, "");
  const unit = (m[2] ?? "").toLowerCase();
  const mul = /^(lakh|lac|l$)/.test(unit) ? 100000 : /^(k$|thousand)/.test(unit) ? 1000 : /^(crore|cr)/.test(unit) ? 10000000 : 1;
  if (mul === 1) return n;
  const [w, f = ""] = n.split(".");
  // exact decimal scaling without floating point
  const scaled = BigInt(w! + f) * BigInt(mul) / 10n ** BigInt(f.length);
  return scaled.toString();
}

/** ISO date, "31 Oct 2026", "Oct 2026" (month end), "FY 2026-27" (31 Mar 2027). */
export function dateIn(text: string, today: string): string | null {
  let m = /(\d{4}-\d{2}-\d{2})/.exec(text); if (m) return m[1]!;
  m = /fy\s*(\d{4})\s*[-/]\s*(\d{2,4})/i.exec(text); if (m) return `${Number(m[1]) + 1}-03-31`;
  m = /(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})/i.exec(text);
  if (m && MONTHS.includes(m[2]!.toLowerCase())) return `${m[3]}-${String(MONTHS.indexOf(m[2]!.toLowerCase()) + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  m = /\b([a-z]{3})[a-z]*\s+(\d{4})\b/i.exec(text);
  if (m && MONTHS.includes(m[1]!.toLowerCase())) return lastDay(Number(m[2]), MONTHS.indexOf(m[1]!.toLowerCase()) + 1);
  if (/\blast month\b/i.test(text)) { const d = new Date(today + "T00:00:00Z"); return lastDay(d.getUTCFullYear(), d.getUTCMonth()); }
  return null;
}

const accountsIn = (text: string, known: string[]) => known.filter((a) => new RegExp(`\\b${a}\\b`, "i").test(text));

export const HELP = [
  "Show my position", "Are the books in order?", "Post the drafts",
  "Reconcile bank to 1,30,206.50 as of 31 Oct 2026", "Rebalance BANK 40 INVEST 60",
  "Allocate BIZEXP 60 BIZEXP:Chennai 40 BIZEXP:Bengaluru", "What if rent goes up 15000 a month",
  "Income and expenses this year", "Close Oct 2026", "Close FY 2026-27", "Carry forward FY 2026-27",
];

export function route(text: string, today: string, accounts: string[]): Routed {
  const t = text.trim(), l = t.toLowerCase();
  if (/^(help|\?|what can you do)/.test(l)) return { kind: "help", text: "I can run any of these. Try:" };
  if (/(dashboard|position|overview|how am i doing|where do i stand|net worth|runway)/.test(l)) return { kind: "op", intents: [{ op: "dashboard", input: {} }] };
  if (/(in order|trial balance check|check (the )?books|books balance|integrity)/.test(l)) return { kind: "op", intents: [{ op: "balance", input: {} }] };
  if (/\breconcil/.test(l)) {
    const amt = amountIn(t.replace(/\d{4}-\d{2}-\d{2}|\d{1,2}\s+[a-z]{3}[a-z]*\.?\s+\d{4}/gi, "")), date = dateIn(t, today);
    const acc = accountsIn(t, accounts)[0] ?? (/card/.test(l) ? "CARD" : /cash/.test(l) ? "CASH" : "BANK");
    if (!amt || !date) return { kind: "help", text: "To reconcile I need the statement's closing balance and its date, e.g. \"Reconcile bank to 1,30,206.50 as of 31 Oct 2026\"." };
    return { kind: "op", intents: [{ op: "reconcile", input: { account: acc, statementBalance: amt, asOf: date } }] };
  }
  if (/carry\s*forward|open the new year/.test(l)) {
    const d = dateIn(t, today) ?? `${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 4 ? 0 : 1)}-03-31`;
    return { kind: "op", intents: [{ op: "carry_forward", input: { yearEnd: d } }] };
  }
  if (/\bclose\b/.test(l)) {
    const d = dateIn(t, today);
    if (!d) return { kind: "help", text: "Which period? e.g. \"Close Oct 2026\" or \"Close FY 2026-27\"." };
    return { kind: "op", intents: [{ op: "close", input: { periodEnd: d } }] };
  }
  if (/\bpost\b.*(draft|all|everything|entries)|approve (all|everything)/.test(l)) return { kind: "op", intents: [{ op: "post", input: {} }] };
  if (/\brebalanc/.test(l)) {
    const pairs = [...t.matchAll(/\b([a-z][a-z_]{1,15})\s*[:=]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?/gi)].map((m) => [m[0], m[1]!.toUpperCase(), m[2]!] as const).filter((m) => accounts.includes(m[1]));
    if (pairs.length < 2) return { kind: "help", text: "Give each account and its target share, e.g. \"Rebalance BANK 40 INVEST 60\"." };
    return { kind: "op", intents: [{ op: "rebalance", input: { targets: pairs.map((m) => ({ account: m[1], pct: m[2] })) } }] };
  }
  if (/\balloca/.test(l)) {
    const [from] = accountsIn(t.split(/\bto\b|\s\d/)[0] ?? t, accounts);
    const parts = [...t.matchAll(/(\d{1,3}(?:\.\d{1,2})?)\s*%?\s+([a-z][a-z_]{1,15})(?::([\w-]+))?/gi)].map((m) => [m[0], m[1]!, m[2]!.toUpperCase(), m[3]] as const).filter((m) => accounts.includes(m[2]));
    if (!from || !parts.length) return { kind: "help", text: "Say what to split and how, e.g. \"Allocate BIZEXP 60 BIZEXP:Chennai 40 BIZEXP:Bengaluru\"." };
    return { kind: "op", intents: [{ op: "allocate", input: { from, to: parts.map((m) => ({ account: m[2], weight: m[1], ...(m[3] ? { dimensions: { costCentre: m[3] } } : {}) })) } }] };
  }
  if (/what if|simulat|can i afford|suppose/.test(l)) {
    const amt = amountIn(t);
    if (!amt) return { kind: "help", text: "Give me an amount to try, e.g. \"What if rent goes up 15000 a month\"." };
    const monthly = /(a|per|each|every)\s+month|monthly|\/\s*month|\bp\.?m\b/.test(l);
    const income = /(earn|income|salary|raise|revenue|receive)/.test(l) && !/(spend|pay|rent|emi|cost|expense)/.test(l);
    if (monthly) return { kind: "op", intents: [{ op: "simulate", input: { monthlyChange: income ? { income: amt } : { expenses: amt }, months: 12 } }] };
    const [acc] = accountsIn(t, accounts);
    if (!acc) return { kind: "help", text: "Which account would a one-off hit? e.g. \"What if I spend 90k on BIZEXP\"." };
    return { kind: "op", intents: [{ op: "simulate", input: { entries: [{ narration: t.slice(0, 120), amount: amt, direction: income ? "in" : "out", account: acc }], months: 12 } }] };
  }
  const reportKind = /balance sheet|own and owe/.test(l) ? "balance-sheet" : /trial balance/.test(l) ? "trial-balance" : /statement of affairs/.test(l) ? "statement-of-affairs"
    : /(p\s*&\s*l|profit|income and expenses|income & expenses|spending|report)/.test(l) ? "profit-and-loss" : null;
  if (reportKind) return { kind: "op", intents: [{ op: "report", input: { kind: reportKind } }] };
  // Anything that reads like a transaction goes through capture, which classifies and applies policy.
  if (amountIn(t) && /(paid|pay|spent|bought|received|got|transfer|deposit|withdrew|salary|rent|emi)/.test(l)) return { kind: "chat", text: t };
  return { kind: "help", text: "I didn't recognise that. Try one of these:" };
}
