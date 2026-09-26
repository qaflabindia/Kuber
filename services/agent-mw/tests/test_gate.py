"""Model-processing gate (TAGOF Domain 12): no valid decision, no model call."""
from __future__ import annotations

import pytest

from agentmw.app import create_app
from agentmw.gate import check_request, parse_processing_approval
from conftest import APPROVAL, CHART, SECRET, TODAY, Mw, make_settings, next_step_body

BODIES = {
    "/v1/next-step": next_step_body(),
    "/v1/compose": {"request": "bank?", "tool_outputs": [{"tool": "kuber_balance", "output": "BANK ₹1,000.00"}]},
    "/v1/classify": {"line": {"narration": "RENT", "direction": "out", "magnitude": "10k_1l"}, "chart": CHART},
}


@pytest.mark.parametrize("value,ok", [
    ("system_owner:asha:2026-09-25:us", True),
    ("asha:2026-09-01:in", True),
    ("asha:2026-09-01:ap-south-1", True),
    ("", False), (None, False),
    ("asha:2026-09-01", False),              # missing location
    ("asha:2026-02-30:in", False),           # not a real date
    ("asha:2026-09-26:in", False),           # future
    ("asha:2026-09-01:india", False),        # not a country code
    ("1asha:2026-09-01:in", False),          # approver shape
])
def test_parse(value, ok):
    assert parse_processing_approval(value, today=TODAY).ok is ok


def test_location_is_normalised():
    assert parse_processing_approval("asha:2026-09-01:US", today=TODAY).record == "asha:2026-09-01:us"


@pytest.mark.parametrize("path", sorted(BODIES))
@pytest.mark.parametrize("approval", [None, "", "asha:2026-02-30:in", "asha:2099-01-01:in", "garbage"])
def test_every_endpoint_503_without_valid_decision(tmp_path, fake_lm, path, approval):
    m = Mw(create_app(make_settings(tmp_path, processing_approved=approval), lm=fake_lm, today=TODAY))
    r = m.post(path, BODIES[path])
    assert r.status_code == 503 and r.json()["error"] == "processing_not_approved"
    assert fake_lm.calls == 0          # no model was called


@pytest.mark.parametrize("presented", [None, "other:2026-09-01:us", "system_owner:asha:2026-09-01:in"])
def test_core_must_present_the_same_record(mw, presented, fake_lm):
    r = mw.post("/v1/next-step", next_step_body(), approval=presented)
    assert r.status_code == 503 and r.json()["error"] == "processing_not_approved"
    assert fake_lm.calls == 0


def test_valid_decision_opens_the_gate(mw):
    assert mw.post("/v1/next-step", next_step_body()).status_code == 200


def test_check_request_unit():
    s = parse_processing_approval(APPROVAL, today=TODAY)
    assert check_request(s, APPROVAL) is None
    assert check_request(s, None)
    assert check_request(parse_processing_approval(None), APPROVAL)


def test_healthz_reports_gate_without_secrets(tmp_path, fake_lm):
    for approval, approved in [(None, False), (APPROVAL, True)]:
        m = Mw(create_app(make_settings(tmp_path, processing_approved=approval, model="anthropic/claude-x"), lm=fake_lm, today=TODAY))
        r = m.client.get("/healthz")
        assert r.status_code == 200
        body = r.json()
        assert body["gate"]["approved"] is approved
        text = r.text
        assert SECRET not in text and "asha" not in text and "system_owner" not in text
        if approved:
            assert body["gate"]["location"] == "us" and body["gate"]["date"] == "2026-09-01"
        else:
            assert "not set" in body["gate"]["reason"]


def test_no_model_configured_is_503(tmp_path):
    m = Mw(create_app(make_settings(tmp_path), lm=None, today=TODAY))
    r = m.post("/v1/next-step", next_step_body())
    assert r.status_code == 503 and r.json()["error"] == "model_not_configured"
