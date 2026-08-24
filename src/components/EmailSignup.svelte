<script lang="ts">
  import {
    submitSignup, alreadySignedUp, looksLikeEmail,
    type SignupSource,
  } from "../lib/emailSignup";

  let {
    source = "home" as SignupSource,
    heading = "",
    blurb = "",
    cta = "Notify me",
    variant = "paper" as "paper" | "overlay",
    ondone = () => {},
  } = $props();

  let email = $state("");
  let honeypot = $state("");     // hidden from humans; bots fill it
  let busy = $state(false);
  let done = $state(false);
  let error = $state<string | null>(null);
  let seen = $state(false);

  $effect(() => {
    seen = alreadySignedUp();
  });

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    error = null;
    if (!looksLikeEmail(email)) {
      error = "That doesn't look like an email address.";
      return;
    }
    busy = true;
    const res = await submitSignup(email, source, honeypot);
    busy = false;
    if (res.ok) {
      done = true;
      ondone();
    } else {
      error = res.error;
    }
  }
</script>

<div class="signup {variant}">
  {#if done || seen}
    <p class="thanks" role="status">
      {done ? "Got it. I'll write once, when it's playable." : "You're on the list."}
    </p>
  {:else}
    {#if heading}<h3>{heading}</h3>{/if}
    {#if blurb}<p class="blurb">{blurb}</p>{/if}

    <form onsubmit={onSubmit} novalidate>
      <label class="sr-only" for="signup-{source}">Email address</label>
      <div class="row">
        <input
          id="signup-{source}"
          type="email"
          inputmode="email"
          autocomplete="email"
          placeholder="you@example.com"
          bind:value={email}
          disabled={busy}
          aria-describedby="signup-note-{source}"
        />
        <button type="submit" disabled={busy}>{busy ? "Sending…" : cta}</button>
      </div>

      <!-- Honeypot. Not display:none — some bots skip hidden fields, and screen
           readers are handled by aria-hidden + tabindex instead. -->
      <div class="hp" aria-hidden="true">
        <label for="company-{source}">Company</label>
        <input id="company-{source}" tabindex="-1" autocomplete="off"
               bind:value={honeypot} />
      </div>

      {#if error}<p class="err" role="alert">{error}</p>{/if}

      <p class="note" id="signup-note-{source}">
        One email per release, nothing else. Unsubscribe in a click.
        <a href="/privacy/">Privacy</a>.
      </p>
    </form>
  {/if}
</div>

<style>
  .signup { max-width: 34rem; }
  h3 {
    font-family: "AllByteCustom", Georgia, serif;
    margin: 0 0 0.35rem;
    font-size: 1.5rem;
  }
  .blurb { margin: 0 0 0.9rem; line-height: 1.55; font-size: 0.98rem; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  input[type="email"] {
    flex: 1 1 15rem; min-width: 0;
    padding: 0.6rem 0.7rem;
    font: inherit; font-size: 0.98rem;
    border-radius: 2px;
  }
  button {
    padding: 0.6rem 1.15rem;
    font-family: "AllByteCustom", Georgia, serif;
    letter-spacing: 0.06em; text-transform: uppercase;
    font-size: 0.9rem; cursor: pointer; border-radius: 2px;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  .note { font-size: 0.8rem; margin: 0.55rem 0 0; line-height: 1.45; }
  .err { font-size: 0.86rem; margin: 0.5rem 0 0; }
  .thanks { margin: 0; font-size: 1rem; }

  /* Off-screen rather than display:none, so it stays in the a11y tree. */
  .sr-only {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .hp { position: absolute; left: -9999px; height: 0; overflow: hidden; }

  /* --- paper: the homepage booklet palette --- */
  .paper h3 { color: var(--crimson); }
  .paper .blurb { color: var(--ink); }
  .paper input[type="email"] {
    background: var(--panel); color: var(--ink);
    border: 1px solid var(--rule);
  }
  .paper button {
    background: var(--panel); color: var(--crimson);
    border: 1px solid var(--gilt);
  }
  .paper button:hover:not(:disabled) { background: var(--paperblend); }
  .paper .note { color: var(--ink-soft); }
  .paper .note a { color: var(--crimson); }
  .paper .err { color: var(--sem-danger); }
  .paper .thanks { color: var(--ink); }

  /* --- overlay: sits over the game at the end of the credits --- */
  .overlay h3 { color: #e6c877; }
  .overlay .blurb { color: #e8e2d4; }
  .overlay input[type="email"] {
    background: rgba(0, 0, 0, 0.45); color: #f3ede0;
    border: 1px solid rgba(230, 200, 119, 0.45);
  }
  .overlay button {
    background: rgba(230, 200, 119, 0.12); color: #e6c877;
    border: 1px solid rgba(230, 200, 119, 0.55);
  }
  .overlay button:hover:not(:disabled) { background: rgba(230, 200, 119, 0.22); }
  .overlay .note { color: rgba(232, 226, 212, 0.62); }
  .overlay .note a { color: rgba(230, 200, 119, 0.85); }
  .overlay .err { color: #f8a08f; }
  .overlay .thanks { color: #e8e2d4; }
</style>
