<script lang="ts">
  import { inr, NATURE_LABEL } from "$lib/format";
  import Icon from "$lib/components/Icon.svelte";

  let { data } = $props();
  let q = $state("");
  let showZero = $state(false);

  // Balances are stored debit-positive; show each account in its natural direction.
  const natural = (nature: string, bal: string) => (["asset", "expense"].includes(nature) ? BigInt(bal) : -BigInt(bal));
  const groups = $derived(["asset", "liability", "equity", "income", "expense"].map((n) => {
    const items = data.accounts.filter((a) => a.nature === n && (showZero || a.balance !== "0")
      && (!q || a.name.toLowerCase().includes(q.toLowerCase()) || a.account_id.toLowerCase().includes(q.toLowerCase())));
    return { n, items, total: items.reduce((s, a) => s + natural(a.nature, a.balance), 0n) };
  }).filter((g) => g.items.length));
</script>

<svelte:head><title>Ledger · Kuber</title></svelte:head>

<header class="top">
  <div>
    <div class="eyebrow">Ledger · book {data.book}</div>
    <h1>Accounts</h1>
    <p class="integrity" class:bad={!data.verify.intact}>
      <Icon name={data.verify.intact ? "shield" : "alert"} size={15} />
      {data.verify.intact ? "Every entry is chained and verified. Nothing has been altered." : `Chain broken at ${data.verify.firstBrokenJournal}. Entries after it cannot be trusted.`}
    </p>
  </div>
  <div class="filters">
    <input type="search" placeholder="Find an account" bind:value={q} aria-label="Find an account" />
    <label class="check"><input type="checkbox" bind:checked={showZero} /> Show empty</label>
  </div>
</header>

<div class="cols">
  {#each groups as g (g.n)}
    <section class="panel">
      <div class="panel-head"><h2>{NATURE_LABEL[g.n]}</h2><span class="num faint">{inr(g.total)}</span></div>
      <div class="panel-body">
        {#each g.items as a (a.account_id)}
          <a class="acc" href="/ledger/{encodeURIComponent(a.account_id)}">
            <span class="nm">{a.name}<span class="id faint">{a.account_id}</span></span>
            <span class="num" class:zero={a.balance === "0"}>{inr(natural(a.nature, a.balance))}</span>
          </a>
        {/each}
      </div>
    </section>
  {:else}
    <p class="muted">No accounts match.</p>
  {/each}
</div>

<style>
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
  .top h1 { margin: 8px 0; }
  .integrity { display: flex; gap: 6px; align-items: center; color: var(--sage); margin: 0; font-size: 13.5px; }
  .integrity.bad { color: var(--clay); }
  .filters { display: flex; gap: 14px; align-items: center; }
  .filters input[type="search"] { width: 240px; }
  .check { display: flex; gap: 6px; align-items: center; color: var(--text-2); font-size: 13.5px; white-space: nowrap; }
  .cols { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; align-items: start; }
  .acc { display: flex; justify-content: space-between; gap: 12px; padding: 11px 8px; margin: 0 -8px; border-radius: 8px; }
  .acc:hover { background: var(--ink-3); }
  .nm { display: flex; flex-direction: column; }
  .id { font-size: 11.5px; letter-spacing: .04em; }
  .zero { color: var(--text-3); }
</style>
