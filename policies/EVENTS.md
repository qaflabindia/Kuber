# Kuber event catalogue

Every event type Kuber recognises, with its fund-management class and the policy that governs it.

| Code | Event | Category | Class | Policy |
| --- | --- | --- | --- | --- |
| EVT-ANY | Any event without a specific policy | system | control | POL-000 |
| EVT-CASH-SHORTFALL | Projected cash shortfall | treasury | control | POL-001 |
| EVT-APPROVAL-ROUTING | Approval routing required | system | control | POL-002 |
| EVT-GST-DUE | GST liability due | statutory | non-negotiable | POL-101 |
| EVT-TDS-DUE | TDS deposit due | statutory | non-negotiable | POL-102 |
| EVT-PAYROLL-STATUTORY-DUE | PF / ESI contribution due | statutory | non-negotiable | POL-103 |
| EVT-ADVANCE-TAX-DUE | Advance tax instalment due | statutory | non-negotiable | POL-104 |
| EVT-SALARY-DUE | Salary disbursement due | contractual | non-negotiable | POL-105 |
| EVT-EMI-DUE | Loan EMI due | contractual | non-negotiable | POL-106 |
| EVT-RENT-DUE | Rent or lease payment due | contractual | non-negotiable | POL-107 |
| EVT-MSME-PAYABLE-AGEING | MSME supplier bill ageing | statutory | time-escalating | POL-108 |
| EVT-ITC-SUPPLIER-UNPAID | Supplier unpaid near ITC 180-day limit | statutory | time-escalating | POL-109 |
| EVT-VENDOR-BILL-DUE | Vendor bill due (budgeted) | payables | negotiable-budget | POL-201 |
| EVT-PURCHASE-REQUEST | Purchase request within budget | procurement | negotiable-budget | POL-202 |
| EVT-PURCHASE-REQUEST-NONBUDGET | Purchase request outside budget | procurement | negotiable-nonbudget | POL-301 |
| EVT-EMERGENCY-PAYMENT | Emergency payment | treasury | negotiable-nonbudget | POL-302 |
| EVT-CAPEX-REQUEST | Capital expenditure request | capex | negotiable-nonbudget | POL-303 |
| EVT-RECEIPT | Money received | receivables | control | POL-401 |
| EVT-RECEIVABLE-OVERDUE | Customer invoice overdue | receivables | negotiable-budget | POL-402 |
| EVT-CASH-SURPLUS | Idle cash above requirement | treasury | negotiable-budget | POL-403 |
| EVT-VENDOR-BANK-CHANGE | Vendor bank details changed | master-data | control | POL-501 |
| EVT-TXN-INGESTED | Transaction ingested | bookkeeping | control | POL-502 |
| EVT-BANK-STATEMENT-RECEIVED | Bank statement received | bookkeeping | control | POL-503 |
| EVT-PERIOD-END | Accounting period end | close | control | POL-504 |
| EVT-INTERBRANCH-TRANSFER | Inter-branch transfer | branch | control | POL-505 |
| EVT-THRESHOLD-SPLIT-SUSPECTED | Possible split below approval limit | controls | control | POL-506 |
| EVT-POLICY-CHANGE | Policy created or amended | governance | control | POL-900 |
