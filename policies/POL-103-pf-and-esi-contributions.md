---
policy_id: POL-103
title: PF and ESI contributions
event: EVT-PAYROLL-STATUTORY-DUE
class: non-negotiable
subtype: statutory
autonomy: L2
approver: Controller
escalate_to: CFO
priority_rank: 1
amount_limit_inr: null
sla: Pay by due date minus 2 days
control_refs: [IFC-PAY-02]
framework_refs: [EPF Scheme 1952 para 38, ESI (Central) Regulations]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-103 — PF and ESI contributions

## Intent

Remit provident fund and ESI contributions on time for every wage month.

## Trigger

Five days before the 15th of the month following the wage month.

## Checks

- Contribution totals equal payroll register for the month.
- Headcount matches the payroll master; new joiners and leavers reflected.
- Funds available.

## Decision

- Prepare ECR and ESI challan entries; route at L2; schedule payment.

## On failure or shortfall

- Mismatch: hold with the variance by employee.
- Funds short: EVT-CASH-SHORTFALL, rank 1.

## Evidence to keep

- Payroll register
- ECR / challan
- Approval record

## Exceptions

- Establishments not covered under the Acts: policy inactive for that entity.

## Notes for the agent

- Rates and wage ceilings are rule data.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
