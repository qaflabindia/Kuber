<script lang="ts">
  import { enhance } from "$app/forms";
  let { form, data } = $props();
  let type = $state("freelancer");
  let busy = $state(false);
  const today = new Date().toISOString().slice(0, 10);
  const kinds = [
    { id: "individual", title: "Just me", body: "Salary, spending, savings and loans." },
    { id: "household", title: "My household", body: "Shared accounts and goals for a family." },
    { id: "freelancer", title: "Me and my practice", body: "Personal money plus fees, invoices and business costs." },
    { id: "company", title: "A company", body: "Receivables, payables, GST and statutory books." },
  ];
</script>

<svelte:head><title>Open your books · Kuber</title></svelte:head>

<div class="wrap">
  <div class="intro">
    <div class="eyebrow">Welcome, {data.session?.name}</div>
    <h1>Let's open your books.</h1>
    <p class="muted">Start small. Kuber adds accounts, reports and controls as your activity calls for them; nothing here is permanent.</p>
  </div>

  <form method="POST" class="panel form" use:enhance={() => { busy = true; return async ({ update }) => { busy = false; await update(); }; }}>
    <fieldset>
      <legend class="eyebrow">Who are these books for?</legend>
      <div class="kinds">
        {#each kinds as k}
          <label class="kind" class:on={type === k.id}>
            <input type="radio" name="type" value={k.id} bind:group={type} />
            <span class="k-title">{k.title}</span>
            <span class="k-body faint">{k.body}</span>
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset>
      <legend class="eyebrow">What do you have today? <span class="opt">Optional</span></legend>
      <div class="grid3">
        <div class="field"><label for="bank">In the bank (₹)</label><input id="bank" name="bank" inputmode="decimal" placeholder="1,25,000" /></div>
        <div class="field"><label for="cash">Cash in hand (₹)</label><input id="cash" name="cash" inputmode="decimal" placeholder="5,000" /></div>
        <div class="field"><label for="loans">Loans outstanding (₹)</label><input id="loans" name="loans" inputmode="decimal" placeholder="24,00,000" /></div>
      </div>
      <div class="field as-of"><label for="asOf">As of</label><input id="asOf" name="asOf" type="date" value={today} /></div>
      <p class="faint small">These figures are enough for a statement of affairs on day one. Statements you import later fill in the detail.</p>
    </fieldset>

    {#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
    <div class="actions"><button class="btn primary" disabled={busy}>{busy ? "Opening…" : "Open my books"}</button></div>
  </form>
</div>

<style>
  .wrap { max-width: 880px; margin: 0 auto; padding: 72px 24px; }
  .intro { margin-bottom: 32px; }
  .intro h1 { margin: 8px 0 12px; font-size: 48px; }
  .form { padding: 32px; display: grid; gap: 32px; }
  fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 16px; }
  legend { margin-bottom: 14px; }
  .opt { text-transform: none; letter-spacing: 0; font-weight: 500; margin-left: 6px; color: var(--text-3); }
  .kinds { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .kind { position: relative; display: grid; gap: 4px; padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--r-md);
    cursor: pointer; transition: border-color 0.15s var(--ease), background 0.15s var(--ease); }
  .kind:hover { border-color: #34404f; }
  .kind.on { border-color: var(--brass); background: var(--brass-wash); }
  .kind input { position: absolute; opacity: 0; pointer-events: none; }
  .kind:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
  .k-title { font-family: var(--serif); font-size: 20px; }
  .k-body { font-size: 13.5px; }
  .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .as-of { max-width: 220px; }
  .small { font-size: 12.5px; margin: 0; }
  .actions { display: flex; justify-content: flex-end; }
  .error { color: var(--clay); margin: 0; }
  @media (max-width: 700px) { .kinds, .grid3 { grid-template-columns: 1fr; } }
</style>
