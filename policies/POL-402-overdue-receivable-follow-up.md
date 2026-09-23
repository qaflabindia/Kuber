---
policy_id: POL-402
title: Overdue receivable follow-up
event: EVT-RECEIVABLE-OVERDUE
class: negotiable-budget
subtype: collections
autonomy: L3
approver: Account owner
escalate_to: CFO
priority_rank: null
amount_limit_inr: null
sla: First reminder on day 1 overdue
control_refs: [IFC-O2C-02]
framework_refs: [Ind AS 109 (expected credit loss)]
owner: CFO
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-402 — Overdue receivable follow-up

## Intent

Collect overdue invoices in a consistent sequence and reflect credit risk in the books.

## Trigger

An invoice passes its due date unpaid.

## Checks

- Customer's payment history and risk score.
- Open disputes or credit notes pending.

## Decision

- Day 1: polite reminder with statement of account (L3).
- Day 15: second reminder; notify account owner.
- Day 30: call task for account owner; hold new credit sales above limit.
- Day 60: escalate to CFO; consider invoice discounting or legal notice (L1).

## On failure or shortfall

- Dispute raised: pause reminders, open a dispute task.

## Evidence to keep

- Reminders sent
- Customer responses
- ECL bucket movement

## Exceptions

- Government and PSU customers: reminders only, no credit hold.

## Notes for the agent

- Update the expected-receipt date in the simulation after every customer response.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
