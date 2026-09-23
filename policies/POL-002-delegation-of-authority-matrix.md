---
policy_id: POL-002
title: Delegation of authority matrix
event: EVT-APPROVAL-ROUTING
class: control
subtype: approval
autonomy: L0
approver: Owner
escalate_to: Owner
priority_rank: null
amount_limit_inr: null
sla: n/a
control_refs: [IFC-GEN-02, SOX-404-ELC (if US-listed)]
framework_refs: [COSO 2013 control activities]
owner: Owner
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-002 — Delegation of authority matrix

## Intent

One table decides who may approve what, so every other policy can say 'route per DoA' instead of naming people.

## Trigger

Any policy requests an approver chain.

## Checks

- Aggregate the amount per counterparty over the last 30 days, not only the single transaction.
- Identify category (opex, capex, non-budget, treasury) and entity.

## Decision

- Route using these example bands (each entity sets its own):
    - Up to 25,000: Preparer's manager
    - 25,001 to 2,00,000: Controller
    - 2,00,001 to 10,00,000: CFO
    - Above 10,00,000 or any non-budget capex: Owner / Board
- Maker and checker must be different principals; the agent counts as a maker.

## On failure or shortfall

- If the approver is unavailable past the SLA of the calling policy, route to the next band up.

## Evidence to keep

- Resolved approver chain
- Aggregation window used

## Exceptions

- A single-person entity approves its own items; the record is marked self-approved.

## Notes for the agent

- Amounts are in INR. The bands above are illustrative defaults, not recommendations.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
