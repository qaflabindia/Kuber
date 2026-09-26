"""Per-tenant rate limits and cost accounting, in memory (one instance; counters reset on restart).

Exposed at /metrics in Prometheus text format. Tenant ids are opaque ids chosen by the core; no
request content, principal or secret is ever a label.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field


@dataclass
class TenantUsage:
    requests: dict[str, int] = field(default_factory=lambda: defaultdict(int))     # "<program>:<outcome>"
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    day: str = ""
    day_tokens: int = 0


class Limiter:
    def __init__(self, per_minute: int, tokens_per_day: int, price_in_per_m: float, price_out_per_m: float,
                 clock=time.time):
        self.per_minute, self.tokens_per_day = per_minute, tokens_per_day
        self.price_in, self.price_out = price_in_per_m, price_out_per_m
        self._clock = clock
        self._windows: dict[str, deque[float]] = defaultdict(deque)
        self._usage: dict[str, TenantUsage] = defaultdict(TenantUsage)
        self._lock = threading.Lock()
        self.rejections: dict[str, int] = defaultdict(int)

    def _today(self) -> str:
        return time.strftime("%Y-%m-%d", time.gmtime(self._clock()))

    def admit(self, tenant: str) -> str | None:
        """None when the request may proceed, else the reason code (rate_limited / budget_exhausted)."""
        now = self._clock()
        with self._lock:
            w = self._windows[tenant]
            while w and w[0] <= now - 60:
                w.popleft()
            u = self._usage[tenant]
            if u.day != self._today():
                u.day, u.day_tokens = self._today(), 0
            if u.day_tokens >= self.tokens_per_day:
                self.rejections["budget_exhausted"] += 1
                return "budget_exhausted"
            if len(w) >= self.per_minute:
                self.rejections["rate_limited"] += 1
                return "rate_limited"
            w.append(now)
            return None

    def record(self, tenant: str, program: str, outcome: str, tokens_in: int, tokens_out: int) -> float:
        cost = tokens_in * self.price_in / 1e6 + tokens_out * self.price_out / 1e6
        with self._lock:
            u = self._usage[tenant]
            if u.day != self._today():
                u.day, u.day_tokens = self._today(), 0
            u.requests[f"{program}:{outcome}"] += 1
            u.tokens_in += tokens_in
            u.tokens_out += tokens_out
            u.day_tokens += tokens_in + tokens_out
            u.cost_usd += cost
        return cost

    def snapshot(self) -> dict[str, TenantUsage]:
        with self._lock:
            return dict(self._usage)

    def prometheus(self, gate_ok: bool) -> str:
        def esc(s: str) -> str:
            return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
        lines = [
            "# HELP agentmw_processing_approved 1 when the model-processing gate is open",
            "# TYPE agentmw_processing_approved gauge",
            f"agentmw_processing_approved {1 if gate_ok else 0}",
            "# TYPE agentmw_requests_total counter",
            "# TYPE agentmw_tokens_in_total counter",
            "# TYPE agentmw_tokens_out_total counter",
            "# TYPE agentmw_cost_usd_total counter",
            "# TYPE agentmw_rejections_total counter",
        ]
        for tenant, u in sorted(self.snapshot().items()):
            t = esc(tenant)
            for key, n in sorted(u.requests.items()):
                program, outcome = key.split(":", 1)
                lines.append(f'agentmw_requests_total{{tenant="{t}",program="{program}",outcome="{outcome}"}} {n}')
            lines.append(f'agentmw_tokens_in_total{{tenant="{t}"}} {u.tokens_in}')
            lines.append(f'agentmw_tokens_out_total{{tenant="{t}"}} {u.tokens_out}')
            lines.append(f'agentmw_cost_usd_total{{tenant="{t}"}} {u.cost_usd:.6f}')
        for reason, n in sorted(self.rejections.items()):
            lines.append(f'agentmw_rejections_total{{reason="{reason}"}} {n}')
        return "\n".join(lines) + "\n"
