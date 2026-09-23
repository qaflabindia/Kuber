<script lang="ts">
  import { enhance } from "$app/forms";
  import Icon from "$lib/components/Icon.svelte";

  let { form } = $props();
  let input: HTMLInputElement;
  let fileName = $state("");
  let over = $state(false);
  let busy = $state(false);

  function drop(e: DragEvent) {
    e.preventDefault(); over = false;
    const files = e.dataTransfer?.files;
    if (files?.length) { input.files = files; fileName = files[0]!.name; }
  }
</script>

<svelte:head><title>Import · Kuber</title></svelte:head>

<header class="top">
  <div class="eyebrow">Import</div>
  <h1>Bring in a statement</h1>
  <p class="muted">Kuber reads each line, matches it against what it already knows, and either records it or asks you. Importing the same file twice is safe; duplicates are recognised.</p>
</header>

<div class="grid">
  <form method="POST" enctype="multipart/form-data" class="panel up"
    use:enhance={() => { busy = true; return async ({ update }) => { busy = false; await update({ reset: true }); fileName = ""; }; }}>
    <label class="drop" class:over class:has={fileName}
      ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} ondrop={drop}>
      <input bind:this={input} type="file" name="file" accept=".csv,text/csv" required
        onchange={() => (fileName = input.files?.[0]?.name ?? "")} />
      <Icon name="upload" size={30} />
      {#if fileName}
        <strong>{fileName}</strong><span class="faint">Ready to import</span>
      {:else}
        <strong>Drop a CSV statement here</strong><span class="faint">or click to choose a file · up to 2 MB</span>
      {/if}
    </label>

    <div class="row">
      <div class="field">
        <label for="instrument">This statement is for</label>
        <select id="instrument" name="instrument">
          <option value="BANK">Bank account</option>
          <option value="CARD">Credit card</option>
          <option value="CASH">Cash book</option>
        </select>
      </div>
      <button class="btn primary" disabled={busy || !fileName}>{busy ? "Reading…" : "Import"}</button>
    </div>

    {#if form?.message}<p class="error" role="alert"><Icon name="alert" size={15} /> {form.message}</p>{/if}
  </form>

  <aside class="side">
    {#if form?.ok}
      <div class="panel result" role="status">
        <div class="eyebrow">{form.name}</div>
        {#if form.duplicate}
          <h2>Already imported</h2>
          <p class="muted">This exact statement was imported before. Nothing was changed.</p>
        {:else}
          <h2>{form.accepted} {form.accepted === 1 ? "line" : "lines"} read</h2>
          {#if form.skipped}<p class="faint">{form.skipped} skipped (blank or unreadable rows).</p>{/if}
          <p class="muted">Kuber is classifying them now. Anything it can't settle will wait for you in Review.</p>
          <div class="acts">
            <a class="btn primary" href="/review">Go to Review <Icon name="arrowRight" size={15} /></a>
            <a class="btn quiet" href="/">Today</a>
          </div>
        {/if}
      </div>
    {:else}
      <div class="panel help">
        <h3>What Kuber reads</h3>
        <p class="muted">Standard bank CSV exports with a date, a narration and withdrawal/deposit columns (HDFC, ICICI, SBI and Axis layouts).</p>
        <h3>What happens next</h3>
        <ol class="muted">
          <li>Each line becomes a transaction, fingerprinted so it is never counted twice.</li>
          <li>Kuber proposes an account using your rules, then your history, then the counterparty.</li>
          <li>Your policies decide whether it posts on its own or asks you.</li>
        </ol>
      </div>
    {/if}
  </aside>
</div>

<style>
  .top { margin-bottom: 28px; }
  .top h1 { margin: 8px 0; }
  .top p { margin: 0; max-width: 66ch; }
  .grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px; align-items: start; }
  .up { padding: 22px; display: grid; gap: 18px; }
  .drop { position: relative; display: grid; justify-items: center; gap: 6px; padding: 48px 20px; border: 1.5px dashed var(--line);
    border-radius: 14px; cursor: pointer; text-align: center; transition: border-color .15s var(--ease), background .15s var(--ease); color: var(--text-2); }
  .drop:hover, .drop.over { border-color: var(--brass); background: rgba(201, 168, 106, 0.05); }
  .drop.has { border-style: solid; border-color: rgba(141, 187, 164, .5); }
  .drop :global(svg) { color: var(--brass); margin-bottom: 6px; }
  .drop strong { color: var(--text); font-size: 16px; }
  .drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .drop:focus-within { outline: 2px solid var(--brass); outline-offset: 2px; }
  .row { display: flex; gap: 12px; align-items: flex-end; justify-content: space-between; }
  .row .field { flex: 1; max-width: 280px; }
  .result, .help { padding: 22px 24px; }
  .result h2 { margin: 8px 0; }
  .help h3 { font-size: 15px; margin: 0 0 6px; font-family: var(--sans); font-weight: 600; }
  .help p { margin: 0 0 18px; }
  .help ol { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
  .acts { display: flex; gap: 10px; margin-top: 14px; }
  .error { color: var(--clay); margin: 0; display: flex; gap: 6px; align-items: center; }
  @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } }
</style>
