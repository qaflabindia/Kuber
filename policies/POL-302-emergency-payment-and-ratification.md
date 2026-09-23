---
policy_id: POL-302
title: Emergency payment and ratification
event: EVT-EMERGENCY-PAYMENT
class: negotiable-nonbudget
subtype: emergency
autonomy: L3
approver: Any authorised signatory
escalate_to: CFO
priority_rank: null
amount_limit_inr: 500000
sla: Ratify within 3 business days
control_refs: [IFC-TRY-03]
framework_refs: [COSO 2013 control activities]
owner: CFO
status: active
version: 1
effective_from: 2026-10-01
review_by: 2027-03-31
---

# POL-302 — Emergency payment and ratification

## Intent

Allow a necessary payment to go ahead before normal approval, and make sure it is reviewed afterwards.

## Trigger

A user marks a payment as emergency and states the reason.

## Checks

- Reason falls in an allowed category: outage, safety, legal deadline, regulatory penalty.
- Amount within the emergency limit.
- Payee is not new, or has been verified by phone.

## Decision

- Allow the signatory to release the payment (L3).
- Open a ratification task for the normal approver with a 3-day window.

## On failure or shortfall

- Not ratified in time: escalate to CFO and flag the signatory's next emergency request for pre-approval.
- Ratification refused: record as a control exception; start recovery if applicable.

## Evidence to keep

- Reason
- Payment
- Ratification decision

## Exceptions

- Above the emergency limit: no emergency path; follow POL-301.

## Notes for the agent

- Count emergency payments per signatory per quarter; frequent use is itself a control finding.

## Change log

- v1 · 2026-09-23 · Initial version seeded from the Kuber implementation design.
