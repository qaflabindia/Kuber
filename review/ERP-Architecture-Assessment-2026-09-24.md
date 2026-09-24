# Kuber enterprise ERP architecture assessment

Date: 24 September 2026  
Baseline: platform commit `aa95ccf` (clean before review artifacts)  
Perspective: enterprise solution architecture, financial controls, scalability and operations  
Decision: **Do not admit production financial data or declare enterprise readiness at this baseline. Continue development with the existing modular core, while closing the financial-control and identity gaps first.**

## 1. Executive assessment

Kuber has credible foundations for an accounting kernel: exact minor-unit arithmetic, balanced postings, immutable event history, reversal-based correction, stream concurrency, a transactional outbox, database row-level security, encrypted event payloads, and daily reporting aggregates. These are valuable assets worth preserving.

The main risks are in the boundaries between otherwise sensible components. A successful approval is confused with a successful posting. A plan's state check and its writes are separate transactions. Import concurrency is mistaken for deduplication. Bank matching uses insufficient business identity. Key maintenance accounts for database copies but misses retained message copies. These can produce incomplete or misleading books while every posted journal still balances.

The current implementation is a **Phase 0, predominantly INR accounting kernel with an agent interface**. The design document describes a much broader ERP. Procurement, AP/AR document lifecycles, inventory valuation, tax subledgers, fixed assets, consolidation, enterprise master data and scoped approval authority remain future capabilities. Their absence is a roadmap gap, not evidence that an already delivered module is defective.

Do not respond to these findings by splitting every module into a microservice. Most urgent issues require stronger transaction boundaries, state machines, authoritative identities and explicit control ownership. Distribution adds more failure boundaries unless those foundations are established first.

### Evidence and limits

- Existing suite: **113 tests passed; 3 skipped** using `bash scripts/test-docker.sh`. Skipped cases are one live NATS integration test and two live classifier tests.
- TypeScript production/core test typecheck: passed.
- Additional audit suite: **14 of 14 scenarios reproduced** using isolated temporary PostgreSQL databases. A passing audit reproduction demonstrates a defect exists; it is not a regression test proving the system is correct.
- Reproductions: [architecture-review.test.ts](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/review/architecture-review.test.ts); [audit configuration](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/review/vitest.config.ts).
- Existing tests originally targeted port 5433. An unrestricted retry confirmed connection refusal there. The repository's TLS test script successfully used the existing PostgreSQL container on 5432.
- No application fixes were applied. Review files and diagnostic tests were added; synthetic databases were dropped by test cleanup.
- This assessment does not claim a production load result, cloud infrastructure audit, penetration test, legal compliance certification, or independently witnessed disaster recovery exercise.
- The data-key test preserves a copy of an actual sealed outbox envelope and simulates post-grace retirement. It does not run a real NATS redelivery. Fault injection controls the precise interleaving in plan and import tests.

### Corrections to the preliminary review

The earlier CSRF concern is withdrawn: the installed SvelteKit runtime implements origin checking for form submissions, enabled by default, and application configuration does not disable it. A custom token's absence alone is not a defect.

The earlier blanket P0 characterization of writable projections was overstated. Projection workers need write privileges. The problem is unnecessary credential reach and insufficient separation of runtime, operator and module privileges.

Database readiness should not fail merely because the broker is down if direct ledger commands are intentionally supported through the outbox. Readiness needs to reflect the operation being served, with dependency degradation, backlog capacity and freshness exposed separately.

Production Kubernetes manifests are not a requirement for a local Phase 0 prototype. A proven deployment and recovery topology is a requirement before claiming enterprise service levels.

## 2. Business capability and control assessment

| Area | Implemented evidence | Enterprise gap / consequence |
| --- | --- | --- |
| Record to report | Exact balanced journals, reversals, hard/soft locks, trial balance, P&L, balance sheet | Reliable close orchestration, certified report snapshots, legal entity/book permissions and recoverable approvals |
| Bank ingestion and reconciliation | CSV extraction, content addressing, provisional matching, reconciliation plan | Stable bank transaction identity, correct matching, control totals, retained originals, unresolved-item workflow |
| Approval authority | Agent/human distinction and policy autonomy thresholds | User membership, task permissions, amount delegation, maker-checker, expiry, revocation and scoped authorization |
| Master data | Seed charts, added accounts, learned parties/rules | Effective-dated party/account/dimension governance, controlled merges, valid dimension values, source-specific identities |
| Multi-entity / multi-book | Tenant and book identifiers | Entity hierarchy, book basis/currency configuration, intercompany ownership and balancing, consolidation rules |
| Procure to pay / order to cash | Ledger control-account party presence | Business documents, AP/AR lifecycle, matching, settlement, credit/debit notes and subledger-to-GL reconciliation |
| Inventory / assets / tax / payroll | Design coverage and some GL account seeds | Valuation/depreciation/tax engines, controlled interfaces and domain-specific acceptance evidence |
| Audit and evidence | Encrypted evidence events and lookup | Original source retrieval, exact policy versions, authorization proof, evidence completeness monitoring and independently anchored integrity |
| Operations | Local TLS stack, encrypted dump/restore scripts | SLO telemetry, recovery drills, replay tooling, deployment controls, capacity limits and operational ownership |

Company tenant creation is already accepted by the API. Restrict released capabilities by supported business process and control readiness; a company-shaped chart does not establish company ERP completeness. Taxonomy and accounting treatments require accounting-owner sign-off before statutory reporting is represented as supported.

## 3. Findings requiring remediation

Priority definitions: P0 blocks any shared or externally accessible financial deployment; P1 blocks real-data pilot for affected functionality or the explicitly named scale/integration gate; P2 is a bounded improvement before larger workloads. “Reproduced” means execution evidence; “code-confirmed” means a concrete implementation path; “unproven” means assurance evidence is absent.

### F01 — P0: identity is self-asserted at both entry points

**Evidence:** Reproduced A01; code-confirmed development sign-in. [Sign-in](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/web/src/routes/signin/+page.server.ts:12) converts supplied names to owner principals and accepts a user-selected workspace. [HTTP identity resolution](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/core/src/server.ts:36) accepts matching tenant headers and a syntactically valid principal. The HTTPS configuration does not request or validate a BFF client certificate.

**Failure:** An unsigned HTTP request claiming `auditor:outsider` posted a journal successfully. A reachable web sign-in can issue an owner session for a supplied workspace. Local loopback binding limits network exposure in Compose, but does not create authenticated identity.

**Required design:** An identity provider or passkey authentication, server-resolved tenant membership and user identity, revocable sessions, and verified service identity. Use a short-lived signed identity context with audience and issuer validation between BFF and core, or an equivalent authenticated boundary. A client certificate establishes a service, not the human's permissions. Production startup must reject development sign-in and missing/invalid session secrets; require secure cookies behind correctly configured HTTPS.

**Exit evidence:** Wrong identity, tenant, issuer, audience, expired/revoked credentials and header spoofing all fail without a financial side effect. Owner creation requires authenticated onboarding.

### F02 — P1: authorization, separation of duties and book scope are incomplete

**Evidence:** Reproduced A10 and A12. [Commit authority](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/ops/src/index.ts:120) distinguishes agents from all other principals; it does not enforce the policy's named approver or an authorization matrix. [MCP commit tool](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/core/src/tools.ts:64) passes tenant and plan ID but omits the token's permitted book.

**Failure:** An auditor created and approved their own write plan. An agent tool scoped to book `main` committed a policy-eligible plan for `restricted` when provided that plan's ID and hash. This requires knowledge of those values; no unauthorized discovery was demonstrated. Evidence records describe whether preparer and approver differ but do not enforce separation.

**Required design:** A command authorization service enforcing tenant, legal entity, book, action, amount, delegation and maker-checker requirements. The GL and draft services must receive a validated authorization decision. Direct journals, rules, chat capture and close endpoints need equivalent checks. Enforce MCP grant scope at commit as well as plan creation. Single-owner exceptions should be explicit policy, not a universal bypass. OWASP recommends deny-by-default permissions validated on every request: [authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

**Exit evidence:** Table-driven role/resource tests; auditor read-only; preparer unable to approve where separation is required; cross-book tokens denied even with valid plan IDs/hashes.

### F03 — P1: plan approval and execution lack a single consistency boundary

**Evidence:** Reproduced A04 and A05. [Commit path](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/ops/src/index.ts:120) reads proposed status, compares journal sequence, appends approval, executes actions separately, and finally updates status. The per-book lock is acquired later inside each GL action.

**Failure:** A second writer posted after plan validation; the original plan still committed against a different balance basis. A two-journal rebalance failed after journal one; retry was rejected as stale because the first journal changed the sequence. The “resume safely” comment does not match observed behavior.

**Additional exposure:** Sequence counts journals, not account or lock changes. Non-ledger close prerequisites such as pending drafts can also change without updating that sequence. Concurrent discard and commit have no common plan lock.

**Required design:** Atomically claim the plan. For same-book GL actions, check the full aggregate version and execute the approved batch under one transaction and book lock; commit status and audit events with it. For cross-module work, use a durable workflow with per-step command IDs and states such as approved, executing, waiting, completed and failed. Revalidate authority and relevant policy at execution. Distinguish external book changes from the workflow's own completed steps. Close must also fence or drain in-flight period work.

**Exit evidence:** Concurrent commit/discard/close/post tests; fault after every step; retry completes once or returns a durable failure without stranding partial work; no unapproved change to the approved effects.

### F04 — P1: command retry semantics can duplicate financial entries

**Evidence:** Reproduced A02 and A11. [Journal and opening-balance endpoints](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/core/src/server.ts:81) create new journal UUIDs per request. An `Idempotency-Key` header is ignored. A completed plan retry returns “not open” rather than its original result.

**Failure:** Two identical HTTP requests with the same idempotency key created two journals. A client losing the first response cannot safely infer the outcome.

**Required design:** Persist a tenant/action-scoped command ID, canonical request hash, status and result in the transaction with the financial effect. Same key plus same request returns the original outcome; changed payload returns conflict. Apply to journals, openings, imports, approvals, corrections and future external execution. Separate business identity from incidental request UUIDs.

**Exit evidence:** Timeout-after-commit and repeated submission tests produce exactly one effect, with stable outcome lookup.

### F05 — P1: overlapping imports can acknowledge success while omitting new transactions

**Evidence:** Reproduced A06. [Import conflict handling](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/channels/src/index.ts:51) returns whole-file duplicate on any stream concurrency error.

**Failure:** Simultaneous imports containing [shared, unique A] and [shared, unique B] produced only two extracted transactions out of three. The losing import was reported as duplicate even though its unique row was not stored.

**Required design:** Re-read and retry the conflicted import; distinguish duplicate signal from overlap at transaction level. Preserve statement identity and a disposition for every source row. Prefer source system + bank account + stable transaction ID/version. Occurrence counts reset per file and content similarity alone cannot reliably distinguish repeated identical payments across files.

**Exit evidence:** Concurrent identical, overlapping and disjoint statements; repeated legitimate identical payments; accepted + duplicate + quarantined rows reconcile to source control totals with no silent omissions.

### F06 — P1: bank confirmation can hide a different transaction and does not propagate correctly

**Evidence:** Reproduced A07 and A08. [Provisional matching](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/agent/src/index.ts:108) matches instrument, signed amount and a date window, without requiring counterparty or reference agreement. Confirmation updates the agent's index only.

**Failure:** A payment to Bob confirmed a provisional payment to Alice with the same amount/date, leaving no draft for Bob. Even a valid match left the journal provisional in GL state and reporting. [Reconciliation](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/ops/src/operations.ts:190) consequently continues to treat it as a timing item.

**Required design:** Explicit reconciliation records linking immutable source transactions and journals; stable references and account identity, ambiguity detection, human resolution where required, partial/many-to-many matching, reversals and differences. Propagate confirmation as a business event to all relevant views; do not rewrite the original journal.

**Exit evidence:** Same amount/day different parties never auto-match; valid confirmed entries cease to be outstanding in reconciliation, reporting and close checks.

### F07 — P1: approval state reports “posted” before the GL accepts the journal

**Evidence:** Reproduced A03. [Draft approval](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/agent/src/index.ts:176) changes status to posted when it emits PostingRequested. [Agent subscriptions](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/core/src/cell.ts:111) omit PostingRejected; [Agent handler](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/agent/src/index.ts:42) has no rejection transition.

**Failure:** Approve a draft after its period has hard-closed: GL emits PostingRejected; no journal exists; the draft disappears from review and remains marked posted. Bulk plans can similarly report committed when they have only requested postings.

**Required design:** queued → approved → posting_pending → posted only on JournalPosted, or posting_failed on rejection. Link request, journal and rejection IDs; expose unresolved exceptions with an owner and retry/correction route. Prevent learning from a failed posting from silently elevating future automation.

**Exit evidence:** Reject for locks, accounts, dimensions or other invariants; every request reaches a visible terminal or retryable state; reports and UI never label unposted work as posted.

### F08 — P1: invalid dates can change accounting periods between ledger and reports

**Evidence:** Reproduced A09. [Date validation](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/gl/src/book.ts:159) uses Date.parse and the contracts use a date-shaped regex.

**Failure:** A journal with `2026-02-31` was committed. The PostgreSQL reporting path stored `2026-03-03`. The ledger's date and report's date disagree, potentially changing period attribution and lock interpretation.

**Required design:** Strict calendar validation before persistence, consistent date-only serialization, one authoritative accounting date, explicit timezone rules for timestamps, and range/precision limits for amounts before they reach NUMERIC projections.

**Exit evidence:** Impossible dates rejected across HTTP, import, operation and event paths; leap days, fiscal boundaries and timezones produce identical ledger/report dates.

### F09 — P1 at scale gate: all tenants share serialized module consumers

**Evidence:** Code-confirmed. [NATS consumer settings](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/packages/bus/src/nats.ts:54) use one durable per module with MaxAckPending=1. [Cell subscriptions](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/core/src/cell.ts:108) filter every tenant in that cell. Classification calls the LLM inside the database transaction/handler.

**Impact:** Adding core replicas does not create independent progress for those tenants. A slow classifier or problematic event delays unrelated tenants. A 15-second attempt plus retry/backoff can approach or exceed the 30-second acknowledgement deadline.

**Required design:** Stable partitions by tenant/book consistency boundary, versioned routing, bounded workers, per-tenant fairness and admission control. Scale on queue age and processing lag. Preserve per-aggregate ordering; increasing in-flight messages alone is not a safe fix. Move slow model work outside database transactions, into bounded jobs; persist input/version and validate results when applied. [NATS consumer documentation](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/jetstream/consumers.md) describes shared acknowledgement limits and redelivery behavior.

**Exit evidence:** Multi-replica tests demonstrate throughput growth across books while a slow tenant/model does not stall others; redelivery produces no duplicate effect.

### F10 — P1 at scale gate: aggregate memory and replay cost grow with complete history

**Evidence:** Code-confirmed. [Book evolution](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/gl/src/book.ts:60) copies the entire journals Map for each journal. [GL cache](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/gl/src/index.ts:17) stores complete book histories and limits book count rather than bytes; durable snapshots are not used.

**Impact:** Warm writes include O(N) map copying for a book with N journals. Replaying N journals performs O(N²) cumulative map-copy work. More replicas multiply memory and cold-replay cost. Delta reads alone do not make total write cost O(new events). Read-only state loading also does not advance the cache, so some replicas repeatedly fold the same delta.

**Required design:** Separate compact command state (versions, locks, balances and required references) from full historical journals. Use on-demand journal retrieval, durable versioned snapshots, bounded-memory replay and byte-based cache limits. Retain a serialized writer per book initially; benchmark before redesigning journal sequencing for a very large enterprise book.

**Exit evidence:** Cold start, replay and posting latency tested at agreed mature book sizes, including 100k/1m journals where applicable; memory bounded and verified after replica churn. A synthetic fold benchmark harness is included, but it could not be executed in this managed environment because the `tsx` IPC socket was denied; no benchmark number is being presented as evidence.

### F11 — P2: interactive queries do work proportional to history or outstanding work

**Evidence:** [Layout data loading](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/web/src/routes/+layout.server.ts:15) fetches all drafts/ratifications and performs full GL verification on shell loads. [Recent journals and drill-through](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/reporting/src/index.ts:218) aggregate all journal lines before LIMIT and expose unbounded drill results. [Evidence lookup](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/evidence/src/index.ts:207) requests a stream suffix to retrieve one evidence record.

**Impact:** Growing history slows routine navigation and increases decryption/memory work. N+1 evidence lookups can amplify it. Daily aggregates help balance reports but do not solve these paths.

**Required design:** Count queries for badges, keyset pagination, bounded drill/export paths, indexed journal-header/latest-ID selection before fetching lines, point event reads, and asynchronous incremental integrity verification with timestamp/coverage. Cache only with tenant/book/version keys and freshness contracts. Inspect EXPLAIN (ANALYZE, BUFFERS) on realistic distributions before final index choices.

**Exit evidence:** Query plans and p95/p99 remain within target at mature history; maximum page sizes enforced; background verification retains equivalent integrity coverage.

### F12 — P1: delivery exhaustion and projection rebuild are not operationally complete

**Evidence:** [Consumer retry loop](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/packages/bus/src/nats.ts:62) stops delivery after ten attempts, logs and naks failures, with no durable exception workflow. Retention defaults to seven days. [Outbox relay](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/packages/eventstore/src/relay.ts:22) publishes sequentially inside a DB transaction. No production replay/rebuild command was found.

**Impact:** Events survive in PostgreSQL, but a consumer that misses transport retention or exhausts retries can remain incomplete without automatic repair. A maximum-sequence checkpoint does not prove that all prior events were processed. Broker I/O holds DB locks. The relay leader lock is held on a different reserved connection from batch work, so loss of leadership needs explicit fencing/stop behavior.

**Ordering caution:** Global BIGSERIAL positions are allocation order, not commit order. A future catch-up cursor that advances past a high committed position can miss a lower position committed later. PostgreSQL documents nontransactional sequence behavior in [transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html). This is a code/design risk for readAll-based catch-up, not a reproduced current projection loss.

**Required design:** Durable quarantine with event ID, tenant, attempts, reason and repair action; MaxDeliver advisory monitoring; replay from PostgreSQL through versioned projection generations with side effects disabled; contiguous per-stream checkpoints and gap checks. Consider bounded relay batches/leases or CDC with ordering and failover proof. Separate published-outbox retention from inbox deduplication retention.

**Exit evidence:** Kill after publish/before mark, exhaust retries, restore after retention expiry, rebuild from zero and compare exact balances/evidence; no gaps or duplicate external effects.

### F13 — P1: key lifecycle is not coordinated with all retained data

**Evidence:** Reproduced A13 and A14. [Retired-key usage check](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/core/src/keys-admin.ts:154) counts SQL ciphertext copies but not published broker copies. [Erasure list](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/core/src/keys-admin.ts:33) omits evidence tables.

**Failure:** After re-encryption and retirement, the saved previously published envelope failed decryption because version 1 no longer existed. Tenant shredding left readable account balances in evidence.balances.

**Further code-confirmed risk:** LocalFileKms loads master keys once. Rewrapping with a newly added master key can break existing processes once their tenant-key cache expires unless key reload/restart is coordinated. A backup that contains wrapped tenant keys can restore erased data if the corresponding master key remains available; deletion from the current database does not erase past backups.

**Required design:** Key retention tied to consumer/replay horizons and backup recovery requirements; managed KMS lifecycle; coordinated reload; tenant-wide write fencing and cache invalidation for erasure; schema-complete retention inventory including derived data. Reconcile legal hold, erasure and restoration behavior with the data owner before enabling erasure operationally.

**Exit evidence:** Rotate with offline consumers; replay old messages; restore backups across rotations; verify all plaintext projections are gone for an erased synthetic tenant and tombstones remain effective after restore.

### F14 — P1 before shared production: privilege boundaries are weaker than module boundaries

**Evidence:** [Cell startup](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/core/src/cell.ts:84) loads migration and system connections in the same runtime, warning rather than refusing when the app role bypasses RLS. [Grants](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/packages/eventstore/src/migrations.ts:165) grant broad projection writes and INSERT on schema_migrations. Compose provides owner credentials to the core.

**Impact:** A process compromise reaches operator authority and cross-tenant data. RLS based on a caller-selected tenant setting is defense against accidental cross-tenant queries, not protection against a compromised application choosing another tenant. Static module ownership checks are not a database security boundary.

**Required design:** Dedicated deployment/migration identity with no owner credentials in request-serving processes; startup fails closed on bypass roles; least-privilege system reader/relay roles; module-specific grants when worker separation is introduced; remove migration-table writes from runtime roles. Share only necessary trust roots and service credentials.

**Exit evidence:** Role capability tests run in CI and deployed-environment validation; runtime credentials cannot migrate, suppress migrations, alter event history or administer keys.

### F15 — P1 for certified reporting: freshness and snapshot consistency are not guaranteed

**Evidence:** Reports use async projections; the shell converts failed draft/ratification calls to empty arrays. P&L reads closing movements and aggregate balances in separate transactions: [P&L](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/reporting/src/index.ts:132). Checkpoints retain the maximum observed journal sequence.

**Impact:** A balanced report can still be incomplete. During projection progress, report components can reflect different points in time. A service error can appear as “nothing waiting.” Period-close checks read projections without proving they caught up or accounting for pending posting requests.

**Required design:** Query contract includes book version, contiguous projection watermark, as-of timestamp and freshness status. Certified reports use a consistent snapshot and persisted close version; multi-query calculations run in one suitable snapshot. Keep “unavailable,” “pending” and zero distinct. Close waits for reconciliation checkpoints and unresolved financial effects.

**Exit evidence:** Concurrent close/post/project tests yield reproducible statements; stale views disclose their basis; unavailable controls never become empty queues.

### F16 — P1 before policy-controlled autonomy: policy provenance and lifecycle are incomplete

**Evidence:** [Policy model and decisions](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/policy/src/index.ts:22) loads versioned files but Decision records only IDs. Policies load at process start; decisions lack tenant scope and immutable policy-content hashes. Commit relies on stored needsPerson instead of reevaluating current authority.

**Impact:** After a policy change, evidence cannot independently identify the exact approved policy content from its ID alone. A rolling deployment can evaluate different policy versions across replicas. Approval or autonomy revocation after planning is not reliably enforced at execution.

**Required design:** Tenant/entity-scoped, immutable policy versions with approval history, effective dates and hashes; record ruleset/model/prompt identifiers in evidence. Distinguish historical accounting-rule reproduction from current execution authority. Validate policy input types and limits; expire or revalidate outstanding plans when authority changes.

**Exit evidence:** A decision reproduces against its recorded ruleset; revoked authority blocks old plans; policy rollout is consistent and attributable.

### F17 — P1 when enabling external integrations: connector credentials are not tenant-bound

**Evidence:** [External tool registry](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/apps/core/src/copilot/external.ts:18) is global for the process; tools() accepts no tenant context. All callers get configured tools backed by the same headers. With no explicit allow list, remote readOnlyHint controls inclusion.

**Impact:** A private bank/mail/GST connector configured for one organization could be exposed to other tenants using that cell's copilot. This is conditional on enabling such a connector; no real connector data was accessed. Read-only hints are descriptive, not authorization enforcement. Raw copilot history and tool results also flow to the model provider, unlike the classifier's limited masking.

**Required design:** Tenant-bound connector registrations, credentials and entitlements; explicit operation allow lists, server identity and outbound policy; execution authority independent of remote annotations; tenant-specific model egress policy and data minimization.

**Exit evidence:** Two tenants with different connectors cannot enumerate/call each other's tools; sensitive results cannot leave through disallowed model or tool destinations.

### F18 — P1 for evidence-led ingestion: source originals and validation controls are insufficient

**Evidence:** [Signal persistence](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/modules/channels/src/index.ts:36) stores content hash and extracted transactions, not original source bytes or an object reference. CSV parsing selects debit when both debit and credit are present and does not prove opening + movements = closing.

**Impact:** A content hash cannot reconstruct an original statement or prove extraction completeness. Uploaded CSVs are designated authoritative without demonstrating bank origin; this should be represented as user-supplied source evidence. Invalid/ambiguous rows can produce misleading interpretation.

**Required design:** Immutable encrypted original-object retention with digest, source identity, uploader, parser/mapping version, row lineage, account identity, control totals and explicit reject/quarantine outcomes. Distinguish externally authenticated bank feeds from user uploads. Retention and deletion must cover originals and derivatives.

**Exit evidence:** Every posting and excluded row traces to retrievable source bytes and interpretation version; control-total mismatches block import certification.

### F19 — P1 before enterprise service commitments: recovery and observability are unproven

**Evidence:** [Backup validation](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/scripts/backup.sh:11) lists archive contents; this does not prove full restore or business reconciliation. [Restore procedure](/Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform/scripts/restore.sh:8) does not establish a new broker epoch or reconcile retained transport state with the restored database. Logging is disabled in Fastify; operational errors use console output; no metrics/tracing deployment was found.

**Impact:** Restoring an older database while retaining a newer broker can reintroduce projections from events absent in the restored event store, or leave acknowledged work undelivered. A dump listing cannot establish RPO/RTO. Local single-instance Compose cannot demonstrate regional availability.

**Required design:** Agreed failure model, HA PostgreSQL, WAL/PITR and off-host backup retention, independently recoverable keys/configuration, broker reset/rebuild protocol, and regular full restoration drills with business totals. Separate liveness, service readiness and processing health. Record command latency, book lock wait, DB pool wait, outbox age, per-consumer lag/retries, evidence gaps, unresolved postings, backup age and certificate/key failures. Publish runbooks with named owners and escalation.

**Exit evidence:** Timed restore into an isolated environment, complete reconciliation, exact replay, and failure drills for process/node/AZ/region. Define regional data-loss allowance explicitly: asynchronous inter-region replication cannot alone guarantee zero loss of every acknowledged write.

## 4. Recommended architecture decisions

| Decision | Recommendation | Reason / tradeoff |
| --- | --- | --- |
| Domain deployment | Keep a modular monolith for the kernel; independently deploy workers when scaling requires it | Fewer distributed consistency boundaries while preserving domain ownership |
| Financial transaction boundary | Atomic same-book command batch with full version validation; durable workflow across domains | Controls partial effects and approvals without holding SQL transactions across external calls |
| Data authority | GL owns posted journals; modules own source business documents; reconciliation records link their effects | Makes ownership and exception recovery explicit |
| Tenant isolation | Authenticated tenant membership + RLS; cells bound failure/capacity; dedicated cells for large tenants when justified | RLS is defense in depth, not authentication |
| Worker scaling | Partition by tenant/book, process bounded work, enforce fairness; use versioned routing and fencing | More workers can make independent progress while book ordering stays correct |
| Read scaling | PostgreSQL daily/materialized models first; read replicas only with freshness routing; add analytical stores when measured need exists | Avoids premature operational complexity and stale financial answers |
| AI | Separate queued inference and model egress policy; deterministic validation and explicit execution authority | Slow or hostile model/tool behavior cannot become ledger authority |
| Database roles | Migration/operator credentials outside runtime; restrictive request and worker identities | Limits compromise and accidental cross-domain updates |
| Recovery | PostgreSQL authoritative, projections rebuilt into new generations, broker state coordinated to recovered epoch | Prevents replay from mixing histories |
| Production platform | A managed deployment meeting measured availability/recovery needs; EKS only with operating capability and justified workload | Kubernetes alone does not provide ERP integrity or capacity |

The proposed cells direction is sound, but cell IDs in subjects are only one part. A cell needs bounded capacity, tenant placement, routing, isolation and controlled migration. AWS describes independently operating cells with routing as the containment model: [cell architecture](https://docs.aws.amazon.com/wellarchitected/latest/reducing-scope-of-impact-with-cell-based-architecture/what-is-a-cell-based-architecture.html). Kuber still needs a placement/control plane and a tested freeze-copy-verify-cutover procedure for tenant movement.

Do not add sticky sessions merely to hide cold replay cost. Fix aggregate state first; if temporary book affinity is used, make it an optimization with correct failover.

## 5. Capacity assessment

The design assumes 167 requests/s average, 1,000/s peak, 150 commands/s, roughly 1,200 events/s, p95 commands under 300 ms, p95 reads under 200 ms and p99 projection lag under 2 s. These are **targets, not measured capacity**. The assertion that this lightly loads the ledger is not established by the current implementation.

Useful bounds to validate:

- Single consumer capacity is approximately 1 / mean handler time. At an illustrative 20 ms per event, one serialized consumer handles about 50 events/s before headroom. This example is not a measured Kuber throughput.
- One book's write capacity is limited by its lock-held service time; replicas increase different-book concurrency, not the hot-book ceiling.
- Default production pools permit up to 20 application + 3 system connections per core replica, plus migration/administration connections. Replica count must respect database limits and leave failover/maintenance headroom.
- The documented import storm of 1,000 × 500 lines / 300 seconds is about 1,667 source transactions/s. At the document's approximate eight events per line, it implies about 13,333 events/s, materially above the separate 1,200-events/s peak estimate. Clarify acceptable backlog and drain time.
- Bound records/bytes per book, event size, journal line count, import rows, active tenants and model concurrency. Average HTTP request rate alone does not size an ERP.

Run representative tests with mature history and skewed tenants: ordinary day, one hot enterprise book, simultaneous close, import storm, cold replicas, slow SQL, model outage, delayed broker and projection replay. Record p50/p95/p99, errors, queue age, CPU, heap/GC, SQL plans, pool wait, storage/WAL and exact business reconciliation. No production-capacity claim should be made until these pass.

## 6. Delivery roadmap and accountable owners

These are ordered work packages, not calendar promises; staffing and workload assumptions are still unknown.

| Gate | Work package | Accountable owner | Required exit evidence |
| --- | --- | --- | --- |
| G0: safe shared access | F01–F02, F14; supported-capability restrictions | Security lead + platform lead; finance controls owner signs roles | Authenticated tenancy, deny-by-default permissions, SoD/book-scope tests, restricted runtime credentials |
| G1: correct financial lifecycle | F03–F08, F15, F18 | Ledger lead + accounting/process owner | No duplicate/lost effects, recoverable workflows, correct matching, strict dates, certified source/report lineage |
| G2: recoverable operations | F12–F13, F16, F19; F17 before connector enablement | Platform/SRE + security + integrations owners | Replay/restore/rotation drills, policy traceability, visible exceptions, alerts and runbooks |
| G3: bounded horizontal scale | F09–F11, measured workload targets | Platform architect + performance lead | Multi-replica throughput/latency, tenant fairness, bounded memory, mature-book and cold-start tests |
| G4: enterprise ERP processes | AP/AR, procurement, assets, inventory, tax, consolidation by approved roadmap | Domain product owners + finance controller | End-to-end golden books, subledger reconciliations, controlled migration and operational acceptance per process |

Release controls should name a decision owner, supporting test IDs, evidence artifact, compensating control (if any), expiry and retest date. A green unit suite is not an authorization to waive a failed financial control.

Before enterprise sizing and migration planning, resolve: tenant/entity/book counts; largest book and retention horizon; peak posting/import mix; approval matrix; deployment/residency requirements; dependency SLAs; RPO/RTO by failure scenario; migration volumes and control totals; and accounting-framework/currency requirements. Those answers affect topology and scope, but do not change the reproduced defects.

## 7. Acceptance and traceability

| Audit test | Finding | Reproduced behavior |
| --- | --- | --- |
| A01 | F01/F02 | Unsigned auditor header posts through core HTTP |
| A02 | F04 | Same request/idempotency header yields two journals |
| A03 | F07 | Rejected GL posting leaves draft marked posted |
| A04 | F03 | Interleaving writer bypasses approved balance basis |
| A05 | F03 | Partial multi-journal plan cannot resume |
| A06 | F05 | Overlapping imports omit a unique row |
| A07 | F06 | Different payee same amount/date auto-confirms |
| A08 | F06 | Confirmed journal remains provisional in GL/report |
| A09 | F08 | Invalid ledger date normalizes to another reporting month |
| A10 | F02 | Auditor prepares and approves write plan |
| A11 | F04 | Completed-plan retry does not return original result |
| A12 | F02 | Book-limited MCP tool commits another book's plan |
| A13 | F13 | Retired key cannot decrypt retained envelope |
| A14 | F13 | Erasure leaves evidence account balances readable |

Reproduce with:

```sh
cd /Users/lakshminarasimhan.santhanamgigkri.com/workspace/Kuber/platform
bash scripts/test-docker.sh
bash scripts/test-docker.sh --config review/vitest.config.ts
pnpm typecheck
# Optional in a normal development shell; blocked in this managed review runtime by tsx IPC socket permissions.
pnpm exec tsx review/replay-benchmark.ts
```

The review harness intentionally asserts current defective behavior. During remediation, replace these expectations with required outcomes and move appropriate cases into the normal regression suite. It is excluded from the default suite so “all tests passed” cannot be confused with financial correctness.

Documentation governance also needs attention: the implementation design still marks evidence persistence and role separation as not built, although current code and existing tests implement them. Elsewhere it promises features such as router/snapshots/complete replay that are not implemented here. Maintain a requirement-to-code-to-test register with explicit designed, implemented, verified and operationally proven states.
