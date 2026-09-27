<script lang="ts">
  import { goto } from "$app/navigation";
  import { date, inr } from "$lib/format";
  import Icon from "$lib/components/Icon.svelte";

  let { data } = $props();

  const TABS = [["balanceSheet", "Balance sheet"], ["profitAndLoss", "Profit and loss"], ["cashFlow", "Cash flow"], ["equity", "Changes in equity"], ["notes", "Notes"]] as const;
  type Tab = (typeof TABS)[number][0];
  const tab = $derived((TABS.some(([k]) => k === data.tab) ? data.tab : "balanceSheet") as Tab);
  const st = $derived(data.bundle.statements[tab]);
  const period = $derived(data.bundle.periods[0]!);
  const STATUS = { certified: "Certified", preliminary: "Preliminary", unavailable: "Unavailable" } as const;

  // Rows grouped by section, in order.
  const sections = $derived.by(() => {
    const out: { name: string; rows: typeof st.rows }[] = [];
    for (const r of st.rows) {
      const name = r.section ?? (r.group ?? "");
      let s = out.at(-1);
      if (!s || s.name !== name) out.push((s = { name, rows: [] }));
      s.rows.push(r);
    }
    return out;
  });
  const failedChecks = $derived(st.checks.filter((c) => !c.ok));

  const kpis = $derived("error" in data.kpis ? null : data.kpis);
  const kpiError = $derived("error" in data.kpis ? data.kpis.error : null);
  const fmt = (unit: string, v: string | null) => v === null ? "—" : unit === "percent" ? `${v}%` : unit === "days" ? `${v} days` : unit === "months" ? `${v} mo` : unit === "paise" ? inr(v, { decimals: false }) : `${v}×`;
  /** Display-only magnitude for the comparison bars (figures themselves are exact strings). */
  const mag = (unit: string, v: string | null) => v === null ? null : Math.abs(unit === "paise" ? Number(BigInt(v) / 100n) : Number(v));
  function bars(unit: string, a: string | null, b: string | null) {
    const x = mag(unit, a), y = mag(unit, b), m = Math.max(x ?? 0, y ?? 0) || 1;
    return { cur: x === null ? null : (x / m) * 100, cmp: y === null ? null : (y / m) * 100 };
  }

  let from = $state(""), to = $state("");
  $effect(() => { from = period.from; to = period.to; });
  const qs = (extra: Record<string, string> = {}) => new URLSearchParams({ from, to, ...extra }).toString();
  function apply(e: SubmitEvent) { e.preventDefault(); goto(`/statements?${qs({ tab })}`, { keepFocus: true, noScroll: true }); }
</script>

<svelte:head><title>Statements · Kuber</title></svelte:head>

<header class="top">
  <div>
    <div class="eyebrow">Statements · {data.bundle.book.framework}</div>
    <h1>Financial statements</h1>
    <p class="muted num">{date(period.from)} – {date(period.to)}{#if data.bundle.periods[1]} · compared with {date(data.bundle.periods[1].from)} – {date(data.bundle.periods[1].to)}{/if}</p>
  </div>
  <form class="period" onsubmit={apply}>
    <div class="field"><label for="from">From</label><input id="from" type="date" bind:value={from} /></div>
    <div class="field"><label for="to">To</label><input id="to" type="date" bind:value={to} /></div>
    <button class="btn">Update</button>
  </form>
</header>

{#if data.bundle.mapping}
  <p class="mapping" class:illustrative={data.bundle.mapping.status !== "approved"}>
    <Icon name={data.bundle.mapping.status === "approved" ? "shield" : "alert"} size={14} />
    Mapping {data.bundle.mapping.label}
  </p>
{/if}

<nav class="tabs" aria-label="Statements">
  {#each TABS as [k, label]}
    <a href="/statements?{qs({ tab: k })}" class:active={k === tab} aria-current={k === tab ? "page" : undefined}>
      {label} <span class="dot {data.bundle.statements[k].status}" aria-hidden="true"></span>
    </a>
  {/each}
</nav>

<section class="panel sheet">
  <div class="head">
    <h2>{st.title}</h2>
    <div class="exports">
      <a class="btn quiet sm" href="/statements/export?{qs({ format: 'csv' })}">CSV</a>
      <a class="btn quiet sm" href="/statements/export?{qs({ format: 'json' })}">JSON</a>
    </div>
  </div>

  <div class="cols">
    {#each st.columns as c}
      <div class="colhead">
        <span class="badge {c.status}">{STATUS[c.status]}</span>
        <span class="muted num">{c.key === "current" ? "Current" : "Comparative"} · {date(c.from)} – {date(c.to)}</span>
        {#if c.reasons.length}<ul class="reasons">{#each c.reasons as r}<li>{r}</li>{/each}</ul>{/if}
      </div>
    {/each}
  </div>

  {#if failedChecks.length}
    <div class="check bad" role="alert"><Icon name="alert" size={16} /> {failedChecks.map((c) => `${c.label} (${c.column})`).join("; ")}</div>
  {/if}

  <table>
    <thead><tr><th>Line</th>{#each st.columns as c}<th class="num">{c.key === "current" ? "Current" : "Comparative"}</th>{/each}</tr></thead>
    {#each sections as s}
      <tbody>
        {#if s.name}<tr class="sec"><th colspan={st.columns.length + 1}>{s.name}</th></tr>{/if}
        {#each s.rows as r (r.key)}
          <tr class={r.kind}>
            <td>
              {#if r.accounts?.length === 1 && r.kind !== "note"}
                <a href="/ledger/{encodeURIComponent(r.accounts[0]!)}?from={period.from}&to={period.to}">{r.label}</a>
              {:else}{r.label}{/if}
              {#if r.text}<div class="muted small">{r.text}</div>{/if}
            </td>
            {#each r.amounts as a, i}
              <td class="num" class:neg={a?.startsWith("-")}>
                {#if st.columns[i]!.status === "unavailable"}<span class="muted">unavailable</span>{:else if a === null}{:else}{inr(a)}{/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    {/each}
  </table>
</section>

<section class="panel kpis" id="kpis">
  <div class="head">
    <h2>Key metrics</h2>
    <div class="legend">
      <span><i style="background: var(--series-in)"></i>Current</span>
      <span><i style="background: var(--series-out)"></i>Comparative</span>
      <a class="btn quiet sm" href="/statements/export?{qs({ what: 'kpis', format: 'csv' })}">CSV</a>
    </div>
  </div>
  {#if kpiError}
    <p class="check bad" role="status"><Icon name="alert" size={16} /> Metrics unavailable: {kpiError}. This is not a zero.</p>
  {:else if kpis}
    <div class="grid">
      {#each kpis.metrics as m (m.id)}
        {@const c = m.columns[0]!}
        {@const p = m.columns[1]}
        {@const b = bars(m.unit, c.value, p?.value ?? null)}
        <article class="tile" title={[...c.reasons, ...c.notes].join("\n")}>
          <div class="tl"><span>{m.name}</span><span class="badge sm {c.status}">{STATUS[c.status as keyof typeof STATUS]}</span></div>
          <div class="val num" class:na={c.value === null}>{fmt(m.unit, c.value)}</div>
          {#if p}<div class="muted small num">vs {fmt(m.unit, p.value)}</div>{/if}
          <div class="bars" aria-hidden="true">
            <span class="bar" style="width: {b.cur ?? 0}%; background: var(--series-in)"></span>
            {#if p}<span class="bar" style="width: {b.cmp ?? 0}%; background: var(--series-out)"></span>{/if}
          </div>
          {#if c.value === null}<p class="why">{c.reasons[0]}</p>{:else if c.notes.some((n) => n.includes("PROXY"))}<p class="why">Proxy basis: see the definition</p>{/if}
          <div class="meta muted small">v{m.version} · {m.definitionStatus} · {m.owner}</div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 14px; flex-wrap: wrap; }
  .top h1 { margin: 8px 0 6px; }
  .top p { margin: 0; }
  .period { display: flex; gap: 10px; align-items: flex-end; }
  .period .field { width: 160px; }
  .mapping { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--sage); margin: 0 0 12px; }
  .mapping.illustrative { color: var(--brass-2); }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 18px; overflow-x: auto; }
  .tabs a { padding: 10px 14px; color: var(--text-3); font-weight: 600; font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; display: flex; gap: 8px; align-items: center; }
  .tabs a:hover { color: var(--text); }
  .tabs a.active { color: var(--brass-2); border-bottom-color: var(--brass); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--brass); }
  .dot.certified { background: var(--sage); } .dot.unavailable { background: var(--clay); }
  .sheet, .kpis { padding: 18px 28px 22px; max-width: 1040px; margin-bottom: 22px; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 12px; }
  .exports, .legend { display: flex; gap: 8px; align-items: center; }
  .legend span { display: flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--text-2); }
  .legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .colhead { display: flex; flex-direction: column; gap: 4px; }
  .badge { align-self: flex-start; font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 3px 9px; border-radius: 999px;
    background: var(--brass-wash); color: var(--brass-2); }
  .badge.certified { background: var(--sage-wash); color: var(--sage); }
  .badge.unavailable { background: var(--clay-wash); color: var(--clay); }
  .badge.sm { font-size: 10px; padding: 2px 7px; }
  .reasons { margin: 2px 0 0; padding-left: 16px; font-size: 12.5px; color: var(--text-3); }
  .check { display: flex; gap: 8px; align-items: center; font-size: 13.5px; margin: 8px 0; }
  .check.bad { color: var(--clay); }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px; text-align: left; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  thead th { font-size: 12px; color: var(--text-3); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  .num { text-align: right; white-space: nowrap; }
  tr.sec th { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); padding-top: 18px; font-weight: 600; }
  tr.subtotal td { color: var(--text-2); font-weight: 600; border-top: 1px dashed var(--line); }
  tr.total td { font-weight: 700; border-top: 1px solid var(--line); }
  tr.exception td { color: var(--clay); background: var(--clay-wash); }
  tr.check td { color: var(--text-3); font-size: 13px; }
  td a:hover { color: var(--brass-2); }
  .neg { color: var(--clay); }
  .small { font-size: 12.5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
  .tile { background: var(--ink-2); border: 1px solid var(--line); border-radius: var(--r-md); padding: 14px; display: flex; flex-direction: column; gap: 6px; }
  .tl { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--text-2); font-weight: 600; }
  .val { font-family: var(--serif); font-size: 26px; }
  .val.na { color: var(--text-3); }
  .bars { display: flex; flex-direction: column; gap: 3px; margin-top: 2px; }
  .bar { height: 5px; border-radius: 3px; min-width: 2px; }
  .why { margin: 0; font-size: 12px; color: var(--clay); }
  .meta { margin-top: auto; }
</style>
