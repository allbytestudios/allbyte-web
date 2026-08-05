<script lang="ts">
  // Pixelate dissolve for the site → game "Play" moment. It runs ENTIRELY on the
  // homepage: the visible page dissolves into fat pixels and cross-fades to a plain
  // dark screen at the peak, ending on black. HeroPlay then navigates to /play,
  // whose studio screen is the same near-black (#050608), so the brief black
  // bridges home → game with no templated splash and no flash.
  //
  // Owner 2026-08-05: pixelate the WHOLE visible page, not just the hero image.
  // The browser has no native "screenshot the DOM" API, so we snapshot the
  // viewport with snapdom (rasterizes the DOM — nav, headline, buttons, AND the
  // hero video's current frame — to a canvas), then run the same GPU drawImage
  // mosaic over that. The dissolve only ever uses drawImage (never getImageData/
  // toDataURL), so canvas taint can't break it. If the snapshot fails or is slow,
  // we fall back to the previous video-only effect — Play is never blocked.
  import { onMount } from "svelte";

  let { ondone }: { ondone?: () => void } = $props();

  // Owner recipe (tuned in the pixelate lab 2026-08-03):
  const GRAIN = 12; // peak block size — a slight, high-count mosaic
  const DUR = 500; // ms
  const SWAP = 0.7; // page hands over to black at peak pixelation
  const SNAP_WAIT_MS = 650; // cap the wait for the snapshot before starting anyway

  let canvasEl: HTMLCanvasElement;

  // The hand-off frame: a plain dark screen matching /play's studio bg (#050608),
  // so the transition drops to black rather than a templated studio page.
  function paintBlack(x: CanvasRenderingContext2D, w: number, h: number) {
    x.fillStyle = "#050608";
    x.fillRect(0, 0, w, h);
  }

  // Fallback source when the page snapshot isn't available: the hero video only
  // (the original behavior). Object-fit: cover into the canvas.
  function drawVideo(bx: CanvasRenderingContext2D, video: HTMLVideoElement | null, w: number, h: number) {
    let ok = false;
    try {
      if (video && video.videoWidth) {
        const vr = video.videoWidth / video.videoHeight, cr = w / h;
        let sw = video.videoWidth, sh = video.videoHeight, sox = 0, soy = 0;
        if (vr > cr) { sw = video.videoHeight * cr; sox = (video.videoWidth - sw) / 2; }
        else { sh = video.videoWidth / cr; soy = (video.videoHeight - sh) / 2; }
        bx.drawImage(video, sox, soy, sw, sh, 0, 0, w, h);
        ok = true;
      }
    } catch {
      /* not drawable */
    }
    if (!ok) {
      const g = bx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#31558a"); g.addColorStop(0.6, "#7fa8cf");
      g.addColorStop(0.62, "#3a6b34"); g.addColorStop(1, "#2f5a2b");
      bx.fillStyle = g; bx.fillRect(0, 0, w, h);
    }
  }

  onMount(() => {
    const cv = canvasEl;
    // The Play button sits inside a CSS-transformed plate, which would trap a
    // position:fixed element in the plate's box. Reparent to <body> so the
    // canvas covers the whole viewport, not just a box under the button.
    document.body.appendChild(cv);
    const ctx = cv.getContext("2d");
    if (!ctx) { ondone?.(); return; }
    const scale = Math.min(1, 900 / window.innerWidth);
    cv.width = Math.max(160, Math.round(window.innerWidth * scale));
    cv.height = Math.max(100, Math.round(window.innerHeight * scale));
    const W = cv.width, H = cv.height;

    const video = document.querySelector(".hero-video") as HTMLVideoElement | null;
    const allb = document.createElement("canvas"); allb.width = W; allb.height = H;
    paintBlack(allb.getContext("2d")!, W, H);
    const buf = document.createElement("canvas"); buf.width = W; buf.height = H;
    const bx = buf.getContext("2d")!;
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

    let cancelled = false;

    // Snapshot ONLY the visible viewport (snapdom `clip`), rendered at the same
    // `scale` as our buffers so it maps 1:1. Clipping to the viewport instead of
    // the full scrollHeight is what keeps the capture fast enough (~300ms) to
    // beat the cap — a full-page capture missed it and dropped to video-only.
    // embedFonts is off: fonts are imperceptible once mosaiced, and embedding the
    // OTF is a big chunk of the capture cost. Dynamically imported so snapdom
    // (which touches window/document at load) never runs during Astro's SSR pass.
    let pageSnap: HTMLCanvasElement | null = null;
    const capture = async () => {
      const { snapdom } = await import("@zumer/snapdom");
      const r = await snapdom(document.body, {
        scale,
        dpr: 1,
        fast: true,
        embedFonts: false,
        backgroundColor: "#050608",
        exclude: [".pixfx"], // don't snapshot our own overlay
        clip: {
          x: window.scrollX || 0,
          y: window.scrollY || 0,
          width: window.innerWidth,
          height: window.innerHeight,
        },
      });
      const c = await r.toCanvas();
      if (!cancelled) pageSnap = c;
    };

    // Decide the source ONCE when the dissolve starts (no mid-flight snap→video
    // pop): the page snapshot if it landed within the cap, else the video.
    let useSnap = false;
    const drawSource = () => {
      bx.imageSmoothingEnabled = true;
      bx.clearRect(0, 0, W, H);
      if (useSnap && pageSnap) {
        try {
          // pageSnap is the clipped viewport → draw it to fill the buffer.
          bx.drawImage(pageSnap, 0, 0, pageSnap.width, pageSnap.height, 0, 0, W, H);
          return;
        } catch {
          /* snapshot unusable — fall through to the video */
        }
      }
      drawVideo(bx, video, W, H);
    };

    let raf = 0;
    const start = () => {
      useSnap = !!pageSnap;
      const t0 = performance.now();
      const step = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - t0) / DUR);
        // block peaks at SWAP, back to 1 at the ends
        const peak = 1 - Math.abs(t - SWAP) / Math.max(SWAP, 1 - SWAP);
        const block = Math.max(1, Math.round(1 + peak * (GRAIN - 1)));
        const dw = Math.max(1, Math.round(W / block)), dh = Math.max(1, Math.round(H / block));
        const cf = clamp((t - (SWAP - 0.08)) / 0.16, 0, 1); // page → black at peak

        drawSource();
        if (cf > 0) { bx.globalAlpha = cf; bx.drawImage(allb, 0, 0, W, H); bx.globalAlpha = 1; }

        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(buf, 0, 0, W, H, 0, 0, dw, dh);
        ctx.drawImage(cv, 0, 0, dw, dh, 0, 0, W, H);

        if (t < 1) raf = requestAnimationFrame(step);
        else {
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, W, H);
          ctx.drawImage(allb, 0, 0);
          ondone?.();
        }
      };
      raf = requestAnimationFrame(step);
    };

    // Wait for the snapshot (capped) so frame 1 already has the whole page; if it
    // times out we start on the video fallback and never block Play.
    const snapDone = capture().catch(() => {});
    const timer = new Promise<void>((res) => setTimeout(res, SNAP_WAIT_MS));
    Promise.race([snapDone, timer]).then(() => { if (!cancelled) start(); });

    return () => { cancelled = true; cancelAnimationFrame(raf); cv.remove(); };
  });
</script>

<canvas bind:this={canvasEl} class="pixfx" aria-hidden="true"></canvas>

<style>
  .pixfx {
    position: fixed;
    inset: 0;
    z-index: 100;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    pointer-events: none;
    background: transparent;
  }
</style>
