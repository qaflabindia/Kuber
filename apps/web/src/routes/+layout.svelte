<script lang="ts">
  import "$lib/styles/app.css";
  import { page } from "$app/state";
  import Icon from "$lib/components/Icon.svelte";
  import Capture from "$lib/components/Capture.svelte";

  let { data, children } = $props();
  let captureOpen = $state(false);

  const nav = $derived.by(() => {
    const sh = data.shell;
    if (!sh) return [];
    const items: { href: string; label: string; icon: string; count?: number; tone?: string }[] = [
      { href: "/", label: "Today", icon: "today" },
    ];
    if (sh.reviewCount) items.push({ href: "/review", label: "Review", icon: "review", count: sh.reviewCount, tone: sh.awaitingApproval ? "clay" : "brass" });
    if (sh.confirmCount) items.push({ href: "/confirm", label: "Confirm", icon: "confirm", count: sh.confirmCount });
    items.push({ href: "/import", label: "Import", icon: "import" });
    if (sh.hasJournals) {
      items.push({ href: "/reports/profit-and-loss", label: "Reports", icon: "reports" });
      items.push({ href: "/ledger", label: "Ledger", icon: "ledger" });
    }
    return items;
  });

  const active = (href: string) => href === "/" ? page.url.pathname === "/" : page.url.pathname.startsWith(href.split("/").slice(0, 2).join("/"));

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && data.shell) { e.preventDefault(); captureOpen = true; }
  }
</script>

<svelte:window onkeydown={onKey} />
<svelte:head><title>Kuber</title></svelte:head>

{#if data.shell}
  <div class="shell">
    <aside class="rail">
      <a class="brand" href="/" aria-label="Kuber home">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="30" height="30"><circle cx="32" cy="32" r="21" fill="none" stroke="currentColor" stroke-width="3"/><path d="M26 20v24M26 32l12-12M29 30l10 14" stroke="var(--brass-2)" stroke-width="3.2" stroke-linecap="round" fill="none"/></svg>
        </span>
        <span class="word">Kuber</span>
      </a>

      <button class="capture-btn" onclick={() => (captureOpen = true)}>
        <Icon name="spark" size={16} />
        <span>Tell Kuber</span>
        <span class="kbd">⌘K</span>
      </button>

      <nav aria-label="Main">
        {#each nav as item (item.href)}
          <a href={item.href} class:active={active(item.href)} aria-current={active(item.href) ? "page" : undefined}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {#if item.count}<span class="count {item.tone ?? ''}">{item.count}</span>{/if}
          </a>
        {/each}
      </nav>

      <div class="rail-foot">
        <div class="integrity" class:ok={data.shell.intact} title="Every posted journal is chained with SHA-256; this is recomputed on each visit.">
          <Icon name="shield" size={16} />
          <span>{data.shell.intact ? "Ledger verified" : "Ledger check failed"}</span>
        </div>
        <div class="who">
          <div class="avatar" aria-hidden="true">{data.session?.name?.[0]?.toUpperCase()}</div>
          <div class="who-text">
            <div class="who-name">{data.session?.name}</div>
            <div class="faint small">{data.session?.book} · {data.session?.tenant}</div>
          </div>
          <form method="POST" action="/signin?/signout">
            <button class="btn quiet sm icon-only" aria-label="Sign out" title="Sign out"><Icon name="signout" size={16} /></button>
          </form>
        </div>
      </div>
    </aside>

    <main class="main">
      {@render children()}
    </main>
  </div>

  <Capture bind:open={captureOpen} />
{:else}
  {@render children()}
{/if}

<style>
  .shell { display: grid; grid-template-columns: 252px 1fr; min-height: 100vh; }
  .rail {
    position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 20px;
    padding: 22px 16px 18px; border-right: 1px solid var(--line-soft);
    background: linear-gradient(180deg, #0e1219 0%, var(--ink-0) 60%);
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px; color: var(--brass); }
  .word { font-family: var(--serif); font-size: 26px; color: var(--text); letter-spacing: 0.01em; font-variation-settings: "opsz" 48; }
  .capture-btn {
    display: flex; align-items: center; gap: 10px; width: 100%; height: 42px; padding: 0 12px;
    border-radius: var(--r-md); border: 1px solid rgba(201, 168, 106, 0.35); background: var(--brass-wash);
    color: var(--brass-2); font: 600 13.5px var(--sans); cursor: pointer; transition: background 0.15s var(--ease);
  }
  .capture-btn:hover { background: rgba(201, 168, 106, 0.16); }
  .capture-btn span:nth-child(2) { flex: 1; text-align: left; }
  nav { display: grid; gap: 2px; }
  nav a {
    display: flex; align-items: center; gap: 12px; height: 40px; padding: 0 12px; border-radius: var(--r-md);
    color: var(--text-2); font-weight: 500; transition: background 0.12s var(--ease), color 0.12s var(--ease);
  }
  nav a:hover { background: var(--ink-2); color: var(--text); }
  nav a.active { background: var(--ink-2); color: var(--text); box-shadow: inset 2px 0 0 var(--brass); }
  nav a span:nth-child(2) { flex: 1; }
  .count { font-size: 11.5px; font-weight: 700; min-width: 22px; height: 20px; padding: 0 7px; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center; background: var(--ink-3); color: var(--text-2); }
  .count.brass { background: var(--brass-wash); color: var(--brass-2); }
  .count.clay { background: var(--clay-wash); color: var(--clay); }
  .rail-foot { margin-top: auto; display: grid; gap: 14px; }
  .integrity { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--clay); padding: 0 8px; }
  .integrity.ok { color: var(--sage); }
  .who { display: flex; align-items: center; gap: 10px; padding: 10px 8px 0; border-top: 1px solid var(--line-soft); }
  .avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--ink-3);
    color: var(--brass-2); font-family: var(--serif); font-size: 16px; border: 1px solid var(--line); }
  .who-text { flex: 1; min-width: 0; }
  .who-name { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .small { font-size: 11.5px; }
  .icon-only { width: 30px; padding: 0; }
  .main { min-width: 0; padding: 40px 48px 80px; max-width: 1180px; width: 100%; }

  @media (max-width: 900px) {
    .shell { grid-template-columns: 1fr; }
    .rail { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 12px 16px; }
    nav { grid-auto-flow: column; overflow-x: auto; }
    .rail-foot, .capture-btn .kbd { display: none; }
    .main { padding: 24px 16px 64px; }
  }
</style>
