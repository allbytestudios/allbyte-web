<script>
  // TODO: Replace with live API data
  const services = [
    { name: "API", status: "operational" },
    { name: "Game Server", status: "operational" },
    { name: "CDN", status: "operational" },
  ];

  function statusColor(status) {
    switch (status) {
      case "operational": return "#a7f3d0";
      case "degraded": return "#fbbf24";
      case "down": return "#f97316";
      default: return "#6b7280";
    }
  }
</script>

<div class="status-widget">
  <h3 class="status-title">sys.status</h3>
  <ul class="status-list">
    {#each services as service}
      <li class="status-item">
        <span class="status-dot" style="background: {statusColor(service.status)}"></span>
        <span class="status-name">{service.name}</span>
        <span class="status-label">{service.status}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .status-widget {
    margin-top: 2.5rem;
    border: 1px solid var(--engine-border);
    padding: 1rem;
  }

  .status-title {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--engine-accent-dim);
    margin: 0 0 0.75rem;
  }

  .status-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .status-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-name {
    color: var(--engine-text);
  }

  .status-label {
    margin-left: auto;
    opacity: 0.5;
    font-size: 0.7rem;
  }
</style>
