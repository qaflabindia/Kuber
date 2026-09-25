<script lang="ts">
  import { date } from "$lib/format";

  let { data } = $props();
  const KIND: Record<string, string> = { "balance-sheet": "Balance sheet", "profit-and-loss": "Profit and loss", "trial-balance": "Trial balance" };
</script>

<svelte:head><title>Reports · Kuber</title></svelte:head>

<main class="investor">
  <header class="top">
    <div class="eyebrow">{data.kind === "investor" ? "Investor reports" : "Shared with you"}</div>
    <h1>{data.kind === "investor" ? "Certified reports" : "Shared items"}</h1>
    <p class="muted">{data.kind === "investor" ? "Snapshots certified from the ledger and published to investors. Each carries a content hash that reproduces from the books." : "Available until each share expires."}</p>
  </header>
  <section class="panel">
    <div class="panel-body list">
      {#if data.kind === "investor"}
        {#if data.snapshots.length}
          <table class="table">
            <thead><tr><th>Report</th><th>Book</th><th>Certified</th><th>Content hash</th></tr></thead>
            <tbody>{#each data.snapshots as s}<tr><td>{KIND[s.kind] ?? s.kind}</td><td>{s.bookId}</td><td>{date(s.takenAt.slice(0, 10))}</td><td class="mono faint">{s.contentHash.slice(0, 12)}…</td></tr>{/each}</tbody>
          </table>
        {:else}<p class="muted">Nothing has been published yet.</p>{/if}
      {:else}
        {#if data.shares.length}
          <table class="table">
            <thead><tr><th>Item</th><th>Until</th></tr></thead>
            <tbody>{#each data.shares as s}<tr><td>{s.itemType === "report" ? `Report ${s.itemId}` : `Snapshot ${s.itemId.slice(0, 8)}`}</td><td>{date(s.expiresAt.slice(0, 10))}</td></tr>{/each}</tbody>
          </table>
        {:else}<p class="muted">Nothing is shared with you right now.</p>{/if}
      {/if}
    </div>
  </section>
</main>

<style>
  .investor { max-width: 880px; margin: 0 auto; padding: 40px 16px; display: grid; gap: 20px; }
  .top h1 { margin: 8px 0; }
  .top p { margin: 0; max-width: 64ch; }
  .list { padding-top: 20px; }
  .table { display: block; overflow-x: auto; }
</style>
