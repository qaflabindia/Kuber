# Kuber platform — phase 0 core

Event-driven, federated core for Kuber, the financial agent. TypeScript services on PostgreSQL
(event store) and NATS JetStream (messaging), per the implementation design (section 16).

## What runs

One **cell** (a complete stack for a set of tenants) with five federated modules. Modules talk only
through events; none reads another's tables.

| Module | Owns | Consumes | Emits |
| --- | --- | --- | --- |
| `gl` | Books (one event stream each), journals, periods, hash chain | `PostingRequested`, `CorrectionRequested` | `BookOpened`, `AccountAdded`, `JournalPosted`, `JournalReversed`, `PeriodLocked`, `PostingRejected` |
| `channels` | Signals and extracted transactions (content-addressed, so duplicates are impossible) | — | `SignalReceived`, `TransactionExtracted` |
| `agent` | Parties, rules, drafts, ratifications, autonomy overrides | `TransactionExtracted`, GL events | `PartyResolved`, `ProvisionalConfirmed`, `TransactionClassified`, `PolicyDecisionMade`, `PostingRequested`, `DraftQueued`, `DraftApproved`, `RatificationRequested`, `CorrectionRequested`, `RuleLearned`, `AutonomyLimited`, … |
| `policy` | The `.md` policy library (read-only, deterministic) | — | — |
| `reporting` | Journal lines, daily balances, chain checkpoints | GL events | — |
| `ops` | Plans (simulate, then commit exactly that) | — | `PlanApproved` (before a plan's actions run; the actions carry the plan id as `commandId`) |
| `evidence` | One evidence record per committed action, and a lookup by every id and hash it cites | `JournalPosted`, `PeriodLocked` (reads the plan, transaction, signal and correction streams they came from) | `EvidenceRecorded` |

Supporting packages: `contracts` (Zod schemas for every event, money as bigint paise),
`eventstore` (append with optimistic concurrency, transactional outbox, inbox, RLS, relay),
`bus` (NATS JetStream and an in-memory bus with the same contract).

```
Channels ──TransactionExtracted──▶ Agent ──PostingRequested──▶ GL ──JournalPosted──▶ Reporting
                                     ▲                          │                     (and Agent)
                          policy .md │                          └─PostingRejected (on invariant breach)
```

## Agentic operations: no menus, simulate then approve

There are no ERP screens or menus. Eleven **operations** (`modules/ops`) cover the book-keeping
lifecycle, and three surfaces drive the same operations with the same authority rules:

| Stage | Operations |
| --- | --- |
| Capture | `record` |
| Commit | `post` (drafted entries in bulk) |
| Assure | `balance` (trial balance, chain, suspense, freshness), `reconcile` (statement vs books with timing items) |
| Distribute | `allocate` (weights to the paisa, across accounts or cost centres), `rebalance` (asset pool to target shares) |
| Period | `close` (month lock; year-end closing voucher to retained surplus), `carry_forward` (opening position check and sign-off) |
| Insight | `report`, `simulate` (what-if, never posts), `dashboard` |

Every write is a **plan** computed from the authoritative book state. A plan contains:

- the exact journals it would post
- the before and after balance of each affected account
- pre-checks, including the ledger's own validation
- the governing policy
- a hash over its actions and the book version it was computed from

`commit` executes only if the hash matches and the book has not moved since the simulation. What a person approves is exactly what is posted. Blocked plans are shown but not stored.

Authority:

- A person can commit what they have seen.
- An agent (`agent:*`) can commit only when the operation is policy-gated and policy grants L3 or higher.
- `allocate`, `rebalance`, `close` and `carry_forward` always wait for a person.

Surfaces:

- **Canvas (web).** A command bar, answers as plan cards with Approve and Discard, plans waiting for approval, and a live position card. The ledger, reports, review and import views are drill-down targets only.
- **Copilot** (`POST …/books/:b/copilot`).
  - With `ANTHROPIC_API_KEY` and `KUBER_LLM_MODEL` set, a Claude model plans with the tools. The model is not hard-coded; set a current model ID from Anthropic's documentation.
  - Without them, a deterministic intent router handles the common commands.
  - The copilot runs as `agent:copilot` and has no commit tool: every change it proposes waits on the canvas.
- **MCP server** (`POST /mcp`, Streamable HTTP, stateless). It is enabled by `KUBER_MCP_TOKENS`, which maps bearer tokens (at least 24 characters) to one tenant, one book and an `agent:` principal. The tools are `kuber_<operation>`, `kuber_accounts`, `kuber_plans` and `kuber_commit`. For Claude Desktop, use a remote connector or `npx mcp-remote http://localhost:8080/mcp --header "Authorization: Bearer <token>"`.
- **LLM classification** (off by default). With `KUBER_LLM_CLASSIFY=on`, `ANTHROPIC_API_KEY` and a model in
  `KUBER_LLM_CLASSIFY_MODEL` (or `KUBER_LLM_MODEL`), transactions that no rule, history or merchant keyword
  matches are sent to the model instead of going straight to suspense.
  - Only the narration, counterparty text and account names leave the process; runs of four or more digits are masked and amounts are not sent.
  - The answer must be one of the book's own accounts, or it is discarded. Its confidence is capped at 0.9, below POL-502's 0.97, so it is always a draft for review, never an automatic posting.
  - Approving the draft learns a rule, so that counterparty does not reach the model again. Model and prompt version are recorded with each classification.
  - Any model error or refusal sends the transaction to suspense; the pipeline does not wait.
- **MCP client.** `KUBER_MCP_SERVERS` lists external MCP servers (bank feeds, GST, mail) whose allow-listed or read-only tools the copilot may call. Their output is labelled untrusted data.

## Guarantees and how they are enforced

| Guarantee | Mechanism | Test |
| --- | --- | --- |
| Every journal balances, in integer paise | `decide()` in the Book aggregate; `bigint` only | property tests (`fast-check`) |
| History cannot be edited | append-only trigger on `es.events`; app role has no UPDATE/DELETE; per-book SHA-256 hash chain | `eventstore.test.ts`, `domain.test.ts` |
| One writer per book | transaction-scoped advisory lock + expected-version check | 25 concurrent writers test |
| Event published iff committed | transactional outbox; relay marks after broker ack; JetStream de-duplicates by event ID | outbox test, NATS integration test |
| Each event handled once per module | inbox table in the same transaction as the handler's writes | inbox tests |
| Retries never double-post | deterministic journal IDs from request IDs; idempotent `PostJournal` | domain + cell tests |
| Tenant isolation | row-level security on every table; tenant requests and event handlers connect as `kuber_app`, which sees only the tenant in `kuber.tenant`; only `kuber_system` (a member of `kuber_system_scope`) sees every tenant, and it is used by the outbox relay and system reads alone; denied cross-tenant writes are logged as `rls_denied`; stream IDs prefixed by tenant | RLS test, `tests/isolation.test.ts` |
| Module boundaries | each event type has one owning module; the store refuses others | ownership test |
| Every committed action has evidence (design 14.7) | each journal and period lock gets one `EvidenceRecorded` event with source, decision, execution, result, approval and exceptions, sealed and chained; `recordHash` over the canonical record; retrievable by signal, statement hash, transaction, draft, plan id or hash, journal id or hash, event id or record hash | `tests/evidence.test.ts` |
| Agent autonomy stays within policy | `PolicyEngine` (strictest wins, runtime limits only lower autonomy), overrides after corrections | policy tests, correction test |

## Run it

Requirements: Node 22+, pnpm 10, Docker (or local PostgreSQL 16 and NATS 2.11).

Everything in containers:

```bash
./scripts/secure-setup.sh                   # once: master key, certificates, passwords in ~/.kuber
./kuber up -d --build                       # postgres, nats, valkey (TLS), core (HTTPS) on :8080, web on :3000
curl --cacert ~/.kuber/certs/ca.crt https://localhost:8080/healthz
./kuber logs -f core
```

Or the infrastructure in containers and core and web on your machine, with reload:

```bash
./scripts/dev.sh                            # same keys, TLS and passwords; see the script
pnpm demo                                   # two-month walk-through with a throwaway in-memory key
```

The server warns at start-up if the application role can bypass row-level security, and refuses to start if it is a member of `kuber_system_scope`.

Database roles:

| Role | Used by | Sees |
| --- | --- | --- |
| `kuber` (owner, `MIGRATION_URL`) | migrations, key tools | every tenant |
| `kuber_app` (`DATABASE_URL`) | API requests, event handlers | the tenant in `kuber.tenant` only |
| `kuber_system` (`SYSTEM_DATABASE_URL`) | outbox relay, catch-up reads, storage checks | every tenant; no event or key updates |

The core creates `kuber_system` on start with `SYSTEM_DB_PASSWORD`; `./kuber` and `./scripts/secure-setup.sh` add that password to an existing `secrets.env`.

## Data protection

**Threat model**
- **Protected against:**
  - a stolen disk, volume, database dump or backup;
  - an attacker who can read, copy or alter database rows;
  - traffic sniffing between services;
  - one tenant reading another's data.
- **Not protected against:** a compromised running core process or a compromised host. Both hold keys in memory. That is the limit of any server-side encryption that still lets agents work unattended.

**Identity and authorization**
- **Sign-in is by passkey (WebAuthn).** The core holds the credentials (`identity` schema, row-level security by tenant) and verifies every registration and sign-in; the web tier only relays the ceremony and then issues an encrypted session cookie.
  - The first passkey for a new, empty workspace makes its owner. A workspace that has members or data cannot be claimed; others join with a one-time invitation code from an owner.
  - Development sign-in (name only, no proof) exists only with `KUBER_DEV_SIGNIN=true` on both core and web, and both refuse it when `NODE_ENV=production`.
- **The core does not trust identity headers.** The web tier signs each request (HMAC-SHA256 with `CORE_AUTH_SECRET` over method, path, body hash, tenant, principal, time and nonce, valid for 60 seconds, accepted once). Unsigned, altered, stale or replayed requests get 401 before any handler runs. Only `/healthz` and `/readyz` are open; MCP uses its own bearer tokens.
- **Every request is authorized** against the tenant's membership, re-read each time (revocation is immediate): roles owner, controller, preparer, approver, auditor, member, each optionally limited to some books. Auditors are read-only. The same check guards every plan, commit and discard, whether it came from the web, the copilot or MCP.
- **Maker-checker.** Period operations, and plans above the policy's amount limit (or a tenant limit), need an approver other than their preparer; a plan the copilot prepared counts as prepared by the person who asked. A single-owner exception must be switched on by the owner and lapses when a second person joins.
- **MCP tokens are limited to their book**, at commit as well as when planning.
- **High-risk commands are signed on the device** (design 14.4, 16.4). Committing or approving a period operation or a plan above the approval limit, approving a draft or ratifying an automatic posting above the tenant limit, and locking a period directly:
  - the browser asks `POST /v1/tenants/:t/signing/options`; the core renders a summary from the command itself (amount, payees, accounts, book, periods) and returns WebAuthn options whose challenge is the SHA-256 of the canonical digest inputs (tenant, book, action, subject, subject hash, principal, a single-use server nonce valid 5 minutes, the summary's hash);
  - the web tier shows that summary, then the passkey signs (user verification required); the core verifies the assertion inside the command's own transaction (the member's own active passkey, request unused, unexpired and for exactly this command) and stores it in the resulting event (`PlanApproved`, `PlanApprovalRecorded`, `DraftApproved`, `Ratified`, `PeriodLocked`: field `signature`);
  - an assertion for one plan cannot approve another, and cannot be reused;
  - `ops verify-signatures [--tenant t]` re-checks every stored signature offline against the stored public key and its event; evidence records carry the signature and its verification;
  - only development sign-in (a member without a passkey, `KUBER_DEV_SIGNIN=true`) falls back to the step-up claim, recorded as `kind: "dev-step-up"`, which is not a signature.
  - Not a single HTTP command today, so not signed: publishing a policy (policies are files loaded at start-up) and paying at a bank (Kuber records payments as plans, which are signed above the limit).
- **Two authenticators.** Owners and controllers with one passkey are warned (`/me`, the members page, the books-in-order check); members add a passkey from the members page after confirming with a current one. The separation setting `requireTwoAuthenticators` (off by default) refuses their signatures until they have two.
- **Recovery** of an existing member who lost access is an operator action: `identity-cli recover <workspace> <role:name> --reason "…"` issues a one-time code for the same principal, recorded as `RecoveryIssued` and `RecoveryCompleted` in the identity stream; redeeming it revokes their other passkeys unless `--keep-passkeys`.

**Encryption at rest (application-level, AES-256-GCM)**
- **Envelope encryption.** A master key in a key-management service (KMS) unlocks per-tenant data keys; those keys encrypt the data.
  - Locally, the KMS is `~/.kuber/master.keys` (permissions 0600, outside the repository).
  - `packages/crypto` defines the KMS interface, so AWS KMS, GCP KMS or Vault Transit can replace the local file.
  - Tenant keys are stored only in wrapped (locked) form, in `keys.tenant_keys`.
- **Events** are encrypted before they reach PostgreSQL. The same ciphertext goes through the outbox and NATS, so no plaintext copy of an event exists at rest.
- **Sensitive columns are encrypted:**
  - payee names, rule patterns, draft proposals and narrations;
  - ops plans and their actions.
- **Some fields stay readable so reports can run in SQL:** amounts, dates and account codes in the reporting projection, and principals and tenant ids in event metadata.
- **Each ciphertext is bound to its tenant and its exact row.** A value copied to another row or tenant does not decrypt.
- **Payee ids are keyed pseudonyms** (`p.<HMAC>`), so a guessed merchant name cannot be confirmed from the database.
- **Tamper evidence.** Each stream has a link chain over salted digests. It can be verified without keys, and still after re-encryption or crypto-shredding.
- **Database guards:**
  - `es.events` is append-only. The only permitted update is an owner-run maintenance reseal, which cannot change an event's identity or meaning.
  - The application role cannot update events or keys, and cannot shred.

**In transit**
- A local CA issues one service certificate.
- PostgreSQL requires TLS for TCP connections, with password authentication (SCRAM); clients connect with `sslmode=verify-full`.
- NATS and Valkey accept TLS only, with token and password authentication.
- core serves HTTPS.
- The core refuses to start without all of this (`KUBER_REQUIRE_TLS=true`).
- All published ports are bound to 127.0.0.1. The browser session cookie is encrypted (AES-256-GCM).

**Operating it**
- **First install:**
  1. `./scripts/secure-setup.sh` creates the master key, certificates and passwords.
  2. `./kuber up -d --build` starts the stack.
- **Existing install (before passkeys):** run `./scripts/secure-setup.sh` (adds `CORE_AUTH_SECRET`) and rebuild. Existing workspaces have data but no members, so each owner needs an invitation that keeps their principal: `./kuber run --rm --entrypoint "npx tsx apps/core/src/identity-cli.ts" tools invite <workspace> owner:<name>`, then "Create a passkey" with that code. Everyone is signed out once.
- **Existing plaintext install:** `./scripts/secure-migrate.sh`. It rotates the database passwords, turns on TLS, encrypts every legacy row, purges the broker, verifies, then takes a backup.
- **Keys** (`./kuber run --rm tools <command>`):

  | Command | What it does |
  | --- | --- |
  | `status` | Shows master keys, tenant key versions and shredded tenants |
  | `verify` | Checks link chains and digests; lists anything still plaintext |
  | `rotate-master` | Adds a new master key and re-wraps every tenant key under it |
  | `retire-master <id>` | Removes an old master key once nothing is wrapped with it |
  | `rotate-tenant <t>` | Creates a new tenant data key and re-encrypts under it |
  | `drop-retired <t>` | Drops old tenant data keys after a 5-minute grace, only when no stored value uses them and no envelope sealed with them is still within the bus retention (`KUBER_BUS_RETENTION_DAYS`, default 7) |
  | `shred <t> --reason … --confirm <t>` | Crypto-shreds a tenant (irreversible) and records it in the shred ledger |
  | `purge-shredded` | Purges shredded tenants' readable rows again (run about 2 minutes after `shred`, when key caches have expired) |
  | `reapply-shreds [ledger]` | After a restore: shreds again every tenant in the shred ledger (`restore.sh --replace` runs it) |
  | `prune-outbox` | Deletes published outbox rows that the broker no longer retains |
  | `purge-bus` | Drops broker messages and records the purge, so `drop-retired` stops waiting for them |

- **Key lifecycle.** A data key is dropped only when nothing retained needs it. That covers events, unpublished outbox rows, sealed columns and certified report snapshots, which are all re-encrypted. It also covers envelopes already published to NATS: these keep their original ciphertext until the bus retention has passed or `purge-bus` has run. Cached aggregate snapshots under an old key are deleted, not re-encrypted.
- **Crypto-shredding:**
  - Deletes the tenant's keys. Purges every table listed in the retention inventory (`RETENTION` in `apps/core/src/keys-admin.ts`), including evidence balances, dead letters and report snapshots.
  - A database trigger refuses new events for a shredded tenant, even from a process that still has its keys cached.
  - The encrypted events remain, unreadable, but their structure still verifies.
  - `keys verify` fails if anything readable remains for a shredded tenant, or if a table with a `tenant_id` column is missing from the inventory.
- **Backups and erasure:**
  - A backup holds the wrapped tenant keys and ciphertext as they were when it was taken. If a backup predates a shred and the master key still exists, the backup can bring the erased tenant back.
  - The shred ledger (`~/.kuber/shredded.jsonl`, next to `master.keys`, not with the backups) records every shred. `keys reapply-shreds` erases those tenants again after a restore.
  - Erasure is complete in backups only when every backup older than the shred has expired, or when the master keys that wrapped those backups' tenant keys have been rotated out and destroyed (`rotate-master`, then `retire-master`). Set the backup retention with that in mind.
  - Dropped data keys also survive in older backups. That is intended: those backups must remain restorable.
- **Backups:**
  - `./scripts/backup.sh` streams `pg_dump` through chunked AES-256-GCM under a fresh file key, then verifies the result.
  - `./scripts/restore.sh <file>` restores into a new database; `--replace` restores over the live one.
  - Keep `master.keys` and the backups in different places. Either one alone is useless.

**Operations** (`pnpm ops <command>`, or `./kuber run --rm tools ops <command>`; see `apps/core/src/ops-cli.ts`):

| Command | What it does |
| --- | --- |
| `status` | Shows the outbox backlog, open dead letters, unprocessed events per consumer, and report lag per book |
| `dead-letters [--all]` | Lists deliveries that failed their last retry (JetStream `max_deliver`), with the event reference and the error |
| `retry <id\|all>` / `discard <id> --reason …` | Re-runs the handler on the event read from PostgreSQL (idempotent), or closes the dead letter |
| `gaps` | Lists events that a consumer has no inbox record for. Unlike a checkpoint, this shows every missed event |
| `check <reporting\|agent\|evidence>` | Compares the projection with the event store: exact balances, journal counts, contiguity, gaps |
| `rebuild <reporting\|agent\|evidence> [--tenant t]` | Deletes the projection and replays it from the event store in one transaction. Inbox rows are rewritten, and no side effects run (evidence is rebuilt from its own records). Then runs `check`; the result is deterministic |
| `certify <t> <book> <kind>` | Waits until the projection has caught up, then stores a certified statement with its ledger position and hash, encrypted |
| `reproduce <t> <snapshotId>` | Recomputes a certified statement at its ledger position and compares hashes |

Every report states its basis: the journals projected, the ledger position, the lag, and whether any journal is missing. The API and statements accept `fresh=require` (refuse with 409) or `fresh=wait&timeoutMs=…`. All the figures in one statement come from a single database snapshot.

## Develop on this machine

This folder is the source of truth; there is no other working copy.

- Whole stack in containers: `./scripts/secure-setup.sh` once, then `./kuber up -d --build`, then open http://localhost:3000.
- Native with reload:
  - Run `./scripts/dev.sh`. Postgres, NATS and Valkey run in Docker; core and web run from source (core on 8080, web on 3000).
  - `pnpm` 10.28 is required: `corepack enable`.
  - Passkeys work on http://localhost:3000. `KUBER_DEV_SIGNIN=true ./scripts/dev.sh` adds the labelled, insecure name-only sign-in (needed by `pnpm e2e`).
  - Members from the command line: `pnpm identity invite|members|revoke …` (see `apps/core/src/identity-cli.ts`).
- Tests:
  - Start the database with `./kuber up -d postgres`, then run `pnpm test:docker`. It connects over TLS with the generated owner password.
  - Each test file gets its own database, dropped afterwards.
  - `pnpm test` uses `TEST_DATABASE_ADMIN_URL`, or `postgres://kuber@localhost:5433/postgres` if it is unset.
- Browser walkthrough:
  - Run `npx playwright install chromium` once, then `pnpm e2e` against a running stack.
  - It writes screenshots to `e2e-shots/` and fails on any browser console error.
- Typecheck: `pnpm typecheck` checks core. For web, run `cd apps/web && pnpm check`.

## Tests

```bash
pnpm test:docker                                                                          # 116 tests, over TLS with the generated password
pnpm test:llm                                                                             # live Anthropic classifier; needs ANTHROPIC_API_KEY and KUBER_LLM_CLASSIFY_MODEL
KUBER_INTEGRATION=1 NATS_URL=nats://localhost:4222 pnpm test:integration                 # real JetStream
pnpm typecheck
```

Each test file creates and drops its own database.

## API (phase 0)

Every `/v1` request carries `x-kuber-auth: KH1 <claims>.<mac>`, made by `signRequest` in
`packages/auth` with `CORE_AUTH_SECRET` (tenant must match the path; principal `role:name` must be an
active member). Identity: `POST /v1/tenants/:t/identity/{registration,authentication}/{options,verify}`,
`GET /v1/tenants/:t/me`, `GET|POST /v1/tenants/:t/members[/invitations]`,
`POST /v1/tenants/:t/members/:principal/revoke`, `GET|PUT /v1/tenants/:t/settings/separation`.

| Method and path | Purpose |
| --- | --- |
| `POST /v1/tenants/:t/books` | Open a book (`individual`, `household`, `freelancer`, `company`) |
| `POST /v1/tenants/:t/books/:b/accounts` | Grow the chart of accounts |
| `POST /v1/tenants/:t/books/:b/journals` | Manual journal (`debit` / `credit` as rupee strings) |
| `POST /v1/tenants/:t/books/:b/opening-balances` | Declare an opening balance |
| `POST /v1/tenants/:t/books/:b/locks` | Soft or hard period lock (owner or controller) |
| `POST /v1/tenants/:t/books/:b/statements` | Bank statement CSV, asynchronous (202) |
| `POST /v1/tenants/:t/books/:b/chat` | "Paid 450 to the plumber in cash" |
| `GET  /v1/tenants/:t/drafts` · `POST …/drafts/:id/approve` · `POST …/drafts/:id/reject` | Review queue |
| `GET  /v1/tenants/:t/ratifications` · `POST …/journals/:id/ratify` · `POST …/journals/:id/correct` | Weekly review |
| `POST /v1/tenants/:t/rules` | Explicit classification rule |
| `GET  /v1/tenants/:t/evidence?q=<id or hash>` · `GET …/evidence/:id` | Evidence records citing an id or hash, each with `verified.recordHash` and `verified.citations` |
| `GET  …/books/:b/reports/{trial-balance,profit-and-loss,balance-sheet,statement-of-affairs}` | Statements (amounts in paise) |
| `GET  …/books/:b/accounts/:a/lines` | Drill-through to journal lines |
| `GET  …/books/:b/verify` | Recompute the hash chain |
| `GET  …/books/:b/attention` | Counts for badges: open drafts, drafts awaiting approval, ratifications, open plans |
| `GET  …/books/:b/journal-lifecycle` | Every entry (drafts, plans, refused postings, schedule exceptions) as `draft`, `submitted`, `approved`, `posting`, `posted` or `failed` |
| `POST …/books/:b/schedules` · `GET …/books/:b/schedules[/reconciliation,/exceptions]` · `GET /v1/tenants/:t/schedules/:id` · `POST …/books/:b/schedules/run` | Recurring and recognition schedules; approve with the `schedule_approve` operation |
| `GET  …/books/:b/suspense/items` · `GET …/books/:b/suspense/roll-forward?from=&to=` · `POST /v1/tenants/:t/suspense/items/:id/assign` | Suspense cases; resolve with the `resolve_suspense` operation |

Lists of open work and drill-through are keyset pages: `?limit=` (drafts and ratifications at most
500, plans 200, drill-through 1,000) and `?after=` (plans: `?before=`) with the cursor returned in
the `x-next-cursor` response header; `GET /drafts` also takes `?book=`.
| `GET /healthz`, `GET /readyz` | Liveness and readiness |

## Measured (indicative only)

One process on a 2-vCPU sandbox, PostgreSQL 16 and NATS on the same machine, relay and all three
consumers running in the same process, 20 concurrent connections, ~4,000 events in the store:

| Workload | Throughput | p50 | p99 |
| --- | --- | --- | --- |
| Trial balance reads | ~1,580 req/s | 11 ms | 35 ms |
| Manual journals to a single book (worst case: all writers on one book) | ~160–200 req/s | 95–110 ms | 210–610 ms |

These are not capacity figures for production; they show the design has headroom against the
~1,000 req/s peak in section 16.5 when reads and writes are spread across books and instances.
Load tests from section 16.5 must run per cell before launch.

### Scale work (F09–F11), before and after

Hardware and method: 2 vCPU (Intel Xeon @ 2.1 GHz), 7 GB RAM sandbox shared with other workloads,
Node 22.22, PostgreSQL 16 on the same host, in-memory bus, one process. Single runs, not a load
test; expect ±20–30 % between runs. `review/replay-benchmark.ts` is a pure in-memory fold;
`scripts/scale-bench.ts <journals>` (needs `TEST_DATABASE_ADMIN_URL`) posts N journals to one book
with `gl.execute`, then measures cold loads, projection and interactive reads.

| Measure | Before | After |
| --- | --- | --- |
| Fold 1k / 3k / 10k journals (replay-benchmark) | 49 / 370 / 6,123 ms (quadratic) | 16 / 21 / 42 ms |
| Sequential writes, one book, 5k journals | 205/s (last 500: p50 5.7 ms, p95 12.5 ms) | 320–358/s (last 500: p50 1.4–3.5 ms, p95 2.9–6.3 ms) |
| Sequential writes, one book, 20k journals | not run (quadratic) | 457/s (last 500: p50 1.7 ms, p95 3.8 ms) |
| Concurrent writes, 8 books | 579/s | 763–882/s |
| Cold load of a 5k-journal book on a new instance | 1,743–2,158 ms (full replay) | 64–76 ms (snapshot + tail); 183 ms full replay |
| Cold load, 20k journals | not run | 251–351 ms (snapshot + tail); 676 ms full replay |
| Heap after the 5k run | 99 MB | 40–81 MB |
| `dashboard` plan, 5k journals (p50 / p95) | 23 / 56 ms | 17–19 / 23–29 ms (20k: 27 / 40 ms) |
| `reconcile` plan, 5k journals | 4.4 / 7.0 ms | 1.7–3.1 / 3.8–5.0 ms |
| Recent journals (20), 5k journals | 37 / 55 ms | 21 / 35 ms; 1.7 / 5 ms at 20k with table statistics |
| `balance` plan, 5k / 20k journals | 231 / 375 ms (5k) | 171 / 221 ms (5k), 654 / 730 ms (20k): dominated by full hash-chain verification, still O(history) |

Tenant fairness is shown by tests rather than a throughput figure: with 8 lanes a tenant whose
handler is blocked does not delay a tenant in another lane (memory bus and JetStream); with 1 lane
it does. Projection of one tenant's 5k journals took 54 s before and ~20 s after on the in-memory
bus; one tenant always stays in one lane, so a single hot tenant is still bounded by one consumer.

## Finance requirements (G0 pilot)

Tests are in `tests/fin-gl.test.ts`, named by requirement.

- **FIN-GL-01 journal lifecycle.** One vocabulary for every path an entry takes: `draft`, `submitted`, `approved`, `posting`, `posted`, `failed` (`@kuber/contracts` `draftLifecycle` / `planLifecycle`; stored draft and plan states are unchanged). A manual journal (API, any ops operation) to a control account is refused unless it is a controlled adjustment flagged and committed by an owner or controller, with the party on every control line. A refused manual journal changes nothing and is recorded as `PostingRejected` on `<tenant>/gl-rejections/<book>`, shown as `failed` with its reason.
- **FIN-GL-02 recurring journals.** Template lines, monthly, start and end, policy version, optional auto-reversal on the first day of the next month. Approved once by a `schedule_approve` plan (period-approval authority, maker-checker); `ops run-schedules [--as-of d] [--tenant t]` then posts each occurrence as `system:scheduler` under that approval (its plan id is the journal's command id), within the approved amount, re-checking the approver's authority on every run. The occurrence id (schedule, period, kind) is claimed under the book lock with its journal, so reruns and concurrent runs post once. A locked posting or reversal date becomes an exception case; the date is never moved.
- **FIN-GL-03 prepaid and accrual schedules.** Straight-line monthly over the coverage dates (remainder paise in the last month), remaining balance, cancellation through a `schedule_cancel` plan that recalculates the remaining balance and can release it; the `schedules` operation and `…/schedules/reconciliation` reconcile schedule balances to the GL by period.
- **FIN-GL-05 suspense.** Each journal to `SUSPENSE` opens an item (source, owner, age, resolution). `resolve_suspense` reverses the original on the resolution date and posts the replacement (`replaces`), linking all three; a plain reversal resolves the item as reversed. The ledger refuses a manual journal that pairs suspense with non-money accounts, any journal that moves the suspense balance towards zero against non-money accounts, and a back-dated correction of a suspense entry. The roll-forward (opening + additions − resolved = closing) is by item dates, so a past period keeps its position.
- **FIN-GL-04 foreign currency: deferred.** G0 books are INR only. The book currency and its minor-unit exponent are explicit (`BOOK_CURRENCY = "INR"`, `CURRENCY_EXPONENT.INR = 2`: amounts are integer paise), and a journal, `record` or schedule naming another currency is refused with `currency_not_supported`. Rates, transaction vs functional currency, revaluation and realised/unrealised gains are not built.

## Known limits and next steps

- Evidence covers committed journals and period locks. Not yet: a plan that fails part-way (its `PlanApproved` is recorded, the failure only in `ops.plans`), later ratification of an auto-posted journal (its own event, not appended to the record), MCP tool-call traces, and control tests over `control_refs`.
- Evidence is built as events arrive. A database with journals from before `evidence-001` needs a backfill replay (`readAll` through the handler) before its history has records.
- `approval.signature` is the device signature of the approval when the command was signed (null for commands that need none, and for plans committed before signed commands). Ratification signatures are on `Ratified`, not in the journal's record.
- Signed commands are enforced at the HTTP boundary, the only surface people use to approve; `cell.ops.commit` called in-process (tests, tooling) does not require one, and `ops verify-signatures` lists period operations committed without a signature. Drafts and ratifications use the tenant's SoD limit only (not policy limits). WebAuthn authenticators do not display the summary; the web tier shows it before asking the passkey.
- `kuber.tenant` is still set by the application for each request, so tenant scoping relies on the core choosing the right tenant; the database stops any role but `kuber_system` from seeing more than one.
- Book state is cached in memory and caught up from the store; persistent snapshots (`es.snapshots`) are the next step for very large books.
- JetStream consumers use `max_ack_pending = 1` for ordering; scale-out needs partitioned subjects (for example by tenant hash) per consumer.
- Messages exceeding `max_deliver` need a dead-letter stream and alert.
- Party resolution is exact-alias only; fuzzy matching is not built.
- The LLM classifier runs inside the agent's database transaction (15-second timeout, one retry). Fine with one ordered consumer; move the call ahead of the transaction before consumers scale out.
- There is no labelled evaluation set yet (design 13.5), so a model or prompt change cannot be measured before release.
- Plans are computed from the book state at one version and refused if it moves; a posting between the commit check and the last action of a multi-step plan (for example a year-end close) is narrowed by soft-locking first, not eliminated.
- `carry_forward` verifies and signs off; the ledger is continuous, so balances are not re-posted and pending drafts dated in a closed year must be decided before the close.
- The rules router covers common phrasings only; open-ended requests need the model.
- Temporal timers, ClickHouse cube and Centrifugo live updates arrive in phase 1.
- Foreign currency (FIN-GL-04) is deferred: books are INR only and other currencies are refused.
- Schedules are monthly only; `ops run-schedules` must be run by an external timer (cron) until Temporal timers arrive. A schedule exception can be dismissed but not retried; a cancelled schedule's unreleased balance stays on its account.
