"""Offline optimiser: reproducible artifacts, held-out scores, no lock writes, gate applies."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentmw.optimize.compile import compile_program, main, split
from agentmw.optimize.dataset import load_examples, read_rows

SAMPLE = Path(__file__).resolve().parents[1] / "optimize" / "sample" / "golden.sample.jsonl"
FIELDS = {"id", "version", "program", "sha256", "optimizer", "seed", "datasetHash", "metric", "scores", "approvedBy", "content"}


def test_sample_dataset_feeds_each_program():
    assert len(read_rows(SAMPLE)) == 13
    assert [len(load_examples(p, SAMPLE)) for p in ("next_step", "compose", "classify")] == [5, 4, 4]


def test_split_is_seeded_and_disjoint():
    ex = load_examples("next_step", SAMPLE)
    a, b = split(ex, 7, 0.3), split(ex, 7, 0.3)
    assert [e.id for e in a[1]] == [e.id for e in b[1]]
    assert not {e.id for e in a[0]} & {e.id for e in a[1]}


@pytest.mark.parametrize("program,optimizer", [("next_step", "gepa"), ("compose", "gepa"), ("classify", "miprov2")])
def test_same_seed_and_dataset_give_the_same_artifact(tmp_path, program, optimizer):
    a = compile_program(program, SAMPLE, optimizer, 7, tmp_path / "a", "fake")
    b = compile_program(program, SAMPLE, optimizer, 7, tmp_path / "b", "fake")
    assert a["sha256"] == b["sha256"] and a["id"] == b["id"]
    fa, fb = (tmp_path / d / f"{a['id']}.json" for d in ("a", "b"))
    assert fa.read_bytes() == fb.read_bytes()          # byte-for-byte, not just the content hash
    art = json.loads(fa.read_text())
    assert FIELDS <= set(art)
    assert art["approvedBy"] is None and art["program"] == program and art["seed"] == 7
    assert art["metric"].startswith(program + ".")
    assert set(art["scores"]) == {"before", "after"} and art["split"]["holdout"] >= 1
    assert (tmp_path / "a" / f"{a['id']}.report.md").read_text().startswith("# Compiled artifact")


def test_optimiser_never_writes_the_lock(tmp_path):
    out = tmp_path / "agent" / "artifacts"
    compile_program("classify", SAMPLE, "gepa", 7, out, "fake")
    assert not (tmp_path / "agent" / "prompts.lock.json").exists()
    assert sorted(p.suffix for p in out.iterdir()) == [".json", ".md"]


def test_compiled_artifact_loads_only_after_approval(tmp_path):
    from agentmw.artifacts import resolve
    out = tmp_path / "artifacts"
    art = compile_program("next_step", SAMPLE, "gepa", 7, out, "fake")
    lock = tmp_path / "prompts.lock.json"
    assert resolve("next_step", out, lock).id is None
    lock.write_text(json.dumps({"artifacts": {art["id"]: {"version": art["version"], "sha256": art["sha256"], "approvedBy": "system_owner:asha"}}}))
    assert resolve("next_step", out, lock).id == art["id"]


def test_real_model_needs_processing_approval(tmp_path, monkeypatch):
    monkeypatch.delenv("KUBER_LLM_PROCESSING_APPROVED", raising=False)
    with pytest.raises(SystemExit, match="processing_not_approved"):
        compile_program("next_step", SAMPLE, "gepa", 7, tmp_path, "anthropic/claude-x")


def test_cli(tmp_path, capsys):
    assert main(["--program", "classify", "--dataset", str(SAMPLE), "--optimizer", "gepa", "--seed", "7",
                 "--out", str(tmp_path), "--model", "fake"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["approvedBy"] is None and Path(out["artifact"]).exists()


def test_too_few_examples(tmp_path):
    d = tmp_path / "d.jsonl"
    d.write_text(SAMPLE.read_text().splitlines()[0] + "\n")
    with pytest.raises(SystemExit):
        compile_program("next_step", d, "gepa", 7, tmp_path, "fake")
