"""The three reasoning programs, each a DSPy Signature + Module with typed Pydantic I/O, and the checks
the middleware applies to their outputs before anything is returned to the core."""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import dspy
import jsonschema

from ..grounding import check_grounding
from ..schemas import (FORBIDDEN_TOOLS, ClassifyRequest, ComposeRequest, NextStepRequest)
from .classify import ClassifyFallback, ClassifySignature
from .compose import ComposeAnswer, ComposeSignature
from .next_step import Decision, NextStep, NextStepSignature


class ProgramRejected(Exception):
    """The model's output failed a check; nothing it proposed is returned (422)."""

    def __init__(self, code: str, detail: str, extra: dict[str, Any] | None = None):
        super().__init__(detail)
        self.code, self.detail, self.extra = code, detail, extra or {}


def _field(pred: Any, name: str, default: Any = None) -> Any:
    return getattr(pred, name, default) if not isinstance(pred, dict) else pred.get(name, default)


# ------------------------------------------------------------------------------------ next_step
def next_step_inputs(req: NextStepRequest) -> dict[str, Any]:
    return {"request": req.request, "history": req.history, "catalogue": req.catalogue, "prior_steps": req.prior_steps}


def next_step_check(req: NextStepRequest, pred: Any) -> dict[str, Any]:
    d = _field(pred, "decision")
    if isinstance(d, dict):
        d = Decision.model_validate(d)
    if not isinstance(d, Decision):
        raise ProgramRejected("malformed_output", "the model did not return a decision")
    if d.action == "final":
        draft = (d.draft or "").strip()
        if not draft:
            raise ProgramRejected("malformed_output", "final decision without a draft")
        return {"action": "final", "draft": draft[:8000]}
    tool = (d.tool or "").strip()
    if tool in FORBIDDEN_TOOLS:
        raise ProgramRejected("forbidden_tool", f"the model proposed {tool}, which the agent may never call", {"tool": tool})
    spec = next((t for t in req.catalogue if t.name == tool), None)
    if spec is None:
        raise ProgramRejected("tool_not_in_catalogue", "the model named a tool outside the catalogue it was given",
                              {"tool": tool[:64]})
    args = d.args or {}
    try:
        jsonschema.Draft202012Validator.check_schema(spec.input_schema)
        schema_ok = True
    except jsonschema.SchemaError:
        schema_ok = False              # the core validates by its own schema before executing (TOL-02)
    if schema_ok:
        errors = sorted(jsonschema.Draft202012Validator(spec.input_schema).iter_errors(args), key=str)
        if errors:
            raise ProgramRejected("args_invalid", f"arguments do not match {tool}'s input schema: {errors[0].message[:200]}",
                                  {"tool": tool})
    return {"action": "tool", "tool": tool, "args": args}


# ------------------------------------------------------------------------------------ compose
def compose_inputs(req: ComposeRequest) -> dict[str, Any]:
    return {"request": req.request, "tool_outputs": req.tool_outputs, "draft": req.draft or ""}


def _strs(v: Any, n: int = 12, width: int = 1000) -> list[str]:
    return [str(x)[:width] for x in (v or [])][:n] if isinstance(v, list) else []


def compose_check(req: ComposeRequest, pred: Any) -> dict[str, Any]:
    answer = str(_field(pred, "answer", "") or "").strip()
    if not answer:
        raise ProgramRejected("malformed_output", "the model returned no answer")
    facts, inferences, opinions = (_strs(_field(pred, k)) for k in ("facts", "inferences", "opinions"))
    outputs = [t.output for t in req.tool_outputs]
    g = check_grounding("\n".join([answer, *facts, *inferences, *opinions]), outputs)
    if not g.ok:
        raise ProgramRejected("ungrounded_figures", "the answer contains figures absent from the tool outputs",
                              {"ungrounded": g.ungrounded[:20]})
    return {"answer": answer[:8000], "facts": facts, "inferences": inferences, "opinions": opinions,
            "grounding": {"ok": True, "ungrounded": []}}


# ------------------------------------------------------------------------------------ classify
def classify_inputs(req: ClassifyRequest) -> dict[str, Any]:
    return {"line": req.line, "chart": req.chart}


def classify_check(req: ClassifyRequest, pred: Any) -> dict[str, Any]:
    acc = str(_field(pred, "account_id", "") or "").strip()
    if acc not in {a.id for a in req.chart}:
        raise ProgramRejected("account_not_in_chart", "the proposed account is not in the chart passed",
                              {"accountId": acc[:64]})
    try:
        conf = float(_field(pred, "confidence", 0.0))
    except (TypeError, ValueError):
        conf = 0.0
    conf = 0.0 if conf != conf else max(0.0, min(1.0, conf))
    return {"accountId": acc, "confidence": round(conf, 4), "reasons": _strs(_field(pred, "reasons"), 3, 200)}


@dataclass(frozen=True)
class ProgramSpec:
    name: str
    module: type[dspy.Module]
    signature: type[dspy.Signature]
    inputs: Callable[[Any], dict[str, Any]]
    check: Callable[[Any, Any], dict[str, Any]]


PROGRAMS: dict[str, ProgramSpec] = {
    "next_step": ProgramSpec("next_step", NextStep, NextStepSignature, next_step_inputs, next_step_check),
    "compose": ProgramSpec("compose", ComposeAnswer, ComposeSignature, compose_inputs, compose_check),
    "classify": ProgramSpec("classify", ClassifyFallback, ClassifySignature, classify_inputs, classify_check),
}


def usage_of(pred: Any) -> tuple[int, int]:
    try:
        u = pred.get_lm_usage() or {}
    except Exception:
        return 0, 0
    tin = sum(int(v.get("prompt_tokens") or 0) for v in u.values() if isinstance(v, dict))
    tout = sum(int(v.get("completion_tokens") or 0) for v in u.values() if isinstance(v, dict))
    return tin, tout


def run_program(module: dspy.Module, spec: ProgramSpec, req: Any, lm: Any) -> tuple[Any, int, int, int]:
    """Run one program with usage tracking. Returns (prediction, tokensIn, tokensOut, ms)."""
    t0 = time.monotonic()
    with dspy.context(lm=lm, track_usage=True):
        pred = module(**spec.inputs(req))
    tin, tout = usage_of(pred)
    return pred, tin, tout, int((time.monotonic() - t0) * 1000)
