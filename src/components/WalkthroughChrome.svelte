<script lang="ts">
  /**
   * Page chrome for the walkthrough: sticky section/scene nav with scroll-spy
   * and live progress, plus the screenshot lightbox.
   *
   * Both are page singletons that need whole-document awareness, so they share
   * one island. Scene content itself is server-rendered by the Astro page —
   * this only adds navigation and interaction on top, so the guide is fully
   * readable with JS off.
   */
  import { onMount } from "svelte";
  import { ticks } from "../lib/walkthroughTicks.svelte";

  interface SceneMeta {
    code: string;
    title: string;
    kind: string;
    order: number;
    items: { name: string }[];
    boss: boolean;
    revisitOf?: string | null;
  }
  interface Section {
    key: string;
    label: string;
    scenes: SceneMeta[];
  }

  let { sections = [] as Section[] } = $props();

  let activeCode = $state<string>("");
  let navOpen = $state(false);

  // --- lightbox --------------------------------------------------------------
  let box = $state<{ name: string; alt: string } | null>(null);

  onMount(() => {
    ticks.load();

    const onOpen = (e: Event) => {
      box = (e as CustomEvent).detail;
      document.body.style.overflow = "hidden";
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && box) close();
    };
    // Inline ::shot figures come from a remark transform, so they're plain HTML
    // with no island to dispatch for them. Delegate so they get the same
    // lightbox as the frontmatter shots.
    const onDelegatedClick = (e: Event) => {
      const btn = (e.target as HTMLElement)?.closest?.("[data-lightbox]") as HTMLElement | null;
      if (!btn) return;
      const name = btn.dataset.lightbox ?? "";
      const cap = btn.closest("figure")?.querySelector(".inline-shot-cap")?.textContent?.trim();
      box = { name, alt: cap || name };
      document.body.style.overflow = "hidden";
    };

    window.addEventListener("walkthrough:lightbox", onOpen);
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onDelegatedClick);

    // Scroll-spy. rootMargin biases toward the scene occupying the upper-middle
    // of the viewport, which is what a reader considers "where I am".
    const ratios = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const code = (e.target as HTMLElement).dataset.code ?? "";
          ratios.set(code, e.isIntersecting ? e.intersectionRatio : 0);
        }
        let best = "";
        let bestRatio = 0;
        for (const [code, r] of ratios) if (r > bestRatio) [best, bestRatio] = [code, r];
        if (best) activeCode = best;
      },
      { rootMargin: "-15% 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] }
    );
    document.querySelectorAll("[data-code]").forEach((n) => io.observe(n));

    return () => {
      window.removeEventListener("walkthrough:lightbox", onOpen);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onDelegatedClick);
      io.disconnect();
      document.body.style.overflow = "";
    };
  });

  function close() {
    box = null;
    document.body.style.overflow = "";
  }

  function jump(code: string) {
    document.getElementById(code)?.scrollIntoView({ behavior: "smooth", block: "start" });
    navOpen = false;
  }

  const pairs = (scenes: SceneMeta[]) =>
    scenes.flatMap((s) => s.items.map((i) => [s.code, i.name] as [string, string]));

  let allPairs = $derived(pairs(sections.flatMap((s) => s.scenes)));
  let total = $derived(ticks.progress(allPairs));
</script>

<!-- Mobile bar -->
<div class="wt-bar">
  <button class="bar-btn" onclick={() => (navOpen = !navOpen)} aria-expanded={navOpen}>
    <span class="burger" aria-hidden="true"></span> Contents
  </button>
  <span class="bar-progress">{total.done}/{total.total} items</span>
</div>

<nav class="wt-nav" class:open={navOpen} aria-label="Walkthrough contents">
  <div class="nav-head">
    <h2>Contents</h2>
    {#if total.total}
      <div class="prog">
        <div class="prog-bar"><div class="prog-fill" style={`width:${total.pct}%`}></div></div>
        <span class="prog-txt">{total.done}/{total.total} items found</span>
      </div>
    {/if}
  </div>

  {#each sections as section}
    {@const sp = ticks.progress(pairs(section.scenes))}
    <div class="nav-section">
      <h3>
        {section.label}
        {#if sp.total}<span class="sec-count">{sp.done}/{sp.total}</span>{/if}
      </h3>
      <ul>
        {#each section.scenes as s}
          <li>
            <button class="nav-link" class:active={activeCode === s.code} onclick={() => jump(s.code)}>
              <span class="code">{s.code}</span>
              <span class="title">{s.title}</span>
              {#if s.boss}<span class="pip boss" title="Boss">◆</span>{/if}
              {#if s.items.length}
                {@const ip = ticks.progress(s.items.map((i) => [s.code, i.name] as [string, string]))}
                <span class="pip items" class:done={ip.done === ip.total}>{ip.done}/{ip.total}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/each}

  {#if total.done > 0}
    <button class="reset" onclick={() => ticks.clear()}>Reset checklist</button>
  {/if}
</nav>

{#if box}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="lb"
    role="dialog"
    aria-modal="true"
    aria-label={box.alt}
    tabindex="-1"
    onclick={close}
  >
    <button class="lb-close" onclick={close} aria-label="Close">×</button>
    <img src={`/walkthrough/${box.name}.webp`} alt={box.alt} />
    <p class="lb-cap">{box.alt}</p>
  </div>
{/if}

<style>
  /* --- nav rail (desktop) --- */
  .wt-nav {
    position: sticky; top: 1rem; align-self: start; max-height: calc(100vh - 2rem);
    overflow-y: auto; padding-right: 0.5rem;
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
  }
  .nav-head h2 {
    margin: 0 0 0.5rem; font-size: 1rem; color: var(--heart-accent, #3a3020);
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .prog { margin-bottom: 1rem; }
  .prog-bar {
    height: 6px; background: rgba(58, 48, 32, 0.18); border-radius: 999px; overflow: hidden;
    border: 1px solid rgba(58, 48, 32, 0.25);
  }
  .prog-fill { height: 100%; background: var(--heart-accent, #3a3020); transition: width 0.25s ease; }
  .prog-txt { font-size: 0.72rem; color: var(--heart-accent-dim, #5a4d38); }

  .nav-section { margin-bottom: 1rem; }
  .nav-section h3 {
    margin: 0 0 0.35rem; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--heart-accent-dim, #5a4d38); display: flex; justify-content: space-between; gap: 0.5rem;
    border-bottom: 1px solid rgba(58, 48, 32, 0.2); padding-bottom: 0.2rem;
  }
  .sec-count { font-weight: normal; opacity: 0.8; }
  .wt-nav ul { list-style: none; margin: 0; padding: 0; }
  .nav-link {
    display: flex; align-items: baseline; gap: 0.4rem; width: 100%; text-align: left;
    background: none; border: 0; cursor: pointer; padding: 0.28rem 0.4rem; border-radius: 3px;
    color: var(--heart-text, #2a2218); font-family: inherit; font-size: 0.82rem; line-height: 1.3;
    border-left: 3px solid transparent;
  }
  .nav-link:hover { background: rgba(58, 48, 32, 0.08); }
  .nav-link.active {
    background: rgba(58, 48, 32, 0.12); border-left-color: var(--heart-accent, #3a3020); font-weight: 600;
  }
  .nav-link:focus-visible { outline: 2px solid var(--heart-accent, #3a3020); outline-offset: 1px; }
  .code { font-size: 0.68rem; color: var(--heart-accent-dim, #5a4d38); flex: none; }
  .title { flex: 1; min-width: 0; }
  .pip { font-size: 0.64rem; flex: none; padding: 0.05rem 0.32rem; border-radius: 999px; }
  .pip.items { background: rgba(58, 48, 32, 0.14); color: var(--heart-accent-dim, #5a4d38); }
  .pip.items.done { background: rgba(63, 107, 63, 0.2); color: #3f6b3f; }
  .pip.boss { color: #8f3323; }
  .reset {
    margin-top: 0.5rem; font-size: 0.7rem; background: none; cursor: pointer;
    border: 1px solid rgba(58, 48, 32, 0.35); border-radius: 3px; padding: 0.25rem 0.5rem;
    color: var(--heart-accent-dim, #5a4d38); font-family: inherit;
  }
  .reset:hover { background: rgba(58, 48, 32, 0.08); }

  /* --- mobile bar --- */
  .wt-bar { display: none; }

  /* --- lightbox --- */
  .lb {
    position: fixed; inset: 0; z-index: 200; background: rgba(20, 16, 10, 0.92);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 2rem 1rem; cursor: zoom-out;
  }
  .lb img { max-width: 100%; max-height: 85vh; object-fit: contain; border: 2px solid #8a7d60; }
  .lb-cap {
    color: #e8dfc4; font-family: "AllByteCustom", Georgia, serif; font-size: 0.85rem; margin: 0.7rem 0 0; text-align: center;
  }
  .lb-close {
    position: absolute; top: 0.8rem; right: 1.1rem; background: none; border: 0; cursor: pointer;
    color: #e8dfc4; font-size: 2.2rem; line-height: 1; padding: 0.2rem 0.6rem;
  }
  .lb-close:hover { color: #fff; }

  @media (max-width: 900px) {
    .wt-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      position: sticky; top: 0; z-index: 50; padding: 0.5rem 0.9rem;
      background: var(--heart-card-bg, #dbd0a0); border-bottom: 1.5px solid var(--heart-card-border, #7a6e52);
      font-family: "AllByteCustom", Georgia, serif;
    }
    .bar-btn {
      display: flex; align-items: center; gap: 0.5rem; background: none; border: 0; cursor: pointer;
      font-family: inherit; font-size: 0.88rem; color: var(--heart-text, #2a2218); padding: 0.2rem 0;
    }
    .burger {
      width: 1.05rem; height: 2px; background: currentColor; position: relative; display: block;
    }
    .burger::before, .burger::after {
      content: ""; position: absolute; left: 0; width: 100%; height: 2px; background: currentColor;
    }
    .burger::before { top: -5px; } .burger::after { top: 5px; }
    .bar-progress { font-size: 0.75rem; color: var(--heart-accent-dim, #5a4d38); }

    .wt-nav {
      position: fixed; inset: 0; top: 0; z-index: 100; max-height: none; overflow-y: auto;
      background: var(--heart-bg, #cec08a); padding: 1.2rem 1.1rem 3rem;
      display: none; border-right: 0;
    }
    .wt-nav.open { display: block; }
  }
</style>
