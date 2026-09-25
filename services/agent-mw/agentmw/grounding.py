"""Grounding check (TAGOF GEN-01), a line-for-line port of the core's
apps/core/src/copilot/governance/grounding.ts (ws5/agent-gov). The core's check stays authoritative;
this copy lets ComposeAnswer refuse an ungrounded draft early and gives the optimiser a metric that
cannot reward invented figures.

Every monetary figure and percentage in a reply must come from the turn's tool outputs:
  money    ₹ / Rs / INR amounts in Indian (1,30,206.50) or western (130,206.50) grouping or none, with
           or without lakh / lac / L / crore / cr / k / thousand, numbers followed by rupees / INR / Rs,
           and paise amounts
  percent  "12.5%", "40 percent", "40 per cent"
Figures are normalised exactly (integers, no floating point). A figure is grounded when its value
appears in some tool output (as rupees or, for bare integers, as raw paise), or is exactly the sum or
difference of at most two tool figures. Only money-marked tool numbers and bare numbers of three or
more digits are terms of a sum or difference; ISO dates in tool outputs are ignored. Percentages are
grounded only against percentages the tools state. Signs are ignored.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

SCALE = 1_000_000          # millionths of a rupee
PAISA = SCALE // 100

NUM = r"\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?"
UNIT = r"lakhs?|lacs?|lac|crores?|cr|k|thousand|mn|million|l"
_F = re.I | re.A
_MULT: list[tuple[re.Pattern[str], int]] = [
    (re.compile(r"^(lakhs?|lacs?|lac|l)$", _F), 100_000),
    (re.compile(r"^(crores?|cr)$", _F), 10_000_000),
    (re.compile(r"^(k|thousand)$", _F), 1_000),
    (re.compile(r"^(mn|million)$", _F), 1_000_000),
]


def scaled(num: str, unit: str = "", per_rupee: int = SCALE) -> int | None:
    """'1,30,206.50' x unit -> millionths of a rupee (exact); None when finer than the scale."""
    n = num.replace(",", "")
    w, _, f = n.partition(".")
    if not re.fullmatch(r"\d+", w, re.A) or not re.fullmatch(r"\d*", f, re.A):
        return None
    mul = next((m for rx, m in _MULT if rx.match(unit or "")), 1)
    num10, den = int(w + f) * mul * per_rupee, 10 ** len(f)
    return num10 // den if num10 % den == 0 else None


@dataclass
class Figure:
    text: str
    kind: str        # "money" | "percent"
    value: int
    paise: str | None = None


_RE = {
    "prefixed": re.compile(rf"(?:₹|\bRs\.?|\bINR)\s*-?\s*({NUM})(?:\s*({UNIT})\b)?(?:\s*/-)?", _F),
    "currencyWord": re.compile(rf"(?<![\w.,])({NUM})\s*(?:({UNIT})\s+)?(?:rupees?|inr|rs\b\.?)", _F),
    "paise": re.compile(rf"(?<![\w.,])({NUM})\s*paise\b", _F),
    "unit": re.compile(rf"(?<![\w.,₹])({NUM})\s*(lakhs?|lacs?|lac|crores?|cr|k|thousand)\b", _F),
    "percent": re.compile(rf"(?<![\w.,])({NUM})\s*(?:%|percent\b|per\s+cent\b)", _F),
}


def extract_figures(text: str) -> list[Figure]:
    """Monetary figures and percentages in a reply, each once (the first, most specific reading of a span wins)."""
    taken: list[tuple[int, int]] = []
    out: list[tuple[int, Figure]] = []

    def free(a: int, b: int) -> bool:
        return not any(a < y and x < b for x, y in taken)

    def scan(rx: re.Pattern[str], kind: str, value) -> None:
        for m in rx.finditer(text):
            a, b = m.start(), m.end()
            if not free(a, b):
                continue
            v = value(m)
            if v is None:
                continue
            taken.append((a, b))
            paise = str(v // PAISA) if kind == "money" and v % PAISA == 0 else None
            out.append((a, Figure(m.group(0).strip(), kind, v, paise)))

    scan(_RE["prefixed"], "money", lambda m: scaled(m.group(1), m.group(2) or ""))
    scan(_RE["currencyWord"], "money", lambda m: scaled(m.group(1), m.group(2) or ""))
    scan(_RE["paise"], "money", lambda m: scaled(m.group(1), "", PAISA))
    scan(_RE["unit"], "money", lambda m: scaled(m.group(1), m.group(2)))
    scan(_RE["percent"], "percent", lambda m: scaled(m.group(1)))
    return [f for _, f in sorted(out, key=lambda t: t[0])]


_TOKEN = re.compile(
    rf"(₹|\bRs\.?\s*|\bINR\s*)?(-?)({NUM})(?:\s*({UNIT})\b)?(\s*(?:%|percent\b|per\s+cent\b|rupees?\b|paise\b))?", _F)
_DATE_PART = re.compile(r"\d{4}-\d{2}-\d{2}", re.A)
_PCT_SUFFIX = re.compile(r"^(%|percent|per\s+cent)$", re.A)


@dataclass
class ToolValues:
    money: set[int] = field(default_factory=set)
    money_terms: set[int] = field(default_factory=set)
    percent: set[int] = field(default_factory=set)


def tool_values(outputs: list[str]) -> ToolValues:
    tv = ToolValues()
    for raw in outputs:
        o = _DATE_PART.sub(lambda d: " " * len(d.group(0)), raw)
        for m in _TOKEN.finditer(o):
            cur, num, unit, suffix = m.group(1), m.group(3), m.group(4) or "", m.group(5) or ""
            suf = suffix.strip().lower()
            if _PCT_SUFFIX.match(suf):
                p = scaled(num)
                if p is not None:
                    tv.percent.add(p)
                continue
            marked = bool(cur) or bool(unit) or suf.startswith("rupee") or suf == "paise"
            values: list[int] = []
            if suf == "paise":
                p = scaled(num, "", PAISA)
                if p is not None:
                    values.append(p)
            else:
                r = scaled(num, unit)
                if r is not None:
                    values.append(r)
                if not cur and not unit and "." not in num:
                    p = scaled(num, "", PAISA)
                    if p is not None:
                        values.append(p)
            strong = marked or len(num.replace(",", "").replace(".", "")) >= 3
            for v in values:
                tv.money.add(v)
                if strong:
                    tv.money_terms.add(v)
    return tv


def _grounded_in(v: int, direct: set[int], terms: set[int]) -> bool:
    if v in direct:
        return True
    return any((v - a) in terms or (a - v) in terms or (a + v) in terms for a in terms)


@dataclass
class GroundingResult:
    ok: bool
    ungrounded: list[str]


def check_grounding(reply: str, tool_outputs: list[str]) -> GroundingResult:
    figs = extract_figures(reply)
    if not figs:
        return GroundingResult(True, [])
    vals = tool_values(tool_outputs)
    bad = [f.text for f in figs if not (
        _grounded_in(f.value, vals.money, vals.money_terms) if f.kind == "money"
        else _grounded_in(f.value, vals.percent, vals.percent))]
    return GroundingResult(not bad, bad)


def format_inr(paise: int) -> str:
    """₹ with Indian digit grouping: 12345678990 paise -> '₹12,34,56,789.90' (the core's formatINR)."""
    neg, n = paise < 0, abs(paise)
    rupees, p = divmod(n, 100)
    s = str(rupees)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups) + "," + tail
    return f"{'-' if neg else ''}₹{s}.{p:02d}"
