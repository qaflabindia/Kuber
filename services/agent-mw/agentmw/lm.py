"""Provider-agnostic model configuration through DSPy's LM (LiteLLM model strings):

    AGENT_MW_MODEL=anthropic/claude-sonnet-4-5 | openai/gpt-4.1-mini | ollama_chat/llama3.1 | ...

Keys are read by the provider client from the environment only (ANTHROPIC_API_KEY, OPENAI_API_KEY,
...); no request can carry or change a key, a model or an endpoint. AGENT_MW_API_BASE optionally
points at a local server (ollama). Temperature is 0, responses are not cached, and max tokens and the
client timeout are bounded by config.py.
"""
from __future__ import annotations

import os

import dspy

from .config import Settings


def build_lm(settings: Settings) -> dspy.LM | None:
    if not settings.model:
        return None
    kwargs: dict = {}
    base = os.environ.get("AGENT_MW_API_BASE")
    if base:
        kwargs["api_base"] = base
    return dspy.LM(settings.model, temperature=0.0, max_tokens=settings.max_tokens, cache=False,
                   num_retries=1, timeout=settings.timeout_s, **kwargs)
