<script lang="ts">
  /**
   * A walkthrough screenshot with optional callout markers.
   *
   * Coords arrive in the SOURCE still's pixel space (what Quinn's still driver
   * reports). They're converted to percentages here using the original
   * dimensions emitted by sync, so markers land correctly regardless of the
   * downscale width or the rendered size on screen. Authoring stays raw-pixel;
   * rendering stays resolution-independent.
   */
  import dims from "../data/walkthrough-stills.json";

  interface Indicator {
    label: string;
    target?: string;
    x: number;
    y: number;
    screenshot?: string;
  }

  let {
    name,
    alt,
    indicators = [] as Indicator[],
    eager = false,
  }: {
    name: string;
    alt: string;
    indicators?: Indicator[];
    /** First shot on the page — don't lazy-load the LCP image. */
    eager?: boolean;
  } = $props();

  // Each shot is its own Astro island, so there's no shared parent to hand a
  // callback down from — the lightbox is a separate island entirely. A window
  // event is the decoupled way to connect them.
  const openLightbox = () =>
    window.dispatchEvent(
      new CustomEvent("walkthrough:lightbox", { detail: { name, alt, indicators } })
    );

  const size = (dims as Record<string, { w: number; h: number; widths?: number[] }>)[name];

  // srcset from the widths sync actually emitted. `sizes` mirrors the layout:
  // full viewport width on mobile, ~800px content column on desktop -- so a
  // phone fetches the 480 file instead of the 1280 one.
  const srcset = (size?.widths ?? [])
    .map((w) => `/walkthrough/${name}-${w}.webp ${w}w`)
    .join(", ");
  const SIZES = "(max-width: 900px) 100vw, 800px";

  // Only markers for THIS still, positioned as a percentage of the source.
  let marks = $derived(
    indicators
      .filter((i) => !i.screenshot || i.screenshot.replace(/\.[^.]+$/, "") === name)
      .map((i) => ({
        ...i,
        left: size ? (i.x / size.w) * 100 : null,
        top: size ? (i.y / size.h) * 100 : null,
      }))
      // A marker with no dimension data would stack at 0,0 and look like a bug.
      .filter((i) => i.left !== null && i.top !== null)
  );
</script>

<figure class="wt-shot">
  <button class="shot-btn" onclick={openLightbox} aria-label={`Enlarge screenshot: ${alt}`}>
    <img
      src={`/walkthrough/${name}.webp`}
      srcset={srcset || undefined}
      sizes={srcset ? SIZES : undefined}
      width={size?.w}
      height={size?.h}
      {alt}
      loading={eager ? "eager" : "lazy"}
      fetchpriority={eager ? "high" : undefined}
      decoding="async"
    />
    {#each marks as m}
      <span
        class="marker marker-{m.target ?? 'item'}"
        style={`left:${m.left}%; top:${m.top}%`}
      >
        <span class="dot" aria-hidden="true"></span>
        <span class="label">{m.label}</span>
      </span>
    {/each}
  </button>
</figure>

<style>
  .wt-shot { margin: 1.1rem 0; }
  .shot-btn {
    position: relative; display: block; width: 100%; padding: 0; cursor: zoom-in;
    background: none; border: 2px solid var(--heart-card-border, #7a6e52); border-radius: 4px;
    overflow: hidden; line-height: 0;
  }
  .shot-btn:focus-visible { outline: 3px solid var(--heart-accent, #3a3020); outline-offset: 2px; }
  /* width/height attrs give the intrinsic ratio so space is reserved before the
     image loads (no layout shift); these keep it fluid. */
  img { width: 100%; height: auto; display: block; }

  @media (max-width: 900px) {
    /* Cap height so a tall still can't push the instructions off-screen -- the
       prose is the product, the screenshot supports it. */
    img { max-height: 60svh; width: auto; margin: 0 auto; }
  }

  .marker {
    position: absolute; transform: translate(-50%, -50%);
    display: flex; align-items: center; gap: 0.4rem; pointer-events: none;
    line-height: 1;
  }
  .dot {
    width: 1.05rem; height: 1.05rem; border-radius: 50%; flex: none;
    border: 2.5px solid #fdf6e3; background: rgba(58, 48, 32, 0.55);
    box-shadow: 0 0 0 2px rgba(42, 34, 24, 0.85), 0 2px 6px rgba(0, 0, 0, 0.5);
  }
  .label {
    font-family: Georgia, "Times New Roman", serif; font-size: 0.78rem; white-space: nowrap;
    color: #2a2218; background: #fdf6e3; padding: 0.16rem 0.5rem; border-radius: 3px;
    border: 1.5px solid #2a2218; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.45);
  }
  /* Target-specific accents keep chest/door/npc scannable at a glance. */
  .marker-chest .dot { background: rgba(180, 130, 20, 0.75); }
  .marker-door .dot,
  .marker-exit .dot { background: rgba(60, 110, 160, 0.75); }
  .marker-npc .dot { background: rgba(150, 60, 120, 0.75); }
  .marker-bed .dot { background: rgba(80, 130, 90, 0.75); }

  @media (max-width: 640px) {
    .label { font-size: 0.68rem; padding: 0.1rem 0.35rem; }
    .dot { width: 0.85rem; height: 0.85rem; border-width: 2px; }
  }
</style>
