<script lang="ts">
  import { enhance } from "$app/forms";
  import { date, inr, prettyNarration } from "$lib/format";
  import AccountSelect from "$lib/components/AccountSelect.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import SignPrompt from "$lib/components/SignPrompt.svelte";
  import { Signer, signedSubmit } from "$lib/sign.svelte";

  let { data, form } = $props();
  let fixing = $state<string | null>(null);
  let choice = $state<Record<string, string>>({});
  let busy = $state<string | null>(null);

  const name = (id: string | null) => (id && data.accounts.find((a) => a.account_id === id)?.name) || id || "—";
  const daysLeft = (due: string) => Math.ceil((new Date(due).getTime() - Date.now()) / 86_400_000);
  const act = (id: string) => () => { busy = id; return async ({ update }: { update: () => Promise<void> }) => { busy = null; fixing = null; await update(); }; };
  // Confirming a posting above the approval limit is signed with a passkey, after its summary is shown.
  const signer = new Signer();
  const ratifySubmit = (id: string) => signedSubmit(signer, () => ({ action: "journal.ratify", journalId: id }),
    () => { busy = id; }, async ({ update }) => { busy = null; fixing = null; await update(); });
</script>

<svelte:head><title>Confirm · Kuber</title></svelte:head>

<header class="top">
  <div class="eyebrow">Confirm</div>
  <h1>{data.items.length ? `${data.items.length} automatic ${data.items.length === 1 ? "posting" : "postings"} to confirm` : "Nothing to confirm"}</h1>
  <p class="muted">Kuber was permitted to post these on its own. They are already in your books; confirming closes the loop, correcting reverses and re-posts them.</p>
</header>

{#if !data.items.length}
  <div class="panel done"><Icon name="check" size={28} /><div><h2>All confirmed.</h2>
    <p class="muted">Automatic postings appear here for a short window after Kuber makes them.</p></div></div>
{/if}

<div class="list">
  {#each data.items as r (r.request_id)}
    {@const p = prettyNarration(r.narration)}
    {@const left = daysLeft(r.due_by)}
    <article class="panel card">
      <div class="head">
        <div class="what">
          <div class="faint small num">{r.txnDate ? date(r.txnDate) : ""}</div>
          <h2>{p.title}</h2>
          <div class="faint small">Posted to <strong class="acc">{name(r.accountId)}</strong>{p.detail ? ` · ${p.detail}` : ""}</div>
        </div>
        <div class="right">
          <div class="amt num" class:in={r.direction === "in"}>{r.direction === "in" ? "+" : "−"}{inr(r.amount).replace("−", "")}</div>
          <span class="pill" class:clay={left <= 1} class:brass={left > 1}><span class="dot"></span>{left <= 0 ? "Due today" : `${left} ${left === 1 ? "day" : "days"} to confirm`}</span>
        </div>
      </div>

      {#if fixing === r.journal_id}
        <form method="POST" action="?/correct" class="fix" use:enhance={act(r.journal_id)}>
          <input type="hidden" name="journalId" value={r.journal_id} />
          <div class="field grow">
            <label for="c-{r.journal_id}">Should have been</label>
            <AccountSelect id="c-{r.journal_id}" accounts={data.accounts} bind:value={choice[r.journal_id]!} direction={r.direction} />
          </div>
          <label class="check"><input type="checkbox" name="learn" /> Always use this for {p.title}</label>
          <button class="btn primary" disabled={busy === r.journal_id || !choice[r.journal_id]}>Correct</button>
          <button type="button" class="btn quiet" onclick={() => (fixing = null)}>Cancel</button>
        </form>
      {:else}
        <div class="acts">
          <form method="POST" action="?/ratify" use:enhance={ratifySubmit(r.journal_id)}>
            <input type="hidden" name="journalId" value={r.journal_id} />
            <button class="btn primary" disabled={busy === r.journal_id}><Icon name="check" size={15} /> Looks right</button>
          </form>
          <button class="btn quiet" onclick={() => { fixing = r.journal_id; choice[r.journal_id] ??= r.accountId ?? ""; }}><Icon name="edit" size={15} /> Wrong account</button>
        </div>
      {/if}
      {#if busy === r.journal_id}<SignPrompt {signer} />{/if}
      {#if busy === r.journal_id && signer.message}<p class="error small" role="status">{signer.message}</p>{/if}
      {#if form?.id === r.journal_id && form?.message}<p class="error small" role="alert">{form.message}</p>{/if}
    </article>
  {/each}
</div>

<style>
  .top { margin-bottom: 28px; }
  .top h1 { margin: 8px 0; }
  .top p { margin: 0; max-width: 64ch; }
  .list { display: grid; gap: 14px; }
  .card { padding: 22px 24px; display: grid; gap: 18px; }
  .head { display: flex; justify-content: space-between; gap: 24px; }
  .what h2 { font-size: 24px; margin: 4px 0; }
  .acc { color: var(--text); font-weight: 600; }
  .right { display: grid; justify-items: end; gap: 8px; }
  .amt { font-family: var(--serif); font-size: 28px; white-space: nowrap; }
  .amt.in { color: var(--sage); }
  .acts { display: flex; gap: 10px; }
  .fix { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
  .grow { flex: 1; max-width: 340px; }
  .check { display: flex; gap: 8px; align-items: center; color: var(--text-2); font-size: 13.5px; padding-bottom: 10px; }
  .small { font-size: 12.5px; }
  .done { display: flex; gap: 18px; align-items: center; padding: 28px; }
  .done :global(svg) { color: var(--sage); }
  .done p { margin: 4px 0 0; }
  .error { color: var(--clay); margin: 0; }
</style>
