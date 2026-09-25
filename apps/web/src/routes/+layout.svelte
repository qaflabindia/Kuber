<script lang="ts">
  import "$lib/styles/app.css";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import Icon from "$lib/components/Icon.svelte";
  import { integrityLabel, waitingRail } from "$lib/shell";

  let { data, children } = $props();

  // No menu: the rail lists only what is waiting for the person, and disappears when nothing is.
  // When the counts could not be loaded it says so (F15), rather than showing an empty queue.
  const rail = $derived(data.shell ? waitingRail(data.shell) : { state: "items" as const, items: [] });
  const waiting = $derived(rail.state === "items" ? rail.items : []);
  const onCanvas = $derived(page.url.pathname === "/");

  const ROLE: Record<string, string> = { owner: "Owner", controller: "Controller", preparer: "Preparer", approver: "Approver", auditor: "Auditor", member: "Member" };
  const roleLabel = $derived(ROLE[data.shell?.role ?? data.session?.role ?? ""] ?? data.session?.role ?? "");

  function focusAsk() { if (onCanvas) document.getElementById("ask")?.focus(); else goto("/?ask"); }
  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && data.shell) { e.preventDefault(); focusAsk(); }
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

      <button class="capture-btn" onclick={focusAsk}>
        <Icon name="spark" size={16} />
        <span>Ask Kuber</span>
        <span class="kbd">⌘K</span>
      </button>

      {#if rail.state === "unavailable"}
        <div class="waiting" aria-label="Waiting for you">
          <div class="wl">Waiting for you</div>
          <div class="item unavailable" role="status"
            title="Kuber could not load what is waiting for you. This is not an empty queue: reload, or check that the core is running.">
            <Icon name="alert" size={16} />
            <span>Counts unavailable</span>
            <span class="count clay">?</span>
          </div>
        </div>
      {:else if waiting.length}
        <div class="waiting" aria-label="Waiting for you">
          <div class="wl">Waiting for you</div>
          {#each waiting as item (item.href + item.label)}
            <a href={item.href} class:active={page.url.pathname === item.href && item.href !== "/"}>
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
              <span class="count {item.tone}">{item.count}</span>
            </a>
          {/each}
        </div>
      {/if}

      <div class="rail-foot">
        <div class="integrity" class:ok={data.shell.intact === true} class:unknown={data.shell.intact === null}
          title={data.shell.intact === null ? "The integrity check could not run on this visit; this does not mean the ledger is intact or broken." : "Every posted journal is chained with SHA-256; this is recomputed on each visit."}>
          <Icon name="shield" size={16} />
          <span>{integrityLabel(data.shell.intact)}</span>
        </div>
      </div>
      <div class="who" aria-label="Your account" role="group">
        <div class="avatar" aria-hidden="true">{data.session?.name?.[0]?.toUpperCase()}</div>
        <div class="who-text">
          <div class="who-name"><span class="faint as">Signed in as</span> {data.session?.name}</div>
          <div class="faint small"><span class="role">{roleLabel}</span> · {data.session?.book} · {data.session?.tenant}</div>
        </div>
        {#if data.shell.canSeeMembers}
          <a class="btn quiet sm icon-only" href="/settings/members" aria-label="Members and access" title="Members and access"
            aria-current={page.url.pathname.startsWith("/settings/members") ? "page" : undefined}><Icon name="members" size={16} /></a>
        {/if}
        <form method="POST" action="/signin?/signout">
          <button class="btn quiet sm icon-only" aria-label="Sign out" title="Sign out"><Icon name="signout" size={16} /></button>
        </form>
      </div>
    </aside>

    <main class="main">
      {#if !onCanvas}<a class="back" href="/"><Icon name="arrowRight" size={14} /> Canvas</a>{/if}
      {@render children()}
    </main>
  </div>

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
  .waiting { display: grid; gap: 2px; }
  .wl { font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-3); font-weight: 600; padding: 0 12px 6px; }
  .waiting a {
    display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 12px; border-radius: var(--r-md);
    color: var(--text-2); font-weight: 500; font-size: 13.5px; transition: background 0.12s var(--ease), color 0.12s var(--ease);
  }
  .waiting a:hover, .waiting a.active { background: var(--ink-2); color: var(--text); }
  .waiting a span:nth-child(2) { flex: 1; }
  .back { display: inline-flex; gap: 6px; align-items: center; color: var(--text-3); font-size: 13px; margin-bottom: 18px; }
  .back :global(svg) { transform: rotate(180deg); }
  .back:hover { color: var(--text); }
  .count { font-size: 11.5px; font-weight: 700; min-width: 22px; height: 20px; padding: 0 7px; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center; background: var(--ink-3); color: var(--text-2); }
  .count.brass { background: var(--brass-wash); color: var(--brass-2); }
  .count.clay { background: var(--clay-wash); color: var(--clay); }
  .rail-foot { margin-top: auto; display: grid; gap: 14px; }
  .integrity { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--clay); padding: 0 8px; }
  .integrity.ok { color: var(--sage); }
  .integrity.unknown { color: var(--text-3); }
  .waiting .item { display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 12px; font-weight: 500; font-size: 13.5px; }
  .waiting .item span:nth-child(2) { flex: 1; }
  .waiting .unavailable { color: var(--clay); }
  .who { display: flex; align-items: center; gap: 10px; padding: 10px 8px 0; border-top: 1px solid var(--line-soft); }
  .avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--ink-3);
    color: var(--brass-2); font-family: var(--serif); font-size: 16px; border: 1px solid var(--line); }
  .who-text { flex: 1; min-width: 0; }
  .who-name { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .who-name .as { font-weight: 500; font-size: 11.5px; display: block; }
  .role { color: var(--brass-2); font-weight: 600; }
  .who .small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .small { font-size: 11.5px; }
  .icon-only { width: 30px; padding: 0; }
  .main { min-width: 0; padding: 40px 48px 80px; max-width: 1180px; width: 100%; }

  @media (max-width: 900px) {
    .shell { grid-template-columns: 1fr; }
    .rail { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 12px 16px; }
    .waiting { grid-auto-flow: column; overflow-x: auto; } .wl { display: none; }
    .rail-foot, .capture-btn .kbd { display: none; }
    .who { order: 10; width: 100%; padding-top: 10px; }
    .who-name .as { display: inline; }
    .main { padding: 24px 16px 64px; }
  }
</style>
