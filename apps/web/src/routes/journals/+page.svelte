<script lang="ts">
  import { tick } from "svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { date, inr } from "$lib/format";
  import type { Journal } from "$lib/server/api";

  let { data } = $props();

  // Filters work on the loaded page (50 journals); "Older entries" loads the next page from the core.
  let q = $state("");
  let vt = $state("all");
  let open = $state<Set<string>>(new Set());
  $effect(() => { if (data.focus) { open = new Set([data.focus]); tick().then(() => document.getElementById(`j-${data.focus}`)?.scrollIntoView({ block: "center" })); } });

  const total = (j: Journal) => j.lines.reduce((a, l) => (BigInt(l.amount) > 0n ? a + BigInt(l.amount) : a), 0n);
  const types = $derived(["all", ...new Set((data.journals ?? []).map((j) => j.voucher_type ?? "journal"))]);
  const rows = $derived((data.journals ?? []).filter((j) => {
    if (vt !== "all" && (j.voucher_type ?? "journal") !== vt) return false;
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return j.narration.toLowerCase().includes(t) || j.lines.some((l) => (data.names[l.accountId] ?? l.accountId).toLowerCase().includes(t)
      || (l.partyId && (data.partyNames[l.partyId] ?? l.partyId).toLowerCase().includes(t))) || inr(total(j)).includes(t);
  }));
  // Group by date: the day book reads day by day.
  const days = $derived.by(() => {
    const out: { day: string; items: Journal[]; sum: bigint }[] = [];
    for (const j of rows) {
      let d = out.at(-1);
      if (!d || d.day !== j.txn_date) out.push((d = { day: j.txn_date, items: [], sum: 0n }));
      d.items.push(j); d.sum += total(j);
    }
    return out;
  });
  const oldest = $derived(data.journals?.length ? Math.min(...data.journals.map((j) => j.seq)) : null);
  function toggle(id: string) { const n = new Set(open); n.has(id) ? n.delete(id) : n.add(id); open = n; }
  const who = (p: string) => p.startsWith("agent:") ? "Kuber" : p.split(":")[1] ?? p;
  const status = (j: Journal) => j.reverses ? { t: "Reversal", c: "clay" } : j.provisional ? { t: "Provisional", c: "brass" } : { t: "Posted", c: "sage" };
</script>

<svelte:head><title>Day book · Kuber</title></svelte:head>

<header class="top">
  <div>
    <div class="eyebrow">Books</div>
    <h1>Day book</h1>
    <p class="muted">Every journal in the ledger, newest first. Open one to see its lines; each account links to its ledger.</p>
  </div>
  <a class="btn primary" href="/record"><Icon name="edit" size={15} /> Record a transaction</a>
</header>

<div class="bar">
  <div class="search"><Icon name="search" size={16} /><input bind:value={q} placeholder="Search narration, account, party or amount" aria-label="Search journals" /></div>
  <div class="chips" role="group" aria-label="Voucher type">
    {#each types as t}<button class:on={vt === t} onclick={() => (vt = t)}>{t === "all" ? "All" : t}</button>{/each}
  </div>
</div>

{#if data.journals === null}
  <div class="panel empty" role="status"><Icon name="alert" size={18} /> The day book could not be loaded. This is not an empty ledger: reload, or check that the core is running.</div>
{:else if !data.journals.length}
  <div class="panel empty">
    <p>No journals yet.</p>
    <a class="btn primary" href="/record">Record your first transaction</a>
  </div>
{:else if !rows.length}
  <div class="panel empty">No journal on this page matches. <button class="btn quiet" onclick={() => { q = ""; vt = "all"; }}>Clear filters</button></div>
{:else}
  <div class="panel book">
    {#each days as d (d.day)}
      <div class="day"><span>{date(d.day)}</span><span class="num muted">{d.items.length} {d.items.length === 1 ? "entry" : "entries"} · {inr(d.sum)}</span></div>
      {#each d.items as j (j.journal_id)}
        {@const st = status(j)}
        {@const isOpen = open.has(j.journal_id)}
        <div class="j" id="j-{j.journal_id}" class:open={isOpen} class:focus={data.focus === j.journal_id}>
          <button class="jrow" aria-expanded={isOpen} aria-controls="jl-{j.journal_id}" onclick={() => toggle(j.journal_id)}>
            <span class="chev" aria-hidden="true"><Icon name="chevron" size={14} /></span>
            <span class="vt">{j.voucher_type ?? "journal"}</span>
            <span class="nar">{j.narration}</span>
            <span class="by muted">{who(j.principal)}</span>
            <span class="pill {st.c}">{st.t}</span>
            <span class="num amt">{inr(total(j))}</span>
          </button>
          {#if isOpen}
            <div class="lines" id="jl-{j.journal_id}">
              <table class="table mini">
                <thead><tr><th>Account</th><th>Party</th><th>Memo</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead>
                <tbody>
                  {#each j.lines as l}
                    <tr>
                      <td><a href="/ledger/{encodeURIComponent(l.accountId)}">{data.names[l.accountId] ?? l.accountId}</a></td>
                      <td class="muted">{l.partyId ? data.partyNames[l.partyId] ?? l.partyId : ""}</td>
                      <td class="muted">{l.memo ?? ""}</td>
                      <td class="r num">{BigInt(l.amount) > 0n ? inr(l.amount) : ""}</td>
                      <td class="r num">{BigInt(l.amount) < 0n ? inr((-BigInt(l.amount)).toString()) : ""}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <div class="meta muted">Ledger position {j.seq} · recorded by {j.principal}{j.reverses ? ` · reverses ${j.reverses}` : ""}</div>
            </div>
          {/if}
        </div>
      {/each}
    {/each}
  </div>
  <div class="pager">
    {#if data.before}<a class="btn quiet" href="/journals">Newest</a>{/if}
    {#if data.journals.length === 50 && oldest}<a class="btn" href="/journals?before={oldest}">Older entries <Icon name="arrowRight" size={14} /></a>{/if}
  </div>
{/if}

<style>
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .top h1 { margin: 4px 0 6px; } .top p { margin: 0; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .search { flex: 1; min-width: 240px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--ink-0); color: var(--text-3); }
  .search input, .search input:focus { border: 0; box-shadow: none; background: none; padding: 10px 0; }
  .chips { display: flex; gap: 4px; flex-wrap: wrap; }
  .chips button { border: 1px solid var(--line-soft); background: none; color: var(--text-2); font: 600 12.5px var(--sans); padding: 6px 11px; border-radius: 999px; cursor: pointer; text-transform: capitalize; }
  .chips button.on { background: var(--brass-wash); border-color: rgba(201,168,106,.45); color: var(--brass-2); }
  .empty { padding: 28px; display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap; color: var(--text-2); }
  .book { padding: 6px 0; overflow: hidden; }
  .day { display: flex; justify-content: space-between; padding: 14px 18px 6px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); }
  .j { border-top: 1px solid var(--line-soft); }
  .j.focus { box-shadow: inset 3px 0 0 var(--brass); }
  .jrow { width: 100%; display: grid; grid-template-columns: 20px 86px minmax(0, 1fr) 90px 96px 130px; gap: 12px; align-items: center; padding: 11px 18px;
    border: 0; background: none; color: var(--text); font: 500 13.5px var(--sans); text-align: left; cursor: pointer; }
  .jrow:hover { background: var(--ink-2); }
  .chev { color: var(--text-3); display: inline-flex; transition: transform .15s var(--ease); }
  .j.open .chev { transform: rotate(90deg); }
  .vt { font-size: 11px; font-weight: 700; text-transform: capitalize; color: var(--text-2); background: var(--ink-3); border-radius: 6px; padding: 2px 8px; width: fit-content; }
  .nar { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .by { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pill { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; width: fit-content; }
  .pill.sage { background: var(--sage-wash); color: var(--sage); } .pill.brass { background: var(--brass-wash); color: var(--brass-2); } .pill.clay { background: var(--clay-wash); color: var(--clay); }
  .amt { text-align: right; font-weight: 700; }
  .lines { padding: 4px 18px 16px 50px; animation: drop .15s var(--ease); }
  .meta { font-size: 11.5px; margin-top: 8px; }
  .r { text-align: right; }
  .pager { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
  @keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
  @media (max-width: 760px) {
    .jrow { grid-template-columns: 16px minmax(0, 1fr) auto; }
    .vt, .by, .pill { display: none; }
    .lines { padding-left: 18px; overflow-x: auto; }
  }
</style>
