<script lang="ts">
  import { enhance } from "$app/forms";
  import { REASONS } from "$lib/reasons";
  import { invalidateAll } from "$app/navigation";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { Signer } from "$lib/sign.svelte";
  import { date, inr } from "$lib/format";
  import type { Plan } from "$lib/server/api";
  import Icon from "./Icon.svelte";
  import DashboardView from "./DashboardView.svelte";
  import SignPrompt from "./SignPrompt.svelte";

  let { plan, compact = false }: { plan: Plan; compact?: boolean } = $props();

  // Local copies: the card updates itself after commit/discard without reloading the page.
  let status = $state<Plan["status"]>("proposed");
  let showDetail = $state(true);
  let message = $state<string | null>(null);
  let busy = $state(false);
  let commitForm = $state<HTMLFormElement>();
  // Signed commands: the passkey signature for the next submission, and whether this card already asked.
  const signer = new Signer();
  let assertion = "", proceed = false, retried = false;
  $effect.pre(() => { status = plan.status; });
  $effect.pre(() => { showDetail = !compact; });

  const OP_LABEL: Record<string, string> = { record: "Record", post: "Post", balance: "Balance", reconcile: "Reconcile", allocate: "Allocate",
    rebalance: "Rebalance", close: "Close", carry_forward: "Carry forward", report: "Report", simulate: "What-if", dashboard: "Position",
    schedules: "Schedules", suspense: "Suspense",
    // read answers from the agent's tools (kind "read"; nothing to approve)
    chart_of_accounts: "Chart of accounts", trial_balance: "Trial balance", profit_and_loss: "Profit and loss", balance_sheet: "Balance sheet", ledger: "Ledger",
    search_journals: "Search", review_queue: "Review", match_reviews: "Match reviews", income_breakdown: "Income", expense_breakdown: "Expenses",
    cash_position: "Cash", parties: "Parties", policies: "Policy", lifecycle: "Lifecycle", attention: "Attention" };
  const failed = $derived(plan.checks.filter((c) => !c.ok));
  const passed = $derived(plan.checks.filter((c) => c.ok));
  const fmt = (v: unknown, i: number, money?: number[]) => (money?.includes(i) && typeof v === "string" && /^-?\d+$/.test(v) ? inr(v) : String(v ?? ""));
  const dr = (a: string) => BigInt(a) > 0n;
  const abs = (a: string) => { const b = BigInt(a); return (b < 0n ? -b : b).toString(); };

  const pill = $derived(
    status === "committed" ? { cls: "sage", text: "Posted" }
    : status === "discarded" ? { cls: "", text: "Discarded" }
    : status === "stale" ? { cls: "clay", text: "Out of date" }
    : plan.kind === "read" ? { cls: "", text: plan.op === "simulate" ? "Simulation · nothing posted" : "Live" }
    : plan.blocked ? { cls: "clay", text: "Blocked" }
    : !plan.journals.length ? { cls: "brass", text: "Ready to sign off" }
    : { cls: "brass", text: plan.gate === "human" ? "Needs your approval" : "Ready to post" });

  const settle = () => { busy = true; message = null; return async ({ result, update }: { result: { type: string; data?: Record<string, unknown> }; update: (o?: { reset?: boolean; invalidateAll?: boolean }) => Promise<void> }) => {
    busy = false;
    const d = result.data ?? {};
    if (result.type === "success" && d.status) {
      status = d.status as Plan["status"]; message = (d.message as string) ?? null;
      await invalidateAll();
      // Approved drafts post asynchronously (agent -> bus -> ledger); refresh again once they land.
      if (plan.op === "post" && status === "committed") setTimeout(() => void invalidateAll(), 1500);
    }
    else if (result.type === "failure") { message = (d.message as string) ?? "That didn't work."; if (d.code === "stale") status = "stale"; }
    await update({ reset: false, invalidateAll: false });
  }; };

  /**
   * Approving a period operation, or an amount above the approval limit, is a signed command
   * (design 14.4/16.4): the card asks the core for the plan's signing options, shows what exactly
   * will be signed (amount, payees, accounts, book: rendered by the core from the plan), and only
   * then asks the passkey to sign. The signature is sent with the commit; the core verifies it and
   * stores it with the approval. Period operations ask up front; for amounts the core says so, and
   * the card asks once and posts again. Everything else posts exactly as before.
   */
  const sign = async (): Promise<boolean> => {
    const r = await signer.sign({ action: "plan.commit", planId: plan.planId, hash: plan.hash });
    message = signer.message;
    if (r === null) return false;
    assertion = r === "none" ? "" : r.assertion;
    return true;
  };
  const commitSubmit: SubmitFunction = async ({ cancel, formData }) => {
    if (plan.gate === "human" && !assertion && !proceed) {
      cancel();
      if (await sign()) { proceed = true; commitForm?.requestSubmit(); }
      return;
    }
    proceed = false;
    if (assertion) { formData.set("assertion", assertion); assertion = ""; }
    const done = settle();
    return async (o) => {
      const d = (o.result.type === "failure" ? o.result.data : undefined) ?? {};
      if (d.code === "step_up_required" && !retried) {
        busy = false; retried = true;
        if (await sign()) { proceed = true; commitForm?.requestSubmit(); } else retried = false;
        return;
      }
      retried = false;
      await done(o as never);
    };
  };
</script>

<article class="card panel" class:done={status === "committed"} class:off={status === "discarded" || status === "stale"}>
  <header>
    <div class="eyebrow">{OP_LABEL[plan.op] ?? plan.op}</div>
    <span class="pill {pill.cls}"><span class="dot"></span>{pill.text}</span>
  </header>
  <h3>{plan.title}</h3>
  {#if plan.op !== "dashboard"}<p class="summary">{plan.summary}</p>{/if}

  {#if plan.op === "dashboard" && plan.data}
    <DashboardView data={plan.data as never} />
  {:else}
    {#if failed.length}
      <ul class="checks">
        {#each failed as c}<li class:block={c.blocking}><Icon name="alert" size={14} /><span>{c.label}{c.detail ? ` — ${c.detail}` : ""}</span></li>{/each}
      </ul>
    {/if}

    {#if plan.effects.length}
      <div class="effects">
        {#each plan.effects as e}
          {@const delta = BigInt(e.after) - BigInt(e.before)}
          <div class="eff"><span class="nm">{e.name}</span>
            <span class="num faint">{inr(e.before)}</span><Icon name="arrowRight" size={13} />
            <span class="num strong">{inr(e.after)}</span>
            <span class="num delta" class:up={delta > 0n}>{delta > 0n ? "+" : ""}{inr(delta)}</span></div>
        {/each}
      </div>
    {/if}

    {#if showDetail}
      {#each plan.sections as s}
        <div class="section">
          <div class="st">{s.title}</div>
          {#if s.kind === "kv"}
            <dl class="kv">{#each s.rows as r}<dt>{r[0]}</dt><dd class="num">{fmt(r[1], 1, s.money)}</dd>{/each}</dl>
          {:else}
            <div class="scroll"><table class="table mini">
              {#if s.columns}<thead><tr>{#each s.columns as c, i}<th class:r={s.money?.includes(i)}>{c}</th>{/each}</tr></thead>{/if}
              <tbody>{#each s.rows.slice(0, 40) as r}<tr>{#each r as v, i}<td class:r={s.money?.includes(i)} class:num={s.money?.includes(i)}>{fmt(v, i, s.money)}</td>{/each}</tr>{/each}</tbody>
            </table></div>
            {#if s.rows.length > 40}<p class="faint small">{s.rows.length - 40} more rows</p>{/if}
          {/if}
        </div>
      {/each}

      {#if plan.journals.length && plan.op !== "post"}
        <div class="section">
          <div class="st">{plan.journals.length === 1 ? "Journal" : `${plan.journals.length} journals`}</div>
          {#each plan.journals.slice(0, 8) as j}
            <div class="jr">
              <div class="jh"><span class="num faint">{date(j.txnDate)}</span><span>{j.narration}</span>{#if j.voucherType !== "journal"}<span class="pill">{j.voucherType}</span>{/if}</div>
              {#each j.lines as l}
                <div class="jl" class:cr={!dr(l.amount)}><span>{l.name}{l.dimensions ? ` · ${Object.values(l.dimensions).join(", ")}` : ""}</span>
                  <span class="num">{dr(l.amount) ? inr(abs(l.amount)) : ""}</span><span class="num">{dr(l.amount) ? "" : inr(abs(l.amount))}</span></div>
              {/each}
            </div>
          {/each}
        </div>
      {/if}

      {#if passed.length}
        <ul class="checks ok">{#each passed as c}<li><Icon name="check" size={14} /><span>{c.label}{c.detail ? ` — ${c.detail}` : ""}</span></li>{/each}</ul>
      {/if}
      {#if plan.policy}
        <p class="policy faint">Governed by {plan.policy.ids.join(", ")} · autonomy {plan.policy.level} · approver {plan.policy.approver}</p>
      {/if}
      {#each plan.notes as n}<p class="faint small">{n}</p>{/each}
    {/if}
  {/if}

  <footer>
    <div class="links">
      {#if compact && plan.op !== "dashboard"}<button type="button" class="btn quiet sm" onclick={() => (showDetail = !showDetail)}>{showDetail ? "Less" : "Details"}</button>{/if}
      {#each plan.links as [label, href]}<a class="btn quiet sm" {href}>{label} <Icon name="arrowRight" size={13} /></a>{/each}
    </div>
    {#if plan.kind === "write" && status === "proposed"}
      <div class="acts">
        <form method="POST" action="/?/discard" use:enhance={settle}>
          <input type="hidden" name="planId" value={plan.planId} />
          <select name="code" aria-label="Why discard" class="reason sm">{#each REASONS as [code, label]}<option value={code} selected={code === "not_needed"}>{label}</option>{/each}</select>
          <button class="btn quiet sm" disabled={busy}>Discard</button>
        </form>
        <form method="POST" action="/?/commit" use:enhance={commitSubmit} bind:this={commitForm}>
          <input type="hidden" name="planId" value={plan.planId} />
          <input type="hidden" name="hash" value={plan.hash} />
          <button class="btn primary sm" disabled={busy || signer.busy || !!signer.prompt || plan.blocked} title={plan.blocked ? "Resolve the blocking checks first" : plan.gate === "human" ? "Sign with your passkey, then post exactly what is shown" : "Posts exactly what is shown"}>
            <Icon name={plan.gate === "human" ? "shield" : "check"} size={14} /> {plan.op === "close" ? "Approve and close" : plan.op === "carry_forward" || (plan.op === "reconcile" && !plan.journals.length) ? "Sign off" : "Approve and post"}
          </button>
        </form>
      </div>
    {/if}
  </footer>
  <SignPrompt {signer} />
  {#if plan.blocked && plan.kind === "write"}<p class="msg">Resolve the items marked above, then ask again. Nothing was saved.</p>{/if}
  {#if message}<p class="msg" role="status">{message}</p>{/if}
</article>

<style>
  .card { padding: 20px 22px; display: grid; gap: 12px; }
  .card.done { border-color: rgba(141, 187, 164, 0.35); }
  .card.off { opacity: 0.6; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  h3 { font-family: var(--serif); font-weight: 500; font-size: 23px; margin: 0; line-height: 1.2; }
  .summary { margin: 0; color: var(--text-2); }
  .checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 13px; }
  .checks li { display: flex; gap: 8px; align-items: flex-start; color: var(--text-2); }
  .checks li.block { color: var(--clay); }
  .checks li :global(svg) { flex: none; margin-top: 2px; }
  .checks.ok li { color: var(--text-3); }
  .checks.ok :global(svg) { color: var(--sage); }
  .effects { display: grid; gap: 2px; border-left: 2px solid var(--line); padding-left: 12px; }
  .eff { display: grid; grid-template-columns: minmax(120px, 1fr) auto 14px auto 110px; gap: 10px; align-items: center; font-size: 13.5px; }
  .eff :global(svg) { color: var(--text-3); }
  .strong { font-weight: 600; }
  .delta { text-align: right; color: var(--text-3); font-size: 12.5px; }
  .delta.up { color: var(--text-2); }
  .section { display: grid; gap: 6px; }
  .st { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-3); font-weight: 600; }
  .kv { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; margin: 0; font-size: 13.5px; }
  .kv dt { color: var(--text-2); } .kv dd { margin: 0; text-align: right; }
  .scroll { overflow-x: auto; }
  .mini :global(th), .mini :global(td) { padding: 7px 10px; font-size: 13px; }
  .r { text-align: right; }
  .jr { border: 1px solid var(--line-soft); border-radius: 10px; padding: 10px 12px; display: grid; gap: 4px; font-size: 13px; }
  .jh { display: flex; gap: 10px; align-items: center; margin-bottom: 2px; }
  .jl { display: grid; grid-template-columns: 1fr 110px 110px; gap: 10px; }
  .jl.cr span:first-child { padding-left: 18px; }
  .jl .num { text-align: right; }
  .policy { font-size: 12px; margin: 0; }
  .small { font-size: 12.5px; margin: 0; }
  footer { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 2px; }
  .links, .acts { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .msg { margin: 0; font-size: 13px; color: var(--text-2); }
</style>
