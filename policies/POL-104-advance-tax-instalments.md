---
policy_id: POL-104
title: Advance tax instalments
event: EVT-ADVANCE-TAX-DUE
class: non-negotiable
subtype: statutory
autonomy: L1
approver: CFO
escalate_to: Owner
priority_rank: 1
amount_limit_inr: null
sla: Pay by instalment date minus 3 days
control_refs: [IFC-TAX-03]
framework_refs: ["Income Tax Act s.208, s.211", "Income Tax Act s.234B, s.234C"]
owner: CFO
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-104 — Advance tax instalments

## Intent

Pay advance tax instalments on the estimated annual liability to avoid interest.

## Trigger

Ten days before 15 June, 15 September, 15 December and 15 March.

## Checks

- Re-estimate annual taxable income from the tax book and forecast.
- Cumulative instalment due = estimated tax x (15%, 45%, 75%, 100%), less TDS/TCS credits and paid instalments.
- Funds available.

## Decision

- Show the estimate and its drivers; the CFO (or individual) confirms the amount (L1).
- Schedule the challan after confirmation.

## On failure or shortfall

- Estimate uncertain (forecast confidence low): present a range and the interest cost of each end.

## Evidence to keep

- Tax estimate workings
- Challan
- Confirmation record

## Exceptions

- Resident senior citizens without business income are not required to pay advance tax.

## Notes for the agent

- Instalment percentages and exemptions are rule data; check the dated rule table.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
