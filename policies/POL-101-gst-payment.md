---
policy_id: POL-101
title: GST payment
event: EVT-GST-DUE
class: non-negotiable
subtype: statutory
autonomy: L2
approver: Controller
escalate_to: CFO
priority_rank: 1
amount_limit_inr: null
sla: Pay by due date minus 2 days
control_refs: [IFC-TAX-01]
framework_refs: [CGST Act 2017 s.39 (returns), CGST Act 2017 s.50 (interest)]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-101 — GST payment

## Intent

Pay the correct net GST on time for every GSTIN. The payment is not negotiable; the amount must be right.

## Trigger

Seven days before the GSTR-3B due date for the period (20th of the next month for monthly filers; QRMP filers differ).

## Checks

- Output tax in the ledger matches GSTR-1 as filed.
- Input tax credit claimed does not exceed GSTR-2B, net of blocked and reversed credits.
- Electronic cash and credit ledger balances are known.
- Funds available in the paying account on the payment date (simulated balance).

## Decision

- Prepare the challan and the payment entry.
- Route to the approver at L2; on approval, schedule payment for due date minus 2 days.

## On failure or shortfall

- Amount mismatch above 1% or 10,000 INR: hold, explain the difference, ask the Controller.
- Funds short: raise EVT-CASH-SHORTFALL; GST keeps rank 1 in the waterfall.

## Evidence to keep

- GSTR-1, GSTR-2B and draft GSTR-3B
- Challan (CPIN/CIN)
- Approval record

## Exceptions

- Nil liability: file the return, no payment event.

## Notes for the agent

- Per GSTIN. Each registration is a separate obligation.
- Due dates are rule data; read them from the dated tax-rule table, never from this text.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
