<script lang="ts">
  import { enhance } from "$app/forms";
  import PlanCard from "$lib/components/PlanCard.svelte";
  import { inr } from "$lib/format";
  let { data, form } = $props();
  const unowned = $derived(data.items?.filter(i => !i.owner).length ?? 0);
  const aged = $derived(data.items?.filter(i => i.ageDays >= 30).length ?? 0);
  const group = $derived(data.groups?.find(g => g.bookId === data.session?.book));
  const canAssign = $derived(data.shell?.canSeeMembers || ["controller", "staff", "preparer"].includes(data.session?.role ?? ""));
</script>

<svelte:head><title>CFO briefing · Kuber</title></svelte:head>
<header>
  <p class="eyebrow">Your finance briefing</p>
  <h1>Where to focus today.</h1>
  <p class="lede">Know the position. Give exceptions an owner. Test the next decision.</p>
  <div class="scope">
    <form method="POST" action="?/select">
      <label for="book">Book</label>
      <select name="book" id="book" value={data.session?.book ?? ""} disabled={!data.books}>
        {#each data.books ?? [] as b}<option value={b.book_id}>{b.book_id}</option>{/each}
      </select>
      <button class="btn quiet sm" disabled={!data.books}>Open briefing</button>
    </form>
    <span class="faint small">INR · Read at {new Date(data.refreshedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</span>
  </div>
  {#if data.books === null}<p class="warning">Book access could not be loaded. Refresh to try again.</p>{/if}
</header>

<section class="priorities" aria-label="Attention summary">
  <a class="panel focus" href="#exceptions"><span class="eyebrow">Exceptions</span><strong>{data.items === null ? "Unavailable" : `${data.items.length} open`}</strong><span>{data.items === null ? "The exception check did not complete." : `${unowned} without an owner · ${aged} aged 30+ days`}</span></a>
  <a class="panel focus" href="/review"><span class="eyebrow">Human decisions</span><strong>Review proposed entries</strong><span>Inspect classifications and supporting records before approval.</span></a>
  <a class="panel focus" href="#decisions"><span class="eyebrow">Look ahead</span><strong>Test a downside</strong><span>See the effect of changing monthly income and costs.</span></a>
</section>

{#if form?.message}<p class="notice" role="status">{form.message}</p>{/if}

<section class="section">
  <h2>1. Understand the cash position</h2>
  <p class="faint">Figures belong to the selected book. Cash and bank is the recorded balance; restrictions, committed payments and repatriation costs still need treasury review.</p>
  {#if data.position}<PlanCard plan={data.position} />{:else}<p class="warning" role="status">The cash position could not be loaded. No conclusion about liquidity is available.</p>{/if}
  <div class="links"><a href="/ledger/BANK">Trace bank movements →</a><a href="/import">Import a bank statement →</a><a href="/reports/balance-sheet">Balance sheet →</a></div>
</section>

<section class="section" id="exceptions">
  <h2>2. Put an owner on unexplained amounts</h2>
  <p class="faint">Open suspense cases, oldest first. Review the source and resolve the original item through a proposed correction.</p>
  {#if data.items === null}<p class="warning">Exceptions could not be loaded. This does not mean there are none.</p>
  {:else if !data.items.length}<p class="panel empty">No open suspense cases in this book. Bank reconciliation and other control checks remain separate.</p>
  {:else}
    <div class="cases">
      {#each data.items as item}
        <article class="panel case">
          <div class="case-head"><strong class="num">{inr(item.amount)}</strong><span class:warning={item.ageDays >= 30}>{item.ageDays} days open · {item.openedOn}</span></div>
          <p class="source">Source: {item.source}</p>
          <p class="faint small">Journal: {item.journalId}</p>
          {#if canAssign}
            <form method="POST" action="?/assign" use:enhance>
              <input type="hidden" name="item" value={item.itemId} />
              <label for={'owner-' + item.itemId}>Accountable owner</label>
              <input id={'owner-' + item.itemId} name="owner" value={item.owner ?? ""} placeholder="Name or team" required maxlength="200" />
              <button class="btn quiet sm">Save owner</button>
            </form>
          {:else}<p>Owner: {item.owner ?? "Unassigned"}</p>{/if}
          <a href="/ledger/SUSPENSE">Inspect ledger evidence →</a>
        </article>
      {/each}
    </div>
  {/if}
  <form method="POST" action="?/inspect" use:enhance><input type="hidden" name="op" value="suspense" /><button class="btn quiet">Check suspense against the ledger</button></form>
</section>

<section class="section" id="decisions">
  <h2>3. Test the next decision</h2>
  <p class="faint">A 12-month what-if using the current book and the changes below. Enter rupees per month; use a negative income change for a downside. Review the assumptions in the result.</p>
  <form method="POST" action="?/inspect" class="panel scenario" use:enhance>
    <input type="hidden" name="op" value="simulate" />
    <label>Monthly income change<input name="income" type="number" step="0.01" value="0" required /></label>
    <label>Monthly expense change<input name="expenses" type="number" step="0.01" value="0" required /></label>
    <button class="btn primary">Test scenario</button>
  </form>
</section>

<section class="section">
  <h2>4. Check the story before the board meeting</h2>
  <div class="links"><a href="/reports/profit-and-loss">Income and expenses →</a><a href="/reports/trial-balance">Trial balance →</a><a href="/confirm">Confirm automatic postings →</a></div>
  <div class="checks">
    <form method="POST" action="?/inspect" use:enhance><input type="hidden" name="op" value="balance" /><button class="btn quiet">Check book integrity and balances</button></form>
    {#if group}
      {#each [["ic_mismatches", "Investigate intercompany differences"], ["group_pnl", "Group profit and loss"], ["group_perimeter", "Review group perimeter"]] as [op, title]}
        <form method="POST" action="?/inspect" use:enhance><input type="hidden" name="op" value={op} /><button class="btn quiet">{title}</button></form>
      {/each}
    {/if}
  </div>
  <p class="faint small">{group ? `Group: ${group.name}.` : "Select a consolidation book to inspect group results and intercompany differences."} Foreign currency, covenant forecasts, tax obligations and capital project returns require additional inputs and workflows.</p>
</section>

{#if form?.plan}<section class="section result" aria-label="Decision result" aria-live="polite"><h2>Your analysis</h2><PlanCard plan={form.plan} /></section>{/if}

<style>
  h1 { font-size: 42px; margin: 6px 0 8px; } h2 { font-size: 24px; margin: 0 0 8px; }
  .lede { font-family: var(--serif); font-size: 20px; color: var(--text-2); }
  .scope, .scope form, .links, .checks { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
  .scope { justify-content:space-between; margin:22px 0; } .small { font-size:12px; }
  .priorities { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .focus { padding:18px; display:grid; gap:10px; color:var(--text-2); } .focus strong { color:var(--text); font-size:19px; }
  .focus:hover { border-color:var(--brass); } .focus span:last-child { font-size:13px; }
  .section { margin-top:36px; scroll-margin-top:20px; } .section > p { line-height:1.6; }
  .links { margin:16px 0; } a { color:var(--brass-2); }
  .cases { display:grid; gap:12px; margin-bottom:16px; } .case { padding:20px; }
  .case-head { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; } .case-head strong { font-size:23px; }
  .source, .case .small { overflow-wrap:anywhere; } .case form { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin:14px 0; }
  input, select { border:1px solid var(--line); background:var(--ink-2); color:var(--text); border-radius:6px; padding:9px; font:inherit; max-width:100%; }
  .scenario { display:flex; flex-wrap:wrap; align-items:end; gap:16px; padding:20px; } .scenario label { display:grid; gap:8px; flex:1; }
  .warning { color:var(--clay); } .notice { padding:14px; border:1px solid var(--brass); border-radius:8px; } .empty { padding:20px; }
  @media(max-width:700px) { .priorities { grid-template-columns:1fr; } h1 {font-size:34px;} }
</style>
