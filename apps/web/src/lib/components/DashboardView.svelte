<script lang="ts">
  import { inr, inrShort } from "$lib/format";
  import TrendChart from "./TrendChart.svelte";
  import Icon from "./Icon.svelte";

  type Data = {
    kpis: { cash: string; netWorth: string; income: string; expenses: string; surplus: string; avgMonthlySpend: string; runwayMonths: number | null; fy: string };
    trend: { month: string; income: string; expenses: string }[];
    top: { accountId: string; name: string; amount: string }[];
    attention: { drafts: number; ratifications: number; suspense: string };
  };
  let { data }: { data: Data } = $props();
  const k = $derived(data.kpis);
  const topMax = $derived(data.top.reduce((m, t) => (BigInt(t.amount) > m ? BigInt(t.amount) : m), 1n));
  const neg = (v: string) => v.startsWith("-");
</script>

<div class="dash">
  <div class="tiles">
    <div class="tile"><div class="eyebrow">Cash and bank</div><div class="big num">{inrShort(k.cash)}</div><div class="faint small num">{inr(k.cash)}</div></div>
    <div class="tile"><div class="eyebrow">Net worth</div><div class="big num" class:neg={neg(k.netWorth)}>{inrShort(k.netWorth)}</div><div class="faint small">Own less owe</div></div>
    <div class="tile"><div class="eyebrow">Surplus · {k.fy}</div><div class="big num" class:neg={neg(k.surplus)}>{inrShort(k.surplus)}</div>
      <div class="faint small num">In {inrShort(k.income)} · Out {inrShort(k.expenses)}</div></div>
    <div class="tile"><div class="eyebrow">Runway</div>
      <div class="big num">{k.runwayMonths === null ? "—" : `${k.runwayMonths} mo`}</div>
      <div class="faint small num">{BigInt(k.avgMonthlySpend) > 0n ? `at ${inrShort(k.avgMonthlySpend)}/month spend` : "No spending yet"}</div></div>
  </div>

  <div class="lower">
    <div class="pane"><div class="st">Income and expenses by month</div><TrendChart trend={data.trend} /></div>
    <div class="pane">
      <div class="st">Largest spending · {k.fy}</div>
      {#if data.top.length}
        <ul class="top">
          {#each data.top as t}
            <li><a href="/ledger/{t.accountId}"><span>{t.name}</span><span class="num">{inr(t.amount, { decimals: false })}</span></a>
              <div class="track"><div class="fill" style="width: {Number((BigInt(t.amount) * 1000n) / topMax) / 10}%"></div></div></li>
          {/each}
        </ul>
      {:else}<p class="faint small">No spending recorded this year.</p>{/if}

      {#if data.attention.drafts || data.attention.ratifications || data.attention.suspense !== "0"}
        <div class="st att">Needs attention</div>
        <div class="attn">
          {#if data.attention.drafts}<a href="/review"><Icon name="review" size={15} />{data.attention.drafts} {data.attention.drafts === 1 ? "entry" : "entries"} to review</a>{/if}
          {#if data.attention.ratifications}<a href="/confirm"><Icon name="confirm" size={15} />{data.attention.ratifications} automatic {data.attention.ratifications === 1 ? "posting" : "postings"} to confirm</a>{/if}
          {#if data.attention.suspense !== "0"}<a href="/ledger/SUSPENSE"><Icon name="alert" size={15} />{inr(data.attention.suspense)} unclassified</a>{/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .dash { display: grid; gap: 18px; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .tile { background: var(--ink-2); border: 1px solid var(--line-soft); border-radius: 12px; padding: 14px 16px; display: grid; gap: 4px; }
  .big { font-family: var(--serif); font-size: 30px; line-height: 1.1; }
  .neg { color: var(--clay); }
  .small { font-size: 12px; }
  .lower { display: grid; grid-template-columns: 1.5fr 1fr; gap: 18px; }
  .pane { display: grid; gap: 8px; align-content: start; min-width: 0; }
  .st { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-3); font-weight: 600; }
  .st.att { margin-top: 8px; }
  .top { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .top a { display: flex; justify-content: space-between; font-size: 13.5px; margin-bottom: 4px; }
  .top a:hover span:first-child { color: var(--brass-2); }
  .track { height: 4px; background: var(--ink-3); border-radius: 2px; }
  .fill { height: 4px; background: var(--brass); border-radius: 2px; }
  .attn { display: grid; gap: 6px; }
  .attn a { display: flex; gap: 8px; align-items: center; color: var(--clay); font-size: 13.5px; }
  .attn a:hover { text-decoration: underline; text-underline-offset: 3px; }
  @media (max-width: 1100px) { .tiles { grid-template-columns: repeat(2, 1fr); } .lower { grid-template-columns: 1fr; } }
</style>
