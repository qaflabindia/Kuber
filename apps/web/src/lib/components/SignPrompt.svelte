<script lang="ts">
  /**
   * What the person is about to sign, rendered by the core from the command itself (amount, payees,
   * accounts, book, periods), shown before the passkey is asked. The passkey then signs a digest of
   * exactly this command; Kuber stores the signature with the change it authorizes.
   */
  import { inr, date } from "$lib/format";
  import type { Signer } from "$lib/sign.svelte";
  import Icon from "./Icon.svelte";

  let { signer }: { signer: Signer } = $props();
  const p = $derived(signer.prompt);
  const amt = (paise: string) => (paise === "0" ? "" : inr(paise));
</script>

{#if p}
  <div class="sign" role="dialog" aria-modal="false" aria-labelledby="sign-h">
    <div class="eyebrow"><Icon name="shield" size={13} /> Sign with your passkey</div>
    <h4 id="sign-h">{p.summary.title}</h4>
    {#if p.reason}<p class="faint small">Needed because {p.reason}.</p>{/if}
    <dl class="kv">
      <dt>Book</dt><dd>{p.summary.book}</dd>
      {#if p.summary.amountPaise}<dt>Amount</dt><dd class="num strong">{inr(p.summary.amountPaise)}</dd>{/if}
      {#each p.summary.payees as y}<dt>Payee</dt><dd>{y.name ?? y.partyId}{y.name ? ` (${y.partyId})` : ""}</dd>{/each}
      {#each p.summary.periods as x}<dt>Locks</dt><dd>everything up to {date(x.periodEnd)} ({x.level})</dd>{/each}
    </dl>
    {#if p.summary.accounts.length}
      <table class="table mini">
        <thead><tr><th>Account</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead>
        <tbody>{#each p.summary.accounts as a}<tr><td>{a.name} <span class="faint mono">{a.accountId}</span></td><td class="r num">{amt(a.debitPaise)}</td><td class="r num">{amt(a.creditPaise)}</td></tr>{/each}</tbody>
      </table>
    {/if}
    <p class="faint small">Your passkey signs a fingerprint of exactly this command (<span class="mono">{p.digest.slice(0, 16)}…</span>), valid until
      {new Date(p.expiresAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}. It cannot be used for anything else.</p>
    <div class="acts">
      <button type="button" class="btn quiet sm" onclick={() => signer.cancel()}>Cancel</button>
      <button type="button" class="btn primary sm" onclick={() => signer.confirm()}><Icon name="shield" size={14} /> Sign with passkey</button>
    </div>
  </div>
{/if}

<style>
  .sign { border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: grid; gap: 8px; background: var(--panel-2, transparent); }
  h4 { margin: 0; font-family: var(--serif); font-weight: 500; font-size: 19px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 0; font-size: 13.5px; }
  .kv dt { color: var(--text-3); } .kv dd { margin: 0; }
  .strong { font-weight: 600; }
  .mini :global(th), .mini :global(td) { padding: 6px 10px; font-size: 13px; }
  .r { text-align: right; }
  .small { font-size: 12.5px; margin: 0; }
  .mono { font-family: var(--mono, monospace); font-size: 12px; }
  .acts { display: flex; gap: 6px; justify-content: flex-end; }
</style>
