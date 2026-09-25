"""Offline optimiser: compile one reasoning program against a golden dataset (agent design 7.1, 7.4).

    python -m agentmw.optimize --program next_step --dataset eval/agent/golden.jsonl \
        --optimizer gepa|miprov2 --seed 7 --out agent/artifacts/

Writes `<out>/<id>.json` (the artifact) and `<out>/<id>.report.md`. It never deploys anything and
never touches `agent/prompts.lock.json`: an artifact goes live only after a person approves it
(services/agent-mw/README.md, "Approving an artifact").

The artifact holds id, version, sha256 (of the canonical JSON of `content`, the DSPy module state),
program, optimizer, seed, datasetHash, metric, scores before and after on a held-out split, and
approvedBy: null. Nothing time-dependent is written into it, so a fixed seed, dataset and stubbed
model (`--model fake`) produce the same artifact, byte for byte.

Controls (ASDGF CA-6: the optimisation environment runs under the production control matrix):
the model-processing gate applies here too (a real model needs KUBER_LLM_PROCESSING_APPROVED);
the programs get no tools; the only network is the model provider.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import random
import sys
from pathlib import Path
from typing import Any

import dspy

from agentmw.artifacts import content_hash
from agentmw.gate import parse_processing_approval
from agentmw.programs import PROGRAMS

from .dataset import dataset_hash, load_examples
from .metrics import METRICS

log = logging.getLogger("agentmw.optimize")
FAKE = "fake"


def split(examples: list[dspy.Example], seed: int, holdout: float) -> tuple[list[dspy.Example], list[dspy.Example]]:
    idx = list(range(len(examples)))
    random.Random(seed).shuffle(idx)
    n_hold = max(1, round(len(examples) * holdout))
    hold = [examples[i] for i in sorted(idx[:n_hold])]
    train = [examples[i] for i in sorted(idx[n_hold:])]
    return train, hold


def evaluate(program: dspy.Module, examples: list[dspy.Example], metric) -> float:
    """Mean metric on `examples`, sequential and deterministic; a crashing example scores 0."""
    if not examples:
        return 0.0
    total = 0.0
    for ex in examples:
        try:
            pred = program(**ex.inputs())
            total += float(metric(ex, pred).score)
        except Exception as e:     # parse failures count against the program, not the run
            log.debug("example %s failed: %s", ex.get("id"), e)
    return round(total / len(examples), 6)


def _jsonable(obj: Any) -> Any:
    def default(o: Any) -> Any:
        if hasattr(o, "model_dump"):
            return o.model_dump(mode="json")
        if hasattr(o, "toDict"):
            return o.toDict()
        return str(o)
    return json.loads(json.dumps(obj, default=default, sort_keys=True, ensure_ascii=False))


def _strip_lm(state: Any) -> Any:
    """An artifact never chooses a model: predictor LM state is removed before hashing."""
    if isinstance(state, dict):
        return {k: (None if k == "lm" else _strip_lm(v)) for k, v in state.items()}
    if isinstance(state, list):
        return [_strip_lm(v) for v in state]
    return state


def make_lm(model: str):
    if model == FAKE:
        from agentmw.fake_lm import FakeLM, heuristic_responder
        return FakeLM(heuristic_responder)
    return dspy.LM(model, temperature=0.0, max_tokens=2048, cache=False, num_retries=2)


def compile_program(program: str, dataset: Path, optimizer: str, seed: int, out: Path, model: str,
                    reflection_model: str | None = None, budget: int = 40, holdout: float = 0.3,
                    version: str = "1.0.0", owner: str = "System Owner") -> dict[str, Any]:
    if program not in PROGRAMS:
        raise SystemExit(f"unknown program {program}; one of {sorted(PROGRAMS)}")
    if optimizer not in ("gepa", "miprov2"):
        raise SystemExit("optimizer must be gepa or miprov2")
    if model != FAKE or (reflection_model and reflection_model != FAKE):
        g = parse_processing_approval(os.environ.get("KUBER_LLM_PROCESSING_APPROVED"))
        if not g.ok:
            raise SystemExit(f"processing_not_approved: {g.reason}")
    random.seed(seed)
    spec = PROGRAMS[program]
    metric_name, metric = METRICS[program]
    examples = load_examples(program, dataset)
    if len(examples) < 3:
        raise SystemExit(f"{dataset} has {len(examples)} usable {program} examples; at least 3 are needed")
    train, hold = split(examples, seed, holdout)
    lm = make_lm(model)
    reflection = make_lm(reflection_model or model)
    with dspy.context(lm=lm):
        baseline = spec.module()
        before = evaluate(baseline, hold, metric)
        if optimizer == "gepa":
            opt = dspy.GEPA(metric=metric, max_metric_calls=budget, reflection_lm=reflection, seed=seed,
                            num_threads=1, use_merge=False, track_stats=False, reflection_minibatch_size=min(3, len(train)))
            compiled = opt.compile(spec.module(), trainset=train, valset=train)
        else:
            opt = dspy.MIPROv2(metric=metric, auto=None, num_candidates=3, seed=seed, num_threads=1,
                               prompt_model=reflection, task_model=lm, verbose=False, track_stats=False,
                               max_bootstrapped_demos=2, max_labeled_demos=2)
            compiled = opt.compile(spec.module(), trainset=train, valset=train, num_trials=3, minibatch=False,
                                   seed=seed)
        after = evaluate(compiled, hold, metric)
    content = _strip_lm(_jsonable(compiled.dump_state()))
    sha = content_hash(content)
    aid = f"{program}-{sha[:12]}"
    artifact = {
        "id": aid, "version": version, "program": program, "sha256": sha,
        "optimizer": optimizer, "seed": seed, "datasetHash": dataset_hash(dataset), "dataset": dataset.name,
        "metric": metric_name, "model": model, "reflectionModel": reflection_model or model,
        "split": {"train": len(train), "holdout": len(hold), "holdoutIds": [e.get("id") for e in hold]},
        "scores": {"before": before, "after": after},
        "dspyVersion": dspy.__version__, "owner": owner, "approvedBy": None,
        "report": f"{aid}.report.md", "content": content,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{aid}.json").write_text(json.dumps(artifact, indent=2, sort_keys=True, ensure_ascii=False) + "\n", "utf-8")
    (out / f"{aid}.report.md").write_text(report(artifact), "utf-8")
    return artifact


def report(a: dict[str, Any]) -> str:
    delta = a["scores"]["after"] - a["scores"]["before"]
    return f"""# Compiled artifact {a['id']}

Status: **not approved**. This file is evidence for a review; it deploys nothing.

| Field | Value |
|---|---|
| Program | `{a['program']}` |
| Version | {a['version']} |
| Content sha256 | `{a['sha256']}` |
| Optimizer | {a['optimizer']} (seed {a['seed']}) |
| Model / reflection model | `{a['model']}` / `{a['reflectionModel']}` |
| Dataset | `{a['dataset']}` sha256 `{a['datasetHash']}` |
| Split | {a['split']['train']} train, {a['split']['holdout']} held out |
| Metric | `{a['metric']}` |
| Held-out score before | {a['scores']['before']:.4f} |
| Held-out score after | {a['scores']['after']:.4f} ({delta:+.4f}) |
| DSPy | {a['dspyVersion']} |
| Owner | {a['owner']} |
| Approved by | (none) |

Held-out example ids: {', '.join(str(i) for i in a['split']['holdoutIds'])}

## Before approving

1. Read the compiled instructions and demonstrations in `content` of `{a['id']}.json`. Demonstrations
   must contain no personal data and no tenant data the owner has not approved for training use.
2. Run the evaluation hard gates (agent design section 5) with this artifact loaded: unsafe actions,
   agent commits, injection followed, cross-book leakage and grounding violations must all be 0.
3. Confirm the held-out score did not fall, and that the metric was the program's own (`{a['metric']}`).
4. Only then add the lock entry (services/agent-mw/README.md, "Approving an artifact").
"""


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m agentmw.optimize", description=__doc__.split("\n\n")[0])
    p.add_argument("--program", required=True, choices=sorted(PROGRAMS))
    p.add_argument("--dataset", required=True, type=Path)
    p.add_argument("--optimizer", default="gepa", choices=["gepa", "miprov2"])
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--out", type=Path, default=Path("agent/artifacts"))
    p.add_argument("--model", default=os.environ.get("AGENT_MW_MODEL") or FAKE,
                   help="DSPy model string (anthropic/..., openai/..., ollama_chat/...) or 'fake' for an offline deterministic run")
    p.add_argument("--reflection-model", default=None)
    p.add_argument("--budget", type=int, default=40, help="GEPA metric-call budget")
    p.add_argument("--holdout", type=float, default=0.3)
    p.add_argument("--version", default="1.0.0")
    p.add_argument("--owner", default="System Owner")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.WARNING)
    art = compile_program(a.program, a.dataset, a.optimizer, a.seed, a.out, a.model, a.reflection_model,
                          a.budget, a.holdout, a.version, a.owner)
    print(json.dumps({"id": art["id"], "sha256": art["sha256"], "scores": art["scores"],
                      "artifact": str(a.out / f"{art['id']}.json"), "approvedBy": None}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
