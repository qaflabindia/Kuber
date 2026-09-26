# ASDGF scope determination for Kuber's agent instances

ASDGF-2026 §1.3 applies where two or more agent instances stand in relation A1 (a shared writable resource), A2 (one creates another), A3 (a shared objective or scoring function) or A4 (one instance's output enters another's decision context). A set of instances in none of these relations is not a swarm: each is governed on its own under TAGOF Archetypes 5 and 6. This file applies that test to Kuber as merged at c27cd2e, extending agent design section 4. It is the record `tests/agent-eval.test.ts` reads.

Determined 26 September 2026 by the evaluation workstream (ws5/agent-eval). It must be re-determined at every material change (TAGOF Tier 1: re-classification at every material change): a new agent instance, a new tool that carries one instance's output to another, or a change to what the classifier or MCP clients can write.

## Instances

ASDGF 3.1 defines an agent instance as an addressable execution context with its own identity, capability set and budget. A deterministic component is not one.

| Instance | Identity | Model-driven? | Writes | Reads |
|---|---|---|---|---|
| (a) Copilot model loop | `agent:copilot`, on behalf of the signed-in person | Only when the Reasoner is configured: `KUBER_LLM_PROCESSING_APPROVED`, plus `AGENT_MW_URL` or, outside production, `ANTHROPIC_API_KEY` with `KUBER_LLM_MODEL`. Otherwise it is the deterministic router. | Plans only. It is never offered `kuber_commit`, and a person commits every plan on the canvas. | Books through read tools. Drafts come through `kuber_review_queue` and `kuber_post` previews; ledger narrations through `kuber_ledger` and `kuber_search_journals`. |
| (b) Statement classifier | `agent:kuber` | Only with `KUBER_LLM_CLASSIFY=on`, and then only as the fallback step after rules, history and keywords. The default is deterministic. | Drafts, and postings where POL-502 autonomy allows. LLM answers are capped below the auto-post threshold, so an LLM classification is always a draft. | Statement lines and the chart of accounts. It does not read copilot output. |
| (c) External MCP clients | `agent:<name>`, one book per token (`KUBER_MCP_TOKENS`) | Yes: a third-party model such as Claude Desktop. | Plans, and commits where policy lets an agent commit (L3, gate "policy"). The agentic test shows a small entry committed by an MCP client. | The same catalogue as the copilot, including `kuber_plans`, `kuber_post` previews (drafts with the classifier's proposed account) and ledger narrations. |

## Relations

| Relation | Finding |
|---|---|
| **A1:** shared writable resource | **No** between (a) and anything else: the copilot's only writes are plan simulations, and persons commit. **No** between (b) and (c) through the ledger. (c) writes journals and (b) writes postings, but (b)'s model step reads only the statement line and the chart. It never reads journals, and its provisional matching is deterministic. |
| **A2:** one instance creates another | **No.** No instance can start, configure or grant credentials to another. MCP tokens are issued by an operator, and the copilot has no inter-agent credentials (AGT-05, n = 1). |
| **A3:** shared objective or scoring function | **No by construction**, and this is now tested. The copilot golden set (`eval/agent/cases.jsonl`, metric `copilot.golden.v1`; DSPy export `eval/agent/dspy/copilot.jsonl`, metrics `next_step.tool_args.v1` and `compose.grounded_coverage.v1`) and the classifier set (`eval/classifier/classify.jsonl`, metric `classify.account_accuracy.v1`) are separate files with separate metrics. `tests/agent-eval.test.ts` fails if they share a file, a row or a metric id (agent design 7.3). Dream-RSI optimises two separate policy families against separate objectives; the test does not cover that, and it is recorded as a gap. |
| **A4:** one instance's output enters another's context | Depends on configuration: <br>• **(b)→(a)** when the classifier is an LLM and the copilot is a model. LLM-proposed drafts, with their accounts and reasons, reach the copilot through `kuber_review_queue` and `kuber_post` previews. <br>• **(b)→(c)** when the classifier is an LLM and MCP clients are configured: the same drafts reach an MCP client through `kuber_post`. <br>• **(c)→(a)** when MCP clients can write and the copilot is a model: an MCP client's journal narrations and plan titles reach the copilot through `kuber_ledger`, `kuber_search_journals` and `kuber_plans`. The reverse, **(a)→(c)**, also holds: narrations in the copilot's plans reach an MCP client through `kuber_plans`. <br>• A deterministic classifier or a rules-only copilot is not an agent instance, so it creates no A4 edge. |

## Determination

| Configuration | In scope? | Reason |
|---|---|---|
| Classifier rules, copilot rules, no MCP | **No** | No model-driven instance. |
| Classifier rules, copilot rules, MCP on | **No** | One model-driven instance (the MCP client). The copilot and classifier it reads are deterministic. |
| Classifier rules, copilot model, no MCP | **No** | One model-driven instance (the copilot). Classifier drafts are deterministic data. |
| Classifier LLM, copilot rules, no MCP | **No** | One model-driven instance (the classifier). No other instance reads its output. |
| Classifier LLM, copilot model | **Yes, through A4 (b)→(a).** Mediated coupling (K1) at the lowest effect reach: a person approves every write the copilot proposes. | See below. |
| Classifier LLM with MCP on, or copilot model with MCP on | **Yes, through A4.** The coupling is only partly mediated, because an MCP client may commit L3 plans without a person. | See below. |

**Kuber as deployed by default** (every switch off, as in CI, and the pilot recommendation in agent design section 4) **is out of scope.** It is governed as independent agent systems under TAGOF Archetype 5.

### Requirements before an in-scope configuration may run

1. **Treat classifier and MCP-originated text as untrusted.** Already in place: `agent/tools.register.json` marks `kuber_review_queue`, `kuber_match_reviews`, `kuber_ledger`, `kuber_search_journals` and `kuber_parties` as `untrustedOutput`, and `screenToolOutput` wraps and flags that text (PRM-08).
2. **Close open finding AE-01** (`eval/agent/thresholds.json`). The evaluation shows that flagged untrusted text can still lead the model path to propose a write the person did not ask for: in cases ind-03 and ind-05, under the scripted and scripted-dspy engines, the model reads planted text and then proposes `kuber_post`. In an A4 configuration, that is exactly how an LLM-classifier draft carrying injected text would propagate. Governance must refuse unrequested write tools after flagged output in the same turn.
3. **For MCP-on configurations, cap MCP clients to plans, with no agent commit,** or accept and record the unmediated edge: an MCP client that commits under L3 makes the (c)→(a) coupling unmediated.
4. **Record the review here**, under "Reviewed configurations", with the date and reviewer. `tests/agent-eval.test.ts` fails when the running environment enables a configuration not listed there (see `scope-check.ts`: `KUBER_LLM_CLASSIFY`, `KUBER_LLM_PROCESSING_APPROVED`, `AGENT_MW_URL` or `ANTHROPIC_API_KEY` with `KUBER_LLM_MODEL`).

## Reviewed configurations

These lines are parsed by `eval/agent/scope-check.ts`: one configuration per line. The in-scope configurations are deliberately absent until requirements 2 to 4 are met.

- `classifier=rules copilot=rules`: reviewed 2026-09-26 (ws5/agent-eval). Out of scope.
- `classifier=rules copilot=model`: reviewed 2026-09-26 (ws5/agent-eval). Out of scope without MCP write grants; with them, see pending.
- `classifier=llm copilot=rules`: reviewed 2026-09-26 (ws5/agent-eval). Out of scope without MCP clients.

## Pending configurations

These are not reviewed, and the test fails if they are enabled:

- `classifier=llm copilot=model`: in scope (A4, K1 mediated). Blocked on AE-01 and an owner's review.
- Any model instance together with MCP write grants: in scope (A4, partly unmediated). Not yet encoded in the check. `KUBER_MCP_TOKENS` is not read by `scope-check.ts`, which is recorded as a gap.
