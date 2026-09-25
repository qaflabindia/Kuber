"""Grounding: the Python port must agree with the core's TypeScript check, and the compose metric
must give no credit to an answer that invents a figure."""
from __future__ import annotations

import json
from pathlib import Path

import dspy
import pytest

from agentmw.grounding import check_grounding, extract_figures, format_inr, scaled
from agentmw.optimize.metrics import compose_metric
from agentmw.schemas import ToolOutput

PARITY = json.loads((Path(__file__).parent / "data" / "grounding_parity.json").read_text("utf-8"))


@pytest.mark.parametrize("case", PARITY["cases"], ids=lambda c: c["reply"][:40])
def test_parity_with_typescript(case):
    r = check_grounding(case["reply"], case["toolOutputs"])
    assert {"ok": r.ok, "ungrounded": r.ungrounded} == case["expected"]


@pytest.mark.parametrize("text,value", [
    ("₹1,30,206.50", 130_206_500_000), ("₹1.2 lakh", 120_000_000_000), ("INR 2.5 cr", 25_000_000_000_000),
    ("90k", 90_000_000_000), ("50 paise", 500_000), ("Rs. 45,000/-", 45_000_000_000),
])
def test_indian_formats_normalise_exactly(text, value):
    f = extract_figures(text)
    assert len(f) == 1 and f[0].value == value and f[0].kind == "money"


def test_scaled_refuses_sub_scale_precision():
    assert scaled("1.2345678", "") is None


def test_format_inr():
    assert format_inr(1234567890) == "₹1,23,45,678.90"
    assert format_inr(-45000) == "-₹450.00"
    assert format_inr(13020650) == "₹1,30,206.50"
    assert format_inr(99) == "₹0.99"


def _ex(outputs, facts):
    return dspy.Example(request="q", tool_outputs=[ToolOutput(tool="t", output=o) for o in outputs], gold_answer_facts=facts)


def _pred(answer, facts=("f",)):
    return dspy.Prediction(answer=answer, facts=list(facts), inferences=[], opinions=[])


def test_metric_zero_for_any_invented_figure_even_with_full_coverage():
    ex = _ex(["Net profit ₹1,30,000.00; Income ₹4,50,000.00"], ["Net profit ₹1,30,000", "Income ₹4,50,000"])
    good = compose_metric(ex, _pred("Income ₹4,50,000 and net profit ₹1,30,000."))
    bad = compose_metric(ex, _pred("Income ₹4,50,000 and net profit ₹1,30,000, up 12% on August."))
    assert float(good) == 1.0
    assert float(bad) == 0.0 and "12%" in bad.feedback


def test_metric_rewards_coverage_and_structure():
    ex = _ex(["Cash ₹6,00,000.00; burn ₹1,50,000.00"], ["Cash ₹6,00,000", "burn ₹1,50,000"])
    half = compose_metric(ex, _pred("Cash is ₹6,00,000."))
    unstructured = compose_metric(ex, _pred("Cash ₹6,00,000, burn ₹1,50,000.", facts=()))
    assert float(half) == pytest.approx(0.6)
    assert float(unstructured) == pytest.approx(0.8)


def test_metric_indian_and_lakh_forms_count_as_same_figure():
    ex = _ex(["Net profit ₹1,30,000.00"], ["Net profit ₹1,30,000"])
    assert float(compose_metric(ex, _pred("Net profit was ₹1.3 lakh."))) == 1.0


def test_metric_hidden_figure_in_opinions_counts():
    ex = _ex(["Cash ₹6,00,000.00"], ["Cash ₹6,00,000"])
    p = dspy.Prediction(answer="Cash ₹6,00,000.", facts=["Cash ₹6,00,000"], inferences=[], opinions=["Keep ₹2,00,000 aside"])
    assert float(compose_metric(ex, p)) == 0.0
