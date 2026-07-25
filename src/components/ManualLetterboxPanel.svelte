<script lang="ts">
  // Left-letterbox Instruction Booklet.
  //
  // Replaces the minimap in the left letterbox bar (owner's call). Shows the
  // manual (embedded as an iframe of the standalone /manual/ page — it renders
  // single-column and scrolls) ONLY when the letterbox is wide enough to hold it
  // legibly. Same fixed-to-the-left-edge convention as MinimapPanel; the manual
  // just needs more width to read than a minimap, so it's gated to a wider
  // viewport (where 22vw ≥ the MIN_W below) rather than the minimap's 1101px.
  //
  // The minimap protocol/component stays in the tree — this is a swap, reversible.
</script>

<aside class="manual-lb" aria-label="Instruction Booklet">
  <iframe class="manual-lb-frame" src="/manual/" title="Instruction Booklet" loading="lazy"></iframe>
</aside>

<style>
  /* MIN readable width ≈ 340px. Panel width tracks the letterbox (22vw, same as
     the minimap) capped at 480px; it's only SHOWN once 22vw clears the minimum,
     i.e. viewport ≥ ~1545px — below that the bar is too narrow, so nothing shows.
     Desktop + precise pointer only (touch uses the virtual gamepad in the bars). */
  .manual-lb {
    position: fixed;
    left: 0;
    top: 0;
    height: 100dvh;
    width: min(480px, 22vw);
    z-index: 50;
    background: #cdbf9f; /* paper "desk" tone, matches the manual */
    border-right: 2px solid #000;
    box-sizing: border-box;
    display: none; /* gated below */
  }
  .manual-lb-frame {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: #cdbf9f;
  }
  @media (pointer: fine) and (min-width: 1545px) {
    .manual-lb {
      display: block;
    }
  }
</style>
