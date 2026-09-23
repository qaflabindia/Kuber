<script lang="ts">
  import { enhance } from "$app/forms";
  import { date, inr, inrShort, levelLabel } from "$lib/format";
  import EntryRow from "$lib/components/EntryRow.svelte";
  import Icon from "$lib/components/Icon.svelte";

  let { data } = $props();

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = $derived(data.session?.name?.split(" ")[0] ?? "");

  const headline = $derived.by(() => {
    const n = data.draftTotal, c = data.ratifications;
    const parts: string[] = [];
    if (n) parts.push(`${n} ${n === 1 ? "entry needs" : "entries need"} you`);
    if (c) parts.push(`${c} automatic ${c === 1 ? "posting" : "postings"} to confirm`);
    if (!parts.length) return "Everything is recorded. Nothing needs you right now.";
    return parts.join(", and ") + ".";
  });

  function journalView(j: (typeof data.journals)[number]) {
    const cash = j.lines.find((l) => ["BANK", "CASH", "CARD"].includes(l.accountId));
    const other = j.lines.find((l) => l !== cash) ?? j.lines[0]!;
    const amt = BigInt((cash ?? other).amount);
    return { direction: amt >= 0n ? "in" as const : "out" as const, amount: (amt < 0n ? -amt : amt).toString(),
      account: data.accountNames[other.accountId] ?? other.accountId };
  }
</script>

<svelte:head><title>Today · Kuber</title></svelte:head>

<header class="hero">
  <div class="eyebrow">{date(new Date().toISOString())}</div>
  <h1>{greeting}, {first}.</h1>
  <p class="headline">{headline}</p>
</header>

<section class="figures">
  <div class="fig panel">
    <div class="eyebrow">Cash and bank</div>
    <div class="big num">{inrShort(data.figures.cash)}</div>
    <div class="faint small num">{inr(data.figures.cash)}</div>
  </div>
  <div class="fig panel">
    <div class="eyebrow">Net worth</div>
    <div class="big num" class:neg={data.figures.netWorth.startsWith("-")}>{inrShort(data.figures.netWorth)}</div>
    <div class="faint small">Everything you own, less everything you owe</div>
  </div>
  <div class="fig panel">
    <div class="eyebrow">Surplus this financial year</div>
    <div class="big num" class:pos={!data.figures.surplus.startsWith("-") && data.figures.surplus !== "0"}>{inrShort(data.figures.surplus)}</div>
    <div class="faint small num">In {inrShort(data.figures.income)} · Out {inrShort(data.figures.expenses)}</div>
  </div>
</section>

<div class="cols">
  <section class="panel">
    <div class="panel-head">
      <h2>Needs you</h2>
      {#if data.draftTotal > data.drafts.length}<a class="link" href="/review">All {data.draftTotal} <Icon name="arrowRight" size={14} /></a>{/if}
    </div>
    <div class="panel-body">
      {#if data.drafts.length === 0}
        <div class="empty">
          <Icon name="check" size={22} />
          <p>Nothing waiting. When Kuber isn't sure about an entry, it will ask here.</p>
        </div>
      {:else}
        {#each data.drafts as d (d.draft_id)}
          <EntryRow date={d.proposal.txnDate} narration={d.proposal.narration} amount={d.proposal.amount} direction={d.proposal.direction}
            sub={`${data.accountNames[d.proposal.accountId] ?? d.proposal.accountId} · ${levelLabel(d.decision.level)}`}>
            {#snippet actions()}
              {#if d.proposal.accountId !== "SUSPENSE"}
                <form method="POST" action="?/approve" use:enhance>
                  <input type="hidden" name="id" value={d.draft_id} />
                  <button class="btn sm" title="Approve as suggested">Approve</button>
                </form>
              {/if}
              <a class="btn sm quiet" href="/review#{d.draft_id}">Open</a>
            {/snippet}
          </EntryRow>
        {/each}
      {/if}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Recently recorded</h2>
      {#if data.journals.length}<a class="link" href="/ledger">Ledger <Icon name="arrowRight" size={14} /></a>{/if}
    </div>
    <div class="panel-body">
      {#if data.journals.length === 0}
        <div class="empty">
          <Icon name="upload" size={22} />
          <p>No entries yet. <a href="/import" class="u">Import a bank statement</a> or press <span class="kbd">⌘K</span> to tell Kuber about a payment.</p>
        </div>
      {:else}
        {#each data.journals as j (j.journal_id)}
          {@const v = journalView(j)}
          <EntryRow date={j.txn_date} narration={j.narration} amount={v.amount} direction={v.direction}
            sub={`${v.account}${j.provisional ? " · awaiting statement" : ""}${j.reverses ? " · reversal" : ""}${j.principal.startsWith("agent:") ? " · by Kuber" : ""}`} />
        {/each}
      {/if}
    </div>
  </section>
</div>

<style>
  .hero { margin-bottom: 32px; }
  .hero h1 { margin: 10px 0 8px; font-size: 44px; }
  .headline { font-family: var(--serif); font-size: 21px; color: var(--text-2); margin: 0; font-variation-settings: "opsz" 24; }
  .figures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
  .fig { padding: 20px 22px; display: grid; gap: 6px; }
  .big { font-family: var(--serif); font-size: 38px; line-height: 1.1; font-variation-settings: "opsz" 60; }
  .big.pos { color: var(--sage); }
  .big.neg { color: var(--clay); }
  .small { font-size: 12.5px; }
  .cols { display: grid; grid-template-columns: 1.1fr 1fr; gap: 16px; align-items: start; }
  .link { display: inline-flex; align-items: center; gap: 4px; color: var(--brass-2); font-size: 13px; font-weight: 600; }
  .empty { display: flex; gap: 12px; align-items: flex-start; color: var(--text-2); padding: 8px 0 4px; }
  .empty :global(svg) { color: var(--brass); flex: none; margin-top: 2px; }
  .empty p { margin: 0; }
  .u { color: var(--brass-2); text-decoration: underline; text-underline-offset: 3px; }
  @media (max-width: 1080px) { .cols { grid-template-columns: 1fr; } }
  @media (max-width: 760px) { .figures { grid-template-columns: 1fr; } }
</style>
