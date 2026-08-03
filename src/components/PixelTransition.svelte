<script lang="ts">
  // Pixelate dissolve for the site → game "Play" moment. It runs ENTIRELY on the
  // homepage (where both the home image and the AllByte frame are available to
  // cross-blend, exactly like the tuning lab): the home screen dissolves into
  // fat pixels, swaps to AllByte at the peak, and AllByte resolves back out — no
  // zoom, no cut to black. It ends on a sharp AllByte frame; HeroPlay then
  // navigates to /play, whose studio screen matches, so the swap is invisible.
  // One canvas, GPU drawImage scaling — smooth on phones.
  import { onMount } from "svelte";

  let { ondone }: { ondone?: () => void } = $props();

  // Owner recipe (tuned in the pixelate lab 2026-08-03):
  const GRAIN = 12; // peak block size — a slight, high-count mosaic
  const DUR = 500; // ms
  const SWAP = 0.7; // home hands over to AllByte at peak pixelation

  let canvasEl: HTMLCanvasElement;

  function paintAllByte(x: CanvasRenderingContext2D, w: number, h: number) {
    x.fillStyle = "#050608";
    x.fillRect(0, 0, w, h);
    const g = x.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, w * 0.6);
    g.addColorStop(0, "#1b140c");
    g.addColorStop(1, "#050608");
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.textAlign = "center";
    x.fillStyle = "#f4ecd6";
    x.font = `600 ${Math.round(h * 0.16)}px "AllByteCustom", Georgia, serif`;
    x.fillText("All Byte", w / 2, h * 0.57);
    x.font = `${Math.round(h * 0.052)}px monospace`;
    x.fillText("1 0 1 0 1 1 0 0", w / 2, h * 0.4);
  }

  function drawHome(bx: CanvasRenderingContext2D, video: HTMLVideoElement | null, w: number, h: number) {
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
      // Fallback "home" so it never dumps to black if the video isn't ready.
      const g = bx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#31558a"); g.addColorStop(0.6, "#7fa8cf");
      g.addColorStop(0.62, "#3a6b34"); g.addColorStop(1, "#2f5a2b");
      bx.fillStyle = g; bx.fillRect(0, 0, w, h);
    }
  }

  onMount(() => {
    const cv = canvasEl;
    const ctx = cv.getContext("2d");
    if (!ctx) { ondone?.(); return; }
    const scale = Math.min(1, 900 / window.innerWidth);
    cv.width = Math.max(160, Math.round(window.innerWidth * scale));
    cv.height = Math.max(100, Math.round(window.innerHeight * scale));
    const W = cv.width, H = cv.height;

    const video = document.querySelector(".hero-video") as HTMLVideoElement | null;
    const allb = document.createElement("canvas"); allb.width = W; allb.height = H;
    paintAllByte(allb.getContext("2d")!, W, H);
    const buf = document.createElement("canvas"); buf.width = W; buf.height = H;
    const bx = buf.getContext("2d")!;
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

    let raf = 0, cancelled = false;
    const t0 = performance.now();
    const step = (now: number) => {
      if (cancelled) return;
      const t = Math.min(1, (now - t0) / DUR);
      // block peaks at SWAP, back to 1 at the ends
      const peak = 1 - Math.abs(t - SWAP) / Math.max(SWAP, 1 - SWAP);
      const block = Math.max(1, Math.round(1 + peak * (GRAIN - 1)));
      const dw = Math.max(1, Math.round(W / block)), dh = Math.max(1, Math.round(H / block));
      const cf = clamp((t - (SWAP - 0.08)) / 0.16, 0, 1); // home → AllByte at peak

      bx.imageSmoothingEnabled = true;
      bx.clearRect(0, 0, W, H);
      drawHome(bx, video, W, H);
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

    return () => { cancelled = true; cancelAnimationFrame(raf); };
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
