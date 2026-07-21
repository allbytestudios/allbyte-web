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

  // PARKED 2026-07-21: indicator OVERLAY rendering is disabled — placement was
  // off and only one scene has coords authored so far. Everything upstream is
  // intact and still validated (schema, sync gates, source-pixel -> percentage
  // conversion, still-dimensions.json), so re-enabling is a rendering change
  // only. `marks` is computed but not drawn.
  //
  // Only markers for THIS still, positioned as a percentage of the source.
  // Each label is pushed into the gutter on whichever side its dot is nearer,
  // so the callout text never covers the art it is pointing at. `lane` spreads
  // labels that share a side vertically so they cannot overlap each other.
  let marks = $derived.by(() => {
    const placed = indicators
      .filter((i) => !i.screenshot || i.screenshot.replace(/\.[^.]+$/, "") === name)
      .map((i) => ({
        ...i,
        left: size ? (i.x / size.w) * 100 : null,
        top: size ? (i.y / size.h) * 100 : null,
      }))
      // A marker with no dimension data would stack at 0,0 and look like a bug.
      .filter((i) => i.left !== null && i.top !== null)
      .map((i) => ({ ...i, side: (i.left as number) < 50 ? "left" : "right" }));

    // Vertical de-overlap, per side: keep at least MIN_GAP% between labels.
    const MIN_GAP = 11;
    for (const side of ["left", "right"]) {
      const lane = placed.filter((m) => m.side === side).sort((a, b) => (a.top as number) - (b.top as number));
      let prev = -Infinity;
      for (const m of lane) {
        const want = Math.max(m.top as number, prev + MIN_GAP);
        (m as any).labelTop = Math.min(want, 100);
        prev = (m as any).labelTop;
      }
    }
    return placed;
  });
</script>

<figure class="wt-shot" class:has-marks={marks.length > 0}>
  <div class="shot-frame">
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
  </button>
  </div>
</figure>

<style>
  .wt-shot { margin: 1.1rem 0; }

  /* Gutters hold the callout text so it never covers the art. Only reserved
     when a shot actually has markers. */
  .shot-frame { position: relative; }
  .wt-shot.has-marks .shot-frame { padding: 0 8.5rem; }

  .shot-btn {
    position: relative; display: block; width: 100%; padding: 0; cursor: zoom-in;
    background: none; border: 2px solid var(--heart-card-border, #7a6e52); border-radius: 4px;
    overflow: visible; line-height: 0;
  }
  .shot-btn:focus-visible { outline: 3px solid var(--heart-accent, #3a3020); outline-offset: 2px; }
  /* width/height attrs give the intrinsic ratio so space is reserved before the
     image loads (no layout shift); these keep it fluid. */
  img { width: 100%; height: auto; display: block; border-radius: 2px; }

  /* --- dots: the only thing drawn ON the screenshot --- */
  .dot {
    position: absolute; transform: translate(-50%, -50%); z-index: 2;
    width: 1rem; height: 1rem; border-radius: 50%;
    border: 2.5px solid #fdf6e3; background: rgba(58, 48, 32, 0.6);
    box-shadow: 0 0 0 2px rgba(42, 34, 24, 0.85), 0 2px 6px rgba(0, 0, 0, 0.5);
    pointer-events: none;
  }
  .dot-chest { background: rgba(180, 130, 20, 0.85); }
  .dot-door, .dot-exit { background: rgba(60, 110, 160, 0.85); }
  .dot-npc { background: rgba(150, 60, 120, 0.85); }
  .dot-bed { background: rgba(80, 130, 90, 0.85); }

  /* --- leader lines: image edge -> dot --- */
  .leaders {
    position: absolute; inset: 0; width: 100%; height: 100%;
    pointer-events: none; z-index: 1; overflow: visible;
  }
  .leader { stroke: #2a2218; stroke-width: 1.5; opacity: 0.85; }
  .leader-chest { stroke: #b48214; }
  .leader-door, .leader-exit { stroke: #3c6ea0; }
  .leader-npc { stroke: #963c78; }
  .leader-bed { stroke: #50825a; }

  /* --- callout text: lives in the gutter, ModernGoth --- */
  .callout {
    position: absolute; transform: translateY(-50%); z-index: 3;
    max-width: 8rem; pointer-events: none;
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 0.86rem; line-height: 1.25; letter-spacing: 0.01em;
    color: #2a2218; background: #fdf6e3;
    border: 1.5px solid #2a2218; border-radius: 3px;
    padding: 0.2rem 0.45rem; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.35);
  }
  .callout.on-left { left: 0; text-align: right; }
  .callout.on-right { right: 0; text-align: left; }
  .callout-chest { border-color: #b48214; }
  .callout-door, .callout-exit { border-color: #3c6ea0; }
  .callout-npc { border-color: #963c78; }
  .callout-bed { border-color: #50825a; }

  @media (max-width: 900px) {
    img { max-height: 60svh; width: auto; margin: 0 auto; }
  }
  /* Narrow screens have no room for gutters: stack callouts under the shot as a
     numbered-free legend, still ModernGoth, still colour-matched to its dot. */
  @media (max-width: 700px) {
    .wt-shot.has-marks .shot-frame { padding: 0; }
    .leaders { display: none; }
    .callout {
      position: static; transform: none; display: inline-block;
      max-width: none; margin: 0.3rem 0.3rem 0 0; font-size: 0.8rem;
    }
    .callout.on-left, .callout.on-right { text-align: left; }
  }
</style>
