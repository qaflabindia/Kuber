<script lang="ts">
  import { enhance } from "$app/forms";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { startAuthentication, startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
  let { form, data } = $props();
  let busy = $state(false);
  let mode = $state<"signin" | "register">("signin");
  let message = $state("");
  let workspace = $state(""), name = $state(""), code = $state("");

  /** Passkey ceremony: options from the core (via the BFF), the browser's authenticator, then verification by the core. */
  async function passkey(e: SubmitEvent) {
    e.preventDefault();
    message = "";
    if (!browserSupportsWebAuthn()) { message = "This browser does not support passkeys."; return; }
    busy = true;
    try {
      const next = page.url.searchParams.get("next");
      const q = next ? `?next=${encodeURIComponent(next)}` : "";
      const r = await fetch(`/signin/passkey/options`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, workspace, name, code }) });
      if (!r.ok) { message = (await r.json().catch(() => null))?.message ?? "Could not start sign-in."; return; }
      const { options } = await r.json();
      const response = mode === "register" ? await startRegistration({ optionsJSON: options }) : await startAuthentication({ optionsJSON: options });
      const v = await fetch(`/signin/passkey/verify${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response }) });
      if (!v.ok) { message = (await v.json().catch(() => null))?.message ?? "That passkey was not accepted."; return; }
      await goto((await v.json()).redirect, { invalidateAll: true });
    } catch (err) {
      message = err instanceof Error && err.name === "NotAllowedError" ? "Passkey request was cancelled." : err instanceof Error ? err.message : "Sign-in failed.";
    } finally { busy = false; }
  }
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
    <div class="eyebrow">{mode === "signin" ? "Sign in" : "Create or join a workspace"}</div>
    <h2>{mode === "signin" ? "Welcome back" : "Welcome"}</h2>
    <form class="pk" onsubmit={passkey}>
      <div class="field">
        <label for="pk-workspace">Workspace</label>
        <input id="pk-workspace" bind:value={workspace} required placeholder="laksh-personal" autocomplete="organization" />
      </div>
      {#if mode === "register"}
        <div class="field">
          <label for="pk-name">Your name</label>
          <input id="pk-name" bind:value={name} required minlength="2" autocomplete="name" placeholder="Laksh" />
        </div>
        <div class="field">
          <label for="pk-code">Invitation code</label>
          <input id="pk-code" bind:value={code} placeholder="Leave empty to create a new workspace" autocomplete="off" />
          <span class="hint faint">Joining someone's books? Use the code they sent you. Otherwise you become the owner of a new workspace.</span>
        </div>
      {/if}
      {#if message}<p class="error" role="alert">{message}</p>{/if}
      <button class="btn primary full" disabled={busy}>{busy ? "Waiting for your passkey…" : mode === "signin" ? "Sign in with a passkey" : "Create a passkey"}</button>
    </form>
    <button class="btn quiet full switch" type="button" onclick={() => { mode = mode === "signin" ? "register" : "signin"; message = ""; }}>
      {mode === "signin" ? "New here, or invited? Create a passkey" : "Already have a passkey? Sign in"}
    </button>

    {#if data.devSignIn}
      <form method="POST" action="?/dev" class="dev-form" use:enhance={() => { busy = true; return async ({ update }) => { busy = false; await update(); }; }}>
        <div class="eyebrow dev-label">Development sign-in · KUBER_DEV_SIGNIN=true · not secure</div>
        <div class="field">
          <label for="name">Your name</label>
          <input id="name" name="name" autocomplete="name" value={form?.name ?? ""} required minlength="2" placeholder="Laksh" />
        </div>
        <div class="field">
          <label for="workspace">Workspace</label>
          <input id="workspace" name="workspace" value={form?.workspace ?? ""} placeholder="laksh-personal" />
        </div>
        {#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
        <button class="btn primary full" disabled={busy}>Continue without a passkey</button>
      </form>
    {/if}
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
  .switch { margin-top: 12px; }
  .dev-form { display: grid; gap: 14px; margin-top: 28px; padding-top: 20px; border-top: 1px dashed var(--clay); }
  .dev-label { color: var(--clay); }
  @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; gap: 32px; } .brand { margin-bottom: 24px; } }
</style>
