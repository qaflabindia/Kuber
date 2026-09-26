"""Golden dataset loader for the offline optimiser.

Reads JSONL in the shape the evaluation workstream builds (`eval/agent/*.jsonl`, ws5/agent-eval),
accepting this simple schema per line:

    {"id"?: str, "utterance": str, "history"?: [{role, text}],
     "catalogue"?: [{name, description, input_schema} | "<tool name>"],
     "prior_steps"?: [{tool, args, output}],
     "gold"?: {"tool": str, "args": {...}} | {"action": "final"},          -> next_step
     "tool_outputs"?: [{tool, output}], "gold_answer_facts"?: [str],        -> compose
     "line"?: {narration, direction, magnitude, amount?}, "chart"?: [...],
     "gold_account"?: str}                                                   -> classify

A row feeds every program whose gold it carries; rows without it are skipped for that program.
Extra keys (tags, layer, adversarial class) are ignored.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import dspy

from agentmw.schemas import (ChartAccount, HistoryItem, PriorStep, StatementLine, ToolOutput, ToolSpec)

INPUTS = {
    "next_step": ("request", "history", "catalogue", "prior_steps"),
    "compose": ("request", "tool_outputs", "draft"),
    "classify": ("line", "chart"),
}


def dataset_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_rows(path: Path) -> list[dict[str, Any]]:
    rows = []
    for n, line in enumerate(path.read_text("utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        try:
            obj = json.loads(line)
        except ValueError as e:
            raise ValueError(f"{path}:{n}: not JSON ({e})") from None
        if not isinstance(obj, dict):
            raise ValueError(f"{path}:{n}: each line must be an object")
        obj.setdefault("id", f"{path.stem}:{n}")
        rows.append(obj)
    return rows


def _catalogue(raw: list[Any]) -> list[ToolSpec]:
    out = []
    for t in raw or []:
        if isinstance(t, str):
            out.append(ToolSpec(name=t, description="", input_schema={"type": "object"}))
        else:
            out.append(ToolSpec.model_validate({"input_schema": {"type": "object"}, "description": "", **t}))
    return out


def _line(row: dict[str, Any]) -> StatementLine:
    raw = dict(row.get("line") or {})
    raw.setdefault("narration", row.get("utterance", ""))
    raw.setdefault("direction", "out")
    raw.setdefault("magnitude", "1k_10k")
    return StatementLine.model_validate(raw)


def to_example(program: str, row: dict[str, Any]) -> dspy.Example | None:
    if program == "next_step":
        if "gold" not in row or not row.get("catalogue"):
            return None
        ex = dspy.Example(
            id=row["id"], request=row["utterance"],
            history=[HistoryItem.model_validate(h) for h in row.get("history", [])][-8:],
            catalogue=_catalogue(row["catalogue"]),
            prior_steps=[PriorStep.model_validate(s) for s in row.get("prior_steps", [])],
            gold=row["gold"])
    elif program == "compose":
        if "gold_answer_facts" not in row or "tool_outputs" not in row:
            return None
        ex = dspy.Example(
            id=row["id"], request=row["utterance"],
            tool_outputs=[ToolOutput.model_validate(t) for t in row["tool_outputs"]],
            draft=row.get("draft", ""), gold_answer_facts=list(row["gold_answer_facts"]))
    elif program == "classify":
        if "gold_account" not in row or not row.get("chart"):
            return None
        ex = dspy.Example(
            id=row["id"], line=_line(row), chart=[ChartAccount.model_validate(a) for a in row["chart"]],
            gold_account=row["gold_account"])
    else:
        raise ValueError(f"unknown program {program}")
    return ex.with_inputs(*INPUTS[program])


def load_examples(program: str, path: Path) -> list[dspy.Example]:
    return [e for e in (to_example(program, r) for r in read_rows(path)) if e is not None]
