<script lang="ts">
  import { goto } from "$app/navigation";
  import { date, inr } from "$lib/format";
  import Icon from "$lib/components/Icon.svelte";

  let { data } = $props();

  const SECTION: Record<string, string> = { income: "Income", expense: "Expenses", asset: "What you own", liability: "What you owe", equity: "Equity", Dr: "Debit balances", Cr: "Credit balances" };
  const clean = (l: string) => l.replace(/^(Income|Expense|Asset|Liability|Equity): /, "").replace(/^[A-Z_0-9]+\s{2}(.*?)\s{2}\((Dr|Cr)\)$/, "$1");

  const groups = $derived.by(() => {
    const out: { key: string; label: string; rows: typeof data.statement.rows; total: bigint }[] = [];
    for (const r of data.statement.rows) {
      const key = r.section ?? "_";
      let g = out.find((x) => x.key === key);
      if (!g) out.push((g = { key, label: SECTION[key] ?? "", rows: [], total: 0n }));
      g.rows.push(r); g.total += BigInt(r.amount);
    }
    return out;
  });
  const check = $derived(Object.entries(data.statement.totals).find(([k]) => k.includes("must be 0")));
  const totals = $derived(Object.entries(data.statement.totals).filter(([k]) => !k.includes("must be 0")));
  const drillQ = $derived(data.meta.period === "range" ? `?from=${data.from}&to=${data.to}` : `?to=${data.to}`);

  let from = $state(""), to = $state("");
  $effect(() => { from = data.from; to = data.to; });
  function apply(e: SubmitEvent) {
    e.preventDefault();
    goto(`/reports/${data.kind}?${data.meta.period === "range" ? `from=${from}&` : ""}to=${to}`, { keepFocus: true, noScroll: true });
  }
</script>

<svelte:head><title>{data.meta.short} · Kuber</title></svelte:head>

<header class="top">
  <div>
    <div class="eyebrow">Reports</div>
    <h1>{data.meta.title}</h1>
    <p class="muted num">{data.meta.period === "range" ? `${date(data.from)} – ${date(data.to)}` : `As of ${date(data.to)}`}</p>
  </div>
  <form class="period" onsubmit={apply}>
    {#if data.meta.period === "range"}
      <div class="field"><label for="from">From</label><input id="from" type="date" bind:value={from} /></div>
    {/if}
    <div class="field"><label for="to">{data.meta.period === "range" ? "To" : "As of"}</label><input id="to" type="date" bind:value={to} /></div>
    <button class="btn">Update</button>
  </form>
</header>

<nav class="tabs" aria-label="Reports">
  {#each data.kinds as k}
    <a href="/reports/{k.kind}" class:active={k.kind === data.kind} aria-current={k.kind === data.kind ? "page" : undefined}>{k.label}</a>
  {/each}
</nav>

{#if check}
  <div class="check" class:bad={check[1] !== "0"} role="status">
    <Icon name={check[1] === "0" ? "shield" : "alert"} size={16} />
    {check[1] === "0" ? "Balanced. Every debit has a matching credit." : `Out of balance by ${inr(check[1])}. This should never happen; please report it.`}
  </div>
{/if}

<section class="panel sheet">
  {#if !data.statement.rows.length}
    <p class="muted empty">Nothing recorded in this period.</p>
  {/if}
  {#each groups as g (g.key)}
    <div class="group">
      {#if g.label}<h2 class="gh">{g.label}</h2>{/if}
      {#each g.rows as r}
        {#if r.accountId}
          <a class="line" href="/ledger/{encodeURIComponent(r.accountId)}{drillQ}">
            <span>{clean(r.label)}</span><span class="num">{inr(r.amount)}</span><Icon name="arrowRight" size={14} />
          </a>
        {:else}
          <div class="line static"><span>{clean(r.label)}</span><span class="num">{inr(r.amount)}</span><span></span></div>
        {/if}
      {/each}
      {#if g.label && g.rows.length > 1 && data.kind !== "statement-of-affairs"}
        <div class="line sub"><span>Total {g.label.toLowerCase()}</span><span class="num">{inr(g.total)}</span><span></span></div>
      {/if}
    </div>
  {/each}
  {#if totals.length}
    <div class="totals">
      {#each totals as [k, v], i}
        <div class="line tot" class:final={i === totals.length - 1}>
          <span>{k}</span><span class="num" class:neg={v.startsWith("-")}>{inr(v)}</span><span></span>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 22px; flex-wrap: wrap; }
  .top h1 { margin: 8px 0 6px; }
  .top p { margin: 0; }
  .period { display: flex; gap: 10px; align-items: flex-end; }
  .period .field { width: 160px; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 18px; overflow-x: auto; }
  .tabs a { padding: 10px 14px; color: var(--text-3); font-weight: 600; font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
  .tabs a:hover { color: var(--text); }
  .tabs a.active { color: var(--brass-2); border-bottom-color: var(--brass); }
  .check { display: flex; gap: 8px; align-items: center; color: var(--sage); font-size: 13.5px; margin-bottom: 14px; }
  .check.bad { color: var(--clay); }
  .sheet { padding: 8px 28px 20px; max-width: 880px; }
  .empty { padding: 20px 0; margin: 0; }
  .group { padding: 14px 0 6px; border-bottom: 1px solid var(--line); }
  .gh { font-size: 13px; font-family: var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); margin: 6px 0 6px; font-weight: 600; }
  .line { display: grid; grid-template-columns: 1fr auto 20px; gap: 12px; align-items: center; padding: 9px 8px; margin: 0 -8px; border-radius: 8px; }
  a.line:hover { background: var(--ink-3); }
  a.line :global(svg) { color: var(--text-3); opacity: 0; transition: opacity .15s; }
  a.line:hover :global(svg) { opacity: 1; }
  .line .num { text-align: right; }
  .sub { color: var(--text-2); font-weight: 600; border-top: 1px dashed var(--line); margin-top: 4px; }
  .totals { padding-top: 12px; }
  .tot { font-weight: 600; }
  .tot.final { font-family: var(--serif); font-size: 22px; font-weight: 500; border-top: 1px solid var(--line); margin-top: 6px; padding-top: 14px; }
  .neg { color: var(--clay); }
</style>
