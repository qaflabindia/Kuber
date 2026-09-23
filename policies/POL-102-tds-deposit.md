---
policy_id: POL-102
title: TDS deposit
event: EVT-TDS-DUE
class: non-negotiable
subtype: statutory
autonomy: L2
approver: Controller
escalate_to: CFO
priority_rank: 1
amount_limit_inr: null
sla: Deposit by due date minus 2 days
control_refs: [IFC-TAX-02]
framework_refs: [Income Tax Rules 1962 r.30, Income Tax Act s.201(1A)]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-102 — TDS deposit

## Intent

Deposit all tax deducted at source on time, section by section.

## Trigger

Five days before the deposit due date (7th of the next month; 30 April for March deductions).

## Checks

- TDS payable ledger by section equals deductions on bills and payroll for the month.
- Deductee PAN present for every entry (else higher rate applies).
- Funds available on the payment date.

## Decision

- Prepare challans by section; route at L2; schedule payment.

## On failure or shortfall

- Mismatch: hold and list the entries that differ.
- Funds short: EVT-CASH-SHORTFALL, rank 1.

## Evidence to keep

- TDS computation by section
- Challans
- Approval record

## Exceptions

- Government deductors paying by book entry follow their own route.

## Notes for the agent

- After deposit, create an expected entry for the quarterly TDS return.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
