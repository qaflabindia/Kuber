<script lang="ts">
  import { enhance } from "$app/forms";
  import { goto } from "$app/navigation";
  import { date, inr } from "$lib/format";
  import Icon from "$lib/components/Icon.svelte";
  import PlanCard from "$lib/components/PlanCard.svelte";

  let { data, form } = $props();
  const st = $derived(data.status);
  const tasks = $derived(st?.checklist?.tasks ?? []);
  let open = $state<string | null>(null);
  let busy = $state(false);
  const act = () => { busy = true; return async ({ update }: { update: () => Promise<void> }) => { busy = false; open = null; await update(); }; };
  const stateLabel: Record<string, string> = { open: "Open", awaiting_review: "Awaiting review", done: "Done", not_applicable: "Not applicable" };
  const pill = (t: { state: string; overdue: boolean }) => t.state === "done" ? "sage" : t.overdue ? "clay" : t.state === "awaiting_review" ? "brass" : "";
</script>

<svelte:head><title>Close · Kuber</title></svelte:head>

<header class="top">
  <div>
    <div class="eyebrow">Period close</div>
    <h1>Close of {date(data.period)}</h1>
    {#if !st}
      <p class="error" role="status">The close status is unavailable right now; nothing is shown as complete.</p>
    {:else if st.certified}
      <p class="muted"><span class="pill sage"><span class="dot"></span>Certified</span> Version {st.certified.version} by {st.certified.certifiedBy} · journals to {st.certified.closeSeq}{st.hardLocked ? " · hard-closed" : " · soft close"}</p>
    {:else}
      <p class="muted">{st.blockers.length ? `${st.blockers.length} item${st.blockers.length === 1 ? "" : "s"} before the close can be certified.` : "Everything is in place: ready to certify."}</p>
    {/if}
  </div>
  {#if data.overview?.checklists.length}
    <div class="field">
      <label for="period">Period</label>
      <select id="period" value={data.period} onchange={(e) => goto(`/close?period=${(e.currentTarget as HTMLSelectElement).value}`)}>
        {#each [...data.overview.checklists].reverse() as c}<option value={c.periodEnd}>{date(c.periodEnd)}</option>{/each}
      </select>
    </div>
  {/if}
</header>

{#if form?.plan}<div class="plan"><PlanCard plan={form.plan} /></div>{/if}
{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
{#if data.overview && !data.overview.bankReconciliationService}
  <p class="faint small"><Icon name="alert" size={14} /> No bank reconciliation service is installed: bank tasks cannot be evidenced, so a book with bank accounts cannot be certified yet.</p>
{/if}

{#if st}
  {#if !st.checklist}
    <div class="panel empty"><p class="muted">No close checklist for this period. A superuser or controller creates it (owners, deadlines) from the template.</p></div>
  {:else}
    <section class="panel">
      <div class="panel-head"><h2>Checklist</h2><span class="faint">{tasks.filter((t) => t.state === "done").length} of {tasks.filter((t) => t.applicable).length} done</span></div>
      <table class="table">
        <thead><tr><th>Task</th><th>Owner</th><th>Deadline</th><th>Evidence</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {#each tasks as t (t.taskId)}
            <tr class:na={!t.applicable}>
              <td><strong>{t.area}</strong> <span class="faint">{t.title}</span>{#if t.dependsOn.length}<div class="faint small">after {t.dependsOn.join(", ")}</div>{/if}
                {#if t.withdrawnReason}<div class="small clay-text">{t.withdrawnReason}</div>{/if}</td>
              <td>{t.owner ?? "—"}</td>
              <td class="num">{t.applicable ? date(t.deadline) : "—"}</td>
              <td class="small">{#if t.evidence.length}{t.evidence.map((e) => `${e.kind.replace(/_/g, " ")} ${e.id.slice(0, 18)}`).join(", ")}{:else if t.applicable}<span class="faint">{t.evidenceKinds.join(" or ").replace(/_/g, " ")}</span>{/if}</td>
              <td>{#if t.applicable}<span class="pill {pill(t)}"><span class="dot"></span>{t.overdue ? "Overdue" : stateLabel[t.state]}</span>{#if t.reviewedBy}<div class="faint small">{t.completedBy} · reviewed by {t.reviewedBy}</div>{/if}
                  {:else}<span class="faint small">{t.reason}</span>{/if}</td>
              <td>{#if t.state === "open" && t.owner === data.me}<button class="btn quiet sm" onclick={() => (open = open === t.taskId ? null : t.taskId)}>Complete</button>{/if}</td>
            </tr>
            {#if open === t.taskId}
              <tr><td colspan="6">
                <form method="POST" action="?/complete" class="inline" use:enhance={act}>
                  <input type="hidden" name="period" value={data.period} /><input type="hidden" name="taskId" value={t.taskId} />
                  <div class="field"><label for="kind-{t.taskId}">Evidence</label>
                    <select id="kind-{t.taskId}" name="kind">{#each t.evidenceKinds as k}<option value={k}>{k.replace(/_/g, " ")}</option>{/each}</select></div>
                  <div class="field grow"><label for="ref-{t.taskId}">Reference</label><input id="ref-{t.taskId}" name="ref" required /></div>
                  <div class="field grow"><label for="hash-{t.taskId}">SHA-256</label><input id="hash-{t.taskId}" name="hash" pattern="[0-9a-f]+" minlength="64" maxlength="64" required /></div>
                  <button class="btn primary" disabled={busy}>Prepare for review</button>
                </form>
              </td></tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Account substantiation</h2><span class="faint">every balance-sheet account with a balance or activity, and every bank account</span></div>
      <table class="table">
        <thead><tr><th>Account</th><th class="r">GL balance</th><th>Source</th><th>Status</th><th>Preparer · approver</th><th></th></tr></thead>
        <tbody>
          {#each st.substantiations as a (a.accountId)}
            <tr>
              <td><strong>{a.accountId}</strong> <span class="faint">{a.name}</span></td>
              <td class="r num">{inr(a.glBalance)}</td>
              <td class="small">{a.source?.replace(/_/g, " ") ?? "—"}</td>
              <td><span class="pill {a.status === 'approved' ? 'sage' : 'clay'}"><span class="dot"></span>{a.status === "approved" ? "Approved" : a.status === "stale" ? "Balance changed" : "Missing"}</span></td>
              <td class="small">{a.preparedBy ? `${a.preparedBy} · ${a.approvedBy}` : "—"}</td>
              <td>{#if a.status !== "approved" && !st.certified}<button class="btn quiet sm" onclick={() => (open = open === a.accountId ? null : a.accountId)}>Prepare</button>{/if}</td>
            </tr>
            {#if open === a.accountId}
              <tr><td colspan="6">
                <form method="POST" action="?/substantiate" class="inline" use:enhance={act}>
                  <input type="hidden" name="period" value={data.period} /><input type="hidden" name="accountId" value={a.accountId} />
                  <div class="field"><label for="sb-{a.accountId}">Supporting balance (₹)</label><input id="sb-{a.accountId}" name="sourceBalance" placeholder="when there is no subledger" /></div>
                  <div class="field"><label for="k-{a.accountId}">Evidence</label><select id="k-{a.accountId}" name="kind"><option value="document">document</option><option value="bank_reconciliation">bank reconciliation</option></select></div>
                  <div class="field grow"><label for="r-{a.accountId}">Reference</label><input id="r-{a.accountId}" name="ref" /></div>
                  <div class="field grow"><label for="h-{a.accountId}">SHA-256</label><input id="h-{a.accountId}" name="hash" /></div>
                  <button class="btn primary" disabled={busy}>Prepare for approval</button>
                </form>
              </td></tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Completeness</h2></div>
      {#if st.findings.length}
        <ul class="findings">{#each st.findings as f}<li><Icon name="alert" size={14} /> <strong>{f.label}</strong> <span class="faint">{f.detail}</span></li>{/each}</ul>
      {:else}<p class="muted pad">No expected source is missing and nothing is pending in the period.</p>{/if}
    </section>

    <section class="panel controls">
      {#if !st.certified}
        <form method="POST" action="?/certify" use:enhance={act}>
          <input type="hidden" name="period" value={data.period} />
          <button class="btn primary" disabled={busy}><Icon name="check" size={15} /> Prepare certification</button>
          <span class="faint small">A superuser approves with a passkey signature; the plan shows every blocking check first.</span>
        </form>
      {:else if !st.hardLocked}
        <form method="POST" action="?/reopen" class="inline" use:enhance={act}>
          <input type="hidden" name="period" value={data.period} />
          <div class="field grow"><label for="reason">Reason to reopen</label><input id="reason" name="reason" minlength="10" required /></div>
          <button class="btn" disabled={busy}>Prepare reopen</button>
          <span class="faint small">Withdraws the close, the substantiations and the bank reconciliations of the period.</span>
        </form>
      {:else}<p class="muted pad">Hard-closed: its journals are immutable. A correction is a restatement in an open period.</p>{/if}
    </section>

    {#if st.closes.length}
      <section class="panel">
        <div class="panel-head"><h2>Certified closes</h2></div>
        <table class="table"><tbody>
          {#each st.closes as c (c.closeId)}
            <tr><td>Version {c.version}</td><td class="small faint">{c.contentHash.slice(0, 16)}…</td><td>{c.certifiedBy}</td>
              <td>{#if c.status === "certified"}<span class="pill sage"><span class="dot"></span>Certified</span>{:else}<span class="pill clay"><span class="dot"></span>Withdrawn</span> <span class="faint small">{c.withdrawnReason}</span>{/if}</td></tr>
          {/each}
        </tbody></table>
      </section>
    {/if}
  {/if}
{/if}

<style>
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 24px; }
  .top h1 { margin: 8px 0; }
  .top p { margin: 0; }
  section.panel, .empty { margin-bottom: 18px; }
  .plan { margin-bottom: 18px; }
  .panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .small { font-size: 12.5px; }
  tr.na td { opacity: 0.6; }
  .clay-text { color: var(--clay); }
  .inline { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .grow { flex: 1; min-width: 180px; }
  .findings { margin: 0; padding: 12px 20px; list-style: none; display: grid; gap: 8px; }
  .findings :global(svg) { color: var(--clay); }
  .pad { padding: 12px 20px; margin: 0; }
  .controls { padding: 16px 20px; }
  .controls form { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
</style>
