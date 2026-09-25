"""Signatures, modules and typed request validation."""
from __future__ import annotations

import typing

import dspy
import pytest
from pydantic import ValidationError

from agentmw.programs import PROGRAMS
from agentmw.programs.next_step import Decision
from agentmw.schemas import (ClassifyRequest, NextStepRequest, StatementLine, mask_narration)
from conftest import CATALOGUE, CHART, next_step_body

EXPECTED = {
    "next_step": ({"request", "history", "catalogue", "prior_steps"}, {"decision"}),
    "compose": ({"request", "tool_outputs", "draft"}, {"facts", "inferences", "opinions", "answer"}),
    "classify": ({"line", "chart"}, {"account_id", "confidence", "reasons"}),
}


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_signature_fields(name):
    sig = PROGRAMS[name].signature
    ins, outs = EXPECTED[name]
    assert set(sig.input_fields) == ins
    assert set(sig.output_fields) == outs
    assert sig.instructions.strip()


def test_typed_pydantic_fields():
    sig = PROGRAMS["next_step"].signature
    assert sig.output_fields["decision"].annotation is Decision
    cat = sig.input_fields["catalogue"].annotation
    assert typing.get_origin(cat) is list
    assert PROGRAMS["classify"].signature.input_fields["line"].annotation is StatementLine


@pytest.mark.parametrize("name", sorted(PROGRAMS))
def test_modules_are_dspy_modules_with_one_predictor(name):
    m = PROGRAMS[name].module()
    assert isinstance(m, dspy.Module)
    assert len(m.named_predictors()) == 1


def test_history_is_capped_to_eight():
    req = NextStepRequest.model_validate(next_step_body(history=[{"role": "user", "text": str(i)} for i in range(20)]))
    assert [h.text for h in req.history] == [str(i) for i in range(12, 20)]


@pytest.mark.parametrize("over", [
    {"catalogue": CATALOGUE + [{"name": "kuber_commit", "description": "commit"}]},
    {"catalogue": [CATALOGUE[0], CATALOGUE[0]]},
    {"catalogue": []},
    {"request": ""},
    {"request": "x" * 4001},
    {"unexpected": 1},
    {"prior_steps": [{"tool": "kuber_accounts", "args": {}, "output": "x"}] * 9},
    {"catalogue": [{"name": "Bad Name", "description": ""}]},
])
def test_invalid_next_step_requests(over):
    with pytest.raises(ValidationError):
        NextStepRequest.model_validate(next_step_body(**over))


def test_invalid_request_is_422_over_http(mw, fake_lm):
    r = mw.post("/v1/next-step", next_step_body(catalogue=CATALOGUE + [{"name": "kuber_commit", "description": ""}]))
    assert r.status_code == 422 and r.json()["error"] == "invalid_request"
    r = mw.post("/v1/next-step", b"not json")
    assert r.status_code == 422
    assert fake_lm.calls == 0


def test_narration_is_masked():
    assert mask_narration("NEFT 1234567890 ACME 123 CARD 4111") == "NEFT ########## ACME 123 CARD ####"
    req = ClassifyRequest.model_validate({"line": {"narration": "UPI 9876543210 RENT", "direction": "out", "magnitude": "10k_1l"}, "chart": CHART})
    assert "9876" not in req.line.narration


@pytest.mark.parametrize("line", [
    {"narration": "x", "direction": "sideways", "magnitude": "10k_1l"},
    {"narration": "x", "direction": "in", "magnitude": "12000"},
    {"narration": "x", "direction": "in", "magnitude": "10k_1l", "amount": "twelve"},
])
def test_invalid_statement_line(line):
    with pytest.raises(ValidationError):
        ClassifyRequest.model_validate({"line": line, "chart": CHART})


def test_masked_line_reaches_model_masked(mw, responder_box):
    r = mw.post("/v1/classify", {"line": {"narration": "NEFT 1234567890 RENT", "direction": "out", "magnitude": "10k_1l"}, "chart": CHART})
    assert r.status_code == 200
    prompt = "\n".join(str(m["content"]) for m in responder_box["seen"][-1])
    assert "1234567890" not in prompt and "##########" in prompt
    assert '"amount": null' in prompt or '"amount":null' in prompt


def test_module_runs_with_fake_lm(fake_lm):
    from agentmw.schemas import ToolSpec
    with dspy.context(lm=fake_lm):
        p = PROGRAMS["next_step"].module()(request="profit and loss", history=[], catalogue=[ToolSpec(**c) for c in CATALOGUE], prior_steps=[])
    assert isinstance(p.decision, Decision) and p.decision.tool == "kuber_pnl"
