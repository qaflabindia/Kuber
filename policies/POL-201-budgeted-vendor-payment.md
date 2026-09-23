---
policy_id: POL-201
title: Budgeted vendor payment
event: EVT-VENDOR-BILL-DUE
class: negotiable-budget
subtype: timing
autonomy: L3
approver: Controller
escalate_to: CFO
priority_rank: 6
amount_limit_inr: 200000
sla: "Pay on the due date, not before, unless discounted"
control_refs: [IFC-P2P-01, IFC-P2P-02]
framework_refs: [COSO 2013 control activities]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-201 — Budgeted vendor payment

## Intent

Pay budgeted vendor bills on their due date, using the timing flexibility to protect cash without harming the relationship.

## Trigger

Three days before a vendor bill's due date, where the bill is linked to a budget line.

## Checks

- Three-way match: purchase order, receipt of goods or services, invoice.
- Budget line remaining covers the bill (actual + commitments).
- Vendor bank details verified (POL-501).
- Funds available on the due date.

## Decision

- All checks pass and amount within limit: schedule on due date at L3; ratify in weekly review.
- Early-payment discount offered: pay early if the annualised discount exceeds the cost of funds.
- Above the amount limit: L2 via DoA (POL-002).

## On failure or shortfall

- Budget exhausted: re-route to POL-301 (non-budget).
- Match fails: hold, notify the preparer.
- Funds short: EVT-CASH-SHORTFALL, rank 6.

## Evidence to keep

- PO, GRN, invoice
- Payment record
- Ratification record

## Exceptions

- MSME suppliers are governed by POL-108 as well; the stricter clock wins.

## Notes for the agent

- Annualised discount rate = (d / (1 - d)) x (365 / days paid early).

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
