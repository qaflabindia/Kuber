<script lang="ts">
  import { inr, inrShort } from "$lib/format";

  let { trend }: { trend: { month: string; income: string; expenses: string }[] } = $props();

  const W = 560, H = 190, PAD = { l: 52, r: 12, t: 22, b: 26 };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const label = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

  let hover = $state<number | null>(null);
  let asTable = $state(false);

  const rows = $derived(trend.map((t) => ({ m: t.month, inc: Number(BigInt(t.income) / 100n), exp: Number(BigInt(t.expenses) / 100n), raw: t })));
  const empty = $derived(rows.every((r) => r.inc === 0 && r.exp === 0));
  const max = $derived(Math.max(1, ...rows.flatMap((r) => [r.inc, r.exp])));
  // "Nice" top of scale: 1, 2 or 5 times a power of ten.
  const top = $derived.by(() => { const p = 10 ** Math.floor(Math.log10(max)); return [1, 2, 5, 10].map((k) => k * p).find((v) => v >= max)!; });
  const ticks = $derived([0, top / 2, top]);
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const band = $derived(plotW / Math.max(1, rows.length));
  const barW = $derived(Math.min(22, (band - 18) / 2));
  const y = (v: number) => PAD.t + plotH - (v / top) * plotH;
  const x0 = (i: number) => PAD.l + i * band + band / 2 - barW - 1;       // 2px gap between the pair

  /** Bar with 4px rounded data-end, square at the baseline. */
  function bar(x: number, v: number) {
    const h = Math.max(0, (v / top) * plotH), r = Math.min(4, h, barW / 2), b = PAD.t + plotH;
    if (h === 0) return "";
    return `M${x},${b} V${b - h + r} Q${x},${b - h} ${x + r},${b - h} H${x + barW - r} Q${x + barW},${b - h} ${x + barW},${b - h + r} V${b} Z`;
  }
</script>

<div class="chart">
  <div class="head">
    <div class="legend" aria-hidden={asTable}>
      <span><i style="background: var(--series-in)"></i>Income</span>
      <span><i style="background: var(--series-out)"></i>Expenses</span>
    </div>
    <button type="button" class="linkish" onclick={() => (asTable = !asTable)}>{asTable ? "Show chart" : "Show as table"}</button>
  </div>

  {#if empty}
    <p class="faint none">No income or expenses recorded in this window yet.</p>
  {:else if asTable}
    <table class="table compact">
      <thead><tr><th>Month</th><th class="r">Income</th><th class="r">Expenses</th></tr></thead>
      <tbody>{#each rows as r}<tr><td>{label(r.m)}</td><td class="r num">{inr(r.raw.income)}</td><td class="r num">{inr(r.raw.expenses)}</td></tr>{/each}</tbody>
    </table>
  {:else}
    <svg viewBox="0 0 {W} {H}" role="img" aria-label="Income and expenses by month">
      {#each ticks as t}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} class="grid" class:base={t === 0} />
        <text x={PAD.l - 8} y={y(t) + 4} class="tick" text-anchor="end">{inrShort(BigInt(Math.round(t)) * 100n)}</text>
      {/each}
      {#each rows as r, i}
        <g>
          <path d={bar(x0(i), r.inc)} fill="var(--series-in)" opacity={hover === null || hover === i ? 1 : 0.35} />
          <path d={bar(x0(i) + barW + 2, r.exp)} fill="var(--series-out)" opacity={hover === null || hover === i ? 1 : 0.35} />
          <text x={PAD.l + i * band + band / 2} y={H - 8} class="tick" text-anchor="middle">{label(r.m)}</text>
          {#if i === rows.length - 1 && hover === null}
            <text x={x0(i) + barW / 2} y={y(r.inc) - 6} class="val" text-anchor="middle">{inrShort(r.raw.income)}</text>
            <text x={x0(i) + barW * 1.5 + 2} y={y(r.exp) - 6} class="val" text-anchor="middle">{inrShort(r.raw.expenses)}</text>
          {/if}
          <!-- hit target: the whole month column, larger than the marks -->
          <rect x={PAD.l + i * band} y={PAD.t} width={band} height={plotH} fill="transparent"
            role="presentation" onpointerenter={() => (hover = i)} onpointerleave={() => (hover = null)} />
        </g>
      {/each}
    </svg>
    {#if hover !== null}
      {@const r = rows[hover]!}
      <div class="tip" style="left: {((PAD.l + hover * band + band / 2) / W) * 100}%">
        <strong>{label(r.m)}</strong>
        <span><i style="background: var(--series-in)"></i>Income <b class="num">{inr(r.raw.income)}</b></span>
        <span><i style="background: var(--series-out)"></i>Expenses <b class="num">{inr(r.raw.expenses)}</b></span>
        <span class="faint">Net <b class="num">{inr(BigInt(r.raw.income) - BigInt(r.raw.expenses))}</b></span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .chart { position: relative; }
  .none { font-size: 13px; margin: 18px 0; }
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .legend { display: flex; gap: 14px; font-size: 12.5px; color: var(--text-2); }
  .legend span, .tip span { display: inline-flex; align-items: center; gap: 6px; }
  i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .linkish { background: none; border: 0; color: var(--text-3); font-size: 12px; cursor: pointer; padding: 0; }
  .linkish:hover { color: var(--text); }
  svg { width: 100%; height: auto; display: block; }
  .grid { stroke: var(--line-soft); stroke-width: 1; }
  .grid.base { stroke: var(--line); }
  .tick { fill: var(--text-3); font-size: 10.5px; font-family: var(--sans); }
  .val { fill: var(--text-2); font-size: 10.5px; font-weight: 600; font-family: var(--sans); }
  .tip { position: absolute; top: 20px; transform: translateX(-50%); background: var(--ink-3); border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 12px; display: grid; gap: 4px; font-size: 12.5px; pointer-events: none; white-space: nowrap; box-shadow: 0 8px 24px rgba(0,0,0,.35); z-index: 2; }
  .tip b { font-weight: 600; margin-left: auto; padding-left: 12px; }
  .compact td, .compact th { padding: 8px 10px; }
  .r { text-align: right; }
</style>
