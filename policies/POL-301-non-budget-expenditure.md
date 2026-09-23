---
policy_id: POL-301
title: Non-budget expenditure
event: EVT-PURCHASE-REQUEST-NONBUDGET
class: negotiable-nonbudget
subtype: discretionary
autonomy: L2
approver: "Per DoA, one band up"
escalate_to: Owner
priority_rank: 7
amount_limit_inr: null
sla: Decision within 3 business days
control_refs: [IFC-P2P-05]
framework_refs: [COSO 2013 control activities]
owner: CFO
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-301 — Non-budget expenditure

## Intent

Spend outside the budget needs a funding source and a higher approval than budgeted spend.

## Trigger

A purchase request with no budget line, or exceeding the remaining budget.

## Checks

- Business reason stated by the requester.
- Funding source identified: reallocation from another line, contingency reserve, or supplementary budget.
- Cash impact on the simulated balance for the next 90 days.
- Aggregated amount to the vendor over 30 days (anti-splitting).

## Decision

- Route one DoA band higher than the same amount would need if budgeted.
- On approval: post the budget transfer or supplementary budget first, then the commitment.

## On failure or shortfall

- No funding source: reject with reason; suggest deferral to the next budget cycle.
- Urgent and unavoidable: use POL-302.

## Evidence to keep

- Request and reason
- Funding decision
- Approval chain

## Exceptions

- Individuals: a non-budget spend above a user-set amount only needs a confirmation (L1).

## Notes for the agent

- Report non-budget spend monthly as a share of total spend; a rising share means the budget is unrealistic.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
