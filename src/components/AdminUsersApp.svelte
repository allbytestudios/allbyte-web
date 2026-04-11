<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin, TIER_ORDER, tierLabel } from "../lib/tier";
  import type { Tier } from "../lib/tier";
  import { onMount } from "svelte";

  const API = "https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com";

  interface AdminUser {
    userId: string;
    email: string;
    username: string;
    tier: Tier | string | null;
    stripeCustomerId?: string | null;
    createdAt?: string | null;
    oauthProvider?: string | null;
  }

  let loading = $state(true);
  let users = $state<AdminUser[]>([]);
  let error = $state<string | null>(null);
  let savingUserId = $state<string | null>(null);
  let toast = $state<{ kind: "ok" | "err"; msg: string } | null>(null);

  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));

  onMount(async () => {
    // Wait for auth to settle (initAuth runs in BaseLayout on every page).
    let waited = 0;
    while (!auth.authReady && waited < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    if (!isAdmin(auth.currentUser)) {
      loading = false;
      return;
    }
    await loadUsers();
  });

  async function loadUsers() {
    loading = true;
    error = null;
    try {
      const res = await fetch(`${API}/admin/users`, {
        headers: { Authorization: `Bearer ${auth.authToken}` },
      });
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      users = (data.users || []) as AdminUser[];
    } catch (err: any) {
      error = err?.message ?? String(err);
    } finally {
      loading = false;
    }
  }

  async function setTier(user: AdminUser, newTier: Tier) {
    if (user.tier === newTier) return;
    const previous = user.tier;
    savingUserId = user.userId;
    // Optimistic update
    users = users.map((u) =>
      u.userId === user.userId ? { ...u, tier: newTier } : u
    );
    try {
      const res = await fetch(
        `${API}/admin/users/${encodeURIComponent(user.userId)}/tier`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.authToken}`,
          },
          body: JSON.stringify({ tier: newTier }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
      }
      showToast("ok", `${user.username || user.email} → ${tierLabel(newTier)}`);
    } catch (err: any) {
      // Roll back
      users = users.map((u) =>
        u.userId === user.userId ? { ...u, tier: previous } : u
      );
      showToast("err", err?.message ?? String(err));
    } finally {
      savingUserId = null;
    }
  }

  function showToast(kind: "ok" | "err", msg: string) {
    toast = { kind, msg };
    setTimeout(() => {
      if (toast?.msg === msg) toast = null;
    }, 4000);
  }

  // Derived counts for the summary header
  let counts = $derived.by(() => {
    const c: Record<string, number> = {
      default: 0,
      initiate: 0,
      hero: 0,
      legend: 0,
      admin: 0,
    };
    for (const u of users) {
      const t = (u.tier as string) || "default";
      if (t in c) c[t]++;
    }
    return c;
  });
</script>

<div class="admin-page">
  {#if !auth.authReady || (loading && viewerIsAdmin)}
    <div class="loading">Loading…</div>
  {:else if !viewerIsAdmin}
    <div class="gate">
      <h2>Admin only</h2>
      <p>This page is restricted to admin users.</p>
      {#if !auth.currentUser}
        <p><strong>Sign in</strong> from the home page first, then return here.</p>
      {:else}
        <p>You're signed in as <code>{auth.currentUser.email}</code> with tier <code>{auth.currentUser.tier}</code>.</p>
      {/if}
      <p><a href="/">← Back to home</a></p>
    </div>
  {:else if error}
    <div class="gate error">
      <h2>Couldn't load users</h2>
      <p>{error}</p>
      <button onclick={loadUsers}>Retry</button>
    </div>
  {:else}
    <header class="admin-header">
      <h1>User management</h1>
      <div class="counts">
        <span class="count-pill total">{users.length} total</span>
        <span class="count-pill admin">{counts.admin} admin</span>
        <span class="count-pill legend">{counts.legend} legend</span>
        <span class="count-pill hero">{counts.hero} hero</span>
        <span class="count-pill initiate">{counts.initiate} initiate</span>
        <span class="count-pill free">{counts.default} free</span>
      </div>
    </header>

    <table class="users-table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Username</th>
          <th>Created</th>
          <th>Source</th>
          <th>Tier</th>
        </tr>
      </thead>
      <tbody>
        {#each users as user (user.userId)}
          {@const isSelf = user.userId === auth.currentUser?.userId}
          {@const isSaving = savingUserId === user.userId}
          <tr class:self={isSelf}>
            <td class="email">
              {user.email}
              {#if isSelf}<span class="self-badge">you</span>{/if}
            </td>
            <td>{user.username || "—"}</td>
            <td class="created">{user.createdAt ?? "—"}</td>
            <td class="source">
              {#if user.oauthProvider}{user.oauthProvider}{:else}email{/if}
            </td>
            <td class="tier-cell">
              <select
                disabled={isSelf || isSaving}
                value={user.tier ?? "default"}
                onchange={(e) => setTier(user, (e.currentTarget as HTMLSelectElement).value as Tier)}
                class="tier-select tier-{user.tier ?? 'default'}"
                title={isSelf ? "Admins can't demote themselves — another admin must do it." : ""}
              >
                {#each TIER_ORDER as t}
                  <option value={t}>{tierLabel(t)}</option>
                {/each}
              </select>
              {#if isSaving}<span class="saving">…</span>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if toast}
    <div class="toast toast-{toast.kind}">{toast.msg}</div>
  {/if}
</div>

<style>
  .admin-page {
    max-width: 1100px;
    margin: 0 auto;
    padding: 1rem 1.25rem 4rem;
    color: #e5e7eb;
    font-family: "Courier New", monospace;
  }
  .loading,
  .gate {
    text-align: center;
    padding: 3rem 1rem;
    color: #9ca3af;
  }
  .gate h2 {
    color: #fca5a5;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 1.1rem;
  }
  .gate code {
    background: rgba(255, 255, 255, 0.05);
    padding: 0.1rem 0.35rem;
    border-radius: 2px;
    color: #a7f3d0;
  }
  .gate a { color: #a7f3d0; text-decoration: none; }
  .gate a:hover { text-decoration: underline; }
  .gate.error h2 { color: #fca5a5; }
  .gate button {
    background: rgba(167, 243, 208, 0.1);
    border: 1px solid rgba(167, 243, 208, 0.4);
    color: #a7f3d0;
    padding: 0.45rem 0.9rem;
    border-radius: 4px;
    font-family: inherit;
    cursor: pointer;
  }

  .admin-header {
    margin-bottom: 1rem;
  }
  .admin-header h1 {
    font-size: 1.4rem;
    color: #a7f3d0;
    margin: 0 0 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .count-pill {
    font-size: 0.75rem;
    padding: 0.18rem 0.55rem;
    border-radius: 3px;
    border: 1px solid;
  }
  .count-pill.total { color: #d1d5db; border-color: rgba(255,255,255,0.18); background: rgba(255,255,255,0.04); }
  .count-pill.admin { color: #f472b6; border-color: rgba(244,114,182,0.4); background: rgba(244,114,182,0.1); }
  .count-pill.legend { color: #f97316; border-color: rgba(249,115,22,0.4); background: rgba(249,115,22,0.1); }
  .count-pill.hero { color: #fbbf24; border-color: rgba(251,191,36,0.4); background: rgba(251,191,36,0.1); }
  .count-pill.initiate { color: #a7f3d0; border-color: rgba(167,243,208,0.4); background: rgba(167,243,208,0.1); }
  .count-pill.free { color: #9ca3af; border-color: rgba(156,163,175,0.3); background: rgba(156,163,175,0.06); }

  .users-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
    margin-top: 1rem;
  }
  .users-table th {
    text-align: left;
    color: #6b7280;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid rgba(167, 243, 208, 0.15);
  }
  .users-table td {
    padding: 0.55rem 0.6rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    vertical-align: middle;
  }
  .users-table tr.self td {
    background: rgba(167, 243, 208, 0.04);
  }
  .email {
    color: #e5e7eb;
    word-break: break-all;
  }
  .self-badge {
    display: inline-block;
    margin-left: 0.4rem;
    font-size: 0.65rem;
    background: rgba(167, 243, 208, 0.15);
    color: #a7f3d0;
    padding: 0.05rem 0.35rem;
    border-radius: 2px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .created, .source { color: #9ca3af; font-size: 0.78rem; }
  .source { text-transform: capitalize; }

  .tier-cell { white-space: nowrap; }
  .tier-select {
    background: #12161e;
    color: #e5e7eb;
    border: 1px solid rgba(167, 243, 208, 0.3);
    border-radius: 3px;
    padding: 0.25rem 0.5rem;
    font-family: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .tier-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .tier-select.tier-admin { color: #f472b6; border-color: rgba(244,114,182,0.5); }
  .tier-select.tier-legend { color: #f97316; border-color: rgba(249,115,22,0.5); }
  .tier-select.tier-hero { color: #fbbf24; border-color: rgba(251,191,36,0.5); }
  .tier-select.tier-initiate { color: #a7f3d0; }
  .tier-select.tier-default { color: #9ca3af; }
  .saving {
    color: #9ca3af;
    margin-left: 0.4rem;
    font-size: 0.85rem;
  }

  .toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    padding: 0.7rem 1rem;
    border-radius: 4px;
    font-size: 0.8rem;
    border: 1px solid;
    background: #12161e;
    z-index: 1000;
    max-width: 360px;
    animation: toast-in 0.2s ease-out;
  }
  .toast-ok { color: #a7f3d0; border-color: rgba(167, 243, 208, 0.5); }
  .toast-err { color: #fca5a5; border-color: rgba(248, 113, 113, 0.5); }
  @keyframes toast-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
