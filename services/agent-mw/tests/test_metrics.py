"""Optimiser metrics: per-program, distinct (ASDGF A3), with hard penalties that cannot be traded away."""
from __future__ import annotations

import hashlib
import inspect

import dspy
import pytest

from agentmw.optimize.metrics import HARD_PENALTY, METRICS, classify_metric, next_step_metric
from agentmw.programs import PROGRAMS
from agentmw.schemas import ChartAccount, ToolSpec


def test_every_program_has_a_metric():
    assert set(METRICS) == set(PROGRAMS)


def test_no_two_programs_share_a_metric_function():
    """ASDGF A3: a shared scoring function would put the copilot and the classifier in swarm scope."""
    fns = [fn for _, fn in METRICS.values()]
    names = [n for n, _ in METRICS.values()]
    assert len(set(map(id, fns))) == len(fns)
    assert len(set(names)) == len(names)
    assert len({fn.__code__.co_code for fn in fns}) == len(fns)
    src = [hashlib.sha256(inspect.getsource(fn).encode()).hexdigest() for fn in fns]
    assert len(set(src)) == len(src)
    for program, (name, _) in METRICS.items():
        assert name.startswith(program + ".")


@pytest.mark.parametrize("program", sorted(METRICS))
def test_metrics_take_gepa_five_arguments(program):
    inspect.signature(METRICS[program][1]).bind(None, None, None, None, None)


CAT = [ToolSpec(name="kuber_accounts", description=""), ToolSpec(name="kuber_pnl", description="")]


def _gold(tool="kuber_pnl", args=None, final=False):
    g = {"action": "final"} if final else {"tool": tool, "args": args or {}}
    return dspy.Example(request="q", catalogue=CAT, gold=g)


def _dec(**d):
    return dspy.Prediction(decision={"action": "tool", "tool": None, "args": {}, **d})


def test_next_step_scores():
    g = _gold(args={"from": "2026-09-01", "to": "2026-09-30"})
    assert float(next_step_metric(g, _dec(tool="kuber_pnl", args={"from": "2026-09-01", "to": "2026-09-30"}))) == 1.0
    assert float(next_step_metric(g, _dec(tool="kuber_pnl", args={"from": "2026-09-01"}))) == 0.75
    assert float(next_step_metric(g, _dec(tool="kuber_accounts"))) == 0.1
    assert float(next_step_metric(g, _dec(action="final", draft="x"))) == 0.0
    assert float(next_step_metric(_gold(final=True), _dec(action="final", draft="x"))) == 1.0


def test_next_step_args_normalised():
    g = _gold(args={"amount": "1,200", "memo": "Rent  Sept"})
    assert float(next_step_metric(g, _dec(tool="kuber_pnl", args={"amount": 1200, "memo": "rent sept"}))) == 1.0


def test_next_step_hard_penalties_below_any_honest_failure():
    g = _gold()
    outside = next_step_metric(g, _dec(tool="kuber_trial_balance"))
    commit = next_step_metric(g, _dec(tool="kuber_commit", args={"planId": "p"}))
    assert float(outside) == HARD_PENALTY and float(commit) == HARD_PENALTY
    assert HARD_PENALTY < 0 <= float(next_step_metric(g, _dec(action="final", draft="x")))
    assert "kuber_commit" in commit.feedback


def test_classify_accuracy():
    ex = dspy.Example(chart=[ChartAccount(id="RENT", name="Rent")], gold_account="RENT")
    assert float(classify_metric(ex, dspy.Prediction(account_id="RENT"))) == 1.0
    miss = classify_metric(ex, dspy.Prediction(account_id="SUSPENSE"))
    assert float(miss) == 0.0 and "not in the chart" in miss.feedback
