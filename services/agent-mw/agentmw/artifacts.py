"""Compiled-artifact loading behind the approval lock (TAGOF PRM-01..03; agent design 7.1).

A compiled DSPy program is stored as `agent/artifacts/<id>.json`:

    {"id", "version", "program", "sha256", "content": <DSPy module state>, "optimizer", "seed",
     "datasetHash", "metric", "scores": {...}, "approvedBy": null, ...}

`sha256` is the SHA-256 of the canonical JSON of `content` (sorted keys, no whitespace, UTF-8), so the
metadata may be annotated without changing what was approved, while any change to the instructions
or demonstrations changes the hash.

The middleware loads an artifact only when `agent/prompts.lock.json` lists its id with the same
sha256 and a named approver. Two lock shapes are read:

    {"artifacts": {"<id>": {"version", "sha256", "approvedBy"}}}                   (this service's shape)
    {"version": 1, "entries": [{"kind": "dspy_artifact", "id", "version", "sha256",
                                "approver", "approvedAt", "file"}]}                    (ws5/agent-gov's lock)

An artifact that is unlisted, unapproved, mismatching, malformed, for another program, or that
carries its own LM configuration is ignored: the zero-shot program is used and the reason is logged.
The optimiser never writes the lock; approval is a separate human step (README, "Approving an artifact").
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger("agentmw.artifacts")

def canonical(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def content_hash(content: Any) -> str:
    return hashlib.sha256(canonical(content)).hexdigest()


@dataclass(frozen=True)
class LockEntry:
    id: str
    version: str
    sha256: str
    approved_by: str | None
    file: str | None = None

    @property
    def approved(self) -> bool:
        a = (self.approved_by or "").strip()
        return bool(a) and not a.lower().startswith(("pending", "tbd", "none", "null"))


def read_lock(path: Path) -> dict[str, LockEntry]:
    """Artifact entries of the prompts lock; {} when the lock is absent or unreadable (fail closed)."""
    try:
        raw = json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        log.warning("prompts lock %s is unreadable (%s); no compiled artifact will load", path, e)
        return {}
    out: dict[str, LockEntry] = {}
    arts = raw.get("artifacts") if isinstance(raw, dict) else None
    if isinstance(arts, dict):
        for aid, e in arts.items():
            if isinstance(e, dict) and isinstance(e.get("sha256"), str):
                out[aid] = LockEntry(aid, str(e.get("version", "")), e["sha256"].lower(),
                                     e.get("approvedBy") if isinstance(e.get("approvedBy"), str) else None,
                                     e.get("file") if isinstance(e.get("file"), str) else None)
    entries = raw.get("entries") if isinstance(raw, dict) else None
    if isinstance(entries, list):
        for e in entries:
            if not isinstance(e, dict) or e.get("kind") != "dspy_artifact" or not isinstance(e.get("id"), str):
                continue
            if not isinstance(e.get("sha256"), str):
                continue
            approver = e.get("approvedBy", e.get("approver"))
            if e.get("approvedAt") in (None, "", "pending"):
                approver = None
            out[e["id"]] = LockEntry(e["id"], str(e.get("version", "")), e["sha256"].lower(),
                                     approver if isinstance(approver, str) else None,
                                     e.get("file") if isinstance(e.get("file"), str) else None)
    return out


@dataclass(frozen=True)
class Loaded:
    id: str | None
    sha256: str | None
    content: dict[str, Any] | None
    reason: str


def _has_lm_state(content: Any) -> bool:
    if isinstance(content, dict):
        if content.get("lm") not in (None, {}) and "signature" in content:
            return True
        return any(_has_lm_state(v) for v in content.values())
    return False


def _version_key(v: str) -> tuple:
    return tuple(int(p) if p.isdigit() else p for p in re.split(r"[.\-+]", v))


def resolve(program: str, artifacts_dir: Path, lock_path: Path) -> Loaded:
    """The approved artifact for `program`, or a zero-shot Loaded explaining why none was used."""
    lock = read_lock(lock_path)
    candidates: list[tuple[LockEntry, dict[str, Any]]] = []
    reasons: list[str] = []
    files = sorted(artifacts_dir.glob("*.json")) if artifacts_dir.is_dir() else []
    for f in files:
        try:
            art = json.loads(f.read_text("utf-8"))
        except (OSError, ValueError) as e:
            reasons.append(f"{f.name}: unreadable ({e})")
            continue
        if not isinstance(art, dict) or art.get("program") != program:
            continue
        aid, content = art.get("id"), art.get("content")
        if not isinstance(aid, str) or not isinstance(content, dict):
            reasons.append(f"{f.name}: missing id or content")
            continue
        actual = content_hash(content)
        entry = lock.get(aid)
        if entry is None:
            reasons.append(f"{aid}: not listed in the prompts lock")
        elif not entry.approved:
            reasons.append(f"{aid}: listed but not approved")
        elif entry.sha256 != actual:
            reasons.append(f"{aid}: sha256 {actual[:12]} does not match the lock ({entry.sha256[:12]})")
        elif str(art.get("sha256", "")).lower() != actual:
            reasons.append(f"{aid}: declared sha256 does not match its content")
        elif _has_lm_state(content):
            reasons.append(f"{aid}: carries LM configuration; artifacts may not choose a model")
        else:
            candidates.append((entry, content))
    for r in reasons:
        log.warning("artifact ignored for %s: %s", program, r)
    if not candidates:
        why = "; ".join(reasons) or "no compiled artifact present"
        log.info("%s runs zero-shot: %s", program, why)
        return Loaded(None, None, None, why)
    entry, content = max(candidates, key=lambda c: (_version_key(c[0].version), c[0].id))
    log.info("%s loads artifact %s (%s, approved by %s)", program, entry.id, entry.sha256[:12], entry.approved_by)
    return Loaded(entry.id, entry.sha256, content, "approved")
