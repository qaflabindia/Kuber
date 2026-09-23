---
policy_id: POL-000
title: Global default for unmatched events
event: EVT-ANY
class: control
subtype: fallback
autonomy: L1
approver: Controller
escalate_to: Owner
priority_rank: null
amount_limit_inr: null
sla: 24h to first human action
control_refs: [IFC-GEN-01]
framework_refs: [Companies Act 2013 s.134(5)(e) (IFC)]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-000 — Global default for unmatched events

## Intent

No event is ever handled without a rule. When no active policy matches an event, Kuber treats it as unknown and keeps a person in the loop.

## Trigger

Any event whose code has no active policy, or whose matching policy is retired, in draft, or past its review date.

## Checks

- Confirm no active policy matches the event code, category or class.
- Record the event code so policy coverage can be measured.

## Decision

- Prepare a draft (journal, payment or reply) but do not post or execute.
- Route to the approver for the entity; show the draft and why no policy matched.

## On failure or shortfall

- If nobody acts within the SLA, escalate to the Owner.
- After 3 occurrences of the same unmatched event code in 30 days, raise a 'policy needed' task in the registry.

## Evidence to keep

- Event payload and source
- Draft prepared
- Person who acted

## Exceptions

- None. This policy cannot be retired while any event type lacks a policy.

## Notes for the agent

- Never raise autonomy above L1 under this policy.
- Coverage metric = events handled by a specific policy / all events.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
