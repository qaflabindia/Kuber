---
policy_id: POL-502
title: Auto-posting ingested transactions
event: EVT-TXN-INGESTED
class: control
subtype: bookkeeping
autonomy: L3
approver: Preparer
escalate_to: Controller
priority_rank: null
amount_limit_inr: 25000
sla: Review queue cleared weekly
control_refs: [IFC-GL-01]
framework_refs: [Companies (Accounts) Rules r.3(1) audit trail]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-502 — Auto-posting ingested transactions

## Intent

Post routine transactions without asking, and ask about everything else.

## Trigger

A draft journal is produced from any channel.

## Checks

- Classification confidence.
- Source trust: authoritative (AA, statement) or provisional (SMS, notification, screenshot).
- Amount against the limit.
- Known counterparty.

## Decision

- Authoritative source, confidence at or above 0.97, known counterparty, within limit: post (L3, ratify weekly).
- Provisional source: post as provisional; confirm when the authoritative record arrives.
- Otherwise: queue for the preparer (L1).

## On failure or shortfall

- A ratified entry later corrected: lower this entity's autonomy for that account to L1 for 30 days.

## Evidence to keep

- Event
- Draft
- Confidence
- Model and prompt version

## Exceptions

- Entries to control accounts need a party; entries to locked periods are refused.

## Notes for the agent

- Relax to L4 per account type after 30 consecutive uncorrected postings at accuracy above 98%.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
