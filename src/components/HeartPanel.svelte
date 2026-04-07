<script>
</script>

<div class="heart-panel">
  <!-- Organic texture overlay -->
  <div class="texture-overlay"></div>

  <div class="content">
    <h2 class="panel-title">Game Assets</h2>

    <nav class="sections">
      <a href="/music" class="section-link">
        <h2>Music <span class="arrow">&#8594;</span></h2>
        <p>Original compositions for The Chronicles of Nesis.</p>
      </a>

      <a href="/artwork" class="section-link">
        <h2>Artwork <span class="arrow">&#8594;</span></h2>
        <p>Sprites, pre-rendered backgrounds.</p>
      </a>

      <a href="/fonts" class="section-link">
        <h2>Font <span class="arrow">&#8594;</span></h2>
        <p>A custom typeface designed for The Chronicles of Nesis.</p>
      </a>
    </nav>

  </div>
</div>

<style>
  .heart-panel {
    background: var(--heart-bg);
    color: var(--heart-text);
    padding: 3rem 2rem;
    min-height: 100%;
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
  }

  .texture-overlay {
    position: absolute;
    inset: 0;
    background-image: radial-gradient(
      circle at 20% 50%,
      rgba(200, 169, 110, 0.15) 0%,
      transparent 50%
    ),
    radial-gradient(
      circle at 80% 20%,
      rgba(139, 69, 19, 0.08) 0%,
      transparent 40%
    );
    pointer-events: none;
  }

  .content {
    position: relative;
    z-index: 1;
    max-width: 440px;
    margin: 0 auto;
    width: 100%;
  }

  .panel-title {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0 0 1.5rem;
    color: var(--heart-accent);
    text-align: center;
  }

  .sections {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .section-link {
    display: block;
    text-decoration: none;
    color: inherit;
    border: 1px solid var(--heart-border);
    padding: 1rem 1.25rem;
    transition: all 0.2s;
  }

  .section-link:hover {
    background: rgba(139, 69, 19, 0.06);
    border-color: var(--heart-accent);
  }

  .section-link:hover .arrow {
    opacity: 1;
    transform: translateX(4px);
  }

  .section-link h2 {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0 0 0.375rem;
    color: var(--heart-accent);
    display: flex;
    align-items: center;
  }

  .arrow {
    margin-left: auto;
    opacity: 0.4;
    transition: all 0.2s;
  }

  .section-link p {
    font-size: 0.9rem;
    line-height: 1.5;
    margin: 0;
    opacity: 0.8;
  }

</style>
