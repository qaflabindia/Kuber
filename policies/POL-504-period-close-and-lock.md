---
policy_id: POL-504
title: Period close and lock
event: EVT-PERIOD-END
class: control
subtype: close
autonomy: L1
approver: Controller
escalate_to: CFO
priority_rank: null
amount_limit_inr: null
sla: "Soft close by day 5, hard close by day 10"
control_refs: [IFC-GL-03, SOX-302/404 (if US-listed)]
framework_refs: [Companies Act s.128 (books of account), Ind AS / IFRS as per book]
owner: Controller
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-504 — Period close and lock

## Intent

Close each period on a fixed checklist so reports are final and cannot change silently.

## Trigger

Last day of each month, quarter and year for each book.

## Checks

- All bank accounts reconciled (POL-503).
- Control accounts equal sub-ledgers.
- Suspense and unallocated accounts cleared or explained.
- Accruals, prepayments, depreciation and allocations run.
- Expected entries for the period resolved.

## Decision

- When all checks pass, propose soft lock; Controller confirms (L1).
- Hard lock after review; only a reversal in the next open period can change results.

## On failure or shortfall

- Checklist incomplete at day 5: report blockers to CFO.

## Evidence to keep

- Checklist with timestamps
- Lock record

## Exceptions

- Audit adjustments after hard lock: separate adjustment period, approved by CFO.

## Notes for the agent

- Individuals: monthly soft close only, run automatically when the statement arrives.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
