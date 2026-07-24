<script lang="ts">
  /**
   * Page chrome for the walkthrough: section/step nav with scroll-spy and live
   * progress, plus the screenshot lightbox.
   *
   * Desktop: a sticky left rail (always visible). Mobile: a pinned bottom-right
   * "Contents" button that stays put while the page scrolls, opening a right-side
   * drawer that slides in — and slides back shut when you tap any header. Content
   * itself is server-rendered by the Astro page; this only adds nav + interaction.
   */
  import { onMount } from "svelte";
  import { ticks } from "../lib/walkthroughTicks.svelte";

  interface Step {
    key: string;
    label: string;
    boss: boolean;
    items: { code: string; name: string }[];
  }
  interface Section {
    key: string;
    label: string;
    steps: Step[];
  }

  let { sections = [] as Section[] } = $props();

  // Nav + scroll-spy key on the STEPS, not the scenes — a step outline reads as
  // a walkthrough, a scene list reads as a database dump.
  let activeStep = $state<string>("");
  let navOpen = $state(false);

  // Elements for focus management (mobile drawer).
  let fabEl: HTMLButtonElement | undefined;
  let closeEl: HTMLButtonElement | undefined;

  // --- lightbox --------------------------------------------------------------
  let box = $state<{ name: string; alt: string } | null>(null);

  function openNav() {
    navOpen = true;
    document.body.style.overflow = "hidden"; // lock the page behind the drawer (mobile)
    requestAnimationFrame(() => closeEl?.focus());
  }
  function closeNav() {
    if (!navOpen) return;
    navOpen = false;
    document.body.style.overflow = "";
    fabEl?.focus();
  }

  onMount(() => {
    ticks.load();

    const onOpen = (e: Event) => {
      box = (e as CustomEvent).detail;
      document.body.style.overflow = "hidden";
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (box) close();
      else if (navOpen) closeNav();
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

    // Scroll-spy on steps. rootMargin biases toward the step occupying the
    // upper-middle of the viewport, which is what a reader considers "where I am".
    const ratios = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset.step ?? "";
          ratios.set(key, e.isIntersecting ? e.intersectionRatio : 0);
        }
        let best = "";
        let bestRatio = 0;
        for (const [key, r] of ratios) if (r > bestRatio) [best, bestRatio] = [key, r];
        if (best) activeStep = best;
      },
      { rootMargin: "-15% 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] }
    );
    document.querySelectorAll("[data-step]").forEach((n) => io.observe(n));

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

  function jump(key: string) {
    document.getElementById(key)?.scrollIntoView({ behavior: "smooth", block: "start" });
    closeNav();
  }
  // Section headers are jump targets too — tapping one goes to its first step
  // and slides the drawer shut, same as a step.
  function jumpSection(section: Section) {
    if (section.steps[0]) jump(section.steps[0].key);
  }

  const stepPairs = (step: Step) =>
    step.items.map((i) => [i.code, i.name] as [string, string]);

  let allPairs = $derived(sections.flatMap((s) => s.steps.flatMap(stepPairs)));
  let total = $derived(ticks.progress(allPairs));
</script>

<!-- Pinned trigger (mobile only) — stays put while the page scrolls. -->
<button
  class="wt-fab"
  class:hidden={navOpen}
  bind:this={fabEl}
  onclick={openNav}
  aria-haspopup="dialog"
  aria-expanded={navOpen}
  aria-controls="wt-contents"
>
  <span class="burger" aria-hidden="true"></span>
  Contents
  {#if total.total}<span class="fab-cnt">{total.done}/{total.total}</span>{/if}
</button>

<!-- Scrim (mobile only) — tap to dismiss. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="wt-scrim" class:show={navOpen} onclick={closeNav} aria-hidden="true"></div>

<nav
  id="wt-contents"
  class="wt-nav"
  class:open={navOpen}
  aria-label="Walkthrough contents"
>
  <div class="nav-head">
    <h2>Contents</h2>
    <button class="nav-close" bind:this={closeEl} onclick={closeNav} aria-label="Close contents">✕</button>
    {#if total.total}
      <div class="prog">
        <div class="prog-bar"><div class="prog-fill" style={`width:${total.pct}%`}></div></div>
        <span class="prog-txt">{total.done}/{total.total} items found</span>
      </div>
    {/if}
  </div>

  {#each sections as section}
    {@const sp = ticks.progress(section.steps.flatMap(stepPairs))}
    <div class="nav-section">
      <h3>
        <button class="sec-jump" onclick={() => jumpSection(section)}>{section.label}</button>
        {#if sp.total}<span class="sec-count">{sp.done}/{sp.total}</span>{/if}
      </h3>
      <ul>
        {#each section.steps as step}
          <li>
            <button class="nav-link" class:active={activeStep === step.key} onclick={() => jump(step.key)}>
              <span class="title">{step.label}</span>
              {#if step.boss}<span class="pip boss" title="Boss">◆</span>{/if}
              {#if step.items.length}
                {@const ip = ticks.progress(stepPairs(step))}
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
  .nav-close { display: none; }
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
  .sec-jump {
    background: none; border: 0; padding: 0; cursor: pointer; font: inherit;
    color: inherit; text-transform: inherit; letter-spacing: inherit; text-align: left;
  }
  .sec-jump:hover { color: var(--heart-accent, #3a3020); }
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

  /* --- pinned trigger + scrim: desktop hides them (the rail is always shown) --- */
  .wt-fab, .wt-scrim { display: none; }

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
    /* Pinned "Contents" button — thumb zone, stays put while the page scrolls. */
    .wt-fab {
      display: inline-flex; align-items: center; gap: 0.5rem;
      position: fixed; right: 1rem; bottom: 1rem; z-index: 60;
      font-family: "AllByteCustom", Georgia, serif; font-size: 0.9rem;
      color: #f3ead0; background: var(--heart-accent, #3a3020); border: 1px solid #1d160c;
      padding: 0.6rem 0.95rem; border-radius: 999px;
      box-shadow: 0 5px 16px rgba(30, 22, 10, 0.45); cursor: pointer;
      transition: opacity 0.2s ease, transform 0.1s ease;
    }
    .wt-fab:active { transform: translateY(1px); }
    .wt-fab.hidden { opacity: 0; pointer-events: none; }
    .wt-fab .burger { width: 1rem; background: #f3ead0; }
    .wt-fab .burger::before, .wt-fab .burger::after { background: #f3ead0; }
    .fab-cnt {
      font-size: 0.72rem; background: rgba(243, 234, 208, 0.2);
      padding: 0.05rem 0.4rem; border-radius: 999px; border: 1px solid rgba(243, 234, 208, 0.35);
    }
    .burger {
      width: 1.05rem; height: 2px; background: currentColor; position: relative; display: block;
    }
    .burger::before, .burger::after {
      content: ""; position: absolute; left: 0; width: 100%; height: 2px; background: currentColor;
    }
    .burger::before { top: -5px; } .burger::after { top: 5px; }

    /* Scrim */
    .wt-scrim {
      display: block; position: fixed; inset: 0; z-index: 90;
      background: rgba(30, 22, 10, 0); pointer-events: none; transition: background 0.28s ease;
    }
    .wt-scrim.show { background: rgba(30, 22, 10, 0.42); pointer-events: auto; }

    /* Right-side drawer — slides in and back out. */
    .wt-nav {
      position: fixed; top: 0; right: 0; bottom: 0; left: auto; z-index: 100;
      width: 82%; max-width: 340px; max-height: none;
      background: var(--heart-bg, #cec08a); padding: 1rem 1.1rem 3rem;
      border-left: 2px solid var(--heart-card-border, #7a6e52);
      box-shadow: -8px 0 30px rgba(30, 22, 10, 0.35);
      transform: translateX(102%); transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
      will-change: transform; overflow-y: auto;
    }
    .wt-nav.open { transform: translateX(0); }

    .nav-head { position: relative; }
    .nav-close {
      display: block; position: absolute; top: -0.15rem; right: -0.2rem;
      background: none; border: 0; cursor: pointer; font-size: 1.4rem; line-height: 1;
      color: var(--heart-accent-dim, #5a4d38); padding: 0.1rem 0.35rem;
    }
    .nav-head h2 { padding-right: 1.6rem; }

    /* Bigger tap targets in the drawer. */
    .nav-link { padding: 0.5rem 0.45rem; font-size: 0.9rem; }
    .nav-section h3 { padding-bottom: 0.3rem; }
    .sec-jump { padding: 0.15rem 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .wt-nav, .wt-scrim, .wt-fab { transition: none; }
  }
</style>
