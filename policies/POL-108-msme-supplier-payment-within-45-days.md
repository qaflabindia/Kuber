---
policy_id: POL-108
title: MSME supplier payment within 45 days
event: EVT-MSME-PAYABLE-AGEING
class: time-escalating
subtype: statutory
autonomy: L2
approver: Controller
escalate_to: CFO
priority_rank: 4
amount_limit_inr: null
sla: Pay by day 45 from acceptance
control_refs: [IFC-P2P-04]
framework_refs: ["MSMED Act 2006 s.15, s.16", Income Tax Act s.43B(h), Companies Act Schedule III MSME disclosure]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-108 — MSME supplier payment within 45 days

## Intent

A bill from a registered micro or small supplier starts as negotiable and becomes non-negotiable at the statutory limit. Late payment costs compound interest and the tax deduction for the expense.

## Trigger

Day 30 (alert) and day 40 (action) from the date of acceptance, for suppliers flagged as micro or small with a valid Udyam number.

## Checks

- Supplier's MSME status and category verified from Udyam details on file.
- Agreed credit period (maximum 45 days; 15 days if no written agreement).
- Bill accepted, goods or services received, no open dispute.

## Decision

- Day 30: reclassify from negotiable to non-negotiable in the cash plan.
- Day 40: prepare payment and route at L2.

## On failure or shortfall

- Dispute open: record it; the clock rules still apply, so escalate to CFO.
- Unpaid at year end beyond the limit: flag the 43B(h) disallowance to the tax book.

## Evidence to keep

- Udyam registration
- Acceptance date
- Payment record

## Exceptions

- Medium enterprises are outside s.43B(h); treat as ordinary vendors (POL-201).

## Notes for the agent

- This is the clearest case of negotiability changing with time; recompute daily.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
