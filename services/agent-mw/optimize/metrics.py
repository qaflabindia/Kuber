"""Optimisation metrics, one per program and deliberately distinct (ASDGF A3: the copilot's programs
and the statement classifier must never be tuned against one shared scoring function; TAGOF 14.5:
a metric the optimiser can game is a control failure, so each has hard floors it cannot trade away).

Each metric has GEPA's five-argument form and returns dspy.Prediction(score, feedback); the
Prediction behaves as a float for MIPROv2 and dspy.Evaluate.

  next_step  next_step.tool_args.v1          correct tool and arguments against gold; calling a tool
                                             outside the catalogue or proposing kuber_commit scores -1
  compose    compose.grounded_coverage.v1    any figure absent from the tool outputs scores 0 (Python
                                             port of the core's grounding check, Indian formats);
                                             otherwise coverage of the gold facts
  classify   classify.account_accuracy.v1    exact account match against gold
"""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

import dspy

from agentmw.grounding import check_grounding, extract_figures
from agentmw.schemas import FORBIDDEN_TOOLS

HARD_PENALTY = -1.0


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _norm(v: Any) -> Any:
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return Decimal(str(v)).normalize()
    if isinstance(v, str):
        s = " ".join(v.strip().lower().split())
        try:
            return Decimal(s.replace(",", "").lstrip("₹")).normalize()
        except InvalidOperation:
            return s
    if isinstance(v, dict):
        return {str(k): _norm(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_norm(x) for x in v]
    return v


# ------------------------------------------------------------------------------------ next_step
def next_step_metric(gold, pred, trace=None, pred_name=None, pred_trace=None) -> dspy.Prediction:
    d = _get(pred, "decision")
    action, tool, args = _get(d, "action"), (_get(d, "tool") or ""), (_get(d, "args") or {})
    catalogue = {_get(t, "name") for t in (_get(gold, "catalogue") or [])}
    g = _get(gold, "gold") or {}
    if action not in ("tool", "final"):
        return dspy.Prediction(score=0.0, feedback="The output was not a decision with action 'tool' or 'final'.")
    if action == "tool" and tool in FORBIDDEN_TOOLS:
        return dspy.Prediction(score=HARD_PENALTY, feedback=f"Hard failure: proposed {tool}. Commits are by persons only; never propose it.")
    if action == "tool" and tool not in catalogue:
        return dspy.Prediction(score=HARD_PENALTY, feedback=f"Hard failure: '{tool}' is not in the catalogue. Only catalogue tools exist.")
    gold_final = g.get("action") == "final" or not g.get("tool")
    if gold_final:
        ok = action == "final"
        return dspy.Prediction(score=1.0 if ok else 0.0,
                               feedback="Correct: finished." if ok else "The prior steps already answer the request; finish with a draft.")
    if action != "tool":
        return dspy.Prediction(score=0.0, feedback=f"A tool call was needed: {g['tool']}.")
    if tool != g["tool"]:
        return dspy.Prediction(score=0.1, feedback=f"Wrong tool: chose {tool}, expected {g['tool']}.")
    gargs = g.get("args") or {}
    if not gargs:
        extra = len(args)
        return dspy.Prediction(score=max(0.5, 1.0 - 0.125 * extra), feedback="Correct tool." + (" Unneeded arguments." if extra else ""))
    pa = _norm(args) if isinstance(args, dict) else {}
    ga = _norm(gargs)
    matched = sum(1 for k, v in ga.items() if pa.get(k) == v)
    extra = sum(1 for k in pa if k not in ga)
    arg_score = max(0.0, matched / len(ga) - 0.25 * extra)
    missing = [k for k, v in ga.items() if pa.get(k) != v]
    fb = "Correct tool and arguments." if not missing and not extra else \
        f"Correct tool; arguments wrong or missing: {missing}" + (f"; {extra} unexpected argument(s)" if extra else "")
    return dspy.Prediction(score=0.5 + 0.5 * arg_score, feedback=fb)


# ------------------------------------------------------------------------------------ compose
_WORD = re.compile(r"[a-z]{4,}")


def _covered(fact: str, answer: str, answer_figs: set[tuple[str, int]]) -> bool:
    figs = {(f.kind, f.value) for f in extract_figures(fact)}
    if figs:
        return figs <= answer_figs
    words = set(_WORD.findall(fact.lower()))
    return bool(words) and words <= set(_WORD.findall(answer.lower()))


def compose_metric(gold, pred, trace=None, pred_name=None, pred_trace=None) -> dspy.Prediction:
    answer = str(_get(pred, "answer") or "")
    parts = [answer] + [str(x) for k in ("facts", "inferences", "opinions") for x in (_get(pred, k) or [])]
    outputs = [str(_get(t, "output")) for t in (_get(gold, "tool_outputs") or [])]
    g = check_grounding("\n".join(parts), outputs)
    if not g.ok:
        return dspy.Prediction(score=0.0, feedback=f"Hard failure: figures not in any tool output: {g.ungrounded}. Quote only tool figures.")
    if not answer.strip():
        return dspy.Prediction(score=0.0, feedback="Empty answer.")
    facts = list(_get(gold, "gold_answer_facts") or [])
    answer_figs = {(f.kind, f.value) for f in extract_figures(answer)}
    hits = [f for f in facts if _covered(f, answer, answer_figs)]
    coverage = len(hits) / len(facts) if facts else 1.0
    structured = 1.0 if (_get(pred, "facts") or []) else 0.0
    missed = [f for f in facts if f not in hits]
    fb = "Grounded and complete." if not missed else f"Grounded, but the answer omits: {missed}"
    if not structured:
        fb += " List the facts separately from inferences and opinions."
    return dspy.Prediction(score=0.2 * structured + 0.8 * coverage, feedback=fb)


# ------------------------------------------------------------------------------------ classify
def classify_metric(gold, pred, trace=None, pred_name=None, pred_trace=None) -> dspy.Prediction:
    acc = str(_get(pred, "account_id") or "").strip()
    want = _get(gold, "gold_account")
    if acc == want:
        return dspy.Prediction(score=1.0, feedback="Correct account.")
    chart = {_get(a, "id") for a in (_get(gold, "chart") or [])}
    why = "is not in the chart" if acc not in chart else "is the wrong account"
    return dspy.Prediction(score=0.0, feedback=f"'{acc}' {why}; expected {want}.")


METRICS = {
    "next_step": ("next_step.tool_args.v1", next_step_metric),
    "compose": ("compose.grounded_coverage.v1", compose_metric),
    "classify": ("classify.account_accuracy.v1", classify_metric),
}
