<script lang="ts">
  import { goto } from "$app/navigation";
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { searchNav, type NavSection } from "$lib/shell";
  import { pendingAsk } from "$lib/ask.svelte";

  // ⌘K: jump to any page the member can use, or hand the text to Kuber on the Canvas.
  // Combobox pattern (WAI-ARIA 1.2): focus stays in the input; the active option is aria-activedescendant.
  let { sections, open = $bindable(false), canAsk = true }: { sections: NavSection[]; open?: boolean; canAsk?: boolean } = $props();

  let query = $state("");
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let opener: Element | null = null;

  type Option = { kind: "page"; href: string; label: string; icon: string; section: string; count?: number }
    | { kind: "ask"; text: string };
  const options = $derived.by<Option[]>(() => {
    const pages: Option[] = searchNav(sections, query).map((i) => ({ kind: "page", href: i.href, label: i.label, icon: i.icon, section: i.section, count: i.badge?.count }));
    const q = query.trim();
    if (!canAsk || !q) return pages;
    // A question reads as a question: put "Ask" first when nothing matches or it looks like a sentence.
    const ask: Option = { kind: "ask", text: q };
    return pages.length === 0 || q.split(/\s+/).length >= 3 ? [ask, ...pages] : [...pages, ask];
  });

  $effect(() => { void query; active = 0; });
  $effect(() => {
    if (open) { opener = document.activeElement; query = ""; tick().then(() => input?.focus()); }
  });

  function close() {
    open = false;
    if (opener instanceof HTMLElement) opener.focus();
  }
  async function choose(o: Option | undefined) {
    if (!o) return;
    open = false;
    if (o.kind === "page") await goto(o.href);
    else { pendingAsk.text = o.text; await goto("/?ask"); }
  }
  function onKey(e: KeyboardEvent) {
    const n = options.length;
    if (e.key === "ArrowDown") { e.preventDefault(); if (n) active = (active + 1) % n; scroll(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (n) active = (active - 1 + n) % n; scroll(); }
    else if (e.key === "Home") { e.preventDefault(); active = 0; scroll(); }
    else if (e.key === "End") { e.preventDefault(); active = Math.max(n - 1, 0); scroll(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(options[active]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") e.preventDefault(); // keep focus inside the dialog
  }
  function scroll() { tick().then(() => document.getElementById(`cp-${active}`)?.scrollIntoView({ block: "nearest" })); }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={close}></div>
  <div class="palette" role="dialog" aria-modal="true" aria-label="Go to a page or ask Kuber">
    <div class="field">
      <Icon name="search" size={18} />
      <input bind:this={input} bind:value={query} onkeydown={onKey}
        role="combobox" aria-expanded="true" aria-controls="cp-list" aria-autocomplete="list"
        aria-activedescendant={options.length ? `cp-${active}` : undefined}
        placeholder={canAsk ? "Go to a page, or ask Kuber anything…" : "Go to a page…"} autocomplete="off" spellcheck="false" />
      <kbd>esc</kbd>
    </div>
    <ul id="cp-list" role="listbox" aria-label="Results">
      {#each options as o, i (o.kind === "page" ? o.href : "ask")}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li id="cp-{i}" role="option" aria-selected={i === active} class:active={i === active}
          onmousemove={() => (active = i)} onclick={() => choose(o)}>
          {#if o.kind === "page"}
            <Icon name={o.icon} size={16} />
            <span class="label">{o.label}</span>
            {#if o.count}<span class="count">{o.count}</span>{/if}
            <span class="section">{o.section}</span>
          {:else}
            <span class="spark"><Icon name="spark" size={16} /></span>
            <span class="label"><span class="faint">Ask Kuber:</span> {o.text}</span>
            <span class="section">Canvas</span>
          {/if}
        </li>
      {:else}
        <li class="empty" role="presentation">No page matches.</li>
      {/each}
    </ul>
    <div class="hint" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>⌘</kbd><kbd>K</kbd> toggle</span></div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 60; background: rgba(6, 8, 12, 0.62); backdrop-filter: blur(3px); animation: fade .14s var(--ease); }
  .palette {
    position: fixed; z-index: 61; top: 14vh; left: 50%; transform: translateX(-50%);
    width: min(620px, calc(100vw - 32px)); border-radius: 14px; overflow: hidden;
    background: var(--ink-1, #121720); border: 1px solid var(--line, rgba(255,255,255,.1));
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(201, 168, 106, 0.12);
    animation: rise .16s var(--ease);
  }
  .field { display: flex; align-items: center; gap: 12px; padding: 0 16px; height: 56px; border-bottom: 1px solid var(--line-soft); color: var(--text-3); }
  .field input, .field input:focus { flex: 1; min-width: 0; height: 100%; padding: 0; background: none; border: 0; border-radius: 0; box-shadow: none; outline: none; color: var(--text); font: 500 16px var(--sans); }
  .field input::placeholder { color: var(--text-3); }
  ul { list-style: none; margin: 0; padding: 6px; max-height: min(52vh, 420px); overflow-y: auto; }
  li { display: flex; align-items: center; gap: 12px; height: 42px; padding: 0 12px; border-radius: 9px; cursor: pointer; color: var(--text-2); font-size: 14px; }
  li.active { background: var(--ink-2); color: var(--text); box-shadow: inset 2px 0 0 var(--brass); }
  .label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .section { font-size: 11.5px; color: var(--text-3); }
  .spark { color: var(--brass-2); display: inline-flex; }
  .count { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: var(--brass-wash); color: var(--brass-2); }
  .empty { color: var(--text-3); cursor: default; justify-content: center; }
  .hint { display: flex; gap: 16px; padding: 10px 16px; border-top: 1px solid var(--line-soft); font-size: 11.5px; color: var(--text-3); }
  kbd { font: 600 10.5px var(--sans); padding: 2px 6px; border-radius: 5px; border: 1px solid var(--line-soft); background: var(--ink-2); color: var(--text-3); margin-right: 3px; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes rise { from { opacity: 0; transform: translate(-50%, 8px) scale(.985); } }
  @media (prefers-reduced-motion: reduce) { .scrim, .palette { animation: none; } }
  @media (max-width: 640px) { .palette { top: 10px; } .hint { display: none; } }
</style>
