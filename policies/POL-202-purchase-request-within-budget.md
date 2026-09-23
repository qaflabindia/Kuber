---
policy_id: POL-202
title: Purchase request within budget
event: EVT-PURCHASE-REQUEST
class: negotiable-budget
subtype: commitment
autonomy: L2
approver: Budget owner
escalate_to: Controller
priority_rank: null
amount_limit_inr: null
sla: Decision within 2 business days
control_refs: [IFC-P2P-03]
framework_refs: [COSO 2013 control activities]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-202 — Purchase request within budget

## Intent

Allow spend against an approved budget quickly, while keeping commitments visible before money moves.

## Trigger

A user or the agent requests a purchase and names (or the agent infers) a budget line.

## Checks

- Available = budget - actual - open commitments, for the line and period.
- Requester is within the budget line's scope (cost centre, project).
- Aggregate spend to the vendor in 30 days checked against DoA bands.

## Decision

- Within available and within the requester's own limit: approve automatically and record a commitment (L3).
- Otherwise: route to the budget owner per DoA (L2).

## On failure or shortfall

- Available insufficient: offer POL-301 path with the shortfall amount.

## Evidence to keep

- Request
- Budget snapshot
- Commitment record

## Exceptions

- Capex always follows POL-303 even when budgeted.

## Notes for the agent

- A commitment reduces available budget immediately; release it if the PO is cancelled.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
