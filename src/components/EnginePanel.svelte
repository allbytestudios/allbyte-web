<script>
</script>

<div class="engine-panel">

  <div class="content">
    <h2 class="panel-title"><span class="terminal-prompt">$</span> Game Dev</h2>

    <nav class="sections">
      <a href="/godot-and-claude" class="section-link">
        <h2>
          <span class="bracket">[</span> Godot &amp; Claude <span class="bracket">]</span>
          <span class="arrow">&#8594;</span>
        </h2>
        <p>My local setup and how I do gamedev with Godot &amp; Claude.</p>
      </a>

      <a href="/self-hosted" class="section-link">
        <h2>
          <span class="bracket">[</span> Self-Hosted with Claude <span class="bracket">]</span>
          <span class="arrow">&#8594;</span>
        </h2>
        <p>AI-assisted self-hosted game, subscription, and infra.</p>
      </a>

      <a href="/devlog" class="section-link">
        <h2>
          <span class="bracket">[</span> Devlog <span class="bracket">]</span>
          <span class="arrow">&#8594;</span>
        </h2>
        <p>Technical post-mortems and development updates.</p>
      </a>
    </nav>

  </div>

  <div class="cursor">_</div>
</div>

<style>
  .engine-panel {
    background: var(--engine-bg);
    color: var(--engine-text);
    font-family: "Courier New", Courier, monospace;
    padding: 3rem 2rem;
    min-height: 100%;
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
  }

  .content {
    position: relative;
    z-index: 1;
    max-width: 440px;
    margin: 0 auto;
    width: 100%;
  }

  .panel-title {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0 0 1.5rem;
    color: var(--engine-accent);
    text-align: center;
  }

  .terminal-prompt {
    opacity: 0.5;
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
    border: 1px solid var(--engine-border);
    padding: 1rem 1.25rem;
    transition: all 0.2s;
  }

  .section-link:hover {
    background: rgba(167, 243, 208, 0.06);
    border-color: var(--engine-accent);
  }

  .section-link:hover .arrow {
    opacity: 1;
    transform: translateX(4px);
  }

  .section-link h2 {
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0 0 0.375rem;
    color: var(--engine-accent);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .arrow {
    margin-left: auto;
    opacity: 0.4;
    transition: all 0.2s;
  }

  .bracket {
    opacity: 0.5;
  }

  .section-link p {
    font-size: 0.9rem;
    line-height: 1.5;
    margin: 0;
    opacity: 0.8;
  }

  .cursor {
    position: absolute;
    bottom: 2rem;
    right: 2rem;
    color: var(--engine-accent);
    font-size: 1.5rem;
    animation: blink 1s step-end infinite;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
</style>
