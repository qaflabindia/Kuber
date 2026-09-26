# Kuber agent: value-chain dependency map (TAGOF GEN-04, Domain 12)

Owner: System Owner (Unassigned). Review at every material change (TAGOF CHG-01): a new model, vendor, region, middleware version, or data field sent.

## Processing decision (Domain 12 gate)

Book data reaches a language model only after the operator records a processing decision:

```
KUBER_LLM_PROCESSING_APPROVED=<approver>:<YYYY-MM-DD>:<data-location>
e.g. system_owner:asha:2026-09-25:us
```

The last two fields are the decision date and the data location. The approver may contain `:`.

Enforcement:

- **Core start-up** (`apps/core/src/main.ts`). A malformed value stops the core from starting. When the value is absent, every model path stays off and the core logs why.
- **Core model paths.**
  - `providerFromEnv` (copilot) returns null without a valid record, and the copilot uses its deterministic router.
  - `classifierFromEnv` (statement fallback) turns LLM classification off.
  - The agent core calls `requireProcessingApproval()` before any request to the agent middleware.
- **Agent middleware** (Python, FastAPI; agent design 7.1).
  - Every request from the core carries the record in the header `x-kuber-processing-approval` (`middlewareHeaders`).
  - The middleware holds its own `KUBER_LLM_PROCESSING_APPROVED`. It refuses any request whose header is missing or differs, and it refuses to start without a valid value.
  - Neither tier alone can turn model processing on.
- **Changes.** Changing the location or the vendor is a new decision: set a new record with a new date.

## Dependencies

| # | Dependency | Configured by | What is sent | Masking and minimisation | Vendor retention | If it fails (single point of failure?) |
|---|---|---|---|---|---|---|
| 1 | Anthropic Messages API (copilot, direct provider; kept for tests only once the middleware is default) | `ANTHROPIC_API_KEY`, model id `KUBER_LLM_MODEL` | System prompt (`agent/prompts/copilot.system.v1.md`, hash-locked); the person's question; the last 8 turns of the conversation; tool results. Tool results include account names, balances in paise and rupees, plan journals, and narrations and counterparty names from statements, which are wrapped as untrusted data. | Tool output is screened (PRM-08). Tool outputs must carry no passkeys, secrets, bank account details or member personal data: the register requires `kuber_parties` never to return bank details. Narrations are sent as they are. | Per the vendor's commercial API terms. Record the zero-retention status and region the operator agreed in the processing decision's data location. | **No.** The copilot falls back to the deterministic router with read-only and plan answers. `providerFromEnv` returns null, and the copilot halt (`--scope copilot`) forces the fallback. |
| 2 | Anthropic Messages API (statement classifier fallback) | `KUBER_LLM_CLASSIFY=on`, `KUBER_LLM_CLASSIFY_MODEL` or `KUBER_LLM_MODEL` | Narration, counterparty text and the book's account names. Amounts are not sent. | Runs of four or more digits (account, UPI and card references) are masked before sending. Answers are cached per tenant. | As for row 1. | **No.** Unmatched lines go to suspense for a person to classify. |
| 3 | Kuber agent middleware (Python FastAPI, DSPy programs `NextStep`, `ComposeAnswer`, `ClassifyFallback`) | Internal URL, mutual TLS plus the signed-request scheme (agent core workstream) | As in rows 1 and 2. The middleware forwards to the model vendor it is configured for. | The middleware never touches the database or the tools. It returns only schema-validated output, which the core validates again. | No persistence beyond per-tenant cost and rate counters (agent design 7.1). | **Yes, for the model path only.** When it is down, the core falls back to rules (as in row 1). Ledger, plans and commits do not depend on it. |
| 4 | Compiled DSPy artifacts and Dream-RSI routing policies | `agent/artifacts/*.json`, locked in `agent/prompts.lock.json` | Nothing is sent. These are loaded by the middleware (artifacts) and the core router (routing policy). | They contain instructions and demonstrations. Demonstrations drawn from turn records need the owner's approval for training use, with personal fields hashed. | In the repository, under version control. | **No.** Without an approved artifact, the middleware must refuse to run that program, and the core falls back to rules. |
| 5 | External MCP servers (`ext_*` tools) | `KUBER_MCP_SERVERS` | The tool arguments the model chooses. | Output is always treated as untrusted and screened. | Per the provider. | **No.** They are also **not enabled**: no `ext_*` tool is in `agent/tools.register.json`, so all are refused (default deny) until F17 (tenant-bound connector credentials) is built and each tool is registered by name. |

## Single points of failure and fallbacks

- The model vendor is the only external runtime dependency of the model path. Every model path has a deterministic fallback (router, suspense), and no accounting operation depends on a model.
- The agent middleware is a single service per cell. Run two instances behind the internal load balancer before it becomes the default reasoner.
- Kill switch: `ops autonomy halt <tenant> --scope copilot` or `POST /v1/tenants/:t/autonomy/halt {"scope":"copilot"}` stops the model path at once for a tenant or a book (AGT-09).

## Data sent: what never leaves

These never leave the core:

- passkeys, sessions and signing material;
- `CORE_AUTH_SECRET` and master keys;
- sealed columns, other than through the tool results listed above;
- members' display names;
- bank account details of parties;
- other tenants' data (each tool call is bounded to one tenant and book).

Turn records store hashes of inputs and outputs, not the text (`AgentTurnRecorded`).
