<script lang="ts">
  import { enhance } from "$app/forms";
  import { date, inr } from "$lib/format";
  import Icon from "$lib/components/Icon.svelte";
  import SignPrompt from "$lib/components/SignPrompt.svelte";
  import { Signer, signedSubmit } from "$lib/sign.svelte";

  let { data, form } = $props();
  let busy = $state(false);
  const STEPS = [["upload", "Upload"], ["mapping", "Mapping"], ["rehearse", "Rehearsal"], ["compare", "Comparison"], ["golive", "Go-live"]] as const;
  const p = $derived(data.available ? data.project : null);
  const step = $derived(data.available && data.project ? data.step : "upload");
  const act = () => { busy = true; return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => { busy = false; await update(); }; };
  const signer = new Signer();
  const goLiveSubmit = (projectId: string, comparisonId: string) => signedSubmit(signer, () => ({ action: "migration.golive", projectId, comparisonId }),
    () => { busy = true; }, async ({ update }) => { busy = false; await update(); });
  const needed = $derived(data.available && data.project ? data.mapping.filter((r) => r.cutoffBalance !== "0" || r.usedAfterCutoff) : []);
  const signed = (v: string) => (v.startsWith("-") ? `${inr(v.slice(1))} Cr` : v === "0" ? "—" : `${inr(v)} Dr`);
</script>

<svelte:head><title>Migration · Kuber</title></svelte:head>

<header class="top">
  <div class="eyebrow">Migration</div>
  <h1>{p ? `Moving ${p.bookId} from ${p.sourceSystem === "tally" ? "Tally" : p.sourceSystem === "zoho" ? "Zoho Books" : "a spreadsheet"}` : "Move your books to Kuber"}</h1>
  <p class="muted">Reconcile the old books first, run in parallel second, and cut over once the parallel run is clean. Nothing is kept in two-way sync, and the old system stays the book of record until a superuser signs the go-live.</p>
</header>

{#if !data.available}
  <div class="panel pad"><p class="error"><Icon name="alert" size={15} /> {data.message}</p></div>
{:else}
  {#if p}
    <nav class="steps" aria-label="Migration steps">
      {#each STEPS as [key, label], i}
        <a href="?step={key}" class:on={step === key} aria-current={step === key ? "step" : undefined}><span class="n">{i + 1}</span>{label}</a>
      {/each}
      <span class="pill {p.bookOfRecord === 'kuber' ? 'sage' : 'brass'}"><span class="dot"></span>Book of record: {p.bookOfRecord === "kuber" ? "Kuber" : p.sourceSystem}</span>
    </nav>
  {/if}

  {#if form?.message}<p class="error" role="alert"><Icon name="alert" size={15} /> {form.message}</p>{/if}

  {#if !p}
    <form method="POST" action="?/create" class="panel pad grid2" use:enhance={act}>
      <div class="field"><label for="src">Your books are in</label>
        <select id="src" name="sourceSystem"><option value="tally">Tally (XML export)</option><option value="zoho">Zoho Books (CSV exports)</option><option value="csv">A spreadsheet (Kuber CSV template)</option></select></div>
      <div class="field"><label for="cutoff">Cut-off date (balances as at the end of this day)</label><input id="cutoff" name="cutoff" type="date" required /></div>
      <p class="faint span">Book: <strong>{data.book}</strong>. The cut-off is usually the last day of a financial year or quarter; everything after it is imported as the delta during the parallel run.</p>
      <div class="span"><button class="btn primary" disabled={busy}>Start the migration</button></div>
    </form>
  {:else if step === "upload"}
    <div class="grid">
      <form method="POST" action="?/upload" enctype="multipart/form-data" class="panel pad stack" use:enhance={act}>
        <input type="hidden" name="projectId" value={p.projectId} />
        <div class="field"><label for="file">Export file</label><input id="file" name="file" type="file" accept=".xml,.csv,text/xml,text/csv" required /></div>
        <div class="row">
          <div class="field"><label for="purpose">This file is</label>
            <select id="purpose" name="purpose"><option value="source">Masters, balances and open items at the cut-off</option><option value="delta">Transactions after the cut-off</option><option value="comparison">A trial balance for the parallel run</option></select></div>
          <div class="field"><label for="asOf">Trial balance as at</label><input id="asOf" name="asOf" type="date" /></div>
        </div>
        <button class="btn primary" disabled={busy}><Icon name="upload" size={15} /> {busy ? "Reading…" : "Upload and inventory"}</button>
        {#if form?.done === "uploaded"}<p class="muted" role="status">{form.name}: {form.duplicate ? "already imported, nothing changed" : Object.entries(form.counts ?? {}).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}</p>{/if}
      </form>
      <aside class="panel pad">
        <h3>Inventory at {date(p.cutoff)}</h3>
        <table class="table mini"><tbody>
          {#each p.inventory.categories as c}<tr><td>{c.category.replace(/_/g, " ")}</td><td class="r num">{c.count}</td><td>{#if c.inScope}<span class="pill sage">in scope</span>{:else}<span class="pill">excluded</span>{/if}</td></tr>{/each}
        </tbody></table>
        <h3>Files</h3>
        {#each p.files as f}<p class="faint small"><span class="mono">{f.fileHash.slice(0, 12)}</span> {f.name} · {f.purpose}{f.asOf ? ` at ${f.asOf}` : ""}{f.problems ? ` · ${f.problems} problem(s)` : ""}</p>{:else}<p class="faint">No files yet.</p>{/each}
      </aside>
    </div>
  {:else if step === "mapping"}
    <div class="panel">
      <div class="panel-head"><div><h3>Map {needed.length} source ledgers</h3><p class="faint small">{p.mapping.unmapped} still need approval. Unmapped ledgers block the load; suspense is never a target.</p></div>
        <form method="POST" action="?/approve" use:enhance={act}><input type="hidden" name="projectId" value={p.projectId} /><button class="btn primary sm" disabled={busy}>Approve all suggestions</button></form></div>
      <table class="table">
        <thead><tr><th>Source ledger</th><th>Group</th><th class="r">At cut-off</th><th>Kuber account</th><th></th></tr></thead>
        <tbody>
          {#each needed as r (r.sourceKey)}
            <tr>
              <td>{r.name}{#if r.party}<span class="pill">{r.party}</span>{/if}{#if r.bank}<span class="pill">bank</span>{/if}</td>
              <td class="faint">{r.group ?? "—"}</td>
              <td class="r num">{signed(r.cutoffBalance)}</td>
              <td>{#if r.status === "approved"}<span class="mono">{r.accountId}</span>{:else if r.suggestion}<span class="mono">{r.suggestion.accountId}</span> <span class="faint small">{r.newAccount ? "new account" : `${Math.round((r.suggestion.score ?? 0) * 100)}%`}</span>{:else}<span class="faint">no suggestion</span>{/if}</td>
              <td class="r">{#if r.status === "approved"}<span class="pill sage"><Icon name="check" size={12} /> approved</span>{:else}
                <form method="POST" action="?/approve" class="inline" use:enhance={act}><input type="hidden" name="projectId" value={p.projectId} /><input type="hidden" name="sourceKey" value={r.sourceKey} />
                  <input name="accountId" placeholder={r.suggestion?.accountId ?? "ACCOUNT"} aria-label="Kuber account for {r.name}" /><button class="btn sm" disabled={busy}>Approve</button></form>{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if step === "rehearse"}
    <div class="grid">
      <div class="panel pad stack">
        <h3>Rehearse, then load</h3>
        <p class="muted">A rehearsal loads the opening journal and the open items into an isolated book and reconciles them to the source. It can never issue an invoice or a payment. When it is clean, load the target book.</p>
        <div class="row">
          <form method="POST" action="?/rehearse" use:enhance={act}><input type="hidden" name="projectId" value={p.projectId} /><button class="btn" disabled={busy}>Rehearse</button></form>
          <form method="POST" action="?/load" use:enhance={act}><input type="hidden" name="projectId" value={p.projectId} /><button class="btn primary" disabled={busy}>Load {p.bookId}</button></form>
        </div>
        {#each p.loads.filter((l) => l.status === "active") as l}
          <form method="POST" action="?/rollback" class="row" use:enhance={act}>
            <input type="hidden" name="projectId" value={p.projectId} /><input type="hidden" name="loadId" value={l.loadId} />
            <span class="faint small">{l.kind} load {l.seq} in <span class="mono">{l.bookId}</span> · {l.reconciled ? "reconciled" : "not reconciled"}</span>
            <input name="reason" placeholder="Reason to roll back" minlength="3" required /><button class="btn quiet sm" disabled={busy}>Roll back</button>
          </form>
        {/each}
      </div>
      {#if data.reconciliation}
        {@const rc = data.reconciliation}
        <aside class="panel pad">
          <h3>{rc.reconciled ? "Reconciled to the source" : "Does not reconcile yet"}</h3>
          <ul class="checks">{#each Object.entries(rc.checks) as [k, ok]}<li class:bad={!ok}><Icon name={ok ? "check" : "x"} size={13} /> {k.replace(/([A-Z])/g, " $1").toLowerCase()}</li>{/each}</ul>
          <p class="faint small">Debits {inr(rc.totals.target.debits)} against {inr(rc.totals.source.debits)} in the source; {rc.counts.loadedOpenItems} open items loaded without posting.</p>
        </aside>
      {/if}
    </div>
  {:else if step === "compare"}
    <div class="panel pad stack">
      <div class="row">
        <form method="POST" action="?/delta" class="row" use:enhance={act}><input type="hidden" name="projectId" value={p.projectId} /><input name="asOf" type="date" aria-label="Import up to" /><button class="btn" disabled={busy}>Import transactions after the cut-off</button></form>
        <form method="POST" action="?/compare" class="row" use:enhance={act}><input type="hidden" name="projectId" value={p.projectId} />
          <input name="from" type="date" required aria-label="From" /><input name="to" type="date" required aria-label="To" /><button class="btn primary" disabled={busy}>Compare with the source</button></form>
      </div>
      {#if form?.done === "delta"}<p class="muted" role="status">{form.created} imported, {form.duplicates} already there{form.held?.length ? `, ${form.held.length} held` : ""}.</p>{/if}
    </div>
    {#if data.comparison}
      {@const c = data.comparison}
      <div class="panel">
        <div class="panel-head"><div><h3>Parallel run {date(c.from)} – {date(c.to)}</h3><p class="faint small">{c.differences.length} differences, {c.open} open · net profit Kuber {inr(c.pnl.kuber.net)}, source {inr(c.pnl.source.net)}</p></div></div>
        <table class="table">
          <thead><tr><th>Where</th><th>Process</th><th class="r">Source</th><th class="r">Kuber</th><th class="r">Difference</th><th>Explanation</th></tr></thead>
          <tbody>
            {#each c.differences as d (d.key)}
              <tr>
                <td>{d.name} <span class="faint small">{d.section.replace(/_/g, " ")}</span></td>
                <td class="faint">{d.process}</td>
                <td class="r num">{signed(d.source)}</td><td class="r num">{signed(d.kuber)}</td><td class="r num">{signed(d.difference)}</td>
                <td>{#if d.explanation}<span class="pill sage">{d.explanation.category}</span> <span class="faint small">{d.explanation.note}</span>{:else}
                  <form method="POST" action="?/explain" class="inline" use:enhance={act}>
                    <input type="hidden" name="projectId" value={p.projectId} /><input type="hidden" name="comparisonId" value={c.comparisonId} /><input type="hidden" name="key" value={d.key} />
                    <select name="category" aria-label="Category"><option>timing</option><option>process</option><option>classification</option><option value="source_error">source error</option><option value="kuber_error">Kuber error</option><option>accepted</option></select>
                    <input name="note" placeholder={d.suggestion} minlength="3" required aria-label="Explanation" /><button class="btn sm" disabled={busy}>Explain</button></form>{/if}</td>
              </tr>
            {:else}<tr><td colspan="6" class="faint">No differences: Kuber and the source agree for this period.</td></tr>{/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else if step === "golive"}
    <div class="panel pad stack">
      {#if p.status !== "open"}
        <h3><Icon name="shield" size={16} /> Live since {date(p.goLive ?? "")}</h3>
        <p class="muted">Kuber is the book of record. Pre-cutover rollback is closed; recovery follows the documented procedure and the named fallback operators.</p>
      {:else if data.intent && data.comparison}
        <h3>{data.intent.summary.title}</h3>
        <ul class="checks">{#each data.intent.checklist as x}<li class:bad={!x.ok}><Icon name={x.ok ? "check" : "x"} size={13} /> {x.label} <span class="faint small">{x.detail}</span></li>{/each}</ul>
        <form method="POST" action="?/golive" use:enhance={goLiveSubmit(p.projectId, data.comparison.comparisonId)}>
          <input type="hidden" name="projectId" value={p.projectId} /><input type="hidden" name="comparisonId" value={data.comparison.comparisonId} />
          <button class="btn primary" disabled={busy || !data.intent.ready}><Icon name="shield" size={15} /> Sign the go-live</button>
        </form>
        <SignPrompt {signer} />
        {#if signer.message}<p class="faint">{signer.message}</p>{/if}
      {:else}
        <p class="muted">Run a parallel-period comparison first.</p>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .top { margin-bottom: 22px; }
  .top h1 { margin: 8px 0; }
  .top p { margin: 0; max-width: 72ch; }
  .steps { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
  .steps a { display: inline-flex; gap: 8px; align-items: center; padding: 7px 12px; border-radius: 999px; color: var(--text-2); border: 1px solid var(--line-soft); text-decoration: none; font-size: 13px; }
  .steps a.on { border-color: var(--brass); color: var(--brass-2); background: var(--brass-wash); }
  .steps .n { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; background: var(--ink-2); }
  .steps .pill { margin-left: auto; }
  .pad { padding: 22px 24px; }
  .stack { display: grid; gap: 14px; }
  .grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px; align-items: start; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .span { grid-column: 1 / -1; margin: 0; }
  .row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .inline { display: flex; gap: 6px; align-items: center; justify-content: flex-end; }
  .inline input { max-width: 180px; }
  h3 { font-size: 15px; margin: 0 0 8px; font-family: var(--sans); font-weight: 600; }
  .mini :global(td) { padding: 6px 8px; font-size: 13px; }
  .r { text-align: right; }
  .small { font-size: 12.5px; }
  .mono { font-family: var(--mono, monospace); font-size: 12px; }
  .checks { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
  .checks li { display: flex; gap: 6px; align-items: center; color: var(--sage); }
  .checks li.bad { color: var(--clay); }
  .error { color: var(--clay); display: flex; gap: 6px; align-items: center; }
  @media (max-width: 980px) { .grid, .grid2 { grid-template-columns: 1fr; } }
</style>
