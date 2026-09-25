"""Per-tenant rate limit, token budget, cost accounting, /metrics and the bounded model call."""
from __future__ import annotations

import time

from agentmw.app import create_app
from agentmw.config import MAX_TOKENS_CEILING, TIMEOUT_CEILING_S, Settings
from agentmw.limits import Limiter
from conftest import TODAY, Mw, make_settings, next_step_body


def test_rate_limit_is_per_tenant(tmp_path, fake_lm):
    m = Mw(create_app(make_settings(tmp_path, rate_per_minute=2), lm=fake_lm, today=TODAY))
    assert [m.post("/v1/next-step", next_step_body(), tenant="t1").status_code for _ in range(3)] == [200, 200, 429]
    assert m.post("/v1/next-step", next_step_body(), tenant="t1").json()["error"] == "rate_limited"
    assert m.post("/v1/next-step", next_step_body(), tenant="t2").status_code == 200


def test_daily_token_budget(tmp_path, fake_lm):
    m = Mw(create_app(make_settings(tmp_path, tokens_per_day=1000), lm=fake_lm, today=TODAY))
    codes = [m.post("/v1/next-step", next_step_body()).status_code for _ in range(6)]
    assert codes[0] == 200 and codes[-1] == 429


def test_limiter_window_slides():
    now = [1000.0]
    lim = Limiter(1, 10**9, 3, 15, clock=lambda: now[0])
    assert lim.admit("t") is None and lim.admit("t") == "rate_limited"
    now[0] += 61
    assert lim.admit("t") is None


def test_metrics_counts_tokens_and_cost_per_tenant(mw, responder_box):
    mw.post("/v1/next-step", next_step_body(), tenant="t1")
    responder_box["fn"] = lambda m: {"reasoning": "", "decision": {"action": "tool", "tool": "nope", "args": {}}}
    mw.post("/v1/next-step", next_step_body(), tenant="t1")
    text = mw.get("/metrics").text
    assert 'agentmw_requests_total{tenant="t1",program="next_step",outcome="ok"} 1' in text
    assert 'agentmw_requests_total{tenant="t1",program="next_step",outcome="tool_not_in_catalogue"} 1' in text
    tin = int(next(l for l in text.splitlines() if l.startswith('agentmw_tokens_in_total{tenant="t1"}')).split()[-1])
    cost = float(next(l for l in text.splitlines() if l.startswith('agentmw_cost_usd_total{tenant="t1"}')).split()[-1])
    assert tin > 0 and cost > 0
    assert "agentmw_processing_approved 1" in text
    assert "Chart of accounts" not in text           # no request content in metrics


def test_model_call_times_out(tmp_path, fake_lm, responder_box):
    def slow(messages):
        time.sleep(1.5)
        return {"reasoning": "", "decision": {"action": "final", "draft": "late"}}
    responder_box["fn"] = slow
    m = Mw(create_app(make_settings(tmp_path, timeout_s=1.0), lm=fake_lm, today=TODAY))
    r = m.post("/v1/next-step", next_step_body())
    assert r.status_code == 504 and r.json()["error"] == "model_timeout"


def test_provider_error_is_502_without_detail(mw, responder_box):
    def boom(messages):
        raise RuntimeError("secret prompt text here")
    responder_box["fn"] = boom
    r = mw.post("/v1/next-step", next_step_body())
    assert r.status_code == 502 and "secret prompt" not in r.text


def test_bounds_cannot_be_raised_by_env():
    s = Settings.from_env({"AGENT_MW_MAX_TOKENS": "999999", "AGENT_MW_TIMEOUT_S": "9999"})
    assert s.max_tokens == MAX_TOKENS_CEILING and s.timeout_s == TIMEOUT_CEILING_S


def test_lm_is_configured_bounded(tmp_path):
    from agentmw.lm import build_lm
    lm = build_lm(make_settings(tmp_path, model="anthropic/claude-x", max_tokens=512, timeout_s=5.0))
    assert lm.model == "anthropic/claude-x" and lm.kwargs.get("max_tokens") == 512 and lm.kwargs.get("temperature") == 0.0
    assert build_lm(make_settings(tmp_path)) is None


def test_body_size_limit(mw):
    r = mw.post("/v1/next-step", b"x" * (600 * 1024))
    assert r.status_code == 413
