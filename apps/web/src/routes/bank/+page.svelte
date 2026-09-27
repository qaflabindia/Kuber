<script lang="ts">
  import { enhance } from "$app/forms";
  import { date, inr } from "$lib/format";
  import Icon from "$lib/components/Icon.svelte";
  import SignPrompt from "$lib/components/SignPrompt.svelte";
  import { Signer, signedSubmit } from "$lib/sign.svelte";

  let { data, form } = $props();
  let busy = $state(false);
  const signer = new Signer();
  const money = (p: string | null) => (p === null ? "—" : inr(p));
  const certifySubmit = signedSubmit(signer, (f) => ({ action: "plan.commit", planId: String(f.get("planId")), hash: String(f.get("hash")) }),
    () => { busy = true; }, async ({ update }) => { busy = false; await update(); });
  const r = $derived(data.rec);
  const items = $derived(r ? [...r.outstandingPayments.map((x) => ({ ...x, kind: "Outstanding payment" })), ...r.depositsInTransit.map((x) => ({ ...x, kind: "Deposit in transit" }))] : []);
</script>

<svelte:head><title>Bank · Kuber</title></svelte:head>

<header class="top">
  <div class="eyebrow">Bank</div>
  <h1>Bank reconciliation</h1>
  <p class="muted">Statements prove the bank's side; every timing item stays listed with its age. A reconciliation certifies only when its difference is exactly zero, and an independent reviewer signs it with a passkey.</p>
</header>

{#if !data.accounts}
  <div class="panel pad"><p class="error"><Icon name="alert" size={15} /> Bank accounts could not be loaded.</p></div>
{:else if !data.accounts.length}
  <div class="panel pad"><h2>No bank account registered</h2><p class="muted">A treasurer or controller registers the book's bank accounts (number sealed, shown masked) before statements are imported.</p></div>
{:else}
  <nav class="tabs" aria-label="Bank accounts">
    {#each data.accounts as a (a.bankAccountId)}
      <a href="?account={a.bankAccountId}" class:active={a.bankAccountId === data.account}>{a.bankName} <span class="mono faint">{a.masked}</span></a>
    {/each}
  </nav>

  <div class="grid">
    <section class="panel pad">
      <div class="row">
        <h2>Reconciliation at {data.periodEnd ? date(data.periodEnd) : "—"}</h2>
        <form method="GET" class="inline"><input type="hidden" name="account" value={data.account} /><input type="date" name="end" value={data.periodEnd} aria-label="Period end" /><button class="btn quiet sm">Show</button></form>
      </div>
      {#if r}
        <dl class="kv">
          <dt>Balance per bank statement</dt><dd class="num">{money(r.bankBalance)}</dd>
          <dt>Adjusted bank balance</dt><dd class="num">{money(r.adjustedBank)}</dd>
          <dt>Balance per books</dt><dd class="num">{money(r.bookBalance)}</dd>
          <dt>Adjusted book balance</dt><dd class="num">{money(r.adjustedBook)}</dd>
          <dt>Unexplained difference</dt><dd class="num strong" class:bad={!r.differenceZero}>{money(r.difference)}</dd>
        </dl>
        <div class="pills">
          <span class="pill" class:brass={r.differenceZero} class:clay={!r.differenceZero}><span class="dot"></span>{r.differenceZero ? "Difference zero" : "Difference not zero"}</span>
          <span class="pill" class:brass={r.noOutstandingItems}><span class="dot"></span>{r.noOutstandingItems ? "No outstanding items" : `${r.outstandingCount} outstanding item(s)`}</span>
          {#if r.staleItems.length}<span class="pill clay"><span class="dot"></span>{r.staleItems.length} stale</span>{/if}
        </div>
        <h3>Timing items</h3>
        {#if items.length}
          <table class="table">
            <thead><tr><th>Kind</th><th>Date</th><th>Narration</th><th class="r">Amount</th><th class="r">Age</th><th>Source</th></tr></thead>
            <tbody>{#each items as x (x.journalId)}<tr class:stale={x.stale}><td>{x.kind}</td><td class="num">{date(x.txnDate)}</td><td>{x.narration}</td><td class="r num">{inr(x.amount)}</td><td class="r num">{x.ageDays} d</td><td class="faint small">{x.source.voucherType} · {x.source.postedBy}</td></tr>{/each}</tbody>
          </table>
        {:else}<p class="faint">None.</p>{/if}
        {#if r.unrecorded.length}
          <h3>On the statement, not yet in the books</h3>
          <table class="table"><tbody>{#each r.unrecorded as u (u.txnId)}<tr><td class="num">{date(u.txnDate)}</td><td>{u.narration ?? u.txnId}</td><td class="r num">{inr(u.amount)}</td></tr>{/each}</tbody></table>
          <a class="btn quiet sm" href="/review">Review them <Icon name="arrowRight" size={14} /></a>
        {/if}
        {#if r.problems.length}<ul class="problems">{#each r.problems as p}<li><Icon name="alert" size={14} /> {p}</li>{/each}</ul>{/if}

        <div class="acts">
          <form method="POST" action="?/prepare" use:enhance={() => { busy = true; return async ({ update }) => { busy = false; await update({ reset: false }); }; }}>
            <input type="hidden" name="account" value={data.account} /><input type="hidden" name="end" value={data.periodEnd} />
            <button class="btn quiet" disabled={busy || !r.certifiable}>Prepare certification</button>
          </form>
          {#if form?.prepared && !form.prepared.blocked}
            <form method="POST" action="?/certify" use:enhance={certifySubmit}>
              <input type="hidden" name="planId" value={form.prepared.planId} /><input type="hidden" name="hash" value={form.prepared.hash} />
              <button class="btn primary" disabled={busy}><Icon name="shield" size={14} /> Certify (independent reviewer)</button>
            </form>
          {/if}
        </div>
        <SignPrompt {signer} />
        {#if signer.message}<p class="error" role="alert"><Icon name="alert" size={15} /> {signer.message}</p>{/if}
        {#if form?.message}<p class="error" role="alert"><Icon name="alert" size={15} /> {form.message}</p>{/if}
        {#if form?.certified}<p class="ok" role="status"><Icon name="check" size={15} /> Certified.</p>{/if}
      {:else}<p class="faint">The reconciliation could not be computed.</p>{/if}
    </section>

    <aside class="side">
      <section class="panel pad">
        <h3>Statement coverage</h3>
        {#if data.coverage}
          <p class="faint small">{date(data.coverage.from)} – {date(data.coverage.to)} · {data.coverage.complete ? "complete" : `${data.coverage.gaps.length} gap(s)`}</p>
          <ul class="periods">
            {#each data.coverage.periods as p (p.statementId)}<li class:held={p.status === "held"}><span class="num">{date(p.periodFrom)} – {date(p.periodTo)}</span> <span class="faint small">{p.status} · {p.provenance}</span></li>{/each}
            {#each data.coverage.gaps as g}<li class="gap"><span class="num">{date(g.from)} – {date(g.to)}</span> <span class="small">missing</span></li>{/each}
          </ul>
        {:else}<p class="faint">Unavailable.</p>{/if}
      </section>
      <section class="panel pad">
        <h3>Certifications</h3>
        {#each data.certifications as c (c.reconciliationId)}
          <div class="cert"><strong class="num">{date(c.periodEnd)}</strong> v{c.version} · <span class:bad={c.status !== "certified"}>{c.status}</span>
            <div class="faint small">prepared by {c.preparedBy}, certified by {c.certifiedBy}</div>
            {#if c.withdrawnReason}<div class="small bad">{c.withdrawnReason}</div>{/if}</div>
        {:else}<p class="faint">None yet.</p>{/each}
      </section>
      <section class="panel pad">
        <h3>Exceptions</h3>
        {#each data.exceptions as e (e.caseId)}
          <div class="cert"><span class="pill clay"><span class="dot"></span>{e.requirement}</span> <span class="small">{e.cause}</span>
            <div class="faint small">{e.owner} · due {date(e.dueBy)}{e.hold !== "none" ? ` · holds ${e.hold}` : ""}</div></div>
        {:else}<p class="faint">No open exceptions.</p>{/each}
      </section>
    </aside>
  </div>
{/if}

<style>
  .top { margin-bottom: 24px; }
  .top h1 { margin: 8px 0; }
  .top p { margin: 0; max-width: 70ch; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .tabs a { padding: 8px 14px; border-radius: 999px; border: 1px solid var(--line); color: var(--text-2); text-decoration: none; }
  .tabs a.active { border-color: var(--brass); color: var(--text); }
  .grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; align-items: start; }
  .side { display: grid; gap: 16px; }
  .pad { padding: 22px 24px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .inline { display: flex; gap: 8px; align-items: center; }
  .kv { display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; margin: 16px 0; }
  .kv dd { margin: 0; text-align: right; }
  .pills { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  h3 { font-size: 15px; font-family: var(--sans); font-weight: 600; margin: 18px 0 8px; }
  .r { text-align: right; }
  tr.stale td { color: var(--clay); }
  .bad { color: var(--clay); }
  .ok { color: var(--sage, #8dbba4); display: flex; gap: 6px; align-items: center; }
  .error { color: var(--clay); display: flex; gap: 6px; align-items: center; }
  .problems { list-style: none; padding: 0; display: grid; gap: 4px; color: var(--clay); }
  .acts { display: flex; gap: 10px; margin-top: 18px; }
  .periods { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
  .periods .gap, .periods .held { color: var(--clay); }
  .cert { padding: 8px 0; border-bottom: 1px solid var(--line); }
  @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } }
</style>
