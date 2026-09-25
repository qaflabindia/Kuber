"""Model-processing gate (TAGOF Domain 12, CBJ-01/02; agent design 3 and 7.1).

No book data reaches a model until the operator records a processing decision:

    KUBER_LLM_PROCESSING_APPROVED=<approver>:<YYYY-MM-DD>:<data-location>
      e.g. system_owner:asha:2026-09-25:us   (the approver may itself contain one ':'; the last two
                                               fields are the date and the data location)

The rules are the same as the core's (apps/core/src/copilot/governance/processing.ts on
ws5/agent-gov). The core sends its own record in `x-kuber-processing-approval` and the middleware
requires it to equal its own, so neither tier alone can switch model processing on.
"""
from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass

PROCESSING_ENV = "KUBER_LLM_PROCESSING_APPROVED"
PROCESSING_HEADER = "x-kuber-processing-approval"

_APPROVER = re.compile(r"^[a-z][\w.@-]*(:[\w.@-]+)?$", re.I | re.A)
_LOCATION = re.compile(r"^[a-z]{2}(-[a-z0-9]+){0,3}$", re.I | re.A)
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$", re.A)


@dataclass(frozen=True)
class GateStatus:
    ok: bool
    configured: bool
    reason: str | None = None
    approver: str | None = None
    date: str | None = None
    location: str | None = None

    @property
    def record(self) -> str | None:
        return f"{self.approver}:{self.date}:{self.location}" if self.ok else None

    def public(self) -> dict:
        """What /healthz may show: the decision's date and data location, never secrets."""
        return {"approved": self.ok, "configured": self.configured, "date": self.date,
                "location": self.location, "reason": None if self.ok else self.reason}


def parse_processing_approval(value: str | None, today: str | None = None) -> GateStatus:
    today = today or _dt.datetime.now(_dt.timezone.utc).date().isoformat()
    v = (value or "").strip()
    if not v:
        return GateStatus(False, False, f"{PROCESSING_ENV} is not set: no processing decision has been recorded")
    parts = v.split(":")
    if len(parts) < 3:
        return GateStatus(False, True, f"{PROCESSING_ENV} must be <approver>:<YYYY-MM-DD>:<data-location>")
    location, date, approver = parts[-1], parts[-2], ":".join(parts[:-2])
    if not _APPROVER.match(approver):
        return GateStatus(False, True, f"{PROCESSING_ENV}: approver is not a principal or name")
    try:
        real = bool(_DATE.match(date)) and _dt.date.fromisoformat(date).isoformat() == date
    except ValueError:
        real = False
    if not real:
        return GateStatus(False, True, f"{PROCESSING_ENV}: \"{date}\" is not a real YYYY-MM-DD date")
    if date > today:
        return GateStatus(False, True, f"{PROCESSING_ENV}: the decision date {date} is in the future")
    if not _LOCATION.match(location):
        return GateStatus(False, True, f"{PROCESSING_ENV}: data location must be a country code, optionally with a region")
    return GateStatus(True, True, None, approver, date, location.lower())


def check_request(status: GateStatus, presented: str | None) -> str | None:
    """None when this request may reach a model; otherwise the reason it may not."""
    if not status.ok:
        return status.reason
    if not presented:
        return f"the core did not present its processing record ({PROCESSING_HEADER})"
    p = parse_processing_approval(presented)
    if not p.ok or p.record != status.record:
        return "the core's processing record does not match the middleware's"
    return None
