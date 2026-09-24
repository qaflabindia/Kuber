/**
 * Schedule arithmetic (FIN-GL-02 recurring journals, FIN-GL-03 prepaid and accrual recognition).
 * Pure and deterministic: periods are calendar months "YYYY-MM", dates are strict IsoDates and
 * amounts are integer paise. The ops module stores schedules and runs them; this file only says
 * what each occurrence is.
 */
import { isIsoDate, stableId, type Line } from "@kuber/contracts";
import { DomainError } from "./book.ts";

export type Period = string;                                   // "YYYY-MM"
export const periodOf = (d: string): Period => d.slice(0, 7);

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const ym = (p: Period) => { const [y, m] = p.split("-").map(Number); return { y: y!, m: m! }; };

export const periodStart = (p: Period) => `${p}-01`;
export const periodEnd = (p: Period) => { const { y, m } = ym(p); return `${p}-${pad(daysIn(y, m))}`; };
export function nextPeriod(p: Period): Period { const { y, m } = ym(p); return m === 12 ? `${pad(y + 1, 4)}-01` : `${pad(y, 4)}-${pad(m + 1)}`; }
/** First day of the period after `p`: where an auto-reversal lands. */
export const reversalDate = (p: Period) => periodStart(nextPeriod(p));

/** Every month from the month of `from` to the month of `to`, inclusive. */
export function periodsBetween(from: string, to: string): Period[] {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new DomainError("bad_date", `bad schedule dates ${from} to ${to}`);
  if (to < from) throw new DomainError("bad_dates", `schedule ends (${to}) before it starts (${from})`);
  const out: Period[] = [];
  for (let p = periodOf(from); p <= periodOf(to); p = nextPeriod(p)) out.push(p);
  return out;
}

/** The posting date of a monthly occurrence: the last day of the month, or day N (1-28). */
export function occurrenceDate(p: Period, day: "last" | number): string {
  if (day === "last") return periodEnd(p);
  if (!Number.isInteger(day) || day < 1 || day > 28) throw new DomainError("bad_day", "a monthly schedule posts on day 1-28 or the last day");
  return `${p}-${pad(day)}`;
}

/** Straight-line monthly recognition: equal parts, the rounding remainder (paise) on the last period. */
export function straightLine(total: bigint, periods: number): bigint[] {
  if (periods < 1) throw new DomainError("bad_schedule", "a schedule needs at least one period");
  const part = total / BigInt(periods);
  const out = Array.from({ length: periods }, () => part);
  out[periods - 1] = total - part * BigInt(periods - 1);
  return out;
}

/** Total debits of a set of lines (the amount a journal moves). */
export const debits = (lines: Line[]) => lines.reduce((a, l) => (BigInt(l.amount) > 0n ? a + BigInt(l.amount) : a), 0n);

/**
 * The business occurrence id: schedule + period + kind. Unique per book, so an occurrence posts at
 * most once however often (or however concurrently) the runner runs.
 */
export const occurrenceId = (tenant: string, scheduleId: string, period: Period, kind: "post" | "reverse") =>
  stableId("schedule-occurrence", `${tenant}/${scheduleId}/${period}/${kind}`);
export const occurrenceJournalId = (tenant: string, scheduleId: string, period: Period, kind: "post" | "reverse" | "release") =>
  stableId("schedule-journal", `${tenant}/${scheduleId}/${period}/${kind}`);
