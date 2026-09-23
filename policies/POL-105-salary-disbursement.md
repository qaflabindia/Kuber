---
policy_id: POL-105
title: Salary disbursement
event: EVT-SALARY-DUE
class: non-negotiable
subtype: contractual
autonomy: L2
approver: CFO
escalate_to: Owner
priority_rank: 2
amount_limit_inr: null
sla: Credit on or before the pay date
control_refs: [IFC-PAY-01]
framework_refs: [Applicable wage-payment law]
owner: CFO
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-105 — Salary disbursement

## Intent

Pay employees the correct net salary on the agreed date.

## Trigger

Three business days before the pay date.

## Checks

- Payroll register approved by HR for the period.
- Variance against last month above 5% explained (joiners, leavers, increments, arrears).
- Bank details unchanged, or changes verified under POL-501.
- Funds available.

## Decision

- Prepare the bulk payment file; route at L2; release on approval.

## On failure or shortfall

- Unexplained variance: hold only the affected employees, pay the rest.
- Funds short: EVT-CASH-SHORTFALL, rank 2.

## Evidence to keep

- Approved payroll register
- Bank upload file
- Approval record

## Exceptions

- Full-and-final settlements follow the exit checklist.

## Notes for the agent

- Never display individual salaries to principals outside the payroll scope.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
