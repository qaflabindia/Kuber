<script lang="ts">
  import { enhance } from "$app/forms";
  import { date } from "$lib/format";
  import Icon from "$lib/components/Icon.svelte";

  let { data, form } = $props();

  const ROLE_LABEL: Record<string, string> = { owner: "Owner", controller: "Controller", preparer: "Preparer", approver: "Approver", auditor: "Auditor", member: "Member", agent: "Agent" };
  const ROLE_HINT: Record<string, string> = {
    owner: "Everything, including members and separation settings.",
    controller: "Posts, closes periods and approves plans; cannot manage members.",
    preparer: "Captures statements and prepares plans for someone else to approve.",
    approver: "Reviews drafts and approves plans (not period operations).",
    auditor: "Reads the books and the member list; changes nothing.",
    member: "Reads, captures and prepares plans.",
  };

  let busy = $state<string | null>(null);
  let editing = $state<string | null>(null);
  let confirming = $state<string | null>(null);
  let copied = $state(false);
  // Invitation form
  let invScope = $state<"all" | "some">("all");
  // Edit form (one member at a time)
  let editRole = $state(""), editScope = $state<"all" | "some">("all"), editBooks = $state<string[]>([]);

  const active = $derived(data.members.filter((m) => m.status === "active"));
  const revoked = $derived(data.members.filter((m) => m.status !== "active"));
  const allBooks = $derived([...new Set([...data.books, ...data.members.flatMap((m) => m.books ?? [])])]);
  const limitRupees = $derived(data.separation.sodLimitPaise ? (BigInt(data.separation.sodLimitPaise) / 100n).toLocaleString("en-IN") : "");
  const people = $derived(active.filter((m) => m.role !== "agent").length);

  function startEdit(m: (typeof data.members)[number]) {
    editing = m.principal; confirming = null;
    editRole = m.role; editScope = m.books ? "some" : "all"; editBooks = [...(m.books ?? [])];
  }
  const act = (key: string, after?: () => void) => () => {
    busy = key;
    return async ({ result, update }: { result: { type: string }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
      busy = null;
      if (result.type === "success") { after?.(); }
      await update({ reset: key === "invite" && result.type === "success" });
    };
  };
  async function copy(code: string) {
    try { await navigator.clipboard.writeText(code); copied = true; setTimeout(() => (copied = false), 2500); } catch { copied = false; }
  }
  const scopeText = (books: string[] | null) => (books === null ? "Every book" : books.join(", "));
  type Result = { action?: string; principal?: string; message?: string; ok?: boolean };
  /** The last action's message, when it was about this form (and member). */
  const msgFor = (action: string, principal?: string) => {
    const f = form as Result | null | undefined;
    return f?.action === action && (principal === undefined || f.principal === principal) && f.message ? { text: f.message, ok: !!f.ok } : null;
  };
</script>

<svelte:head><title>Members · Kuber</title></svelte:head>

<header class="top">
  <div class="eyebrow">Workspace · {data.members[0]?.tenant ?? ""}</div>
  <h1>Members and access</h1>
  <p class="muted">Who can see and change these books, over which books, and how they sign in. Every change is checked by Kuber's core against your own role.</p>
  {#if !data.canManage}<p class="pill note"><Icon name="shield" size={13} /> Read-only: only an owner changes members.</p>{/if}
</header>

{#if data.canManage}
  <section class="panel block" aria-labelledby="invite-h">
    <div class="panel-head"><h2 id="invite-h">Invite someone</h2><span class="faint small">They create a passkey with a one-time code</span></div>
    <div class="panel-body">
      {#if form?.action === "invite" && "invitation" in form && form.invitation}
        {@const inv = form.invitation}
        <div class="code-box" role="status" aria-live="polite">
          <div class="eyebrow">One-time invitation code for {form.displayName}</div>
          <div class="code-row">
            <code class="code" aria-label="Invitation code">{inv.token}</code>
            <button type="button" class="btn sm" onclick={() => copy(inv.token)}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p class="small muted">Shown once: Kuber keeps only its hash. It works once, until {date(inv.expiresAt)} ({new Date(inv.expiresAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}).
            They open the sign-in page, choose <strong>Create a passkey</strong>, enter workspace <strong>{data.members[0]?.tenant}</strong> and this code.
            They join as <span class="mono">{inv.principal}</span> · {scopeText(inv.books)}.</p>
        </div>
      {/if}
      <form method="POST" action="?/invite" class="invite" use:enhance={act("invite")}>
        <div class="field">
          <label for="inv-name">Name</label>
          <input id="inv-name" name="displayName" required minlength="2" maxlength="80" autocomplete="off" placeholder="Asha Menon" />
        </div>
        <div class="field">
          <label for="inv-role">Role</label>
          <select id="inv-role" name="role" required aria-describedby="inv-role-hint">
            {#each data.roles as r}<option value={r} selected={r === "preparer"}>{ROLE_LABEL[r]}</option>{/each}
          </select>
          <span id="inv-role-hint" class="hint faint">Owners manage members; controllers and approvers approve; preparers and members prepare; auditors only read.</span>
        </div>
        <div class="field">
          <label for="inv-ttl">Code expires in</label>
          <select id="inv-ttl" name="ttlHours">
            <option value="24">1 day</option><option value="72" selected>3 days</option><option value="168">7 days</option><option value="336">14 days</option>
          </select>
        </div>
        <fieldset class="scope">
          <legend>Books</legend>
          <label class="opt"><input type="radio" name="scope" value="all" bind:group={invScope} /> Every book</label>
          <label class="opt"><input type="radio" name="scope" value="some" bind:group={invScope} /> Only these books</label>
          {#if invScope === "some"}
            <div class="books">{#each allBooks as b}<label class="opt"><input type="checkbox" name="books" value={b} /> {b}</label>{/each}</div>
          {/if}
        </fieldset>
        <div class="row-end">
          {#if msgFor("invite")}<p class="error small" role="alert">{msgFor("invite")?.text}</p>{/if}
          <button class="btn primary" disabled={busy === "invite"}>{busy === "invite" ? "Creating…" : "Create invitation"}</button>
        </div>
      </form>
    </div>
  </section>
{/if}

<section class="block" aria-labelledby="members-h">
  <div class="section-head"><h2 id="members-h">{active.length} {active.length === 1 ? "member" : "members"}</h2><span class="faint small">{people} {people === 1 ? "person" : "people"}</span></div>
  <ul class="list">
    {#each active as m (m.principal)}
      {@const isMe = m.principal === data.me.principal}
      {@const manageable = data.canManage && m.role !== "agent"}
      <li class="panel member">
        <div class="m-head">
          <div class="avatar" aria-hidden="true">{m.displayName[0]?.toUpperCase()}</div>
          <div class="m-id">
            <h3>{m.displayName}{#if isMe}<span class="faint you"> · you</span>{/if}</h3>
            <div class="mono faint small">{m.principal}</div>
          </div>
        </div>
        <div class="pills">
          <span class="pill" class:brass={m.role === "owner"}>{ROLE_LABEL[m.role] ?? m.role}</span>
          <span class="pill"><Icon name="book" size={12} /> {scopeText(m.books)}</span>
          <span class="pill sage"><span class="dot"></span>Active</span>
          {#if m.role !== "agent"}
            <span class="pill" class:clay={!m.credentials.length}><Icon name="key" size={12} /> {m.credentials.length} {m.credentials.length === 1 ? "passkey" : "passkeys"}</span>
          {:else}
            <span class="pill">Granted by configuration</span>
          {/if}
        </div>

        {#if editing === m.principal}
          <form method="POST" action="?/change" class="edit" use:enhance={act(`change:${m.principal}`, () => (editing = null))}>
            <input type="hidden" name="principal" value={m.principal} />
            <div class="field">
              <label for="role-{m.principal}">Role</label>
              <select id="role-{m.principal}" name="role" bind:value={editRole} aria-describedby="role-hint-{m.principal}">
                {#each data.roles as r}<option value={r}>{ROLE_LABEL[r]}</option>{/each}
              </select>
              <span id="role-hint-{m.principal}" class="hint faint">{ROLE_HINT[editRole] ?? ""}{editRole !== m.role ? " A role change gives them a new principal; they sign in again with the same passkey." : ""}</span>
            </div>
            <fieldset class="scope">
              <legend>Books</legend>
              <label class="opt"><input type="radio" name="scope" value="all" bind:group={editScope} /> Every book</label>
              <label class="opt"><input type="radio" name="scope" value="some" bind:group={editScope} /> Only these books</label>
              {#if editScope === "some"}
                <div class="books">{#each allBooks as b}<label class="opt"><input type="checkbox" name="books" value={b} bind:group={editBooks} /> {b}</label>{/each}</div>
              {/if}
            </fieldset>
            <div class="acts">
              <button type="button" class="btn quiet sm" onclick={() => (editing = null)}>Cancel</button>
              <button class="btn primary sm" disabled={busy === `change:${m.principal}`}>Save access</button>
            </div>
          </form>
        {:else if manageable}
          <div class="acts">
            <button type="button" class="btn sm" onclick={() => startEdit(m)}><Icon name="edit" size={14} /> Change access</button>
            {#if confirming === m.principal}
              <form method="POST" action="?/revoke" use:enhance={act(`revoke:${m.principal}`, () => (confirming = null))} class="confirm">
                <input type="hidden" name="principal" value={m.principal} />
                <span class="small attention">{isMe ? "Revoke your own access?" : `Revoke ${m.displayName}'s access?`}</span>
                <button class="btn sm danger" disabled={busy === `revoke:${m.principal}`}>Revoke</button>
                <button type="button" class="btn quiet sm" onclick={() => (confirming = null)}>Keep</button>
              </form>
            {:else}
              <button type="button" class="btn quiet sm" onclick={() => { confirming = m.principal; editing = null; }}>Revoke access…</button>
            {/if}
          </div>
        {/if}

        {#if m.credentials.length}
          <details class="keys">
            <summary><Icon name="key" size={13} /> Passkeys</summary>
            <ul>
              {#each m.credentials as c (c.credentialId)}
                <li>
                  <div class="k-text">
                    <span class="mono small" title={c.credentialId}>…{c.credentialId.slice(-10)}</span>
                    <span class="faint small">Added {date(c.createdAt)} · {c.lastUsedAt ? `last used ${date(c.lastUsedAt)}` : "never used"}{c.transports.length ? ` · ${c.transports.join(", ")}` : ""}</span>
                  </div>
                  {#if data.canManage}
                    <form method="POST" action="?/revokeCredential" use:enhance={act(`cred:${c.credentialId}`)}>
                      <input type="hidden" name="credentialId" value={c.credentialId} />
                      <input type="hidden" name="principal" value={m.principal} />
                      <button class="btn quiet sm" disabled={busy === `cred:${c.credentialId}`} aria-label="Revoke passkey ending {c.credentialId.slice(-10)} of {m.displayName}">Revoke</button>
                    </form>
                  {/if}
                </li>
              {/each}
            </ul>
          </details>
        {/if}
        {#each ["change", "revoke", "revokeCredential"] as a}
          {@const msg = msgFor(a, m.principal)}
          {#if msg}<p class="small" class:error={!msg.ok} role={msg.ok ? "status" : "alert"}>{msg.text}</p>{/if}
        {/each}
      </li>
    {/each}
  </ul>

  {#if revoked.length}
    <details class="revoked">
      <summary>{revoked.length} revoked {revoked.length === 1 ? "principal" : "principals"}</summary>
      <ul>{#each revoked as m (m.principal)}<li><span>{m.displayName}</span> <span class="mono faint small">{m.principal}</span> <span class="pill clay">Revoked</span></li>{/each}</ul>
    </details>
  {/if}
</section>

<section class="panel block" aria-labelledby="sod-h">
  <div class="panel-head"><h2 id="sod-h">Separation of duties</h2></div>
  <div class="panel-body">
    <p class="muted small lead">Period operations, and amounts above the approval limit, need approval by someone other than their preparer, confirmed with a passkey.</p>
    {#if data.canSettings}
      <form method="POST" action="?/separation" class="sod" use:enhance={act("separation")}>
        <div class="field">
          <label for="sod-limit">Approval limit (₹)</label>
          <input id="sod-limit" name="sodLimit" inputmode="decimal" autocomplete="off" value={limitRupees} placeholder="Policy default" aria-describedby="sod-limit-hint" />
          <span id="sod-limit-hint" class="hint faint">Leave empty to use each policy's own limit.</span>
        </div>
        <label class="opt solo">
          <input type="checkbox" name="soloOwner" checked={data.separation.soloOwner} aria-describedby="solo-hint" />
          <span>Single-owner exception<span id="solo-hint" class="hint faint block-hint">While the owner is the only person in the workspace, they may approve their own plans. It lapses as soon as someone else joins.</span></span>
        </label>
        <div class="row-end">
          {#if msgFor("separation")}{@const msg = msgFor("separation")!}<p class="small" class:error={!msg.ok} role={msg.ok ? "status" : "alert"}>{msg.text}</p>{/if}
          <button class="btn primary" disabled={busy === "separation"}>Save</button>
        </div>
      </form>
    {:else}
      <dl class="kv">
        <dt>Approval limit</dt><dd class="num">{limitRupees ? `₹${limitRupees}` : "Policy default"}</dd>
        <dt>Single-owner exception</dt><dd>{data.separation.soloOwner ? "On" : "Off"}</dd>
      </dl>
    {/if}
  </div>
</section>

<style>
  .top { margin-bottom: 28px; }
  .top h1 { margin: 8px 0; }
  .top p { margin: 0; max-width: 64ch; }
  .note { margin-top: 12px !important; height: auto; padding: 4px 10px; }
  .block { margin-bottom: 28px; }
  .panel-head h2, .section-head h2 { font-size: 24px; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .small { font-size: 12.5px; }
  .hint { font-size: 12px; }
  .block-hint { display: block; font-weight: 400; margin-top: 2px; }
  .lead { margin: 0 0 16px; max-width: 70ch; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; overflow-wrap: anywhere; }
  .error { color: var(--clay); margin: 0; }
  p[role="status"] { margin: 0; color: var(--text-2); }
  p.error[role="status"] { color: var(--clay); }

  input[type="checkbox"], input[type="radio"] { width: 18px; height: 18px; min-height: 0; padding: 0; margin: 0; flex: none; accent-color: var(--brass); }

  .invite { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; align-items: start; }
  .scope { border: 0; margin: 0; padding: 0; display: grid; gap: 8px; min-width: 0; }
  .scope legend { font-size: 12px; color: var(--text-2); font-weight: 600; letter-spacing: 0.02em; padding: 0; margin-bottom: 6px; }
  .opt { display: flex; gap: 10px; align-items: center; font-size: 14px; color: var(--text-2); cursor: pointer; min-height: 32px; }
  .opt.solo { align-items: flex-start; }
  .books { display: flex; flex-wrap: wrap; gap: 4px 16px; padding-left: 28px; }
  .row-end { grid-column: 1 / -1; display: flex; justify-content: flex-end; align-items: center; gap: 12px; flex-wrap: wrap; }

  .code-box { border: 1px solid rgba(201, 168, 106, 0.4); background: var(--brass-wash); border-radius: var(--r-md); padding: 16px; margin-bottom: 20px; display: grid; gap: 10px; }
  .code-box p { margin: 0; }
  .code-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 17px; color: var(--brass-2); letter-spacing: 0.04em;
    background: var(--ink-0); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 8px 12px; overflow-wrap: anywhere; user-select: all; flex: 1; min-width: 0; }

  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  .member { padding: 18px 20px; display: grid; gap: 12px; }
  .m-head { display: flex; gap: 12px; align-items: center; min-width: 0; }
  .m-id { min-width: 0; }
  .m-id h3 { font-family: var(--serif); font-size: 21px; font-weight: 500; line-height: 1.2; }
  .you { font-family: var(--sans); font-size: 13px; }
  .avatar { width: 36px; height: 36px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--ink-3);
    color: var(--brass-2); font-family: var(--serif); font-size: 17px; border: 1px solid var(--line); }
  .pills { display: flex; flex-wrap: wrap; gap: 6px; }
  .pills .pill { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .acts { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .confirm { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .danger { border-color: rgba(223, 154, 128, 0.5); color: var(--clay); }
  .danger:hover { background: var(--clay-wash); border-color: var(--clay); }
  .edit { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
  .edit .acts { grid-column: 1 / -1; justify-content: flex-end; }

  details summary { cursor: pointer; color: var(--text-2); font-size: 13px; display: inline-flex; gap: 6px; align-items: center; min-height: 30px; border-radius: 4px; }
  details summary:hover { color: var(--text); }
  .keys ul, .revoked ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
  .keys li { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 8px 12px; border: 1px solid var(--line-soft); border-radius: var(--r-md); }
  .k-text { display: grid; min-width: 0; }
  .revoked { margin-top: 16px; }
  .revoked li { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 14px; color: var(--text-2); }

  .sod { display: grid; grid-template-columns: minmax(0, 280px) 1fr; gap: 20px; align-items: start; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 20px; margin: 0; }
  .kv dt { color: var(--text-2); } .kv dd { margin: 0; }

  @media (max-width: 640px) {
    .panel-head { flex-direction: column; align-items: flex-start; gap: 4px; padding: 16px 16px 10px; }
    .panel-body { padding: 0 16px 16px; }
    .member { padding: 16px; }
    .sod { grid-template-columns: 1fr; }
    .row-end { justify-content: stretch; }
    .row-end .btn { width: 100%; }
    .keys li { flex-direction: column; align-items: flex-start; }
  }
</style>
