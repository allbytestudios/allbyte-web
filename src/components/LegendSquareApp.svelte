<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast, isAdmin } from "../lib/tier";
  import { onMount } from "svelte";

  const API = "https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com";

  interface Post {
    postId: string;
    authorId: string;
    authorName: string;
    authorTier: string;
    title: string;
    content: string;
    createdAt: string;
    reply: string | null;
    replyAt: string | null;
  }

  let loading = $state(true);
  let posts = $state<Post[]>([]);
  let error = $state<string | null>(null);
  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "legend"));
  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));

  // Compose form
  let showCompose = $state(false);
  let composeTitle = $state("");
  let composeContent = $state("");
  let composeSending = $state(false);
  let composeError = $state("");

  // Reply state
  let replyingTo = $state<string | null>(null);
  let replyContent = $state("");
  let replySending = $state(false);

  onMount(async () => {
    let waited = 0;
    while (!auth.authReady && waited < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    if (!isTierAtLeast(auth.currentUser, "legend")) {
      loading = false;
      return;
    }
    await loadPosts();
  });

  async function loadPosts() {
    loading = true;
    error = null;
    try {
      const res = await fetch(`${API}/legend/posts`, {
        headers: { Authorization: `Bearer ${auth.authToken}` },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      posts = data.posts ?? [];
    } catch (err: any) {
      error = err?.message ?? String(err);
    } finally {
      loading = false;
    }
  }

  async function submitPost() {
    if (!composeContent.trim()) return;
    composeSending = true;
    composeError = "";
    try {
      const res = await fetch(`${API}/legend/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.authToken}`,
        },
        body: JSON.stringify({
          title: composeTitle.trim(),
          content: composeContent.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `${res.status}`);
      }
      composeTitle = "";
      composeContent = "";
      showCompose = false;
      await loadPosts();
    } catch (err: any) {
      composeError = err?.message ?? String(err);
    } finally {
      composeSending = false;
    }
  }

  async function submitReply(postId: string) {
    if (!replyContent.trim()) return;
    replySending = true;
    try {
      const res = await fetch(`${API}/legend/posts/${postId}/reply`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.authToken}`,
        },
        body: JSON.stringify({ reply: replyContent.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `${res.status}`);
      }
      replyContent = "";
      replyingTo = null;
      await loadPosts();
    } catch {
      // Fail silently for now
    } finally {
      replySending = false;
    }
  }

  function relativeTime(iso: string): string {
    const ms = Date.now() - Date.parse(iso);
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
    return `${Math.round(ms / 86_400_000)}d ago`;
  }

  function tierColor(t: string): string {
    switch (t) {
      case "legend": return "#f97316";
      case "admin": return "#f472b6";
      default: return "#9ca3af";
    }
  }
</script>

<div class="square">
  {#if !auth.authReady || (loading && viewerHasAccess)}
    <div class="loading">Loading…</div>
  {:else if !viewerHasAccess}
    <div class="gate">
      <h2>Legend's Square</h2>
      <p>A private space for <strong>Legend</strong> tier subscribers to post questions, ideas, and requests — with guaranteed responses from AllByte.</p>
      {#if !auth.currentUser}
        <p>Sign in from the home page, then subscribe to Legend to join.</p>
      {:else}
        <p>You're signed in as <code>{auth.currentUser.email}</code> with tier <code>{auth.currentUser.tier ?? "default"}</code>.</p>
      {/if}
      <p><a class="gate-link" href="/subscribe/">View subscription tiers →</a></p>
    </div>
  {:else if error}
    <div class="gate error">
      <h2>Couldn't load posts</h2>
      <p>{error}</p>
      <button onclick={loadPosts}>Retry</button>
    </div>
  {:else}
    <div class="square-header">
      <h2>Legend's Square</h2>
      <button class="compose-btn" onclick={() => (showCompose = !showCompose)}>
        {showCompose ? "Cancel" : "+ New Post"}
      </button>
    </div>

    {#if showCompose}
      <div class="compose">
        <input
          class="compose-title"
          type="text"
          placeholder="Title (optional)"
          bind:value={composeTitle}
          maxlength="200"
        />
        <textarea
          class="compose-body"
          placeholder="What's on your mind? Questions, feature requests, ideas…"
          bind:value={composeContent}
          maxlength="2000"
          rows="4"
        ></textarea>
        <div class="compose-footer">
          <span class="char-count">{composeContent.length}/2000</span>
          {#if composeError}
            <span class="compose-error">{composeError}</span>
          {/if}
          <button
            class="submit-btn"
            disabled={composeSending || !composeContent.trim()}
            onclick={submitPost}
          >
            {composeSending ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
    {/if}

    {#if posts.length === 0}
      <div class="empty">
        <p>No posts yet. Be the first to start a conversation.</p>
      </div>
    {:else}
      <div class="post-list">
        {#each posts as post (post.postId)}
          <div class="post-card">
            <div class="post-header">
              <span class="post-author" style="color: {tierColor(post.authorTier)}">
                {post.authorName}
              </span>
              <span class="post-tier">{post.authorTier}</span>
              <span class="post-time">{relativeTime(post.createdAt)}</span>
            </div>
            {#if post.title}
              <h3 class="post-title">{post.title}</h3>
            {/if}
            <p class="post-content">{post.content}</p>

            {#if post.reply}
              <div class="reply">
                <div class="reply-header">
                  <span class="reply-author">AllByte</span>
                  <span class="reply-time">{relativeTime(post.replyAt ?? post.createdAt)}</span>
                </div>
                <p class="reply-content">{post.reply}</p>
              </div>
            {:else if viewerIsAdmin}
              {#if replyingTo === post.postId}
                <div class="reply-form">
                  <textarea
                    class="reply-input"
                    placeholder="Write your reply…"
                    bind:value={replyContent}
                    rows="3"
                    maxlength="2000"
                  ></textarea>
                  <div class="reply-actions">
                    <button onclick={() => (replyingTo = null)}>Cancel</button>
                    <button
                      class="submit-btn"
                      disabled={replySending || !replyContent.trim()}
                      onclick={() => submitReply(post.postId)}
                    >
                      {replySending ? "Sending…" : "Reply"}
                    </button>
                  </div>
                </div>
              {:else}
                <button class="reply-trigger" onclick={() => { replyingTo = post.postId; replyContent = ""; }}>
                  Reply
                </button>
              {/if}
            {:else}
              <span class="awaiting">Awaiting response…</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .square {
    max-width: 760px;
    margin: 0 auto;
    padding: 1rem 1.25rem 4rem;
    color: #e5e7eb;
    font-family: "Courier New", monospace;
  }
  .loading, .gate {
    text-align: center;
    padding: 3rem 1rem;
    color: #9ca3af;
  }
  .gate h2 {
    color: #f97316;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 1.1rem;
  }
  .gate code {
    background: rgba(255, 255, 255, 0.05);
    padding: 0.1rem 0.35rem;
    border-radius: 2px;
    color: #f97316;
  }
  .gate strong { color: #f97316; }
  .gate a, .gate-link {
    color: #f97316;
    text-decoration: none;
  }
  .gate a:hover { text-decoration: underline; }
  .gate.error h2 { color: #fca5a5; }
  .gate button {
    background: rgba(249, 115, 22, 0.1);
    border: 1px solid rgba(249, 115, 22, 0.4);
    color: #f97316;
    padding: 0.45rem 0.9rem;
    border-radius: 4px;
    font-family: inherit;
    cursor: pointer;
  }
  .empty {
    text-align: center;
    padding: 3rem 1rem;
    color: #6b7280;
    font-style: italic;
  }

  .square-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  .square-header h2 {
    color: #f97316;
    font-size: 1.2rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
  .compose-btn {
    background: rgba(249, 115, 22, 0.1);
    border: 1px solid rgba(249, 115, 22, 0.5);
    color: #f97316;
    padding: 0.4rem 0.9rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.82rem;
    cursor: pointer;
    transition: background 0.15s;
  }
  .compose-btn:hover { background: rgba(249, 115, 22, 0.2); }

  .compose {
    background: #12161e;
    border: 1px solid rgba(249, 115, 22, 0.3);
    border-radius: 6px;
    padding: 1rem;
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .compose-title, .compose-body {
    background: #0a0e17;
    border: 1px solid rgba(249, 115, 22, 0.2);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    color: #e5e7eb;
    font-family: inherit;
    font-size: 0.85rem;
    resize: vertical;
  }
  .compose-title { font-weight: 700; }
  .compose-footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .char-count { font-size: 0.72rem; color: #4b5563; }
  .compose-error { font-size: 0.78rem; color: #f87171; }
  .submit-btn {
    margin-left: auto;
    background: #f97316;
    border: none;
    color: #0a0e17;
    padding: 0.45rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .submit-btn:hover:not(:disabled) { opacity: 0.9; }

  .post-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .post-card {
    background: #12161e;
    border: 1px solid rgba(249, 115, 22, 0.15);
    border-radius: 6px;
    padding: 1rem 1.15rem;
  }
  .post-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .post-author { font-weight: 700; font-size: 0.85rem; }
  .post-tier {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    padding: 0.05rem 0.35rem;
    border: 1px solid rgba(156, 163, 175, 0.25);
    border-radius: 2px;
  }
  .post-time { margin-left: auto; font-size: 0.75rem; color: #4b5563; }
  .post-title {
    font-size: 1rem;
    color: #e5e7eb;
    margin: 0 0 0.3rem;
  }
  .post-content {
    font-size: 0.88rem;
    color: #d1d5db;
    margin: 0;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .reply {
    margin-top: 0.75rem;
    padding: 0.75rem;
    background: rgba(249, 115, 22, 0.06);
    border-left: 3px solid #f97316;
    border-radius: 0 4px 4px 0;
  }
  .reply-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.3rem;
  }
  .reply-author {
    font-weight: 700;
    font-size: 0.82rem;
    color: #f97316;
  }
  .reply-time { font-size: 0.72rem; color: #4b5563; }
  .reply-content {
    font-size: 0.85rem;
    color: #d1d5db;
    margin: 0;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .awaiting {
    display: block;
    margin-top: 0.5rem;
    font-size: 0.78rem;
    color: #4b5563;
    font-style: italic;
  }

  .reply-trigger {
    margin-top: 0.5rem;
    background: none;
    border: 1px solid rgba(249, 115, 22, 0.3);
    color: #f97316;
    padding: 0.3rem 0.7rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .reply-trigger:hover { background: rgba(249, 115, 22, 0.1); }

  .reply-form {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .reply-input {
    background: #0a0e17;
    border: 1px solid rgba(249, 115, 22, 0.3);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    color: #e5e7eb;
    font-family: inherit;
    font-size: 0.85rem;
    resize: vertical;
  }
  .reply-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .reply-actions button {
    background: none;
    border: 1px solid rgba(249, 115, 22, 0.3);
    color: #f97316;
    padding: 0.3rem 0.7rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }
</style>
