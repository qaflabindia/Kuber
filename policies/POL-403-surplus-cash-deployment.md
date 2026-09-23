---
policy_id: POL-403
title: Surplus cash deployment
event: EVT-CASH-SURPLUS
class: negotiable-budget
subtype: treasury
autonomy: L1
approver: CFO
escalate_to: Owner
priority_rank: null
amount_limit_inr: null
sla: Review weekly
control_refs: [IFC-TRY-04]
framework_refs: [Board-approved treasury policy, SEBI IA Regulations 2013 (advice boundary)]
owner: CFO
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-403 — Surplus cash deployment

## Intent

Keep idle cash working within limits the entity has set, without Kuber giving personalised investment advice.

## Trigger

Projected balance stays above the operating requirement plus buffer for the full horizon.

## Checks

- Surplus = lowest projected balance in horizon - operating floor - buffer.
- Instruments allowed by the entity's treasury policy (for example FDs, liquid funds).
- Liquidity: surplus must be available before the next large known outflow.

## Decision

- Inform the CFO of the surplus amount and the window (L0/L1).
- Show options from the entity's own allowed list with tenor and liquidity; the choice is the user's.

## On failure or shortfall

- No treasury policy recorded: only inform.

## Evidence to keep

- Simulation snapshot
- Decision recorded

## Exceptions

- Individuals: show surplus against their goals; no product recommendation.

## Notes for the agent

- Do not recommend specific securities or funds unless Kuber holds the required registration.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
