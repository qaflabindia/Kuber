/**
 * Deterministic intent router: the copilot's static fast path (AAWDS L3 "mixed": program code
 * resolves what it can; the bounded model loop runs only when this cannot). No language model.
 *
 * It maps natural phrasing to read tools (chart of accounts, sales, expenses, reports, balances,
 * ledgers, search, review, attention, cash, policies, parties) and to the operation plans (record,
 * post, reconcile, allocate, rebalance, close, carry forward, simulate, position). Account names
 * are matched fuzzily against the chart for reads; for writes it never guesses an account: a
 * phrase that does not name one exactly and uniquely gets a short clarifying question instead.
 */
export interface Intent { op: string; input: Record<string, unknown>; note?: string }
export interface ReadCall { tool: string; args: Record<string, unknown> }
export type Routed =
  | { kind: "op"; intents: Intent[] }
  | { kind: "read"; calls: ReadCall[] }
  | { kind: "chat"; text: string }
  /** Context integrity (never captured): a standing business rule stated in chat, to become a governed proposal, never conversation memory. */
  | { kind: "standing_rule"; rule: StandingRule }
  | { kind: "clarify"; text: string; suggestions?: string[] }
  | { kind: "help"; text: string; reason: "asked" | "unrecognised" };
/** A standing rule: a classification rule (pattern → account) or a policy statement (a POL-900 note). */
export type StandingRule = { kind: "classification"; pattern: string; account: string; statedAs: string } | { kind: "policy"; statement: string };
/** An account as the router sees it: id and name, with nature and cash flag when known. */
export interface AccountRef { id: string; name: string; nature?: string; cash?: boolean }
export interface RouteOptions { fyStartMonth?: number }

export const ROUTER_VERSION = "2.0.0";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const monthIdx = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

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

// ---------------------------------------------------------------- periods
export interface Period { from: string; to: string; label: string }

/** The fiscal year containing `iso` (start month `start`, April by default). */
export function fiscalYear(iso: string, start = 4): Period {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  const s = m >= start ? y : y - 1, endY = start === 1 ? s : s + 1, endM = start === 1 ? 12 : start - 1;
  return { from: `${s}-${pad(start)}-01`, to: lastDay(endY, endM), label: start === 1 ? `FY ${s}` : `FY ${s}-${pad((s + 1) % 100)}` };
}
const monthPeriod = (y: number, m: number): Period =>
  ({ from: `${y}-${pad(m)}-01`, to: lastDay(y, m), label: `${new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", { month: "short", timeZone: "UTC" })} ${y}` });
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fullYear = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s));

/** A reporting period named in the text ("this month", "last FY", "Oct 2026", "Q2", "FY 2026-27", "from … to …"), or null. */
export function periodIn(text: string, today: string, fyStart = 4): Period | null {
  const l = text.toLowerCase();
  const iso = [...l.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
  if (iso.length >= 2 && /\b(from|between|to|and|till|until)\b|–|-\s/.test(l)) {
    const [a, b] = iso[0]! <= iso[1]! ? [iso[0]!, iso[1]!] : [iso[1]!, iso[0]!];
    return { from: a, to: b, label: `${a} to ${b}` };
  }
  const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
  const fy = fiscalYear(today, fyStart);
  let m = /\bfy\s*'?(\d{2,4})\s*[-/–]\s*'?(\d{2,4})\b/.exec(l);
  if (m) return fiscalYear(`${fullYear(m[1]!)}-${pad(fyStart)}-01`, fyStart);
  m = /\bfy\s*'?(\d{4}|\d{2})\b/.exec(l);
  if (m) { const y = fullYear(m[1]!); return fiscalYear(fyStart === 1 ? `${y}-01-01` : `${y - 1}-${pad(fyStart)}-01`, fyStart); }
  m = /\bq([1-4])\b/.exec(l);
  if (m) {
    const q = Number(m[1]) - 1, startM0 = fyStart - 1 + q * 3;
    const y = Number(fy.from.slice(0, 4)) + Math.floor(startM0 / 12), sm = (startM0 % 12) + 1;
    const end = new Date(Date.UTC(y, sm - 1 + 3, 0)).toISOString().slice(0, 10);
    return { from: `${y}-${pad(sm)}-01`, to: end, label: `Q${q + 1} ${fy.label}` };
  }
  if (/\b(this|current) month\b|\bmonth to date\b|\bmtd\b|\bso far this month\b/.test(l)) return monthPeriod(ty, tm);
  if (/\b(last|previous|past) month\b/.test(l)) return tm === 1 ? monthPeriod(ty - 1, 12) : monthPeriod(ty, tm - 1);
  if (/\b(last|previous|past) (fy|financial year|fiscal year|year)\b/.test(l)) return fiscalYear(addDays(fy.from, -1), fyStart);
  if (/\b(this|current) (fy|financial year|fiscal year|year)\b|\bytd\b|\byear to date\b|\bso far this year\b|\bthis fy\b/.test(l)) return fy;
  if (/\btoday\b/.test(l)) return { from: today, to: today, label: "today" };
  if (/\byesterday\b/.test(l)) { const d = addDays(today, -1); return { from: d, to: d, label: "yesterday" }; }
  // a named month, with or without a year; "may" only with a year or a preposition
  const re = new RegExp(String.raw`(?:\b(in|for|during|of|since|over)\s+)?\b${MONTH_RE}\b\.?(?:\s*,?\s*'?(\d{4}|\d{2})\b)?`, "g");
  for (const mm of l.matchAll(re)) {
    const word = mm[2]!, year = mm[3];
    if (word === "may" && !year && !mm[1]) continue;
    const mi = monthIdx(word);
    const y = year ? fullYear(year) : mi <= tm ? ty : ty - 1;
    return monthPeriod(y, mi);
  }
  return null;
}

// ---------------------------------------------------------------- accounts
const ACCOUNT_STOP = new Set(["the", "my", "our", "a", "an", "of", "account", "accounts", "acct", "ac", "a/c", "balance", "in", "for", "on", "to", "from", "and", "please", "me", "show", "what", "is", "whats", "s", "ledger", "statement"]);
const stem = (w: string) => (w.length > 3 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !ACCOUNT_STOP.has(w)).map(stem);

/**
 * Accounts that `query` may name, best first: exact id or name scores 1; otherwise simple token
 * overlap between the query and the account's name and id (case-insensitive, plural-insensitive,
 * prefixes of four or more letters count), weighted towards covering the query.
 */
export function matchAccounts(query: string, accounts: AccountRef[]): (AccountRef & { score: number })[] {
  const q = query.trim().toLowerCase().replace(/[?.!]+$/, "");
  const qt = [...new Set(tokens(q))];
  const out: (AccountRef & { score: number })[] = [];
  for (const a of accounts) {
    if (a.id.toLowerCase() === q || a.name.toLowerCase() === q) { out.push({ ...a, score: 1 }); continue; }
    if (!qt.length) continue;
    const nt = [...new Set([...tokens(a.name), ...tokens(a.id.replace(/[:_]/g, " "))])];
    const nameT = [...new Set(tokens(a.name))];
    const hit = (w: string) => nt.some((n) => n === w || (w.length >= 4 && n.startsWith(w)) || (n.length >= 4 && w.startsWith(n)));
    const overlap = qt.filter(hit).length;
    if (!overlap) continue;
    const covered = nameT.filter((n) => qt.some((w) => n === w || (w.length >= 4 && n.startsWith(w)) || (n.length >= 4 && w.startsWith(n)))).length;
    const score = 0.6 * (overlap / qt.length) + 0.4 * (nameT.length ? covered / nameT.length : 0);
    out.push({ ...a, score: Math.round(score * 1000) / 1000 });
  }
  return out.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
}

export type Resolved = { kind: "one"; id: string } | { kind: "ambiguous"; options: AccountRef[] } | { kind: "none" };
/**
 * One account for a phrase. Reads accept a clear best fuzzy match; writes accept only an exact
 * id or name (or an unambiguous full-name match): otherwise the caller asks, it never guesses.
 */
export function resolveAccount(phrase: string, accounts: AccountRef[], mode: "read" | "write"): Resolved {
  const m = matchAccounts(phrase, accounts);
  if (!m.length) return { kind: "none" };
  const [a, b] = m;
  if (mode === "write") {
    if (a!.score === 1 && (!b || b.score < 1)) return { kind: "one", id: a!.id };
    return { kind: "ambiguous", options: m.slice(0, 4) };
  }
  if (a!.score >= 0.5 && (!b || a!.score - b.score >= 0.2)) return { kind: "one", id: a!.id };
  return { kind: "ambiguous", options: m.slice(0, 4) };
}

const idsIn = (text: string, known: string[]) => known.filter((a) => new RegExp(`(^|[^\\w:])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w:])`, "i").test(text));
const listOf = (opts: AccountRef[]) => opts.map((o) => `${o.id} (${o.name})`).join(", ");

// ---------------------------------------------------------------- help
export const HELP_GROUPS: { title: string; items: string[] }[] = [
  { title: "Ask about the books", items: ["Chart of accounts", "Sales this month", "Expenses by category this year", "Profit and loss for last month", "Trial balance", "Balance sheet", "Balance of BANK", "Find Swiggy over 500"] },
  { title: "What needs doing", items: ["What needs my attention?", "Drafts to review", "Cash and runway", "Suspense items", "Are the books in order?"] },
  { title: "Prepare a change (you approve it)", items: ["Record 1499 printer ink to BIZEXP from bank", "Post the drafts", "Reconcile bank to 1,30,206.50 as of 31 Oct 2026", "Close Oct 2026", "What if rent goes up 15000 a month"] },
  { title: "Policies", items: ["What is the policy for a vendor bank change?"] },
];
/** Short starter set for the canvas chips (one or two from each group). */
export const HELP = ["What needs my attention?", "Sales this month", "Expenses by category", "Chart of accounts", "Cash and runway", "Are the books in order?"];
export const helpText = (lead: string) => `${lead}\n` + HELP_GROUPS.map((g) => `${g.title}: ${g.items.map((i) => `"${i}"`).join(", ")}.`).join("\n");

// ---------------------------------------------------------------- the router
const read = (tool: string, args: Record<string, unknown> = {}): Routed => ({ kind: "read", calls: [{ tool, args }] });
const op = (name: string, input: Record<string, unknown> = {}): Routed => ({ kind: "op", intents: [{ op: name, input }] });
const clarify = (text: string, suggestions?: string[]): Routed => ({ kind: "clarify", text, ...(suggestions?.length ? { suggestions } : {}) });
const period = (p: Period | null) => (p ? { from: p.from, to: p.to } : {});
const QUESTION = /^(what|how|show|can|could|would|do|did|does|is|are|which|where|when|why|list|give|tell|display|get|view|see|open|find|search|please)\b/;

export function route(text: string, today: string, accountsIn: (string | AccountRef)[], opts: RouteOptions = {}): Routed {
  const accounts: AccountRef[] = accountsIn.map((a) => (typeof a === "string" ? { id: a, name: a } : a));
  const ids = accounts.map((a) => a.id);
  const fyStart = opts.fyStartMonth ?? 4;
  const t = text.trim().replace(/\s+/g, " "), l = t.toLowerCase().replace(/[’`]/g, "'");
  const p = () => periodIn(t, today, fyStart);

  if (!t) return { kind: "help", text: helpText("Here is what I can do:"), reason: "asked" };
  if (/^(help|\?|what can you do|what do you do|how (do|can) i use|commands|menu|options|capabilities)\b/.test(l)) return { kind: "help", text: helpText("I can answer from your books and prepare changes for you to approve:"), reason: "asked" };
  if (/^(hi|hello|hey|namaste|good (morning|afternoon|evening))\b[\s!.,]*$/.test(l)) return { kind: "help", text: helpText("Hello. Ask me about your books, for example:"), reason: "asked" };

  // ------------------------------------------------ standing rules (never remembered as conversation: a governed proposal)
  const standing = standingRuleIn(t, accounts);
  if (standing) return standing;

  // A question about named policies is a policy lookup, never an operation it happens to mention ("POL-502 says auto-post ... which wins?").
  if (/\bpol[-\s]?\d{3}\b/i.test(l) && (l.includes("?") || QUESTION.test(l))) return read("kuber_policies", { query: policyQuery(t) });

  // ------------------------------------------------ operations (plans a person approves)
  if (/\bwhat if\b|\bsimulat|\bcan i afford\b|\bsuppose\b/.test(l)) {
    const amt = amountIn(t);
    if (!amt) return clarify("Give me an amount to try, e.g. \"What if rent goes up 15000 a month\".");
    const monthly = /(a|per|each|every)\s+month|monthly|\/\s*month|\bp\.?m\b/.test(l);
    const income = /(earn|income|salary|raise|revenue|receive|sales)/.test(l) && !/(spend|pay|rent|emi|cost|expense)/.test(l);
    if (monthly) return op("simulate", { monthlyChange: income ? { income: amt } : { expenses: amt }, months: 12 });
    const [acc] = idsIn(t, ids);
    if (!acc) return clarify("Which account would a one-off hit? e.g. \"What if I spend 90k on BIZEXP\".", accounts.filter((a) => a.nature === "expense").slice(0, 3).map((a) => `What if I spend ${amt} on ${a.id}`));
    return op("simulate", { entries: [{ narration: t.slice(0, 120), amount: amt, direction: income ? "in" : "out", account: acc }], months: 12 });
  }
  if (/\breconcil/.test(l)) {
    const amt = amountIn(t.replace(/\d{4}-\d{2}-\d{2}|\d{1,2}\s+[a-z]{3}[a-z]*\.?\s+\d{4}/gi, "")), date = dateIn(t, today);
    const acc = idsIn(t, ids)[0] ?? (/card/.test(l) ? "CARD" : /cash/.test(l) ? "CASH" : "BANK");
    if (!amt || !date) return clarify("To reconcile I need the statement's closing balance and its date, e.g. \"Reconcile bank to 1,30,206.50 as of 31 Oct 2026\".");
    return op("reconcile", { account: acc, statementBalance: amt, asOf: date });
  }
  if (/carry\s*forward|open the new year/.test(l)) {
    const d = dateIn(t, today) ?? `${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 4 ? 0 : 1)}-03-31`;
    return op("carry_forward", { yearEnd: d });
  }
  if (/^(please\s+|can you\s+|let's\s+)?(close|lock)\b|\bclose (the )?(books|period|month|year|fy|quarter)\b|\bclose\s+(fy|q[1-4]|\d)/.test(l) || new RegExp(String.raw`\bclose\s+${MONTH_RE}`).test(l)) {
    const d = dateIn(t, today);
    if (!d) return clarify("Which period? e.g. \"Close Oct 2026\" or \"Close FY 2026-27\".");
    return op("close", { periodEnd: d });
  }
  if (/\bpost\b.*(drafts?|all|everything|entries|pending)|approve (all|everything)/.test(l)) return op("post");
  if (/\brebalanc/.test(l)) {
    const pairs = [...t.matchAll(/\b([a-z][a-z_]{1,15})\s*[:=]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?/gi)].map((m) => [m[0], m[1]!.toUpperCase(), m[2]!] as const).filter((m) => ids.includes(m[1]));
    if (pairs.length < 2) return clarify("Give each account and its target share, e.g. \"Rebalance BANK 40 INVEST 60\".");
    return op("rebalance", { targets: pairs.map((m) => ({ account: m[1], pct: m[2] })) });
  }
  if (/\balloca/.test(l)) {
    const [from] = idsIn(t.split(/\bto\b|\s\d/)[0] ?? t, ids);
    const parts = [...t.matchAll(/(\d{1,3}(?:\.\d{1,2})?)\s*%?\s+([a-z][a-z_]{1,15})(?::([\w-]+))?/gi)].map((m) => [m[0], m[1]!, m[2]!.toUpperCase(), m[3]] as const).filter((m) => ids.includes(m[2]));
    if (!from || !parts.length) return clarify("Say what to split and how, e.g. \"Allocate BIZEXP 60 BIZEXP:Chennai 40 BIZEXP:Bengaluru\".");
    return op("allocate", { from, to: parts.map((m) => ({ account: m[2], weight: m[1], ...(m[3] ? { dimensions: { costCentre: m[3] } } : {}) })) });
  }
  if (/^(please\s+)?(record|add|book|enter|log)\b/.test(l) && amountIn(t.replace(/\d{4}-\d{2}-\d{2}/g, ""))) return recordIntent(t, today, accounts);
  // Anything that reads like a transaction (not a question) goes through capture, which classifies and applies policy.
  if (!QUESTION.test(l) && !l.includes("?") && amountIn(t) && /\b(paid|pay|spent|bought|received|got|transfer(red)?|deposit(ed)?|withdrew|salary|rent|emi)\b/.test(l)) return { kind: "chat", text: t };

  // ------------------------------------------------ reads
  // Mapped statements and KPIs (FIN-RPT-01/02): read operations, before the cash / profit / schedule phrasings below.
  const kpi = metricIn(l);
  if (kpi && /\b(drill|behind|break ?down|what makes up|made up of|explain|why|details?|journals?|evidence)\b/.test(l)) return op("kpi_drill", { metric: kpi, ...period(p()) });
  if (kpi) return op("kpis", { metrics: [kpi], ...period(p()) });
  if (/\bkpis?\b|\bkey (metrics|ratios)\b|\b(financial|accounting) ratios\b|\bratio analysis\b|\bmetric catalogue\b/.test(l)) return op("kpis", period(p()));
  if (/\bcash ?flows?( statement)?\b|\bstatement of cash ?flows?\b|\bfunds? flow\b/.test(l)) return op("cash_flow", period(p()));
  if (/\b(statement of )?changes in equity\b|\bequity (statement|movements?|roll ?forward)\b|\bstatement of (shareholders'? )?equity\b/.test(l)) return op("equity_statement", period(p()));
  if (/\bfinancial statements\b|\bschedule (iii|3)\b|\bmapped statements\b|\bnotes to (the )?(accounts|statements)\b/.test(l)) return op("financial_statements", period(p()));
  if (/\b(what|anything|something) (needs|requires) (my |our )?(attention|approval|action)|needs? my (attention|approval)|\bwhat('s| is) (pending|waiting|outstanding|open)\b|\banything (pending|waiting|to do|for me)\b|\bmy (to-?do|tasks|inbox)\b|\bwhat should i (do|look at)\b|\battention\b/.test(l)) return read("kuber_attention");
  if (/\bmatch(es|ing)? reviews?\b|\breview (the )?match|\bstatement lines? to match\b|\bpossible duplicates?\b|\bunmatched\b/.test(l)) return read("kuber_match_reviews");
  if (/\bpost\b/.test(l) && /\bdrafts?\b/.test(l)) return op("post");
  if (/\b(drafts?|review queue|to review|in review|for review|awaiting (my )?approval|pending (entries|items|transactions|approvals?)|needs? review|unapproved|review)\b/.test(l)) return read("kuber_review_queue");
  if (/\b(open|pending|waiting|proposed)\s+plans?\b|\bplans? (waiting|pending|open|to approve)\b|^(my |the )?plans\??$/.test(l)) return read("kuber_plans");
  if (/\blifecycle\b|\bfailed (postings?|entries|journals?)\b|\brejected (entries|postings?|journals?)\b|\bjournal (status|states)\b|\bwhat failed\b/.test(l)) return read("kuber_lifecycle", /\bfail|reject/.test(l) ? { state: "failed" } : {});
  if (/\b(in order|check (the |my )?books|books? (balance|ok|okay|correct|tally|in shape)|integrity|do the books tally|books healthy)\b/.test(l)) return op("balance");
  if (/\bsuspense\b|\bunclassified\b|\buncategori[sz]ed\b/.test(l)) return op("suspense", period(p()));
  if (/\bschedules?\b|\brecurring (entries|journals|payments)\b|\bamorti[sz]|\bprepaid\b|\bdeferred (revenue|income)\b/.test(l)) return op("schedules", {});
  if (/\bchart of accounts?\b|\bc\.?o\.?a\b|\baccount (list|tree|heads)\b|\b(list|show|see|view|all|what)( me)?( all)?( of)?( (my|the|our))? accounts\b(?!\s+(payable|receivable))|^(my |the |all )?accounts\s*(please)?\??$|\b(asset|liability|liabilities|equity|income|expense)s? accounts\b/.test(l)) {
    const cat = /\b(asset|liabilit(y|ies)|equity|income|expense)s? accounts\b/.exec(l)?.[1];
    return read("kuber_chart_of_accounts", cat ? { category: cat.startsWith("liabilit") ? "liability" : cat } : {});
  }
  if (/\btrial balance\b|\btb\b/.test(l)) { const d = dateIn(t, today); return read("kuber_trial_balance", d ? { asOf: d } : {}); }
  if (/\bbalance ?sheet\b|\bown and (what i )?owe\b|\bassets and liabilities\b/.test(l)) { const d = dateIn(t, today); return read("kuber_balance_sheet", d ? { asOf: d } : {}); }
  if (/\bp\s*&\s*l\b|\bp\s*and\s*l\b|\bpnl\b|\bprofit\b|\bloss\b|\bincome statement\b|\bsurplus\b|\bnet income\b|\bbottom line\b|\bincome (and|&) expen/.test(l)) return read("kuber_profit_and_loss", period(p()));
  if (/\bpolic(y|ies)\b|\bpol[-\s]?\d{3}\b|\b(rules?|limits?) (for|on|about)\b|\bapproval (limit|matrix)\b|\bwho (approves|can approve|signs off)\b|\bdelegation of authority\b/.test(l)) return read("kuber_policies", { query: policyQuery(t) });
  if (/\b(vendors?|suppliers?|customers?|clients?|parties|party|payees?|counterpart(y|ies))\b/.test(l) && !/\b(paid|pay|owe)\b/.test(l)) {
    const kind = /\b(vendors?|suppliers?|payees?)\b/.test(l) ? "vendor" : /\b(customers?|clients?)\b/.test(l) ? "customer" : undefined;
    const named = /\b(?:named|called|like|matching)\s+(.+?)\??$/.exec(t)?.[1];
    return read("kuber_parties", { ...(kind ? { kind } : {}), ...(named ? { query: named } : {}) });
  }
  // balance of <account>, <account> balance, ledger for <account>
  const bal = /\bbalance (?:of|in|for|on)\s+(.+?)[?.!]*$/i.exec(t) ?? /\bhow much (?:is|do i have|do we have|money is) in (?:my |the |our )?(.+?)[?.!]*$/i.exec(t)
    ?? /^(?:what(?:'s| is)|show|tell me)?\s*(?:me\s+)?(?:my |the |our )?(.+?)(?:'s)?\s+balance[?.!]*$/i.exec(t);
  const led = /\b(?:ledger|statement|transactions|entries|movements?|activity|history)\s+(?:for|of|in|on)\s+(?:my |the |our )?(.+?)[?.!]*$/i.exec(t)
    ?? /^(?:show|open|view|see)\s+(?:me\s+)?(?:my |the |our )?(.+?)\s+(?:ledger|account|statement|transactions)[?.!]*$/i.exec(t);
  const cashWords = /\b(cash|runway|liquidity|burn rate|how long (will|can|would) (my |the |our )?(money|cash|funds|savings) last|money do (i|we) have)\b/.test(l);
  const ledgerFor = (phrase: string, limit?: number): Routed | null => {
    const per = periodIn(phrase, today, fyStart);
    const clean = phrase.replace(new RegExp(String.raw`\b(this|last|previous|current) (month|year|fy|financial year)\b|\b(in|for|during|since|from)\s+${MONTH_RE}\b.*$|\bfy\s*\S+|\d{4}-\d{2}-\d{2}.*$`, "gi"), "").replace(/\b(in|for|during|from)\s*$/i, "").trim();
    const r = resolveAccount(clean || phrase, accounts, "read");
    if (r.kind === "one") return read("kuber_ledger", { account: r.id, ...period(per), ...(limit ? { limit } : {}) });
    if (r.kind === "ambiguous") return clarify(`Which account do you mean by "${clean}": ${listOf(r.options)}?`, r.options.map((o) => `${limit ? "Balance of" : "Ledger for"} ${o.id}`));
    return null;
  };
  if (bal && !(cashWords && !/\b(of|in|for|on)\b/.test(l))) {
    const r = ledgerFor(bal[1]!, 10);
    if (r) return r;
    if (!cashWords) return clarify(`I couldn't find an account called "${bal[1]}". Say "Chart of accounts" to see the list, or give the account id.`, ["Chart of accounts"]);
  }
  if (led) {
    const r = ledgerFor(led[1]!);
    if (r) return r;
  }
  if (cashWords || /\bbank balance\b|\bhow much money\b/.test(l)) return read("kuber_cash_position");
  if (/\b(dashboard|position|overview|how am i doing|how are we doing|how('s| is) (my|our) (business|finances)|where do (i|we) stand|net worth|financial health|summary)\b/.test(l)) return op("dashboard");
  if (/^(find|search|look ?up|look for)\b|\b(show|list|give)( me)?( all)? (transactions|entries|journals|payments|receipts)\s+(with|containing|mentioning|about|matching|to|from|for|over|above|under|below)\b|\bany (transactions|entries|payments) (to|from|for|with|mentioning)\b/.test(l)) return read("kuber_search_journals", searchArgs(t, today, fyStart, accounts));
  if (/\b(sales|revenue|revenues|income|incomes|earnings|earned|earn|turnover|takings|top ?line|receipts|how much (did|have) (i|we) (make|made)|money (came|coming) in|inflows?)\b/.test(l)) {
    const acc = accountFilter(t, accounts, "income", /\b(?:from|of|for|on|by)\s+(?:the |my |our )?(.+?)(?:\s+(?:this|last|in|for|during|since|over)\b.*)?[?.!]*$/i);
    return read("kuber_income_breakdown", { ...period(p()), ...(acc ? { account: acc } : {}) });
  }
  if (/\b(expenses?|expenditure|spend|spends|spending|spent|costs?|outgoings?|outflows?|burn|where (did|does|is) (my|the|our) money go(ing)?|bills)\b/.test(l)) {
    const acc = accountFilter(t, accounts, "expense", /\b(?:on|for|under|in)\s+(?:the |my |our )?(.+?)(?:\s+(?:this|last|in|for|during|since|over|by)\b.*)?[?.!]*$/i);
    return read("kuber_expense_breakdown", { ...period(p()), ...(acc ? { account: acc } : {}) });
  }
  // A bare account name ("Rent?", "BANK") reads that account's ledger.
  const bare = t.replace(/^(show|open|what about|how about)\s+(me\s+)?/i, "").replace(/[?.!]+$/, "");
  if (bare.split(" ").length <= 4) {
    const r = resolveAccount(bare, accounts, "read");
    if (r.kind === "one" && matchAccounts(bare, accounts)[0]!.score >= 0.8) return read("kuber_ledger", { account: r.id, limit: 20 });
  }
  return { kind: "help", text: helpText("I didn't recognise that as something I can do from rules. Here is what I can do:"), reason: "unrecognised" };
}

/** The catalogue metric a phrase names (FIN-RPT-02), or null. "Runway" alone stays the cash position read. */
export const METRIC_PHRASES: [RegExp, string][] = [
  [/\bcurrent ratio\b/, "current_ratio"],
  [/\b(quick|acid[- ]test) ratio\b/, "quick_ratio"],
  [/\bdso\b|\bdays? sales outstanding\b|\bdebtors?'? days\b|\breceivables? days\b|\bdays to collect\b/, "dso"],
  [/\bdpo\b|\bdays? payables? outstanding\b|\bcreditors?'? days\b|\bpayables? days\b/, "dpo"],
  [/\bgross (profit )?margin\b/, "gross_margin"],
  [/\boperating (profit )?margin\b|\bebit margin\b/, "operating_margin"],
  [/\bworking capital\b/, "working_capital"],
  [/\bdebt[- ]?(to[- ]?)?equity\b|\bd\/e ratio\b|\bgearing\b/, "debt_to_equity"],
  [/\bcash runway (kpi|metric)\b|\brunway (kpi|metric|in months)\b/, "cash_runway"],
];
export function metricIn(l: string): string | null {
  for (const [re, id] of METRIC_PHRASES) if (re.test(l)) return id;
  return null;
}

/** An optional account filter for a breakdown: only a clear match among accounts of that nature; otherwise no filter (a read never guesses). */
function accountFilter(text: string, accounts: AccountRef[], nature: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  if (!m) return undefined;
  const phrase = m[1]!.replace(/\b(category|categories|account|accounts|head|month|year)\b/gi, "").trim();
  if (!phrase || /^(by|per|each|all|every|me|this|last|the)$/i.test(phrase)) return undefined;
  const pool = accounts.filter((a) => !a.nature || a.nature === nature);
  const r = resolveAccount(phrase, pool, "read");
  return r.kind === "one" ? r.id : undefined;
}

// ---------------------------------------------------------------- standing rules
const STANDING_LEAD = /^(?:please\s+|ok(?:ay)?[,.]?\s+|note[:,]?\s+(?:that\s+)?|remember[:,]?\s+(?:that\s+)?|keep in mind[:,]?\s+(?:that\s+)?|for future reference[:,]?\s+|make (?:it|this) a rule(?: that)?[:,]?\s+)*(?:(?:from now on|going forward|henceforth|hereafter|in (?:the )?future|from today(?: onwards?)?|as a rule)[,:]?\s+)/i;
const STANDING_ANY = /\b(from now on|going forward|henceforth|hereafter|from today onwards?|as a (standing )?rule|every time|each time|whenever)\b|\b(always|never)\s+(book|post|classify|record|put|code|categori[sz]e|treat|map|file|charge|send|route|pay|approve|auto-?post|allow|require|let)\b|\b(should|must|will|to)\s+always\s+(go|be)\b|\bremember (that|to)\b|\bkeep in mind\b|\bfor future reference\b|^note that\b/i;
const CLASSIFY_VERB = String.raw`(?:book|post|classify|record|put|code|categori[sz]e|treat|map|file|charge|log)`;
/**
 * A standing business rule stated in chat ("always book Swiggy to staff welfare", "from now on payments
 * above 50,000 need my approval"), or null. Questions are not rules. A classification rule needs an
 * account named exactly and uniquely; otherwise the person is asked (a rule is never guessed).
 */
export function standingRuleIn(t: string, accounts: AccountRef[]): Routed | null {
  const l = t.toLowerCase();
  if (!STANDING_ANY.test(t) || /\?\s*$/.test(t) || /^(what|how|who|which|why|when|where|is|are|do|does|did|can|could|should i|would)\b/.test(l)) return null;
  const body = t.replace(STANDING_LEAD, "").replace(/^(?:please\s+)?(?:remember (?:that|to)\s+|keep in mind(?: that)?\s+|note that\s+|for future reference[,:]?\s+)?/i, "").replace(/[.!]+$/, "").trim();
  const cls = new RegExp(String.raw`^(?:(?:always|please)\s+)*${CLASSIFY_VERB}\s+(?:all\s+|any\s+|every\s+|each\s+)?(.+?)\s+(?:(?:payments?|charges?|bills?|expenses?|transactions?|spends?|orders?|purchases?)\s+)?(?:to|as|under|in|into|against)\s+(?:the\s+|my\s+|our\s+)?(.+?)(?:\s+(?:always|from now on|going forward|account))?$`, "i").exec(body)
    ?? new RegExp(String.raw`^(?:all\s+|any\s+)?(.+?)\s+(?:payments?\s+|charges?\s+|bills?\s+|expenses?\s+|transactions?\s+)?(?:should|must|will|always)?\s*(?:always\s+)?(?:go(?:es)?|be\s+(?:booked|posted|classified|recorded|coded))\s+(?:to|as|under|in|into)\s+(?:the\s+|my\s+|our\s+)?(.+?)(?:\s+(?:always|from now on|going forward|account))?$`, "i").exec(body)
    // "Zoom is a software cost (for us)": the item and the kind of cost it is.
    ?? /^(?:all\s+|any\s+)?(.+?)\s+(?:is|are)\s+(?:always\s+)?(?:an?\s+|our\s+|my\s+)?(.+?)\s+(?:costs?|expenses?|charges?|spends?)(?:\s+for\s+(?:us|me))?$/i.exec(body);
  const money = /(?:₹|\brs\.?|\binr)\s*\d|\b\d[\d,]*(?:\.\d+)?\s*(?:lakhs?|lacs?|k|crores?|cr)\b|\b\d{4,}\b/i.test(body);
  if (cls && !money && !/\b(approv|limit|above|below|over|under \d|payments? to new)\b/i.test(cls[1]!)) {
    const pattern = cls[1]!.replace(/^(?:the|my|our|all|any)\s+/i, "").replace(/\s+(?:payments?|charges?|bills?|orders?|rides?|trips?|subscriptions?|fees?|invoices?|expenses?|transactions?|spends?|purchases?)$/i, "").trim();
    const phrase = cls[2]!.replace(/\s+(?:account|head|category)$/i, "").trim();
    const pool = accounts.filter((a) => !a.cash && a.id !== "SUSPENSE" && (!a.nature || a.nature === "expense" || a.nature === "income" || a.nature === "asset" || a.nature === "liability"));
    const r = resolveAccount(phrase, pool, "write");
    if (r.kind === "one" && pattern.length >= 2) return { kind: "standing_rule", rule: { kind: "classification", pattern, account: r.id, statedAs: t.slice(0, 500) } };
    const options = r.kind === "ambiguous" ? r.options : pool.filter((a) => a.nature === "expense").slice(0, 4);
    return clarify(`To make that a standing rule I need the exact account for "${pattern}"${options.length ? `: ${listOf(options)}` : ""}? Say it with the account id, e.g. "Always book ${pattern} to ${options[0]?.id ?? "BIZEXP"}". I'll prepare it as a rule proposal for approval; I don't keep rules from our conversation.`,
      options.map((o) => `Always book ${pattern} to ${o.id}`));
  }
  return { kind: "standing_rule", rule: { kind: "policy", statement: t.replace(/[.!]+$/, "").trim().slice(0, 1000) } };
}

function policyQuery(text: string): string {
  const q = text.replace(/[?!.]+$/, "")
    .replace(/^(please\s+)?(what('s| is| are)|tell me|show( me)?|explain|find|look up|is there)\s+/i, "")
    .replace(/\b(the|our|my|a|an|kuber'?s?)\s+(polic(y|ies)|rules?)\s+(for|on|about|when|around|regarding)\s+/i, "")
    .replace(/\b(polic(y|ies)|rules?)\s+(for|on|about|when|around|regarding)\s+/i, "")
    .replace(/^(the|our|my)\s+/i, "").trim();
  return q || "policy";
}

function searchArgs(text: string, today: string, fyStart: number, accounts: AccountRef[]): Record<string, unknown> {
  // "… and total them", "…: what's the total?": what to do with the matches, not text to search for.
  let s = text.replace(/[?!.]+$/, "").replace(/\s*[,:;]?\s*(?:and\s+)?(?:what(?:'s| is) the total|give me the total|total (?:them|it|these)(?: up)?|add (?:them|it|these) up|in total|altogether)\b.*$/i, "");
  const args: Record<string, unknown> = {};
  const num = String.raw`(?:₹|rs\.?\s*|inr\s*)?\d[\d,]*(?:\.\d+)?\s*(?:lakhs?|lacs?|k|thousand|crores?|cr)?`;
  const between = new RegExp(String.raw`\bbetween\s+(${num})\s+and\s+(${num})`, "i").exec(s);
  if (between) { args.minAmount = amountIn(between[1]!); args.maxAmount = amountIn(between[2]!); s = s.replace(between[0], " "); }
  const over = new RegExp(String.raw`\b(?:over|above|more than|greater than|at least|>=?)\s*(${num})`, "i").exec(s);
  if (over) { args.minAmount = amountIn(over[1]!); s = s.replace(over[0], " "); }
  const under = new RegExp(String.raw`\b(?:under|below|less than|at most|<=?)\s*(${num})`, "i").exec(s);
  if (under) { args.maxAmount = amountIn(under[1]!); s = s.replace(under[0], " "); }
  const per = periodIn(s, today, fyStart);
  if (per) { args.from = per.from; args.to = per.to; }
  s = s.replace(new RegExp(String.raw`\b(this|last|previous|current) (month|year|fy|financial year)\b|\b(in|for|during|since|from)\s+${MONTH_RE}\b(\s+\d{4})?|\bfy\s*\S+|\b(from|between)?\s*\d{4}-\d{2}-\d{2}(\s+(to|and|till)\s+\d{4}-\d{2}-\d{2})?|\b${MONTH_RE}\s+\d{4}\b`, "gi"), " ");
  const accM = /\b(?:in|on|from|to)\s+(?:account|a\/c)\s+(\S+)/i.exec(s);
  if (accM) { const r = resolveAccount(accM[1]!, accounts, "read"); if (r.kind === "one") { args.account = r.id; s = s.replace(accM[0], " "); } }
  s = s.replace(/^(please\s+)?(find|search( for)?|look ?up|look for|show|list|give)( me)?( all)?( the)?\s*/i, "")
    .replace(/^(any\s+)?(transactions|entries|journals|payments|receipts)\s*(with|containing|mentioning|about|matching|to|from|for)?\s*/i, "")
    .replace(/\b(transactions|entries|journals|payments)\b/gi, " ")
    .replace(/\s+(with|containing|mentioning|to|from|for)\s*$/i, "").replace(/\s+/g, " ").trim();
  if (s) args.text = s;
  return args;
}

/** "Record 1499 printer ink to BIZEXP from bank on 2026-11-02": a record plan, or a question when the account or money account is not certain. */
function recordIntent(t: string, today: string, accounts: AccountRef[]): Routed {
  const l = t.toLowerCase();
  const noDates = t.replace(/\d{4}-\d{2}-\d{2}|\d{1,2}\s+[a-z]{3}[a-z]*\.?\s+\d{4}/gi, " ");
  const amount = amountIn(noDates)!;
  const date = /\d{4}-\d{2}-\d{2}|\d{1,2}\s+[a-z]{3}[a-z]*\.?\s+\d{4}/i.test(t) ? dateIn(t, today) : null;
  const direction = /\b(received|receipt|income|sales?|earned|got|refund|collected)\b/.test(l) ? "in" : "out";
  const cash = accounts.filter((a) => a.cash);
  // the money account: named after from/via/by/using/through/into, else the only cash-like account
  const viaM = /\b(?:from|via|by|using|through|with|into|in)\s+(?:the |my |our )?([\w:]+(?: [a-z]+)?)(?=\s|$|[?.!,])/gi;
  let via: string | undefined;
  for (const m of t.matchAll(viaM)) {
    const pool = cash.length ? cash : accounts;
    const r = resolveAccount(m[1]!.replace(/\s+(on|dated)$/i, ""), pool, "read");
    const w = m[1]!.toLowerCase().split(" ")[0]!;
    if (r.kind === "one" && (pool.find((a) => a.id === r.id)!.id.toLowerCase() === w || /^(bank|cash|card)$/.test(w))) { via = r.id; break; }
  }
  if (!via && cash.length === 1) via = cash[0]!.id;
  // the account it belongs to: after to/under/as/against/into/for, exact and unique only
  const others = accounts.filter((a) => a.id !== via && !a.cash);
  let account: string | undefined, candidates: AccountRef[] = [];
  for (const m of t.matchAll(/\b(?:to|under|as|against|towards|for)\s+/gi)) {
    const phrase = /^(?:the |my |our )?(.+?)(?=\s+(?:from|via|by|using|through|with|into|on|dated)\b|[?.!,]|$)/i.exec(t.slice(m.index! + m[0].length))?.[1]?.trim();
    if (!phrase) continue;
    const r = resolveAccount(phrase, others, "write");
    if (r.kind === "one") { account = r.id; break; }
    if (r.kind === "ambiguous" && !candidates.length) candidates = r.options;
  }
  if (!account) {
    const exact = idsIn(t, others.map((a) => a.id));
    if (exact.length === 1) account = exact[0];
  }
  if (!account) {
    const pool = (candidates.length ? candidates : others.filter((a) => a.nature === (direction === "in" ? "income" : "expense")).slice(0, 4));
    return clarify(`Which account should this ${direction === "in" ? "income" : "expense"} of ₹${amount} go to${pool.length ? `: ${listOf(pool)}` : ""}? Say it with the account id, e.g. "${t} to ${pool[0]?.id ?? "BIZEXP"}".`,
      pool.map((a) => `${t} to ${a.id}`));
  }
  if (!via) {
    const pool = cash.length ? cash : accounts.filter((a) => /^(BANK|CASH|CARD)$/.test(a.id));
    return clarify(`Paid ${direction === "in" ? "into" : "from"} which account: ${listOf(pool)}?`, pool.map((a) => `${t} ${direction === "in" ? "into" : "from"} ${a.id}`));
  }
  const narration = t.replace(/^(please\s+)?(record|add|book|enter|log)\s+(an?\s+)?(expense|income|payment|receipt)?\s*(of\s+)?/i, "")
    .replace(/(?:₹|rs\.?\s*|inr\s*)?\d[\d,]*(?:\.\d+)?\s*(lakhs?|lacs?|k\b|thousand|crores?|cr\b)?/i, "")
    .replace(/\b(to|under|as|against|towards)\s+(the |my |our )?\S+(\s+\S+)?(?=\s+(from|via|by|using|through|with|into|on|dated)\b|$)/i, "")
    .replace(new RegExp(String.raw`\b(from|via|by|using|through|with|into|in)\s+(the |my |our )?(bank|cash|card|${via.replace(/[^\w:]/g, "")})\b`, "i"), "")
    .replace(/\b(on|dated)?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[a-z]{3}[a-z]*\.?\s+\d{4})/i, "").replace(/^\s*(for|paid for|spent on)\s+/i, "").replace(/\s+/g, " ").trim();
  // A party named by its master id (V-…, C-…) goes on the plan, so its controls (payment holds, POL-501) apply.
  const party = /\b([VC]-[A-Z0-9][A-Z0-9-]*)\b/.exec(t)?.[1];
  return op("record", { narration: narration.length >= 2 ? narration.slice(0, 200) : `Recorded through Kuber: ${t.slice(0, 150)}`, amount, direction, account, via, ...(date ? { date } : {}), ...(party ? { party } : {}) });
}
