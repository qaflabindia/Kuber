---
policy_id: POL-106
title: Loan EMI
event: EVT-EMI-DUE
class: non-negotiable
subtype: contractual
autonomy: L3
approver: Controller
escalate_to: CFO
priority_rank: 3
amount_limit_inr: null
sla: Funds in the debit account 1 day before EMI date
control_refs: [IFC-TRY-02]
framework_refs: [Loan agreement, Ind AS 109 (amortised cost)]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-106 — Loan EMI

## Intent

Keep every EMI and loan repayment current; a missed EMI damages the credit score and may trigger default clauses.

## Trigger

Five days before the EMI date in the loan schedule.

## Checks

- EMI amount matches the schedule (floating-rate resets applied).
- Debit account projected balance covers the EMI on the date.

## Decision

- If funds are available: no action needed (auto-debit); post the interest/principal split when the debit arrives (L3, ratify in weekly review).
- If the debit account is short: propose a transfer from another own account (L2).

## On failure or shortfall

- No internal source: EVT-CASH-SHORTFALL, rank 3.
- Bounce detected: alert Owner immediately.

## Evidence to keep

- Loan schedule
- Bank debit
- Split journal

## Exceptions

- Moratorium or restructuring agreed with the lender: schedule replaced, not skipped.

## Notes for the agent

- For individuals, the same policy applies to personal loans, home loans and card EMIs.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
