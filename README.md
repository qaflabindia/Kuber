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
| Tenant isolation | row-level security on every table; app connects as a non-bypass role; stream IDs prefixed by tenant | RLS test, end-to-end isolation test |
| Module boundaries | each event type has one owning module; the store refuses others | ownership test |
| Agent autonomy stays within policy | `PolicyEngine` (strictest wins, runtime limits only lower autonomy), overrides after corrections | policy tests, correction test |

## Run it

Requirements: Node 22+, pnpm 10, Docker (or local PostgreSQL 16 and NATS 2.11).

Everything in containers:

```bash
docker compose up -d --build               # postgres, nats (JetStream), valkey, core API on :8080
curl localhost:8080/healthz
docker compose logs -f core
```

Or the infrastructure in containers and the API on your machine:

```bash
docker compose up -d postgres nats valkey  # the app role kuber_app is created by deploy/postgres-init.sql
pnpm install

export MIGRATION_URL=postgres://kuber:kuber@localhost:5432/kuber        # owner: migrations and grants only
export DATABASE_URL=postgres://kuber_app:kuber_app@localhost:5432/kuber # application role: RLS applies
export APP_ROLE=kuber_app NATS_URL=nats://localhost:4222 CELL_ID=in-mum-1
pnpm start                                  # API on :8080, relay and consumers in-process
pnpm demo                                   # two-month freelancer walk-through, printed statements
```

The server warns at start-up if the application role can bypass row-level security.

## Tests

```bash
TEST_DATABASE_ADMIN_URL=postgres://kuber:kuber@localhost:5432/postgres pnpm test          # 46 tests
KUBER_INTEGRATION=1 NATS_URL=nats://localhost:4222 pnpm test:integration                 # real JetStream
pnpm typecheck
```

Each test file creates and drops its own database.

## API (phase 0)

Headers: `x-kuber-tenant` (must match the path) and `x-kuber-principal` (`role:name`). In
production these come only from the SvelteKit backend-for-frontend over mutual TLS, after passkey
sign-in; signed high-risk commands are verified there (design 16.4).

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
| `GET  …/books/:b/reports/{trial-balance,profit-and-loss,balance-sheet,statement-of-affairs}` | Statements (amounts in paise) |
| `GET  …/books/:b/accounts/:a/lines` | Drill-through to journal lines |
| `GET  …/books/:b/verify` | Recompute the hash chain |
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

## Known limits and next steps

- `kuber.role = 'system'` is a session setting the application role can set. Next: separate database roles for system consumers and tenant requests.
- Book state is cached in memory and caught up from the store; persistent snapshots (`es.snapshots`) are the next step for very large books.
- JetStream consumers use `max_ack_pending = 1` for ordering; scale-out needs partitioned subjects (for example by tenant hash) per consumer.
- Messages exceeding `max_deliver` need a dead-letter stream and alert.
- Party resolution is exact-alias only; fuzzy matching and the LLM classifier slot are not built.
- Plans are computed from the book state at one version and refused if it moves; a posting between the commit check and the last action of a multi-step plan (for example a year-end close) is narrowed by soft-locking first, not eliminated.
- `carry_forward` verifies and signs off; the ledger is continuous, so balances are not re-posted and pending drafts dated in a closed year must be decided before the close.
- The rules router covers common phrasings only; open-ended requests need the model.
- Passkeys, command signing, Temporal timers, ClickHouse cube and Centrifugo live updates arrive in phase 1.
