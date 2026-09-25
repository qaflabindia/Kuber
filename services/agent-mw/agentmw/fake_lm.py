"""A deterministic, offline language model for tests and reproducibility runs (never used in serving).

`FakeLM(responder)` answers every request by calling `responder(messages) -> dict | str`:
a dict is rendered as the output fields the DSPy adapter expects; a str is returned verbatim
(GEPA's reflection prompts are raw text, not signatures). Token usage is a word count, so
cost accounting and meta fields can be tested without a network.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from dspy.clients.engines.dummy_engine import AsyncDummyEngine, DummyEngine
from dspy.lm15 import Message, Response, TextPart, Usage
from dspy.utils.dummies import DummyLM

Responder = Callable[[list[dict[str, Any]]], "dict[str, Any] | str"]

_OUTPUT_FIELDS = re.compile(r"Your output fields are:\s*(.*?)(?:\n\n|All interactions)", re.S)
_FIELD_NAME = re.compile(r"\d+\.\s*`(\w+)`")


def output_fields(messages: list[dict[str, Any]]) -> list[str]:
    """Names of the output fields a ChatAdapter/JSONAdapter prompt asks for (from the system message)."""
    system = next((m.get("content") or "" for m in messages if m.get("role") == "system"), "")
    m = _OUTPUT_FIELDS.search(system)
    return _FIELD_NAME.findall(m.group(1)) if m else []


def last_user(messages: list[dict[str, Any]]) -> str:
    return next((m.get("content") or "" for m in reversed(messages) if m.get("role") == "user"), "")


class _Engine(DummyEngine):
    def _complete_messages(self, messages):  # type: ignore[override]
        owner: FakeLM = self.owner  # type: ignore[assignment]
        out = owner.responder(messages)
        text = out if isinstance(out, str) else owner._format_answer_fields(out)
        words_in = sum(len(str(m.get("content") or "").split()) for m in messages)
        owner.calls += 1
        return Response(id=None, model=owner.model, message=Message.assistant([TextPart(text)]), finish_reason="stop",
                        usage=Usage(input_tokens=words_in, output_tokens=len(text.split()),
                                    total_tokens=words_in + len(text.split())))


class FakeLM(DummyLM):
    def __init__(self, responder: Responder, model: str = "fake/deterministic"):
        super().__init__({})
        self.model = model
        self.responder = responder
        self.calls = 0
        self._engine_spec = _Engine(self)
        self._async_engine_spec = AsyncDummyEngine(self._engine_spec)

    def copy(self, **kwargs):  # DummyLM.copy installs a plain DummyEngine; keep the responder
        new = super().copy(**kwargs)
        new._engine_spec = _Engine(new)
        new._async_engine_spec = AsyncDummyEngine(new._engine_spec)
        return new


# ------------------------------------------------------------------------------------ heuristic responder
_SECTION = re.compile(r"\[\[ ## (\w+) ## \]\]\n(.*?)(?=\n\n(?:\[\[ ## |Respond with )|\Z)", re.S)
_WORDS = re.compile(r"[a-z]+")


def input_sections(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """The field values of the final user message (earlier user messages are demonstrations)."""
    import json
    out: dict[str, Any] = {}
    for name, raw in _SECTION.findall(last_user(messages)):
        try:
            out[name] = json.loads(raw)
        except ValueError:
            out[name] = raw.strip()
    return out


def _stems(text: str) -> set[str]:
    return {w[:4] for w in _WORDS.findall(str(text).lower()) if len(w) >= 3}


def _best(items: list[dict[str, Any]], text: str, key) -> dict[str, Any] | None:
    words = _stems(text)
    scored = [(len(words & _stems(key(it))), -i, it) for i, it in enumerate(items)]
    return max(scored, key=lambda t: (t[0], t[1]))[2] if scored else None


def heuristic_responder(messages: list[dict[str, Any]]) -> dict[str, Any] | str:
    """A deterministic stand-in model: word overlap for tool and account choice, echo for answers.

    Used for tests and for `--model fake` optimiser runs that must be reproducible offline. It never
    reads anything outside the prompt and never contacts a network."""
    fields = output_fields(messages)
    if not fields:     # GEPA reflection prompt: raw text in, a fenced instruction out
        return "```\nFollow every rule in the task exactly. Use only the tools, figures and accounts given.\n```"
    x = input_sections(messages)
    out: dict[str, Any] = {}
    for f in fields:
        if f == "reasoning":
            out[f] = "Deterministic heuristic."
        elif f == "decision":
            steps = x.get("prior_steps") or []
            if steps:
                out[f] = {"action": "final", "draft": str(steps[-1].get("output", ""))[:200] or "Done.", "tool": None, "args": None}
            else:
                cat = x.get("catalogue") or []
                t = _best(cat, x.get("request", ""), lambda it: f"{it.get('name', '').replace('_', ' ')} {it.get('description', '')}")
                out[f] = {"action": "tool", "tool": (t or {}).get("name", ""), "args": {}, "draft": None}
        elif f == "answer":
            outs = [str(t.get("output", ""))[:300] for t in (x.get("tool_outputs") or [])]
            out[f] = ("The books show: " + "; ".join(outs)) if outs else "The tools returned nothing to report."
        elif f == "facts":
            out[f] = [str(t.get("output", ""))[:300] for t in (x.get("tool_outputs") or [])]
        elif f in ("inferences", "opinions"):
            out[f] = []
        elif f == "account_id":
            line = x.get("line") or {}
            a = _best(x.get("chart") or [], line.get("narration", "") if isinstance(line, dict) else str(line),
                      lambda it: f"{it.get('name', '')} {it.get('type', '') or ''}")
            out[f] = (a or {}).get("id", "")
        elif f == "confidence":
            out[f] = 0.5
        elif f == "reasons":
            out[f] = ["word overlap between narration and account name"]
        else:
            out[f] = "Deterministic."
    return out
