<script lang="ts">
  // Mounts the real-user performance beacon on every page (BaseLayout).
  //
  // A component rather than a bare import so it participates in Astro's island
  // lifecycle: ClientRouter swaps pages without a full reload, and onMount /
  // onDestroy give a clean start and stop per navigation.
  //
  // Renders nothing. See src/lib/perfBeacon.ts for what is collected and the
  // privacy posture (same as the play funnel: session-scoped random id, coarse
  // device class, referrer host only).
  import { onMount } from "svelte";
  import { initPerfBeacon, perfMark } from "../lib/perfBeacon";

  onMount(() => {
    const stop = initPerfBeacon();
    // A baseline mark on every page, so a report always has at least one
    // timeline anchor even when the page has nothing else to report.
    perfMark("mount");
    return stop;
  });
</script>
