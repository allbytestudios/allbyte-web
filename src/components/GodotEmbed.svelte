<script>
  let loading = $state(true);
  let progress = $state(0);

  // TODO: Load Godot engine when actual export files are in /godot/
  // The Godot HTML5 export will provide an engine loader script.
  // Required HTTP headers for SharedArrayBuffer (configure in CloudFront):
  //   Cross-Origin-Opener-Policy: same-origin
  //   Cross-Origin-Embedder-Policy: require-corp
</script>

<div class="godot-container">
  {#if loading}
    <div class="loading-screen">
      <div class="loading-title">AllByte Studios</div>
      <div class="loading-subtitle">Preparing the world...</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: {progress}%"></div>
      </div>
      <p class="loading-note">
        Place your Godot 3.5 HTML5 export files in <code>/public/godot/</code>
      </p>
    </div>
  {/if}

  <canvas id="godot-canvas" class="game-canvas"></canvas>
</div>

<style>
  .godot-container {
    width: 100%;
    aspect-ratio: 16 / 9;
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
    font-size: 0.75rem;
    opacity: 0.4;
  }

  .loading-note code {
    color: #a7f3d0;
  }

  .game-canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
