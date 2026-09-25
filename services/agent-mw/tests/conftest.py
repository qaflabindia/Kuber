"""Shared fixtures: a signed client for the app, backed by a deterministic fake LM (no network)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agentmw.app import create_app
from agentmw.auth import auth_key, sign_request
from agentmw.config import Settings
from agentmw.fake_lm import FakeLM, heuristic_responder

SECRET = "s" * 48
APPROVAL = "system_owner:asha:2026-09-01:us"
TODAY = "2026-09-25"

CATALOGUE = [
    {"name": "kuber_accounts", "description": "List the chart of accounts", "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "kuber_pnl", "description": "Profit and loss for a period",
     "input_schema": {"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}}, "required": ["from", "to"]}},
]
CHART = [{"id": "RENT", "name": "Rent expense", "type": "expense"}, {"id": "SALES", "name": "Sales income", "type": "income"}]


def make_settings(tmp_path: Path, **over: Any) -> Settings:
    agent = tmp_path / "agent"
    (agent / "artifacts").mkdir(parents=True, exist_ok=True)
    s = Settings(secret=SECRET, model=None, processing_approved=APPROVAL, agent_dir=agent,
                 lock_path=agent / "prompts.lock.json", artifacts_dir=agent / "artifacts")
    for k, v in over.items():
        setattr(s, k, v)
    return s


class Mw:
    """A TestClient that signs like the core's MiddlewareReasoner."""

    def __init__(self, app, secret: str = SECRET):
        self.client = TestClient(app)
        self.key = auth_key(secret)
        self.app = app

    def post(self, path: str, body: Any, tenant: str | None = "t1", approval: str | None = APPROVAL,
             sign: bool = True, **sign_over: Any):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers = {"content-type": "application/json"}
        if sign:
            headers["x-kuber-auth"] = sign_request(self.key, method="POST", path=path, body=raw, tenant=tenant,
                                                   principal="agent:copilot", **sign_over)
        if approval:
            headers["x-kuber-processing-approval"] = approval
        return self.client.post(path, content=raw, headers=headers)

    def get(self, path: str, sign: bool = True):
        headers = {"x-kuber-auth": sign_request(self.key, method="GET", path=path, body=b"", tenant="t1", principal=None)} if sign else {}
        return self.client.get(path, headers=headers)


@pytest.fixture
def responder_box():
    """Tests replace box['fn'] to script the model; defaults to the heuristic responder."""
    box: dict[str, Any] = {"fn": heuristic_responder, "seen": []}
    return box


@pytest.fixture
def fake_lm(responder_box):
    def r(messages):
        responder_box["seen"].append(messages)
        return responder_box["fn"](messages)
    return FakeLM(r)


@pytest.fixture
def mw(tmp_path, fake_lm):
    return Mw(create_app(make_settings(tmp_path), lm=fake_lm, today=TODAY))


def next_step_body(**over: Any) -> dict[str, Any]:
    return {"request": "Chart of accounts please", "history": [], "catalogue": CATALOGUE, "prior_steps": [], **over}


def decision(**d: Any):
    """A responder that always returns this decision."""
    full = {"action": "tool", "tool": None, "args": None, "draft": None, **d}
    return lambda messages: {"reasoning": "scripted", "decision": full}
