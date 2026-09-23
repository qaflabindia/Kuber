---
policy_id: POL-506
title: Split transactions below approval limits
event: EVT-THRESHOLD-SPLIT-SUSPECTED
class: control
subtype: shield
autonomy: L1
approver: Controller
escalate_to: CFO
priority_rank: null
amount_limit_inr: null
sla: Review before the next payment to the counterparty
control_refs: [IFC-P2P-07]
framework_refs: [COSO 2013 control activities]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-506 — Split transactions below approval limits

## Intent

Approval limits apply to totals, not only to single transactions.

## Trigger

Sum of spends to one counterparty (or one requester) in 30 days exceeds a DoA band while each item stays below it.

## Checks

- List the items, requesters and approvers.
- Check whether a single PO or contract covers them.

## Decision

- Hold further payments to the counterparty pending review (L1).
- Re-route the aggregate to the approver the total would have required.

## On failure or shortfall

- Confirmed deliberate split: record a control exception and notify the Owner.

## Evidence to keep

- Aggregation report
- Review decision

## Exceptions

- Recurring contracted payments (rent, utilities) are excluded.

## Notes for the agent

- Window and bands come from POL-002.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
