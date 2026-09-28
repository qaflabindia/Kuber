<script lang="ts">
  import { enhance } from "$app/forms";
  import { tick, untrack } from "svelte";
  import { page } from "$app/state";
  import Icon from "$lib/components/Icon.svelte";
  import PlanCard from "$lib/components/PlanCard.svelte";
  import { date as fmtDate, inr, NATURE_LABEL } from "$lib/format";
  import type { Plan } from "$lib/server/api";
  import { VOUCHER_INFO, VOUCHER_TYPES, balanceOn, blankLine, defaultSide, evaluate, template, toInput, type DraftLine, type VoucherType } from "$lib/voucher";

  let { data } = $props();

  // Flow: 1 Enter the voucher → 2 Check (the core simulates it: checks, journal, balances before and after)
  // → 3 Post (or send for approval). Nothing is written before step 3; the core re-checks at commit.
  type Step = "enter" | "check" | "done";
  let step = $state<Step>("enter");
  const initial = (page.url.searchParams.get("type") ?? "payment") as VoucherType;
  let type = $state<VoucherType>(VOUCHER_TYPES.includes(initial) ? initial : "payment");
  // Initial values only: the form owns them afterwards.
  let txnDate = $state(untrack(() => data.today));
  let narration = $state("");
  let reference = $state("");
  let lines = $state<DraftLine[]>(untrack(() => template(type, data.accounts)));
  let touched = $state(false);
  let adjust = $state(false), adjustReason = $state("");
  let plan = $state<Plan | null>(null);
  let outcome = $state<{ status: Plan["status"]; message: string | null } | null>(null);
  let busy = $state(false), error = $state<string | null>(null);
  let form: HTMLFormElement | undefined = $state();

  const parties = $derived(data.parties ?? []);
  const byId = $derived(new Map(data.accounts.map((a) => [a.account_id, a])));
  const v = $derived(evaluate(lines, data.accounts, parties, adjust));
  const needsParty = $derived(lines.some((l) => byId.get(l.account)?.is_control));
  const ready = $derived(v.problems.length === 0 && narration.trim().length >= 2 && !!txnDate && (!adjust || adjustReason.trim().length >= 3));
  const payload = $derived(JSON.stringify(toInput({ type, date: txnDate, narration, reference, lines, adjustmentReason: adjust ? adjustReason : undefined })));

  // Account groups: money accounts first for payments, receipts and contras; then by nature.
  const ORDER = ["asset", "liability", "equity", "income", "expense"];
  const groups = $derived.by(() => {
    const cash = data.accounts.filter((a) => a.is_cash_like);
    const rest = ORDER.map((n) => ({ label: NATURE_LABEL[n] ?? n, items: data.accounts.filter((a) => a.nature === n && !a.is_cash_like && a.account_id !== "OPENING") }));
    return [{ label: "Bank, cash and card", items: cash }, ...rest].filter((g) => g.items.length);
  });
  const partiesFor = (accountId: string) => {
    const nature = byId.get(accountId)?.nature;
    const kind = nature === "asset" ? "customer" : nature === "liability" ? "vendor" : null;
    return parties.filter((p) => !kind || p.kind === kind || p.kind === "both");
  };

  function setType(t: VoucherType) {
    if (t === type) return;
    type = t;
    // Keep what the person typed; start from the type's usual accounts only on an untouched voucher.
    if (!touched) lines = template(t, data.accounts);
  }
  function edit(id: number, field: keyof DraftLine, value: string) {
    touched = true;
    lines = lines.map((l) => {
      if (l.id !== id) return l;
      const next = { ...l, [field]: value };
      // Typing on one side clears the other: a line is a debit or a credit.
      if (field === "debit" && value.trim()) next.credit = "";
      if (field === "credit" && value.trim()) next.debit = "";
      if (field === "account" && !byId.get(value)?.is_control) next.party = "";
      return next;
    });
  }
  async function addLine(focus = true) {
    touched = true;
    const side = defaultSide(type, lines.length, lines.length + 1);
    const l = blankLine();
    lines = [...lines, l];
    // Offer the remaining difference on the new line's natural side.
    if (v.difference !== 0n) lines = balanceOn(lines, l.id);
    else void side;
    if (focus) { await tick(); document.getElementById(`acc-${l.id}`)?.focus(); }
  }
  function removeLine(id: number) { touched = true; lines = lines.length > 2 ? lines.filter((l) => l.id !== id) : lines.map((l) => (l.id === id ? blankLine({ id }) : l)); }
  function balance(id: number) { touched = true; lines = balanceOn(lines, id); }
  function amountKey(e: KeyboardEvent, index: number) {
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && index === lines.length - 1) { e.preventDefault(); void addLine(); }
  }
  function onKey(e: KeyboardEvent) {
    if (step !== "enter") return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && ready) { e.preventDefault(); form?.requestSubmit(); }
    if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); void addLine(); }
  }
  function again(keepType = true) {
    step = "enter"; plan = null; outcome = null; error = null; touched = false; adjust = false; adjustReason = "";
    narration = ""; reference = "";
    lines = template(keepType ? type : "payment", data.accounts);
    tick().then(() => document.getElementById("narration")?.focus());
  }
  const onsettled = (status: Plan["status"], message: string | null) => {
    if (status === "committed" || status === "proposed") { outcome = { status, message }; step = "done"; }
    else if (status === "discarded") { step = "enter"; plan = null; }
  };
  const lineTotal = (j: { lines: { amount: string }[] }) => j.lines.reduce((a, l) => (BigInt(l.amount) > 0n ? a + BigInt(l.amount) : a), 0n);
  const name = (id: string) => byId.get(id)?.name ?? id;
</script>

<svelte:window onkeydown={onKey} />
<svelte:head><title>Record · Kuber</title></svelte:head>

<header class="top">
  <div>
    <div class="eyebrow">Books</div>
    <h1>Record a transaction</h1>
  </div>
  <ol class="steps" aria-label="Progress">
    {#each [["enter", "Enter"], ["check", "Check"], ["done", "Post"]] as [k, label], i}
      <li class:on={step === k} class:past={(step === "check" && i === 0) || (step === "done" && i < 2)} aria-current={step === k ? "step" : undefined}>
        <span class="n">{(step === "check" && i === 0) || (step === "done" && i < 2) ? "✓" : i + 1}</span>{label}
      </li>
    {/each}
  </ol>
</header>

{#if !data.canPrepare}
  <div class="notice" role="status"><Icon name="alert" size={16} /> Your role can read the books but not record transactions. Ask a superuser for the Staff role.</div>
{/if}

<div class="layout">
  <section class="main-col">
    {#if step === "enter"}
      <div class="types" role="tablist" aria-label="Voucher type">
        {#each VOUCHER_TYPES as t}
          <button role="tab" type="button" aria-selected={type === t} class:on={type === t} onclick={() => setType(t)}>{VOUCHER_INFO[t].label}</button>
        {/each}
      </div>
      <p class="hint">{VOUCHER_INFO[type].hint}</p>

      <form bind:this={form} method="POST" action="?/preview" class="panel voucher" use:enhance={() => {
        busy = true; error = null;
        return async ({ result }) => {
          busy = false;
          if (result.type === "success" && result.data?.plan) { plan = result.data.plan as Plan; step = "check"; window.scrollTo({ top: 0, behavior: "smooth" }); }
          else if (result.type === "failure") error = (result.data?.message as string) ?? "Kuber could not check this voucher.";
          else error = "Kuber could not check this voucher.";
        };
      }}>
        <input type="hidden" name="voucher" value={payload} />
        <div class="head-fields">
          <div class="field"><label for="date">Date</label><input id="date" type="date" bind:value={txnDate} required /></div>
          <div class="field grow"><label for="narration">Narration</label>
            <input id="narration" bind:value={narration} maxlength="200" placeholder={type === "payment" ? "e.g. October office rent" : type === "sales" ? "e.g. Consulting, October" : "What is this for?"} required /></div>
          <div class="field"><label for="ref">Reference <span class="faint">(optional)</span></label><input id="ref" bind:value={reference} maxlength="60" placeholder="Invoice / cheque no." /></div>
        </div>

        <div class="grid" role="table" aria-label="Voucher lines">
          <div class="row head" role="row">
            <span role="columnheader">Account</span>{#if needsParty}<span role="columnheader">Party</span>{/if}
            <span role="columnheader" class="r">Debit</span><span role="columnheader" class="r">Credit</span><span role="columnheader">Memo</span><span></span>
          </div>
          {#each lines as l, i (l.id)}
            {@const acc = byId.get(l.account)}
            {@const problem = v.lineProblems.get(l.id)}
            <div class="row" class:bad={!!problem} class:party={needsParty} role="row">
              <select id="acc-{l.id}" aria-label="Account, line {i + 1}" value={l.account} onchange={(e) => edit(l.id, "account", e.currentTarget.value)}>
                <option value="">Choose account…</option>
                {#each groups as g}<optgroup label={g.label}>{#each g.items as a}<option value={a.account_id}>{a.name}</option>{/each}</optgroup>{/each}
              </select>
              {#if needsParty}
                {#if acc?.is_control}
                  <select aria-label="Party, line {i + 1}" value={l.party} onchange={(e) => edit(l.id, "party", e.currentTarget.value)}>
                    <option value="">{partiesFor(l.account).length ? "Choose party…" : "No parties registered"}</option>
                    {#each partiesFor(l.account) as p}<option value={p.partyId} disabled={p.hold}>{p.name}{p.hold ? " (payment hold)" : ""}</option>{/each}
                  </select>
                {:else}<span class="muted dash">—</span>{/if}
              {/if}
              <input class="amt" inputmode="decimal" aria-label="Debit, line {i + 1}" placeholder={defaultSide(type, i, lines.length) === "debit" ? "0.00" : ""}
                value={l.debit} oninput={(e) => edit(l.id, "debit", e.currentTarget.value)} onkeydown={(e) => amountKey(e, i)} />
              <input class="amt" inputmode="decimal" aria-label="Credit, line {i + 1}" placeholder={defaultSide(type, i, lines.length) === "credit" ? "0.00" : ""}
                value={l.credit} oninput={(e) => edit(l.id, "credit", e.currentTarget.value)} onkeydown={(e) => amountKey(e, i)} />
              <input aria-label="Memo, line {i + 1}" value={l.memo} maxlength="200" placeholder="" oninput={(e) => edit(l.id, "memo", e.currentTarget.value)} />
              <span class="acts">
                {#if v.difference !== 0n}<button type="button" class="mini" title="Put the difference on this line" onclick={() => balance(l.id)}>Balance</button>{/if}
                <button type="button" class="icon" aria-label="Remove line {i + 1}" onclick={() => removeLine(l.id)}><Icon name="x" size={14} /></button>
              </span>
              {#if problem}<span class="line-problem" role="alert">{problem}</span>{/if}
            </div>
          {/each}
          <div class="row foot" class:party={needsParty}>
            <button type="button" class="add" onclick={() => addLine()}><Icon name="spark" size={14} /> Add line <kbd>Alt N</kbd></button>
            {#if needsParty}<span></span>{/if}
            <span class="num r tot">{inr(v.debits)}</span><span class="num r tot">{inr(v.credits)}</span>
            <span class="diff" class:ok={v.difference === 0n && v.debits > 0n}>
              {v.debits === 0n ? "" : v.difference === 0n ? "Balanced" : `Difference ${inr(v.difference < 0n ? -v.difference : v.difference)}`}
            </span><span></span>
          </div>
        </div>

        {#if needsParty && data.canAdjust}
          <label class="adjust"><input type="checkbox" bind:checked={adjust} /> Controlled adjustment (no registered party)</label>
          {#if adjust}<div class="field"><label for="adj">Reason</label><input id="adj" bind:value={adjustReason} minlength="3" placeholder="Why this control-account entry is not a party's own posting" /></div>{/if}
        {/if}

        {#if error}<div class="notice bad" role="alert"><Icon name="alert" size={16} /> {error}</div>{/if}

        <div class="submit">
          <span class="muted small">{ready ? "Ready to check. Nothing is posted until you confirm." : [...v.problems, ...(narration.trim().length < 2 ? ["Add a narration"] : [])][0] ?? ""}</span>
          <button class="btn primary" disabled={!ready || busy || !data.canPrepare}>{busy ? "Checking…" : "Check voucher"} <kbd class="k">⌘↵</kbd></button>
        </div>
      </form>

    {:else if step === "check" && plan}
      <div class="back-row">
        <button class="btn quiet" onclick={() => { step = "enter"; plan = null; }}><Icon name="edit" size={14} /> Edit voucher</button>
        <span class="muted small">Kuber checked the voucher against the ledger's rules and shows every balance it changes.</span>
      </div>
      <PlanCard {plan} {onsettled} />

    {:else if step === "done" && outcome && plan}
      <div class="panel result" role="status">
        <div class="big" class:pending={outcome.status === "proposed"}><Icon name={outcome.status === "committed" ? "check" : "confirm"} size={28} /></div>
        <h2>{outcome.status === "committed" ? "Posted to the ledger" : "Sent for approval"}</h2>
        <p class="muted">{outcome.status === "committed"
          ? `${plan.title}. It is in the day book now and in every report once the projection catches up (seconds).`
          : outcome.message ?? "Policy asks a second person to approve this. It is waiting on the Canvas for a superuser."}</p>
        {#if plan.journals[0]}
          <table class="table mini">
            <thead><tr><th>Account</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead>
            <tbody>{#each plan.journals[0].lines as ln}
              <tr><td><a href="/ledger/{encodeURIComponent(ln.accountId)}">{ln.name}</a></td>
                <td class="r num">{BigInt(ln.amount) > 0n ? inr(ln.amount) : ""}</td><td class="r num">{BigInt(ln.amount) < 0n ? inr((-BigInt(ln.amount)).toString()) : ""}</td></tr>
            {/each}</tbody>
          </table>
        {/if}
        <div class="result-acts">
          <button class="btn primary" onclick={() => again(true)}>Record another {VOUCHER_INFO[type].label.toLowerCase()}</button>
          <a class="btn" href="/journals{plan.journals[0] ? `?focus=${plan.journals[0].journalId}` : ""}">Open day book</a>
          <a class="btn quiet" href="/reports/balance-sheet">Balance sheet</a>
        </div>
      </div>
    {/if}
  </section>

  <aside class="side">
    <div class="panel recent">
      <div class="st">Latest entries</div>
      {#if data.recent === null}
        <p class="muted small">Could not load the latest entries.</p>
      {:else if !data.recent.length}
        <p class="muted small">Nothing recorded yet. Your first voucher will appear here.</p>
      {:else}
        <ul>
          {#each data.recent as j (j.journal_id)}
            <li><a href="/journals?focus={j.journal_id}">
              <span class="rn">{j.narration}</span>
              <span class="rm"><span class="chip">{j.voucher_type ?? "journal"}</span> {fmtDate(j.txn_date)} · <span class="num">{inr(lineTotal(j))}</span></span>
            </a></li>
          {/each}
        </ul>
        <a class="more" href="/journals">All entries <Icon name="arrowRight" size={13} /></a>
      {/if}
    </div>
    <div class="panel tips">
      <div class="st">How it posts</div>
      <p class="small muted">Check runs the same rules the ledger will: debits equal credits, the period is open, accounts exist, control accounts name their party. Small amounts post at once; larger ones go to a superuser, as your approval policy sets.</p>
      <p class="small muted">Prefer to type? Ask Kuber: “paid ₹4,500 rent from bank”.</p>
    </div>
  </aside>
</div>

<style>
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .top h1 { margin: 4px 0 0; }
  .steps { display: flex; gap: 6px; list-style: none; margin: 0; padding: 0; }
  .steps li { display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 6px; border-radius: 999px; border: 1px solid var(--line-soft); color: var(--text-3); font-size: 13px; font-weight: 600; }
  .steps .n { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--ink-2); font-size: 11.5px; }
  .steps li.on { color: var(--text); border-color: rgba(201,168,106,.45); background: var(--brass-wash); }
  .steps li.on .n { background: var(--brass); color: var(--brass-ink); }
  .steps li.past { color: var(--sage); } .steps li.past .n { background: var(--sage-wash); color: var(--sage); }

  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 22px; align-items: start; }
  .types { display: flex; gap: 4px; padding: 4px; border-radius: 12px; background: var(--ink-1); border: 1px solid var(--line-soft); width: fit-content; max-width: 100%; overflow-x: auto; }
  .types button { border: 0; background: none; color: var(--text-2); font: 600 13.5px var(--sans); padding: 8px 14px; border-radius: 9px; cursor: pointer; white-space: nowrap; }
  .types button:hover { color: var(--text); background: var(--ink-2); }
  .types button.on { background: var(--brass); color: var(--brass-ink); }
  .hint { color: var(--text-3); font-size: 13px; margin: 10px 2px 14px; max-width: 75ch; }

  .voucher { padding: 18px; display: grid; gap: 16px; }
  .head-fields { display: grid; grid-template-columns: 170px 1fr 200px; gap: 12px; }
  .field { display: grid; gap: 6px; } .field label { font-size: 12px; color: var(--text-3); font-weight: 600; }
  .grid { display: grid; gap: 6px; }
  .row { display: grid; grid-template-columns: minmax(180px, 2fr) 130px 130px minmax(100px, 1fr) 96px; gap: 8px; align-items: center; position: relative; }
  .row.party { grid-template-columns: minmax(170px, 2fr) minmax(140px, 1.3fr) 120px 120px minmax(90px, 1fr) 96px; }
  .row.head { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-3); font-weight: 600; padding: 0 2px; }
  .row select, .row input { min-height: 38px; padding: 8px 10px; }
  .row.bad select, .row.bad input { border-color: rgba(223,154,128,.55); }
  .amt { text-align: right; font-variant-numeric: tabular-nums; }
  .r { text-align: right; }
  .dash { padding-left: 10px; }
  .acts { display: flex; gap: 4px; justify-content: flex-end; }
  .mini { border: 1px solid var(--line); background: var(--ink-2); color: var(--brass-2); font: 600 11.5px var(--sans); border-radius: 7px; padding: 5px 8px; cursor: pointer; }
  .icon { border: 0; background: none; color: var(--text-3); width: 30px; height: 30px; border-radius: 7px; cursor: pointer; display: grid; place-items: center; }
  .icon:hover { background: var(--ink-2); color: var(--clay); }
  .line-problem { grid-column: 1 / -1; font-size: 12px; color: var(--clay); margin: -2px 2px 2px; }
  .row.foot { border-top: 1px solid var(--line-soft); padding-top: 10px; margin-top: 4px; }
  .add { display: inline-flex; align-items: center; gap: 8px; border: 1px dashed var(--line); background: none; color: var(--text-2); border-radius: 9px; padding: 8px 12px; cursor: pointer; font: 600 13px var(--sans); width: fit-content; }
  .add:hover { color: var(--text); border-color: var(--brass); }
  .tot { font-weight: 700; padding-right: 10px; }
  .diff { font-size: 12.5px; font-weight: 700; color: var(--clay); } .diff.ok { color: var(--sage); }
  kbd { font: 600 10.5px var(--sans); padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); color: var(--text-3); }
  .k { margin-left: 8px; border-color: rgba(0,0,0,.2); color: inherit; opacity: .7; }
  .adjust { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--text-2); } .adjust input { width: auto; min-height: 0; }
  .submit { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--line-soft); padding-top: 14px; }
  .small { font-size: 12.5px; }
  .notice { display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-radius: var(--r-md); background: var(--ink-2); color: var(--text-2); font-size: 13px; margin-bottom: 14px; }
  .notice.bad { background: var(--clay-wash); color: var(--clay); margin: 0; }
  .back-row { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }

  .result { padding: 28px; text-align: center; display: grid; gap: 12px; justify-items: center; }
  .result h2 { margin: 0; }
  .result .big { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; background: var(--sage-wash); color: var(--sage); animation: pop .3s var(--ease); }
  .result .big.pending { background: var(--brass-wash); color: var(--brass-2); }
  .result table { max-width: 520px; width: 100%; text-align: left; }
  .result-acts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 6px; }
  @keyframes pop { from { transform: scale(.6); opacity: 0; } }

  .side { display: grid; gap: 14px; position: sticky; top: 24px; }
  .recent, .tips { padding: 16px; }
  .st { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-3); font-weight: 600; margin-bottom: 10px; }
  .recent ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .recent li a { display: grid; gap: 2px; padding: 8px; border-radius: 8px; color: var(--text-2); }
  .recent li a:hover { background: var(--ink-2); color: var(--text); }
  .rn { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rm { font-size: 11.5px; color: var(--text-3); }
  .chip { font-size: 10.5px; text-transform: capitalize; padding: 1px 6px; border-radius: 5px; background: var(--ink-3); color: var(--text-2); }
  .more { display: inline-flex; gap: 6px; align-items: center; margin-top: 8px; font-size: 12.5px; color: var(--brass-2); }
  .tips p { margin: 0 0 8px; }

  @media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } .side { position: static; } }
  @media (max-width: 760px) {
    .head-fields { grid-template-columns: 1fr 1fr; } .head-fields .grow { grid-column: 1 / -1; order: -1; }
    .row, .row.party { grid-template-columns: 1fr 1fr; }
    .row > select:first-child { grid-column: 1 / -1; }
    .row.head { display: none; }
    .row { padding: 10px; border: 1px solid var(--line-soft); border-radius: 10px; }
    .row.foot { border: 0; padding: 10px 0 0; }
  }
</style>
