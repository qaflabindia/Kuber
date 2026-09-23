---
policy_id: POL-303
title: Capital expenditure request
event: EVT-CAPEX-REQUEST
class: negotiable-nonbudget
subtype: capex
autonomy: L1
approver: Per DoA
escalate_to: Owner
priority_rank: null
amount_limit_inr: null
sla: Decision within 10 business days
control_refs: [IFC-FA-01]
framework_refs: [Ind AS 16 / IAS 16, AS 10, Companies Act Schedule II]
owner: CFO
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-303 — Capital expenditure request

## Intent

Approve capital spend on evidence of return, and account for it correctly from request to depreciation.

## Trigger

A request to buy or build an asset expected to be used for more than one year above the capitalisation threshold.

## Checks

- Business case: NPV at the entity's hurdle rate, IRR, payback.
- Budgeted or non-budget (non-budget goes one DoA band up).
- Funding: cash, loan or lease; effect on simulated balance and covenants.

## Decision

- Present the appraisal; the approver decides (L1).
- On approval: open a CWIP account; capitalise when ready for use; start depreciation in statutory and tax books.

## On failure or shortfall

- Negative NPV: approve only with a stated strategic reason recorded.

## Evidence to keep

- Appraisal
- Approval
- Capitalisation entry

## Exceptions

- Items below the capitalisation threshold are expensed.

## Notes for the agent

- Useful life: statutory book per Schedule II; tax book per block rates. Keep both.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
