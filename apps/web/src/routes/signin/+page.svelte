<script lang="ts">
  import { enhance } from "$app/forms";
  let { form } = $props();
  let busy = $state(false);
</script>

<svelte:head><title>Sign in · Kuber</title></svelte:head>

<div class="wrap">
  <section class="story">
    <div class="brand">
      <svg viewBox="0 0 64 64" width="40" height="40" aria-hidden="true"><circle cx="32" cy="32" r="21" fill="none" stroke="var(--brass)" stroke-width="3"/><path d="M26 20v24M26 32l12-12M29 30l10 14" stroke="var(--brass-2)" stroke-width="3.2" stroke-linecap="round" fill="none"/></svg>
      <span>Kuber</span>
    </div>
    <h1>Your money,<br /><em>kept in good order.</em></h1>
    <p class="muted lead">Kuber reads your statements, drafts every entry, and asks only when it should. Every figure is double-entry, exact to the paisa, and sealed in a ledger nobody can quietly edit.</p>
    <ul class="points">
      <li><span class="tick">✓</span> Books that balance, always</li>
      <li><span class="tick">✓</span> An agent that follows your policies</li>
      <li><span class="tick">✓</span> Tamper-evident history</li>
    </ul>
  </section>

  <section class="card panel">
    <div class="eyebrow">Sign in</div>
    <h2>Welcome</h2>
    <form method="POST" action="?/signin" use:enhance={() => { busy = true; return async ({ update }) => { busy = false; await update(); }; }}>
      <div class="field">
        <label for="name">Your name</label>
        <input id="name" name="name" autocomplete="name" value={form?.name ?? ""} required minlength="2" placeholder="Laksh" />
      </div>
      <div class="field">
        <label for="workspace">Workspace</label>
        <input id="workspace" name="workspace" value={form?.workspace ?? ""} placeholder="laksh-personal" />
        <span class="hint faint">Your books live in a workspace. Use the same name to come back to them.</span>
      </div>
      {#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
      <button class="btn primary full" disabled={busy}>{busy ? "Opening…" : "Continue"}</button>
    </form>
    <p class="dev faint">Development sign-in. Passkeys replace this before launch.</p>
  </section>
</div>

<style>
  .wrap { min-height: 100vh; display: grid; grid-template-columns: 1.15fr 1fr; gap: 64px; align-items: center;
    padding: 48px clamp(24px, 6vw, 96px);
    background: radial-gradient(1200px 600px at 10% 10%, rgba(201, 168, 106, 0.08), transparent 60%), var(--ink-0); }
  .brand { display: flex; align-items: center; gap: 12px; font-family: var(--serif); font-size: 30px; margin-bottom: 56px; }
  h1 { font-size: clamp(44px, 5vw, 64px); line-height: 1.02; }
  h1 em { color: var(--brass-2); font-style: italic; }
  .lead { max-width: 52ch; font-size: 17px; margin: 24px 0 28px; }
  .points { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; color: var(--text-2); }
  .tick { color: var(--brass); margin-right: 8px; }
  .card { padding: 36px; max-width: 440px; width: 100%; justify-self: center; }
  .card h2 { font-size: 32px; margin: 6px 0 24px; }
  form { display: grid; gap: 18px; }
  .hint { font-size: 12px; }
  .full { width: 100%; height: 44px; margin-top: 4px; }
  .error { color: var(--clay); margin: 0; font-size: 14px; }
  .dev { font-size: 12px; margin: 20px 0 0; text-align: center; }
  @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; gap: 32px; } .brand { margin-bottom: 24px; } }
</style>
