"""Typed request and response bodies. Every list and string is bounded, so no request can make the
middleware build an unbounded prompt; the core already truncates, and these are the backstop."""
from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

FORBIDDEN_TOOLS = frozenset({"kuber_commit"})   # AAWDS L1: commits are by persons only
MAX_HISTORY = 8
MAX_STEPS = 8
TOOL_NAME = r"^[a-z][a-z0-9_]{0,63}$"


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Meta(BaseModel):
    """Recorded by the core in the turn record, so an answer traces to the exact compiled program."""
    program: str
    artifactId: str | None
    artifactHash: str | None
    model: str
    tokensIn: int
    tokensOut: int
    ms: int


class HistoryItem(Strict):
    role: Literal["user", "assistant"]
    text: str = Field(max_length=4000)


class ToolSpec(Strict):
    name: str = Field(pattern=TOOL_NAME)
    description: str = Field(max_length=2000)
    input_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})


class PriorStep(Strict):
    tool: str = Field(pattern=TOOL_NAME)
    args: dict[str, Any] = Field(default_factory=dict)
    output: str = Field(max_length=30_000, description="Tool output, already screened by the core (PRM-08)")


class NextStepRequest(Strict):
    request: str = Field(min_length=1, max_length=4000)
    history: list[HistoryItem] = Field(default_factory=list)
    catalogue: list[ToolSpec] = Field(min_length=1, max_length=96)
    prior_steps: list[PriorStep] = Field(default_factory=list, max_length=MAX_STEPS)

    @field_validator("history")
    @classmethod
    def cap_history(cls, v: list[HistoryItem]) -> list[HistoryItem]:
        return v[-MAX_HISTORY:]         # capped, most recent kept (agent design 2: at most 8 exchanges)

    @model_validator(mode="after")
    def catalogue_is_governed(self) -> "NextStepRequest":
        names = [t.name for t in self.catalogue]
        if len(set(names)) != len(names):
            raise ValueError("catalogue has duplicate tool names")
        bad = FORBIDDEN_TOOLS.intersection(names)
        if bad:
            raise ValueError(f"catalogue contains a tool the agent may never call: {sorted(bad)}")
        return self


class NextStepResponse(BaseModel):
    action: Literal["tool", "final"]
    tool: str | None = None
    args: dict[str, Any] | None = None
    draft: str | None = None
    meta: Meta


class ToolOutput(Strict):
    tool: str = Field(pattern=TOOL_NAME)
    output: str = Field(max_length=30_000)


class ComposeRequest(Strict):
    request: str = Field(min_length=1, max_length=4000)
    tool_outputs: list[ToolOutput] = Field(default_factory=list, max_length=16)
    draft: str | None = Field(default=None, max_length=8000)


class GroundingOut(BaseModel):
    ok: bool
    ungrounded: list[str]


class ComposeResponse(BaseModel):
    answer: str
    facts: list[str]
    inferences: list[str]
    opinions: list[str]
    grounding: GroundingOut
    meta: Meta


MAGNITUDES = ("lt_1k", "1k_10k", "10k_1l", "1l_10l", "10l_1cr", "gte_1cr")
_DIGIT_RUN = re.compile(r"\d{4,}")


def mask_narration(s: str) -> str:
    """Runs of 4+ digits (account, card, phone, reference numbers) are masked before any model sees them."""
    return _DIGIT_RUN.sub(lambda m: "#" * len(m.group(0)), s)


class StatementLine(Strict):
    narration: str = Field(max_length=500)
    direction: Literal["in", "out"]
    magnitude: Literal["lt_1k", "1k_10k", "10k_1l", "1l_10l", "10l_1cr", "gte_1cr"]
    amount: str | None = Field(default=None, pattern=r"^\d{1,13}(\.\d{1,2})?$",
                               description="Rupees; only when the core decides to pass it")
    date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @field_validator("narration")
    @classmethod
    def masked(cls, v: str) -> str:
        return mask_narration(v)       # defence in depth: the core masks first


class ChartAccount(Strict):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(max_length=200)
    type: str | None = Field(default=None, max_length=40)


class ClassifyRequest(Strict):
    line: StatementLine
    chart: list[ChartAccount] = Field(min_length=1, max_length=1000)


class ClassifyResponse(BaseModel):
    accountId: str
    confidence: float
    reasons: list[str]
    meta: Meta
