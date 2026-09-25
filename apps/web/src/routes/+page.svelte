<script lang="ts">
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { tick } from "svelte";
  import PlanCard from "$lib/components/PlanCard.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import type { Plan } from "$lib/server/api";

  let { data } = $props();

  interface Exchange { id: number; asked: string; reply: string; cards: Plan[]; suggestions?: string[]; error?: boolean }
  let thread = $state<Exchange[]>([]);
  let text = $state("");
  let busy = $state(false);
  let input: HTMLTextAreaElement;
  let form: HTMLFormElement;
  let seq = 0;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = $derived(data.session?.name?.split(" ")[0] ?? "");
  const inThread = $derived(new Set(thread.flatMap((x) => x.cards.map((c) => c.planId))));
  const waiting = $derived((data.pending ?? []).filter((p) => !inThread.has(p.planId)));
  const history = $derived(JSON.stringify(thread.slice(0, 8).reverse().flatMap((x) => [{ role: "user", text: x.asked }, { role: "assistant", text: x.reply }])));

  const START = ["Show my position", "Are the books in order?", "Post the drafts", "What if rent goes up 15000 a month", "Close Oct 2026", "Income and expenses this year"];
  const suggestions = $derived((data.copilot.suggestions?.length ? data.copilot.suggestions : START).slice(0, 6));

  $effect(() => { if (page.url.searchParams.has("ask")) input?.focus(); });

  async function ask(t: string) { text = t; await tick(); form.requestSubmit(); }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (text.trim() && !busy) form.requestSubmit(); }
  }
  function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; }
</script>

<svelte:head><title>Kuber</title></svelte:head>

<header class="hero">
  <h1>{greeting}, {first}.</h1>
  <p class="lede">{data.position?.summary ?? "Tell Kuber what you want done. Every change is shown to you before it is posted."}</p>
</header>

<form bind:this={form} method="POST" action="?/ask" class="ask panel"
  use:enhance={() => {
    busy = true;
    const asked = text.trim();
    return async ({ result, update }) => {
      busy = false;
      const d = (result.type === "success" || result.type === "failure") ? (result.data ?? {}) as Record<string, any> : {};
      if (result.type === "success" && d.answer) thread = [{ id: ++seq, asked, reply: d.answer.reply, cards: d.answer.cards, suggestions: d.answer.suggestions }, ...thread];
      else thread = [{ id: ++seq, asked, reply: d.message ?? "Kuber could not answer.", cards: [], error: true }, ...thread];
      text = ""; grow();
      await update({ reset: false, invalidateAll: false });
    };
  }}>
  <Icon name="spark" size={18} />
  <label for="ask" class="sr-only">Tell Kuber what to do</label>
  <textarea id="ask" name="text" rows="1" bind:this={input} bind:value={text} oninput={grow} onkeydown={onKey}
    placeholder="Record, post, reconcile, allocate, rebalance, close, simulate… just say it" autocomplete="off" maxlength="2000"></textarea>
  <input type="hidden" name="history" value={history} />
  <button class="btn primary" disabled={busy || !text.trim()} aria-label="Send">{#if busy}Thinking…{:else}<Icon name="send" size={15} />{/if}</button>
</form>
<div class="chips" aria-label="Suggestions">
  {#each suggestions as s}<button type="button" class="chip" onclick={() => ask(s)} disabled={busy}>{s}</button>{/each}
  <a class="chip" href="/import"><Icon name="upload" size={13} /> Import a statement</a>
</div>
{#if data.copilot.engine === "rules"}
  <p class="engine faint">Running on Kuber's built-in rules. Add a Claude API key to the core for open-ended requests.</p>
{/if}

{#each thread as x (x.id)}
  <section class="exchange">
    <div class="you"><span class="faint">You</span> {x.asked}</div>
    {#if x.reply}<p class="reply" class:err={x.error}>{x.reply}</p>{/if}
    {#if x.suggestions?.length}
      <div class="chips">{#each x.suggestions as s}<button type="button" class="chip" onclick={() => ask(s)}>{s}</button>{/each}</div>
    {/if}
    <div class="cards">{#each x.cards as c (c.planId)}<PlanCard plan={c} />{/each}</div>
  </section>
{/each}

{#if data.pending === null}
  <section class="block">
    <h2>Waiting for your approval</h2>
    <p class="unavailable" role="status">Plans waiting for approval could not be loaded. This is not an empty list: reload, or check that the core is running.</p>
  </section>
{:else if waiting.length}
  <section class="block">
    <h2>Waiting for your approval</h2>
    <div class="cards">{#each waiting as p (p.planId)}<PlanCard plan={p} compact />{/each}</div>
  </section>
{/if}

{#if data.position}
  <section class="block"><PlanCard plan={data.position} /></section>
{/if}

<style>
  .hero { margin-bottom: 22px; }
  .hero h1 { margin: 0 0 8px; font-size: 42px; }
  .lede { font-family: var(--serif); font-size: 19px; color: var(--text-2); margin: 0; max-width: 70ch; }
  .ask { display: flex; gap: 12px; align-items: flex-end; padding: 12px 12px 12px 18px; border-color: rgba(201, 168, 106, 0.35); }
  .ask > :global(svg) { color: var(--brass); margin-bottom: 12px; flex: none; }
  .ask:focus-within { border-color: var(--brass); box-shadow: 0 0 0 4px rgba(201, 168, 106, 0.08); }
  textarea { flex: 1; resize: none; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 16.5px; padding: 9px 0; outline: none; line-height: 1.45; }
  textarea::placeholder { color: var(--text-3); }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 0; }
  .chip { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--line); background: var(--ink-1); color: var(--text-2); border-radius: 999px; padding: 6px 12px; font-size: 13px; cursor: pointer; font-family: inherit; }
  .chip:hover:not(:disabled) { border-color: var(--brass); color: var(--text); }
  .engine { font-size: 12px; margin: 10px 0 0; }
  .exchange { margin-top: 28px; display: grid; gap: 10px; }
  .you { font-size: 14px; color: var(--text); }
  .you .faint { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; margin-right: 8px; }
  .reply { margin: 0; font-family: var(--serif); font-size: 18px; color: var(--text-2); max-width: 75ch; }
  .reply.err { color: var(--clay); }
  .unavailable { margin: 0; color: var(--clay); font-size: 14px; }
  .cards { display: grid; gap: 14px; }
  .block { margin-top: 32px; }
  .block h2 { font-size: 20px; margin: 0 0 12px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
