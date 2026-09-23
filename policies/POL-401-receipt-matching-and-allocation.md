---
policy_id: POL-401
title: Receipt matching and allocation
event: EVT-RECEIPT
class: control
subtype: receivables
autonomy: L3
approver: Controller
escalate_to: CFO
priority_rank: null
amount_limit_inr: null
sla: Allocate within 1 business day
control_refs: [IFC-O2C-01]
framework_refs: [Ind AS 109 (derecognition of receivables)]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-401 — Receipt matching and allocation

## Intent

Every receipt is matched to what it pays, so receivables and customer statements stay correct.

## Trigger

A credit appears on any bank, UPI, wallet or cash account.

## Checks

- Match by reference (invoice number, UTR), then by customer and amount, then by open-item combination.
- Check for expected entries (salary, refunds, interest) before treating it as a customer receipt.

## Decision

- Exact match: allocate and post (L4).
- Probable match (confidence at or above 0.9): allocate and ratify weekly (L3).
- Otherwise: park in 'unallocated receipts' and ask (L1).

## On failure or shortfall

- Unallocated for 7 days: escalate to Controller.

## Evidence to keep

- Bank line
- Allocation record

## Exceptions

- TDS short-receipts: allocate the net and book TDS receivable for the difference.

## Notes for the agent

- For individuals the same logic matches salary, refunds and transfers from family.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
