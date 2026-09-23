<script lang="ts">
  import { dateShort, inr, prettyNarration } from "$lib/format";
  import type { Snippet } from "svelte";

  let { date, narration, amount, direction, sub = "", actions }: {
    date: string; narration: string; amount: string; direction: "in" | "out"; sub?: string; actions?: Snippet;
  } = $props();
  const p = $derived(prettyNarration(narration));
</script>

<div class="row">
  <div class="date num faint">{dateShort(date)}</div>
  <div class="what">
    <div class="title">{p.title}</div>
    <div class="detail faint">{sub || p.detail}</div>
  </div>
  <div class="amt num" class:in={direction === "in"}>{direction === "in" ? "+" : "−"}{inr(amount).replace("−", "")}</div>
  {#if actions}<div class="acts">{@render actions()}</div>{/if}
</div>

<style>
  .row { display: grid; grid-template-columns: 64px 1fr auto auto; align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--line-soft); }
  .row:last-child { border-bottom: 0; }
  .date { font-size: 13px; }
  .what { min-width: 0; }
  .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .detail { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .amt { font-size: 16px; font-weight: 600; text-align: right; }
  .amt.in { color: var(--sage); }
  .acts { display: flex; gap: 6px; }
</style>
