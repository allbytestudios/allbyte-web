<script lang="ts">
  // Tiny client-only island that runs on every page via BaseLayout. Calls
  // initAuth() exactly once per session so the auth.svelte.ts store
  // (currentUser, authReady, authToken) is populated regardless of whether
  // the page also includes BilateralLayout (which used to be the only place
  // that ran initAuth).
  import { auth, initAuth } from "../lib/auth.svelte.ts";
  import { onMount } from "svelte";

  onMount(() => {
    if (!auth.authReady) {
      initAuth();
    }
  });
</script>
