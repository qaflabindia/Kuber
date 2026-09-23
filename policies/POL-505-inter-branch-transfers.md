---
policy_id: POL-505
title: Inter-branch transfers
event: EVT-INTERBRANCH-TRANSFER
class: control
subtype: branch
autonomy: L3
approver: Branch accountant
escalate_to: Controller
priority_rank: null
amount_limit_inr: null
sla: Mirror entry confirmed within 2 business days
control_refs: [IFC-BR-01]
framework_refs: [CGST Act 2017 s.25(4), CGST Act Schedule I para 2]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-505 — Inter-branch transfers

## Intent

Every transfer between HO and branches is recorded at both ends and reconciled.

## Trigger

Cash, goods or charges recorded as moving between two locations of the same entity.

## Checks

- Sender and receiver books both exist.
- Different state GSTINs: taxable supply; tax invoice required.
- Goods at invoice price above cost: unrealised profit to be reserved.

## Decision

- Post the sender entry; create the mirror entry as draft at the receiver (L3).
- Receiver confirms quantity and amount; differences go to 'in transit'.

## On failure or shortfall

- Unconfirmed after 2 days: escalate; 'in transit' items older than 15 days reported at close.

## Evidence to keep

- Transfer note or invoice
- Both entries
- Reconciliation

## Exceptions

- Centralised mode: branch is only a dimension; no mirror entry.

## Notes for the agent

- At period end, eliminate reciprocal balances and unrealised profit on combination.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
