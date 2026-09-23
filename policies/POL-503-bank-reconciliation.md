---
policy_id: POL-503
title: Bank reconciliation
event: EVT-BANK-STATEMENT-RECEIVED
class: control
subtype: bookkeeping
autonomy: L3
approver: Controller
escalate_to: CFO
priority_rank: null
amount_limit_inr: null
sla: Reconciled within 2 business days of statement
control_refs: [IFC-GL-02]
framework_refs: [COSO 2013 monitoring]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-503 — Bank reconciliation

## Intent

Books and bank must agree before any period is locked.

## Trigger

A statement or AA feed arrives for a bank account.

## Checks

- Match: exact reference, then amount and date window, then group matches, then suggested fuzzy matches.
- List reconciling items: cheques not presented, deposits not credited, bank charges, interest.

## Decision

- Auto-confirm exact matches (L4).
- Draft entries for bank charges and interest (L3).
- Suggested matches go to the preparer (L1).

## On failure or shortfall

- Unexplained difference remains: block the period lock; escalate after 5 days.

## Evidence to keep

- Reconciliation statement
- Matched pairs
- Reconciling items

## Exceptions

- None.

## Notes for the agent

- Provisional entries without a bank match after 10 days are flagged as possible duplicates or errors.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
