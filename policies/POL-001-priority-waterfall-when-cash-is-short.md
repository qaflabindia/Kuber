---
policy_id: POL-001
title: Priority waterfall when cash is short
event: EVT-CASH-SHORTFALL
class: control
subtype: treasury
autonomy: L1
approver: CFO
escalate_to: Owner
priority_rank: null
amount_limit_inr: null
sla: Same business day
control_refs: [IFC-TRY-01]
framework_refs: [MSMED Act 2006 s.15, Income Tax Act s.43B(h)]
owner: CFO
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-001 — Priority waterfall when cash is short

## Intent

When projected cash cannot cover every obligation in the horizon, pay in an order that minimises legal, financial and relationship damage.

## Trigger

Simulated balance of any account falls below its floor within the planning horizon (default 30 days).

## Checks

- List obligations in the horizon with their classification, due date and consequence of delay.
- List available fallback funding: undrawn credit lines, liquid investments, inter-entity transfers.
- Confirm each non-negotiable amount has been validated by its own policy.

## Decision

- Rank obligations in this default order (entity may change it):
    - 1. Statutory dues (GST, TDS, PF/ESI, advance tax)
    - 2. Salaries
    - 3. Secured debt service (EMIs, term loans)
    - 4. MSME suppliers at or near day 45
    - 5. Rent and critical operational vendors
    - 6. Other vendors by due date, then by relationship value
    - 7. Discretionary spend (deferred first)
- Propose a funding plan: fallback sources first, then deferral of the lowest ranks.
- Present the plan for CFO approval; nothing moves automatically.

## On failure or shortfall

- If the gap remains after all fallback sources, escalate to the Owner with the deferral list and its penalty cost.

## Evidence to keep

- Simulation snapshot
- Ranked obligation list
- Approved funding plan

## Exceptions

- A court order or tax demand with a deadline moves to rank 1 regardless of type.

## Notes for the agent

- Recompute the waterfall whenever an actual payment or receipt changes the projection.
- Show the cost of each deferral (interest, penalty, lost deduction) next to it.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
