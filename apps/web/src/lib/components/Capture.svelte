<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();
  let text = $state("");
  let busy = $state(false);
  let message = $state<{ tone: "ok" | "err"; text: string } | null>(null);
  let input: HTMLTextAreaElement | undefined = $state();

  const examples = ["Paid 450 to the plumber in cash", "Received 1.18 lakh from Acme for invoice 17 via bank", "Spent 1,200 on groceries by card"];

  $effect(() => { if (open) { message = null; tick().then(() => input?.focus()); } });

  function close() { open = false; }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.currentTarget as HTMLTextAreaElement).form?.requestSubmit(); }
  }
</script>

{#if open}
  <div class="scrim" role="presentation" onclick={close}></div>
  <div class="dialog panel" role="dialog" aria-modal="true" aria-labelledby="capture-title">
    <form method="POST" action="/capture" use:enhance={() => {
      busy = true;
      return async ({ result }) => {
        busy = false;
        if (result.type === "success") {
          message = { tone: "ok", text: String(result.data?.message ?? "Recorded.") };
          text = "";
          await invalidateAll();
        } else if (result.type === "failure") {
          message = { tone: "err", text: String(result.data?.message ?? "That didn't go through.") };
        }
      };
    }}>
      <div class="head">
        <div>
          <div class="eyebrow">Tell Kuber</div>
          <h2 id="capture-title">What happened with your money?</h2>
        </div>
        <button type="button" class="btn quiet sm icon" aria-label="Close" onclick={close}><Icon name="x" size={16} /></button>
      </div>
      <div class="entry">
        <textarea bind:this={input} name="text" bind:value={text} rows="2" maxlength="500" onkeydown={onKey}
          placeholder="Paid 450 to the plumber in cash" aria-label="Describe a transaction"></textarea>
        <button class="btn primary" disabled={busy || !text.trim()} aria-label="Record">
          {busy ? "Recording…" : "Record"} <Icon name="send" size={15} />
        </button>
      </div>
      {#if message}
        <p class="msg {message.tone}" role="status">{message.text}</p>
      {:else}
        <div class="examples">
          <span class="faint">Try</span>
          {#each examples as ex}
            <button type="button" class="chip" onclick={() => { text = ex; input?.focus(); }}>{ex}</button>
          {/each}
        </div>
      {/if}
      <p class="note faint">Cash entries post immediately. Bank and card entries stay provisional until the statement confirms them, so nothing is counted twice.</p>
    </form>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; background: rgba(5, 7, 10, 0.66); backdrop-filter: blur(3px); z-index: 40; animation: fade 0.18s var(--ease); }
  .dialog { position: fixed; z-index: 41; top: 14vh; left: 50%; transform: translateX(-50%); width: min(640px, calc(100vw - 32px));
    padding: 24px; animation: rise 0.22s var(--ease); background: var(--ink-1); }
  .head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
  .head h2 { margin-top: 4px; }
  .icon { width: 30px; padding: 0; }
  .entry { display: flex; gap: 10px; align-items: flex-end; }
  textarea { resize: none; font-size: 17px; line-height: 1.45; padding: 12px 14px; }
  .examples { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 14px; font-size: 13px; }
  .chip { border: 1px solid var(--line); background: var(--ink-2); color: var(--text-2); border-radius: 999px; padding: 5px 12px; font: 500 12.5px var(--sans); cursor: pointer; }
  .chip:hover { color: var(--text); border-color: #34404f; }
  .msg { margin: 14px 0 0; font-size: 14px; }
  .msg.ok { color: var(--sage); }
  .msg.err { color: var(--clay); }
  .note { font-size: 12.5px; margin: 16px 0 0; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes rise { from { opacity: 0; transform: translate(-50%, 8px); } }
</style>
