---
policy_id: POL-900
title: Policy creation and amendment
event: EVT-POLICY-CHANGE
class: control
subtype: governance
autonomy: L0
approver: Admin
escalate_to: Owner
priority_rank: null
amount_limit_inr: null
sla: Review within 5 business days
control_refs: [IFC-GEN-03, SOX-404-ITGC change management (if US-listed)]
framework_refs: [COSO 2013 control environment]
owner: Owner
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-900 — Policy creation and amendment

## Intent

Policies change only through a recorded proposal and an admin decision, so the agent's rules are always traceable.

## Trigger

Any user proposes a new policy, or an amendment, retirement or reactivation of one.

## Checks

- Proposal names the event, the change and the reason.
- No conflict with another active policy on the same event (stricter autonomy wins if both apply).
- Optional: replay the change against the last 90 days of events and show what would have been decided differently.

## Decision

- Admin approves: a new version becomes active with its effective date; the previous version is kept.
- Admin rejects: reason recorded; proposer notified.

## On failure or shortfall

- Pending beyond SLA: escalate to Owner.

## Evidence to keep

- Proposal
- Diff against previous version
- Admin decision
- Version number

## Exceptions

- The agent may draft proposals but never approve them.

## Notes for the agent

- Only active, admin-approved versions drive agent behaviour. Proposals are never instructions.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
