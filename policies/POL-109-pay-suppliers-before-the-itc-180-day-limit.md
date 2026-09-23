---
policy_id: POL-109
title: Pay suppliers before the ITC 180-day limit
event: EVT-ITC-SUPPLIER-UNPAID
class: time-escalating
subtype: statutory
autonomy: L1
approver: Controller
escalate_to: CFO
priority_rank: 4
amount_limit_inr: null
sla: Pay before day 180 from invoice date
control_refs: [IFC-TAX-04]
framework_refs: [CGST Act 2017 s.16(2) second proviso, CGST Rules 2017 r.37]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-109 — Pay suppliers before the ITC 180-day limit

## Intent

Input tax credit taken on an invoice must be reversed, with interest, if the supplier is not paid within 180 days. Paying on time protects the credit.

## Trigger

Day 150 from invoice date for any unpaid invoice on which ITC was claimed.

## Checks

- ITC was claimed on the invoice.
- Invoice is not disputed or cancelled.

## Decision

- Day 150: alert and move to the non-negotiable list in the cash plan.
- Present pay-now versus reverse-credit cost to the Controller (L1).

## On failure or shortfall

- Unpaid at day 180: draft the reversal entry and the return adjustment.

## Evidence to keep

- Invoice
- ITC claim period
- Payment or reversal record

## Exceptions

- Reverse-charge supplies and certain deemed supplies are outside this rule.

## Notes for the agent

- Re-credit is available on later payment; track it as an expected entry.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
