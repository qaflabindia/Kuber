---
policy_id: POL-107
title: Rent and lease payments
event: EVT-RENT-DUE
class: non-negotiable
subtype: contractual
autonomy: L3
approver: Controller
escalate_to: CFO
priority_rank: 5
amount_limit_inr: null
sla: Pay by the agreement's due date
control_refs: [IFC-EXP-03]
framework_refs: [Ind AS 116 / IFRS 16 (leases), Income Tax Act s.194-I (TDS on rent)]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-107 — Rent and lease payments

## Intent

Pay rent on time, deduct TDS where applicable, and keep lease accounting correct.

## Trigger

Three days before the due date in the agreement.

## Checks

- Amount equals agreement (escalation clauses applied).
- TDS applicable? Deduct and net off.
- Landlord bank details verified.
- Funds available.

## Decision

- Schedule the payment at L3 (act, then ratify within 7 days).
- Statutory book: reduce lease liability and book interest per Ind AS 116 for company tenants; individuals book rent expense.

## On failure or shortfall

- Amount differs from agreement: drop to L1 and ask.
- Funds short: EVT-CASH-SHORTFALL, rank 5.

## Evidence to keep

- Agreement
- Payment record
- TDS challan if any

## Exceptions

- Short-term and low-value leases may be expensed where the standard allows.

## Notes for the agent

- Timing may be negotiable with the landlord; amount is not. Record any agreed deferral.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
