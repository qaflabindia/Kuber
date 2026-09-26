"""Configuration from the environment. Keys and secrets come from the environment only, never files in the image."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Hard bounds: the environment may lower these, never raise them past the ceiling.
MAX_TOKENS_CEILING = 4096
TIMEOUT_CEILING_S = 60.0


def _default_agent_dir() -> Path:
    # services/agent-mw/agentmw/config.py -> repository root /agent
    return Path(__file__).resolve().parents[3] / "agent"


def _int(env: dict[str, str], key: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(env.get(key, default))
    except ValueError:
        v = default
    return max(lo, min(hi, v))


def _float(env: dict[str, str], key: str, default: float, lo: float, hi: float) -> float:
    try:
        v = float(env.get(key, default))
    except ValueError:
        v = default
    return max(lo, min(hi, v))


@dataclass
class Settings:
    secret: str | None
    model: str | None
    processing_approved: str | None
    agent_dir: Path
    lock_path: Path
    artifacts_dir: Path
    max_tokens: int = 1024
    timeout_s: float = 20.0
    rate_per_minute: int = 60              # requests per tenant per minute
    tokens_per_day: int = 2_000_000        # token budget per tenant per UTC day
    # USD per million tokens, for cost accounting only (not billing): "in,out"
    price_in_per_m: float = 3.0
    price_out_per_m: float = 15.0
    issuers: list[str] = field(default_factory=lambda: ["kuber-core"])
    # agent/dependencies.md (ws5/agent-gov) row 4: "without an approved artifact the middleware must refuse
    # to run that program". Off by default (zero-shot, logged) until approved artifacts exist; set true to refuse.
    require_artifacts: bool = False

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        e = dict(os.environ if env is None else env)
        agent_dir = Path(e.get("AGENT_MW_AGENT_DIR") or _default_agent_dir())
        price = (e.get("AGENT_MW_PRICE_PER_M") or "3,15").split(",")
        try:
            pin, pout = float(price[0]), float(price[1])
        except (ValueError, IndexError):
            pin, pout = 3.0, 15.0
        return cls(
            secret=e.get("AGENT_MW_SECRET") or None,
            model=e.get("AGENT_MW_MODEL") or None,
            processing_approved=e.get("KUBER_LLM_PROCESSING_APPROVED") or None,
            agent_dir=agent_dir,
            lock_path=Path(e.get("AGENT_MW_PROMPTS_LOCK") or agent_dir / "prompts.lock.json"),
            artifacts_dir=Path(e.get("AGENT_MW_ARTIFACTS_DIR") or agent_dir / "artifacts"),
            max_tokens=_int(e, "AGENT_MW_MAX_TOKENS", 1024, 64, MAX_TOKENS_CEILING),
            timeout_s=_float(e, "AGENT_MW_TIMEOUT_S", 20.0, 1.0, TIMEOUT_CEILING_S),
            rate_per_minute=_int(e, "AGENT_MW_RATE_PER_MINUTE", 60, 1, 10_000),
            tokens_per_day=_int(e, "AGENT_MW_TOKENS_PER_DAY", 2_000_000, 1_000, 1_000_000_000),
            price_in_per_m=pin,
            price_out_per_m=pout,
            require_artifacts=e.get("AGENT_MW_REQUIRE_ARTIFACTS", "").lower() == "true",
        )
