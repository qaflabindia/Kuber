<script lang="ts">
  import { enhance } from "$app/forms";
  import { REASONS } from "$lib/reasons";
  import { date, humanReason, inr, levelLabel, prettyNarration } from "$lib/format";
  import AccountSelect from "$lib/components/AccountSelect.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import SignPrompt from "$lib/components/SignPrompt.svelte";
  import { Signer, signedSubmit } from "$lib/sign.svelte";

  let { data, form } = $props();

  let focused = $state(0);
  let choice = $state<Record<string, string>>({});
  let rejecting = $state<string | null>(null);
  let busy = $state<string | null>(null);

  // Seed each card with Kuber's suggestion before the DOM renders; a <select> bound to an undefined
  // value would otherwise silently adopt its first option (which once approved a ₹75,000 unknown payee).
  $effect.pre(() => {
    for (const d of data.drafts) if (!(d.draft_id in choice)) choice[d.draft_id] = d.proposal.accountId;
  });

  const cards: HTMLElement[] = [];
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName) || e.metaKey || e.ctrlKey) return;
    const n = data.drafts.length;
    if (!n) return;
    if (e.key === "j" || e.key === "ArrowDown") { focused = Math.min(n - 1, focused + 1); cards[focused]?.focus(); e.preventDefault(); }
    if (e.key === "k" || e.key === "ArrowUp") { focused = Math.max(0, focused - 1); cards[focused]?.focus(); e.preventDefault(); }
    if (e.key === "a" && choice[data.drafts[focused]?.draft_id ?? ""] !== "SUSPENSE") { (cards[focused]?.querySelector("form.approve button") as HTMLButtonElement | null)?.click(); }
    if (e.key === "r") { rejecting = data.drafts[focused]?.draft_id ?? null; e.preventDefault(); }
  }
  const pct = (c: number) => `${Math.round(c * 100)}% sure`;
  const act = (id: string) => () => { busy = id; return async ({ update }: { update: () => Promise<void> }) => { busy = null; rejecting = null; await update(); }; };
  // Approving above the approval limit is signed with a passkey, after the summary of exactly what it posts is shown.
  const signer = new Signer();
  const approveSubmit = (id: string) => signedSubmit(signer, (f) => ({ action: "draft.approve", draftId: id, accountId: String(f.get("accountId") ?? "") || undefined }),
    () => { busy = id; }, async ({ update }) => { busy = null; rejecting = null; await update(); });
</script>

<svelte:window onkeydown={onKey} />
<svelte:head><title>Review · Kuber</title></svelte:head>

<header class="top">
  <div>
    <div class="eyebrow">Review</div>
    <h1>{data.drafts.length ? `${data.drafts.length} ${data.drafts.length === 1 ? "entry" : "entries"} to look at` : "All clear"}</h1>
    <p class="muted">Kuber drafted these but wasn't allowed, or wasn't sure enough, to post them on its own. Your answers teach it.</p>
  </div>
  {#if data.drafts.length}
    <div class="keys faint"><span class="kbd">J</span><span class="kbd">K</span> move · <span class="kbd">A</span> approve · <span class="kbd">R</span> reject</div>
  {/if}
</header>

{#if !data.drafts.length}
  <div class="panel done">
    <Icon name="check" size={28} />
    <div>
      <h2>Nothing needs you.</h2>
      <p class="muted">New entries appear here when a statement arrives and Kuber needs your judgement.</p>
    </div>
  </div>
{/if}

<div class="list">
  {#each data.drafts as d, i (d.draft_id)}
    {@const p = prettyNarration(d.proposal.narration)}
    {@const unknown = d.proposal.accountId === "SUSPENSE"}
    <article class="card panel" id={d.draft_id} tabindex="-1" bind:this={cards[i]} class:focused={focused === i}
      onfocusin={() => (focused = i)} aria-label={p.title}>
      <div class="meta">
        <span class="faint num">{date(d.proposal.txnDate)}</span>
        {#if d.status === "rejected_by_gl"}<span class="pill clay"><span class="dot"></span>Not posted</span>
        {:else if d.status === "awaiting_approval"}<span class="pill clay"><span class="dot"></span>Needs approval</span>
        {:else}<span class="pill brass"><span class="dot"></span>{levelLabel(d.decision.level)}</span>{/if}
        {#if d.proposal.provisional}<span class="pill">Awaiting statement</span>{/if}
      </div>

      <div class="main-row">
        <div class="what">
          <h2>{p.title}</h2>
          <div class="faint small">{p.detail}</div>
        </div>
        <div class="amt num" class:in={d.proposal.direction === "in"}>
          {d.proposal.direction === "in" ? "+" : "−"}{inr(d.proposal.amount).replace("−", "")}
        </div>
      </div>

      <div class="why">
        {#if d.gl_rejection}<p><Icon name="alert" size={15} /> The ledger refused this entry: {d.gl_rejection}</p>{/if}
        {#if unknown}
          <p><Icon name="alert" size={15} /> Kuber hasn't seen this counterparty before and found no rule for it.</p>
        {:else}
          <p><span class="faint">Suggests</span> <strong>{data.accounts.find((a) => a.account_id === d.proposal.accountId)?.name ?? d.proposal.accountId}</strong>
            <span class="faint">· {pct(d.proposal.confidence)} · {d.proposal.classifiedBy}</span></p>
        {/if}
        {#each [...new Set(d.decision.reasons.map(humanReason))] as r}<p class="faint small reason">{r}</p>{/each}
      </div>

      <div class="controls">
        <form method="POST" action="?/approve" class="approve" use:enhance={approveSubmit(d.draft_id)}>
          <input type="hidden" name="id" value={d.draft_id} />
          <div class="field grow">
            <label for="acc-{d.draft_id}">Record as</label>
            <AccountSelect id="acc-{d.draft_id}" accounts={data.accounts} bind:value={choice[d.draft_id]!} direction={d.proposal.direction} />
          </div>
          {#if choice[d.draft_id] !== d.proposal.accountId}
            <select name="code" aria-label="Why change it" class="reason">{#each REASONS as [code, label]}<option value={code} selected={code === "wrong_account"}>{label}</option>{/each}</select>
          {/if}
          <button class="btn primary" disabled={busy === d.draft_id || choice[d.draft_id] === "SUSPENSE"}>
            <Icon name="check" size={15} /> {choice[d.draft_id] !== d.proposal.accountId ? "Approve as changed" : "Approve"}
          </button>
        </form>
        {#if rejecting === d.draft_id}
          <form method="POST" action="?/reject" class="reject" use:enhance={act(d.draft_id)}>
            <input type="hidden" name="id" value={d.draft_id} />
            <select name="code" aria-label="Reason code" class="reason">{#each REASONS as [code, label]}<option value={code} selected={code === "duplicate"}>{label}</option>{/each}</select>
            <input name="reason" placeholder="Why? e.g. duplicate, not mine" aria-label="Reason for rejecting" />
            <button class="btn">Reject</button>
            <button type="button" class="btn quiet" onclick={() => (rejecting = null)}>Cancel</button>
          </form>
        {:else}
          <button class="btn quiet" onclick={() => (rejecting = d.draft_id)}>Not a transaction</button>
        {/if}
      </div>
      {#if busy === d.draft_id}<SignPrompt {signer} />{/if}
      {#if busy === d.draft_id && signer.message}<p class="error small" role="status">{signer.message}</p>{/if}
      {#if form?.id === d.draft_id && form?.message}<p class="error small" role="alert">{form.message}</p>{/if}
    </article>
  {/each}
</div>

<style>
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 28px; }
  .top h1 { margin: 8px 0 8px; }
  .top p { margin: 0; max-width: 62ch; }
  .keys { display: flex; gap: 6px; align-items: center; font-size: 12.5px; white-space: nowrap; }
  .list { display: grid; gap: 14px; }
  .card { padding: 22px 24px; display: grid; gap: 16px; transition: border-color 0.15s var(--ease); outline: none; }
  .card.focused { border-color: rgba(201, 168, 106, 0.45); }
  .meta { display: flex; gap: 10px; align-items: center; font-size: 13px; }
  .main-row { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .what h2 { font-size: 26px; }
  .amt { font-family: var(--serif); font-size: 30px; white-space: nowrap; font-variation-settings: "opsz" 48; }
  .amt.in { color: var(--sage); }
  .why { border-left: 2px solid var(--line); padding-left: 14px; display: grid; gap: 2px; }
  .why p { margin: 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .why :global(svg) { color: var(--clay); }
  .reason::before { content: "·"; margin-right: 2px; }
  .small { font-size: 12.5px; }
  .controls { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
  .approve { display: flex; gap: 10px; align-items: flex-end; flex: 1; min-width: 320px; }
  .grow { flex: 1; max-width: 360px; }
  .reject { display: flex; gap: 8px; align-items: center; }
  .reject input { width: 260px; }
  .done { display: flex; gap: 18px; align-items: center; padding: 28px; }
  .done :global(svg) { color: var(--sage); }
  .done p { margin: 4px 0 0; }
  .error { color: var(--clay); margin: 0; }
</style>
