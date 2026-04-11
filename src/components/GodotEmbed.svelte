<script>
  let loading = $state(true);
  let error = $state("");

  // Served from /godot/ in both dev and prod. Astro dev sets the required
  // COOP/COEP headers via vite.server.headers; CloudFront sets them in prod.
  let gameUrl = $state("/godot/index.html");

  function onLoad() {
    loading = false;
  }

  function onError() {
    loading = false;
    error = "Game failed to load.";
  }
</script>

<div class="godot-container">
  {#if loading}
    <div class="loading-screen">
      <div class="loading-title">AllByte Studios</div>
      <div class="loading-subtitle">Loading game...</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: 30%"></div>
      </div>
    </div>
  {/if}

  {#if error}
    <div class="loading-screen">
      <div class="loading-title">AllByte Studios</div>
      <p class="loading-note">{error}</p>
    </div>
  {:else}
    <iframe
      src={gameUrl}
      title="The Chronicles of Nesis"
      class="game-frame"
      onload={onLoad}
      onerror={onError}
      allow="cross-origin-isolated"
    ></iframe>
  {/if}
</div>

<style>
  .godot-container {
    width: 100%;
    aspect-ratio: 1270 / 920;
    max-height: 80vh;
    background: #0a0e17;
    position: relative;
    margin: 0 auto;
    border: 1px solid rgba(0, 255, 136, 0.2);
  }

  .loading-screen {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 2;
    background: #0a0e17;
    color: #e0e7ff;
    font-family: "Courier New", monospace;
  }

  .loading-title {
    font-size: 1.5rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
  }

  .loading-subtitle {
    font-size: 0.875rem;
    opacity: 0.6;
    margin-bottom: 1.5rem;
  }

  .progress-bar {
    width: 60%;
    max-width: 300px;
    height: 4px;
    background: rgba(0, 255, 136, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: #a7f3d0;
    transition: width 0.3s;
  }

  .loading-note {
    margin-top: 2rem;
    font-size: 0.85rem;
    opacity: 0.6;
    color: #f87171;
  }

  .game-frame {
    width: 100%;
    height: 100%;
    border: none;
    display: block;
  }
</style>
