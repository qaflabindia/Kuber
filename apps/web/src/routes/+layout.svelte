<script lang="ts">
  import "$lib/styles/app.css";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import Icon from "$lib/components/Icon.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import { integrityLabel, isCurrent, navSections, waitingRail } from "$lib/shell";

  let { data, children } = $props();

  // Role-aware menu (lib/shell.ts navSections): sections the member can use, with what is waiting for
  // them as badges on the page that holds it. When the counts could not be loaded the rail says so (F15)
  // rather than showing no badges, which would read as an empty queue.
  const sections = $derived(data.shell ? navSections(data.shell) : []);
  const rail = $derived(data.shell ? waitingRail(data.shell) : { state: "items" as const, items: [] });
  const waitingTotal = $derived(rail.state === "items" ? rail.items.reduce((n, i) => n + i.count, 0) : 0);
  const path = $derived(page.url.pathname);
  const canAsk = $derived(!data.shell?.permissions || data.shell.permissions.includes("copilot"));
  const current = $derived(sections.flatMap((s) => s.items).find((i) => isCurrent(i, path)));

  // Role model v2 (design 6.3); legacy names label memberships not yet migrated.
  const ROLE: Record<string, string> = { superuser: "Superuser", admin: "Admin", system_owner: "System owner", controller: "Controller", treasurer: "Treasurer",
    staff: "Staff", auditor: "Auditor", customer: "Customer", supplier: "Supplier", investor: "Investor", guest: "Guest",
    owner: "Superuser", approver: "Superuser", preparer: "Staff", member: "Staff" };
  const roleLabel = $derived(ROLE[data.shell?.role ?? data.session?.role ?? ""] ?? data.session?.role ?? "");

  let paletteOpen = $state(false);
  let drawerOpen = $state(false);
  let collapsed = $state(false);

  // The collapsed rail is a per-browser convenience; storage can be unavailable (private windows).
  const KEY = "kuber.nav.collapsed";
  onMount(() => { try { collapsed = localStorage.getItem(KEY) === "1"; } catch { /* default: expanded */ } });
  function toggleCollapsed() {
    collapsed = !collapsed;
    try { localStorage.setItem(KEY, collapsed ? "1" : "0"); } catch { /* not remembered */ }
  }
  // Leaving a page closes the mobile drawer.
  $effect(() => { void path; drawerOpen = false; });

  function onKey(e: KeyboardEvent) {
    if (!data.shell) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); paletteOpen = !paletteOpen; }
    else if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); toggleCollapsed(); }
    else if (e.key === "Escape" && drawerOpen) drawerOpen = false;
  }
</script>

<svelte:window onkeydown={onKey} />
<svelte:head><title>{current && current.href !== "/" ? `${current.label} · Kuber` : "Kuber"}</title></svelte:head>

{#snippet brandMark()}
  <span class="mark" aria-hidden="true">
    <svg viewBox="0 0 64 64" width="30" height="30"><circle cx="32" cy="32" r="21" fill="none" stroke="currentColor" stroke-width="3"/><path d="M26 20v24M26 32l12-12M29 30l10 14" stroke="var(--brass-2)" stroke-width="3.2" stroke-linecap="round" fill="none"/></svg>
  </span>
{/snippet}

{#if data.shell}
  <a class="skip" href="#main">Skip to content</a>
  <div class="shell" class:collapsed>
    <header class="topbar">
      <button class="icon-btn" onclick={() => (drawerOpen = true)} aria-label="Open menu" aria-controls="nav" aria-expanded={drawerOpen}>
        <Icon name="menu" size={20} />
        {#if waitingTotal}<span class="dot" aria-hidden="true"></span>{/if}
      </button>
      <a class="brand" href="/" aria-label="Kuber home">{@render brandMark()}<span class="word">Kuber</span></a>
      <span class="crumb">{current && current.href !== "/" ? current.label : ""}</span>
      <button class="icon-btn" onclick={() => (paletteOpen = true)} aria-label="Search pages or ask Kuber"><Icon name="search" size={19} /></button>
    </header>

    {#if drawerOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="drawer-scrim" onclick={() => (drawerOpen = false)}></div>
    {/if}

    <aside class="rail" id="nav" class:open={drawerOpen} aria-label="Kuber">
      <div class="rail-head">
        <a class="brand" href="/" aria-label="Kuber home">{@render brandMark()}<span class="word">Kuber</span></a>
        <button class="icon-btn collapse" onclick={toggleCollapsed} aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          title={collapsed ? "Expand menu (⌘\\)" : "Collapse menu (⌘\\)"} aria-pressed={collapsed}><Icon name="panel" size={18} /></button>
        <button class="icon-btn close" onclick={() => (drawerOpen = false)} aria-label="Close menu"><Icon name="x" size={18} /></button>
      </div>

      <button class="capture-btn" onclick={() => (paletteOpen = true)} title="Go to a page or ask Kuber (⌘K)">
        <Icon name={canAsk ? "spark" : "search"} size={16} />
        <span class="lbl">{canAsk ? "Ask or jump to…" : "Jump to…"}</span>
        <span class="kbd">⌘K</span>
      </button>

      {#if rail.state === "unavailable"}
        <div class="unavailable" role="status"
          title="Kuber could not load what is waiting for you. This is not an empty queue: reload, or check that the core is running.">
          <Icon name="alert" size={16} /><span class="lbl">Counts unavailable</span><span class="count clay">?</span>
        </div>
      {/if}

      <nav aria-label="Main">
        {#each sections as section (section.id)}
          <div class="section">
            <div class="sl" id="sl-{section.id}">{section.label}</div>
            <ul aria-labelledby="sl-{section.id}">
              {#each section.items as item (item.href)}
                {@const on = isCurrent(item, path)}
                <li>
                  <a href={item.href} class:on aria-current={on ? "page" : undefined}
                    title={collapsed ? (item.badge ? `${item.label} · ${item.badge.count} waiting` : item.label) : undefined}>
                    <span class="ic"><Icon name={item.icon} size={17} /></span>
                    <span class="lbl">{item.label}</span>
                    {#if item.badge}
                      <span class="count {item.badge.tone}" aria-label="{item.badge.count} waiting">{item.badge.count}</span>
                    {/if}
                  </a>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </nav>

      <div class="rail-foot">
        <div class="integrity" class:ok={data.shell.intact === true} class:unknown={data.shell.intact === null}
          title={data.shell.intact === null ? "The integrity check could not run on this visit; this does not mean the ledger is intact or broken." : "Every posted journal is chained with SHA-256; this is recomputed on each visit."}>
          <Icon name="shield" size={16} />
          <span class="lbl">{integrityLabel(data.shell.intact)}</span>
        </div>
        <div class="who" aria-label="Your account" role="group">
          <div class="avatar" aria-hidden="true" title="{data.session?.name} · {roleLabel}">{data.session?.name?.[0]?.toUpperCase()}</div>
          <div class="who-text">
            <div class="who-name">{data.session?.name}</div>
            <div class="small"><span class="role">{roleLabel}</span> · {data.session?.book} · {data.session?.tenant}</div>
          </div>
          <form method="POST" action="/signin?/signout">
            <button class="icon-btn" aria-label="Sign out" title="Sign out"><Icon name="signout" size={16} /></button>
          </form>
        </div>
      </div>
    </aside>

    <main class="main" id="main" tabindex="-1">
      {@render children()}
    </main>
  </div>
  <CommandPalette {sections} {canAsk} bind:open={paletteOpen} />

{:else}
  {@render children()}
{/if}

<style>
  .shell { --rail-w: 256px; display: grid; grid-template-columns: var(--rail-w) 1fr; min-height: 100vh; transition: grid-template-columns .2s var(--ease); }
  .shell.collapsed { --rail-w: 72px; }
  .skip { position: absolute; left: -9999px; top: 8px; z-index: 80; padding: 8px 14px; border-radius: var(--r-md); background: var(--brass); color: var(--brass-ink); font-weight: 600; }
  .skip:focus { left: 8px; }
  .topbar { display: none; }

  .rail {
    position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 14px; min-width: 0;
    padding: 18px 12px 14px; border-right: 1px solid var(--line-soft); overflow: hidden;
    background: linear-gradient(180deg, #0e1219 0%, var(--ink-0) 60%);
  }
  .rail-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 40px; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 4px 6px; color: var(--brass); min-width: 0; }
  .mark { display: inline-flex; flex: none; }
  .word { font-family: var(--serif); font-size: 25px; color: var(--text); letter-spacing: 0.01em; font-variation-settings: "opsz" 48; }
  .icon-btn { position: relative; display: inline-grid; place-items: center; width: 34px; height: 34px; flex: none; border-radius: 9px; border: 0;
    background: none; color: var(--text-3); cursor: pointer; transition: background .12s var(--ease), color .12s var(--ease); }
  .icon-btn:hover { background: var(--ink-2); color: var(--text); }
  .icon-btn.close { display: none; }

  .capture-btn {
    display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; padding: 0 12px; flex: none;
    border-radius: var(--r-md); border: 1px solid rgba(201, 168, 106, 0.32); background: var(--brass-wash);
    color: var(--brass-2); font: 600 13.5px var(--sans); cursor: pointer; transition: background 0.15s var(--ease), border-color .15s var(--ease);
  }
  .capture-btn:hover { background: rgba(201, 168, 106, 0.16); border-color: rgba(201, 168, 106, 0.5); }
  .capture-btn .lbl { flex: 1; text-align: left; white-space: nowrap; }
  .kbd { font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 5px; border: 1px solid rgba(201,168,106,.3); color: var(--brass); }

  .unavailable { display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 12px; border-radius: var(--r-md);
    background: var(--clay-wash); color: var(--clay); font-weight: 600; font-size: 13px; }
  .unavailable .lbl { flex: 1; }

  nav { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; margin: 0 -4px; padding: 0 4px; scrollbar-width: thin; }
  .section + .section { margin-top: 12px; }
  .sl { font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-3); font-weight: 600; padding: 0 12px 4px; white-space: nowrap; }
  nav ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
  nav a {
    position: relative; display: flex; align-items: center; gap: 11px; height: 34px; padding: 0 10px 0 12px; border-radius: var(--r-md);
    color: var(--text-2); font-weight: 500; font-size: 13.5px; white-space: nowrap;
    transition: background 0.12s var(--ease), color 0.12s var(--ease);
  }
  nav a:hover { background: var(--ink-2); color: var(--text); }
  nav a.on { background: var(--ink-2); color: var(--text); }
  nav a.on::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--brass); }
  nav a.on .ic { color: var(--brass-2); }
  .ic { display: inline-flex; flex: none; color: var(--text-3); transition: color .12s var(--ease); }
  nav a:hover .ic { color: var(--text-2); }
  nav a .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; }

  .count { font-size: 11px; font-weight: 700; min-width: 22px; height: 20px; padding: 0 7px; border-radius: 999px; flex: none;
    display: inline-flex; align-items: center; justify-content: center; background: var(--ink-3); color: var(--text-2); }
  .count.brass { background: var(--brass-wash); color: var(--brass-2); }
  .count.clay { background: var(--clay-wash); color: var(--clay); }

  .rail-foot { display: grid; gap: 12px; flex: none; }
  .integrity { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--clay); padding: 0 12px; white-space: nowrap; }
  .integrity.ok { color: var(--sage); }
  .integrity.unknown { color: var(--text-3); }
  .who { display: flex; align-items: center; gap: 10px; padding: 12px 4px 0 6px; border-top: 1px solid var(--line-soft); }
  .avatar { width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--ink-3);
    color: var(--brass-2); font-family: var(--serif); font-size: 16px; border: 1px solid var(--line); }
  .who-text { flex: 1; min-width: 0; }
  .who-name { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .role { color: var(--brass-2); font-weight: 600; }
  .small { font-size: 11.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .main { min-width: 0; padding: 40px 48px 80px; max-width: 1180px; width: 100%; }
  .main:focus { outline: none; }

  /* Collapsed desktop rail: icons only, labels as tooltips, badges as a corner count. */
  @media (min-width: 901px) {
    .collapsed .word, .collapsed .lbl, .collapsed .kbd, .collapsed .sl, .collapsed .who-text, .collapsed .who form { display: none; }
    .collapsed .rail-head { flex-direction: column; gap: 8px; }
    .collapsed .brand { padding: 4px 0; }
    .collapsed .capture-btn, .collapsed .unavailable { justify-content: center; padding: 0; }
    .collapsed .section + .section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
    .collapsed nav a { justify-content: center; padding: 0; }
    .collapsed nav a .count { position: absolute; top: 2px; right: 4px; min-width: 16px; height: 16px; padding: 0 4px; font-size: 9.5px; }
    .collapsed .unavailable .count { display: none; }
    .collapsed .integrity { justify-content: center; padding: 0; }
    .collapsed .who { justify-content: center; padding: 12px 0 0; }
  }

  /* Mobile: top bar and a slide-in drawer. */
  @media (max-width: 900px) {
    .shell, .shell.collapsed { grid-template-columns: 1fr; }
    .topbar { position: sticky; top: 0; z-index: 40; display: flex; align-items: center; gap: 8px; height: 56px; padding: 0 10px;
      background: rgba(11, 14, 19, 0.88); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line-soft); }
    .topbar .brand .word { font-size: 21px; }
    .topbar .crumb { flex: 1; min-width: 0; color: var(--text-3); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .topbar .crumb:not(:empty)::before { content: "/"; margin-right: 8px; color: var(--line); }
    .dot { position: absolute; top: 7px; right: 7px; width: 8px; height: 8px; border-radius: 50%; background: var(--brass); box-shadow: 0 0 0 2px var(--ink-0); }
    .rail { position: fixed; z-index: 50; left: 0; top: 0; bottom: 0; height: auto; width: min(300px, 86vw);
      transform: translateX(-102%); transition: transform .22s var(--ease); box-shadow: 20px 0 60px rgba(0,0,0,.5); background: var(--ink-0); }
    .rail.open { transform: none; }
    .rail-head .collapse { display: none; }
    .icon-btn.close { display: inline-grid; }
    .kbd { display: none; }
    .drawer-scrim { position: fixed; inset: 0; z-index: 45; background: rgba(6, 8, 12, 0.6); }
    .main { padding: 24px 16px 64px; }
  }
  @media (prefers-reduced-motion: reduce) { .shell, .rail { transition: none; } }
</style>
