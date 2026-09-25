<script lang="ts">
  import { date, inr, NATURE_LABEL, prettyNarration } from "$lib/format";
  import Icon from "$lib/components/Icon.svelte";

  let { data } = $props();
  const debitNormal = $derived(["asset", "expense"].includes(data.account.nature));
  // Running balance in the account's natural direction.
  const rows = $derived.by(() => {
    let run = 0n;
    return data.lines.map((l) => {
      const amt = BigInt(l.amount);
      run += debitNormal ? amt : -amt;
      return { ...l, dr: amt > 0n ? amt : 0n, cr: amt < 0n ? -amt : 0n, run, p: prettyNarration(l.narration) };
    });
  });
  const totals = $derived(rows.reduce((t, r) => ({ dr: t.dr + r.dr, cr: t.cr + r.cr }), { dr: 0n, cr: 0n }));
  const by = (p: string) => (p.startsWith("agent:") ? "Kuber" : /^(owner|superuser):/.test(p) ? "You" : p.split(":")[0]);
</script>

<svelte:head><title>{data.account.name} · Ledger · Kuber</title></svelte:head>

<a class="back" href="/ledger"><Icon name="arrowRight" size={14} /> All accounts</a>
<header class="top">
  <div>
    <div class="eyebrow">{NATURE_LABEL[data.account.nature]} · {data.account.account_id}</div>
    <h1>{data.account.name}</h1>
    <p class="muted num">{data.from || data.to ? `${data.from ? date(data.from) : "Start"} – ${data.to ? date(data.to) : "today"}` : "All time"} · {rows.length} {rows.length === 1 ? "entry" : "entries"}</p>
  </div>
  <div class="bal">
    <div class="eyebrow">Balance</div>
    <div class="big num">{inr(rows.at(-1)?.run ?? 0n)}</div>
  </div>
</header>

<section class="panel">
  {#if !rows.length}
    <p class="muted pad">No entries in this account{data.from || data.to ? " for this period" : ""}.</p>
  {:else}
    <table class="table">
      <thead><tr><th>Date</th><th>Particulars</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead>
      <tbody>
        {#each rows as r (r.journal_id + r.seq + r.amount)}
          <tr>
            <td class="num nowrap faint">{date(r.txn_date)}</td>
            <td>
              <div class="t">{r.p.title}</div>
              <div class="faint small">{r.p.detail}{r.p.detail ? " · " : ""}by {by(r.principal)}{r.provisional ? " · awaiting statement" : ""}{r.reverses ? " · reversal" : ""}</div>
            </td>
            <td class="num r">{r.dr ? inr(r.dr) : ""}</td>
            <td class="num r">{r.cr ? inr(r.cr) : ""}</td>
            <td class="num r strong">{inr(r.run)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot><tr><td></td><td>Totals</td><td class="num r">{inr(totals.dr)}</td><td class="num r">{inr(totals.cr)}</td><td></td></tr></tfoot>
    </table>
  {/if}
</section>

<style>
  .back { display: inline-flex; gap: 6px; align-items: center; color: var(--text-3); font-size: 13px; margin-bottom: 14px; }
  .back :global(svg) { transform: rotate(180deg); }
  .back:hover { color: var(--text); }
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 22px; }
  .top h1 { margin: 8px 0 6px; }
  .top p { margin: 0; }
  .bal { text-align: right; }
  .big { font-family: var(--serif); font-size: 34px; }
  .pad { padding: 24px; margin: 0; }
  .r { text-align: right; }
  .nowrap { white-space: nowrap; }
  .t { font-weight: 600; }
  .small { font-size: 12.5px; }
  .strong { font-weight: 600; }
  tfoot td { font-weight: 600; border-top: 1px solid var(--line); }
</style>
