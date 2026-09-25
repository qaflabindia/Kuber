<script lang="ts">
  import { enhance } from "$app/forms";
  import { date, inr } from "$lib/format";

  let { data, form } = $props();
  const STATUS: Record<string, string> = { open: "Open", partly_paid: "Part paid", paid: "Paid" };
  const statement = $derived(data.customer?.statement ?? data.supplier?.statement ?? null);
</script>

<svelte:head><title>Your account · Kuber</title></svelte:head>

<main class="portal">
  <header class="top">
    <div class="eyebrow">{data.kind === "customer" ? "Customer account" : "Supplier account"}</div>
    <h1>{statement?.name ?? statement?.partyId}</h1>
    {#if statement}
      <p class="muted">{data.kind === "customer" ? "You owe" : "We owe you"} <strong class="num">{inr(statement.balance)}</strong></p>
    {/if}
  </header>

  {#if data.customer}
    <section class="panel" aria-labelledby="open-h">
      <div class="panel-head"><h2 id="open-h">Open invoices</h2></div>
      <div class="panel-body">
        {#if data.customer.openItems.length}
          <table class="table">
            <thead><tr><th>Date</th><th>Reference</th><th class="r">Amount</th><th class="r">Open</th><th>Status</th></tr></thead>
            <tbody>{#each data.customer.openItems as i}<tr><td>{date(i.date)}</td><td class="mono">{i.journalId}</td><td class="r num">{inr(i.amount)}</td><td class="r num">{inr(i.open)}</td><td>{STATUS[i.status]}</td></tr>{/each}</tbody>
          </table>
        {:else}<p class="muted">Nothing open.</p>{/if}
      </div>
    </section>
    <section class="panel" aria-labelledby="paid-h">
      <div class="panel-head"><h2 id="paid-h">Payments received</h2></div>
      <div class="panel-body">
        {#if data.customer.paymentsReceived.length}
          <table class="table"><tbody>{#each data.customer.paymentsReceived as p}<tr><td>{date(p.date)}</td><td class="mono">{p.journalId}</td><td class="r num">{inr(p.amount)}</td></tr>{/each}</tbody></table>
        {:else}<p class="muted">No payments yet.</p>{/if}
      </div>
    </section>
    <section class="panel" aria-labelledby="q-h">
      <div class="panel-head"><h2 id="q-h">Ask a question</h2></div>
      <div class="panel-body">
        <form method="POST" action="?/query" class="form" use:enhance>
          <div class="field"><label for="q-subject">Subject</label><input id="q-subject" name="subject" required minlength="2" maxlength="200" /></div>
          <div class="field"><label for="q-message">Message</label><textarea id="q-message" name="message" required minlength="2" maxlength="4000" rows="3"></textarea></div>
          {#if form?.action === "query"}<p class="small" class:error={!form.ok} role={form.ok ? "status" : "alert"}>{form.message}</p>{/if}
          <button class="btn primary">Send</button>
        </form>
        {#if data.queries.length}
          <ul class="queries">{#each data.queries as q}<li><strong>{q.subject}</strong> <span class="faint small">{date(q.openedAt.slice(0, 10))}</span></li>{/each}</ul>
        {/if}
      </div>
    </section>
  {/if}

  {#if data.supplier}
    <section class="panel" aria-labelledby="bills-h">
      <div class="panel-head"><h2 id="bills-h">Your bills</h2>{#if data.supplier.paymentsHeld}<span class="pill attention">Payments on hold: bank details being verified</span>{/if}</div>
      <div class="panel-body">
        {#if data.supplier.bills.length}
          <table class="table">
            <thead><tr><th>Date</th><th>Reference</th><th class="r">Amount</th><th class="r">Unpaid</th><th>Status</th></tr></thead>
            <tbody>{#each data.supplier.bills as b}<tr><td>{date(b.date)}</td><td class="mono">{b.journalId}</td><td class="r num">{inr(b.amount)}</td><td class="r num">{inr(b.open)}</td><td>{STATUS[b.status]}</td></tr>{/each}</tbody>
          </table>
        {:else}<p class="muted">No bills yet.</p>{/if}
      </div>
    </section>
    <section class="panel" aria-labelledby="bank-h">
      <div class="panel-head"><h2 id="bank-h">Change your bank details</h2></div>
      <div class="panel-body">
        {#if data.supplier.bankChange}
          <p class="muted">A change is {data.supplier.bankChange.status}: we verify it with you by phone before any payment is made to the new account.</p>
        {:else}
          <form method="POST" action="?/bank" class="form" use:enhance>
            <div class="field"><label for="b-holder">Account holder</label><input id="b-holder" name="holderName" required maxlength="140" /></div>
            <div class="field"><label for="b-acct">Account number</label><input id="b-acct" name="accountNumber" required inputmode="numeric" maxlength="34" autocomplete="off" /></div>
            <div class="field"><label for="b-ifsc">IFSC</label><input id="b-ifsc" name="ifsc" required maxlength="11" autocomplete="off" /></div>
            {#if form?.action === "bank"}<p class="small" class:error={!form.ok} role={form.ok ? "status" : "alert"}>{form.message}</p>{/if}
            <button class="btn primary">Request change</button>
          </form>
        {/if}
      </div>
    </section>
  {/if}
</main>

<style>
  .portal { max-width: 880px; margin: 0 auto; padding: 40px 16px; display: grid; gap: 20px; }
  .top h1 { margin: 8px 0; }
  .top p { margin: 0; }
  .form { display: grid; gap: 12px; max-width: 480px; }
  .r { text-align: right; }
  .queries { margin: 16px 0 0; padding-left: 18px; }
  .table { display: block; overflow-x: auto; }
</style>
