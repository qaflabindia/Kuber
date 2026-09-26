# Kuber agent middleware (`services/agent-mw`)

The reasoning tier and LLM gateway of the Kuber agent (agent design section 7.1). It runs DSPy programs for the
copilot's model steps and holds the model keys. It never touches the database, the ledger or a tool. The
TypeScript core keeps the loop, the tools, governance and execution, and calls this service through
`apps/core/src/copilot/reasoner.ts` (`MiddlewareReasoner`).

## Endpoints

| Method and path | Program | Returns |
|---|---|---|
| `POST /v1/next-step` | `NextStep`: one ReAct step | `{action:"tool", tool, args}` or `{action:"final", draft}`, plus `meta` |
| `POST /v1/compose` | `ComposeAnswer`: the reply, built from tool outputs only | `{answer, facts, inferences, opinions, grounding}`, plus `meta` |
| `POST /v1/classify` | `ClassifyFallback`: masked statement line to an account | `{accountId, confidence, reasons}`, plus `meta` |
| `GET /metrics` | | Per-tenant requests, tokens and cost (Prometheus text). The request must be signed |
| `GET /healthz` | | Gate status, auth and model configured, and program/artifact status. No secrets. Unauthenticated |

`meta` = `{program, artifactId, artifactHash, model, tokensIn, tokensOut, ms}`. The core records it in the turn
record.

Checks run in this order on every `/v1` call:

1. Body at most 512 KiB (413).
2. KH1 signature (401).
3. The assertion names a tenant (401).
4. Model-processing gate (503 `processing_not_approved`).
5. Body schema (422 `invalid_request`).
6. With `AGENT_MW_REQUIRE_ARTIFACTS=true`: an approved artifact exists (503 `artifact_not_approved`).
7. Per-tenant rate limit and daily token budget (429).
8. A model is configured (503 `model_not_configured`).
9. Bounded model call (504 `model_timeout`, 502 `model_error`).
10. Output checks (422: `tool_not_in_catalogue`, `forbidden_tool`, `args_invalid`, `ungrounded_figures`,
    `account_not_in_chart` or `malformed_output`).

## Security

- **Signing.** Every request carries `x-kuber-auth: KH1 …`, the same scheme as `packages/auth`. The
  audience is `kuber-agent-mw`, the issuer `kuber-core`, and the key is HKDF over `AGENT_MW_SECRET`. The
  assertion covers the method, the path, a SHA-256 of the body, the tenant, the principal, and a TTL of at
  most 60 s with 30 s skew. Each nonce is accepted once, and replays are refused. Test vectors in
  `tests/test_auth.py` pin byte-for-byte agreement with the TypeScript implementation. The replay cache
  is in-process, so run one instance, or add a shared store before scaling out.
- **Model-processing gate (TAGOF Domain 12).** Requires
  `KUBER_LLM_PROCESSING_APPROVED=<approver>:<YYYY-MM-DD>:<data-location>`, with the same rules as the core.
  The core must also present its own record in `x-kuber-processing-approval`, and the two must match, so
  neither tier alone can switch model processing on.
- **Network.** TLS only, with the certificate `~/.kuber/certs/agent-mw.crt` issued by
  `scripts/secure-setup.sh` from the local CA. In compose the service is on the internal `agent` network
  with the core, and on `llm-egress` for the provider. It has no published port, a read-only root
  filesystem and a non-root user.
- **Prompt handling.**
  - No DSPy response cache is kept, on disk or in memory.
  - Narrations are re-masked: runs of 4 or more digits are hidden.
  - A catalogue containing `kuber_commit` is refused.
  - Provider errors are returned by exception type only, never with their message.

## Configuration (environment only)

| Variable | Meaning |
|---|---|
| `AGENT_MW_SECRET` | Shared with the core, at least 32 characters (secure-setup adds it) |
| `AGENT_MW_MODEL` | DSPy/LiteLLM model string: `anthropic/…`, `openai/…`, `ollama_chat/…`. `fake` gives an offline deterministic model, refused when `AGENT_MW_ENV=production` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AGENT_MW_API_BASE` | Provider credentials and endpoint. Read from the environment only |
| `KUBER_LLM_PROCESSING_APPROVED` | The processing decision |
| `AGENT_MW_TLS_CERT`, `AGENT_MW_TLS_KEY` | Server certificate and key. Required unless `AGENT_MW_ALLOW_PLAINTEXT=true` outside production |
| `AGENT_MW_TIMEOUT_S` | Default 20, ceiling 60 |
| `AGENT_MW_MAX_TOKENS` | Default 1024, ceiling 4096 |
| `AGENT_MW_RATE_PER_MINUTE`, `AGENT_MW_TOKENS_PER_DAY` | Per-tenant limits |
| `AGENT_MW_PRICE_PER_M` | `"in,out"` USD per million tokens, used for cost accounting only |
| `AGENT_MW_REQUIRE_ARTIFACTS` | `true` refuses a program that has no approved artifact. The default runs zero-shot and logs it |
| `AGENT_MW_AGENT_DIR`, `AGENT_MW_PROMPTS_LOCK`, `AGENT_MW_ARTIFACTS_DIR` | Where artifacts and the lock live. Default `<repo>/agent` |

## Offline optimiser

```
python -m agentmw.optimize --program next_step|compose|classify --dataset eval/agent/golden.jsonl \
    --optimizer gepa|miprov2 --seed 7 --out agent/artifacts/ [--model anthropic/… | fake]
```

- **Dataset.** JSONL, one case per line:
  `{utterance, history?, catalogue?, prior_steps?, gold:{tool,args}|{action:"final"}, tool_outputs?, gold_answer_facts?, line?, chart?, gold_account?}`.
  A row feeds every program whose gold it carries. `optimize/sample/golden.sample.jsonl` is a tiny sample.
- **Metrics.** Each program has its own, and a test enforces that none are shared (ASDGF A3):
  - `next_step.tool_args.v1`: correct tool and arguments. Calling a tool outside the catalogue, or
    proposing `kuber_commit`, scores -1.
  - `compose.grounded_coverage.v1`: any figure missing from the tool outputs scores 0. This uses a Python
    port of the core's grounding check, with parity tested against the TypeScript original. Otherwise the
    score is the coverage of the gold facts.
  - `classify.account_accuracy.v1`.
- **Output.**
  - `<out>/<id>.json` holds `kind:"dspy_artifact"`, `id`, `version`, `program`, `sha256` (the canonical
    JSON of `content`), `optimizer`, `seed`, `datasetHash`, `metric`, held-out `scores.before` and
    `scores.after`, `owner`, `approvedBy: null` and `approvedAt: "pending"`.
  - `<out>/<id>.report.md` is the evaluation report.
  - Nothing time-dependent is written, so a fixed seed and dataset give the same bytes (tested with the
    fake model).
- **Controls.** A real model needs the processing decision here too. The optimiser **never writes the
  lock**.

## Approving an artifact

Approval is a separate human step by the System Owner (TAGOF PRM-01, Domain 13). The optimiser cannot do it.

1. Review `<id>.json` and `<id>.report.md`:
   - the instructions;
   - the demonstrations: no personal data, and no tenant data without the owner's training-use approval;
   - the held-out scores.

   Then run the evaluation hard gates (agent design section 5) with the artifact loaded.
2. In `<id>.json`, set `approvedBy` (for example `system_owner:asha`) and `approvedAt` (`YYYY-MM-DD`).
   This does not change the content hash.
3. Add the lock entry in `agent/prompts.lock.json`, in the same reviewed change. There are two ways:
   - Run `pnpm tsx apps/core/src/copilot/governance/prompts.ts --write-lock` (from ws5/agent-gov). It records
     `{kind:"dspy_artifact", id, version, sha256: <sha256 of the file bytes>, approver, approvedAt, file}`
     under `entries`.
   - Or add it by hand under `artifacts`:
     `{"<id>": {"version": "...", "sha256": "<the artifact's sha256 field>", "approvedBy": "system_owner:asha"}}`.
4. Restart the middleware. `/healthz` then shows the program as `compiled` with its artifact id and hash,
   and every response carries them in `meta`.

The middleware accepts either hash form. It ignores, and logs, any artifact that is unlisted, pending,
mismatching, tampered with, meant for another program, or carrying its own LM configuration. In that
case it falls back to zero-shot, or refuses with `AGENT_MW_REQUIRE_ARTIFACTS=true`.

## Tests

```
python3 -m venv .venv && .venv/bin/pip install -e "services/agent-mw[dev]"   # at the repository root
pnpm test:mw
```

The tests make no network calls. The model is `agentmw.fake_lm.FakeLM`, a DSPy `DummyLM` subclass driven
by a responder function.
