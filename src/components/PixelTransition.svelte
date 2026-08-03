<script lang="ts">
  // Pixelate / mosaic-dissolve transition for the site → game "Play" moment,
  // spanning the homepage → /play navigation. It's a SINGLE canvas doing GPU
  // drawImage scaling (no DOM layers, no backdrop-filter), so it's smooth on
  // phones — the fix for the glass shatter's mobile jank.
  //   mode="obscure" (homepage): the hero video blocks up into fat pixels, then
  //     fades to solid dark; ondone() → navigate.
  //   mode="reveal"  (/play): the AllByte screen materialises out of fat pixels
  //     from that same dark, then the canvas fades to hand off to the real
  //     studio loading screen behind it; ondone() → studio scramble starts.
  import { onMount } from "svelte";

  let { mode = "obscure", ondone }: { mode?: "obscure" | "reveal"; ondone?: () => void } = $props();

  const MAX_BLOCK = 60; // chunky — ~a handful of blocks across at peak
  const DARK = "#050608";

  let canvasEl: HTMLCanvasElement;

  function paintAllByte(x: CanvasRenderingContext2D, w: number, h: number) {
    x.fillStyle = DARK;
    x.fillRect(0, 0, w, h);
    const g = x.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, w * 0.6);
    g.addColorStop(0, "#1b140c");
    g.addColorStop(1, DARK);
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.textAlign = "center";
    x.fillStyle = "#f4ecd6";
    x.font = `600 ${Math.round(h * 0.15)}px "AllByteCustom", Georgia, serif`;
    x.fillText("All Byte", w / 2, h * 0.57);
    x.font = `${Math.round(h * 0.05)}px monospace`;
    x.fillText("1 0 1 0 1 1 0 0", w / 2, h * 0.4);
  }

  onMount(() => {
    const cv = canvasEl;
    const ctx = cv.getContext("2d");
    if (!ctx) {
      ondone?.();
      return;
    }
    // Low internal resolution + pixelated upscale = cheap AND chunky.
    cv.width = Math.max(120, Math.round(window.innerWidth * 0.5));
    cv.height = Math.max(80, Math.round(window.innerHeight * 0.5));
    const W = cv.width, H = cv.height;
    let raf = 0;
    let cancelled = false;

    if (mode === "obscure") {
      const video = document.querySelector(".hero-video") as HTMLVideoElement | null;
      const scratch = document.createElement("canvas");
      scratch.width = W; scratch.height = H;
      const sx = scratch.getContext("2d")!;
      const t0 = performance.now(), DUR = 540;
      const step = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - t0) / DUR);
        const pe = Math.min(1, t / 0.72); // pixelate up, then hold
        const block = Math.max(1, Math.round(1 + pe * MAX_BLOCK));
        const dw = Math.max(1, Math.round(W / block)), dh = Math.max(1, Math.round(H / block));
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, W, H);
        let drew = false;
        try {
          if (video && video.videoWidth) {
            // cover-fit the video, then pixelate via down/up scale
            const vr = video.videoWidth / video.videoHeight, cr = W / H;
            let sw = video.videoWidth, sh = video.videoHeight, sox = 0, soy = 0;
            if (vr > cr) { sw = video.videoHeight * cr; sox = (video.videoWidth - sw) / 2; }
            else { sh = video.videoWidth / cr; soy = (video.videoHeight - sh) / 2; }
            sx.imageSmoothingEnabled = false;
            sx.drawImage(video, sox, soy, sw, sh, 0, 0, dw, dh);
            ctx.drawImage(scratch, 0, 0, dw, dh, 0, 0, W, H);
            drew = true;
          }
        } catch {
          /* video not drawable (rare) — fall through to a dark cover */
        }
        if (!drew) { ctx.fillStyle = "#0c1220"; ctx.fillRect(0, 0, W, H); }
        if (t > 0.72) {
          ctx.globalAlpha = (t - 0.72) / 0.28;
          ctx.fillStyle = DARK;
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
        }
        if (t < 1) raf = requestAnimationFrame(step);
        else { ctx.fillStyle = DARK; ctx.fillRect(0, 0, W, H); ondone?.(); }
      };
      raf = requestAnimationFrame(step);
    } else {
      const all = document.createElement("canvas");
      all.width = W; all.height = H;
      paintAllByte(all.getContext("2d")!, W, H);
      const t0 = performance.now(), DUR = 560;
      const step = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - t0) / DUR);
        const pe = 1 - Math.min(1, t / 0.8); // de-pixelate: block big → 1
        const block = Math.max(1, Math.round(1 + pe * MAX_BLOCK));
        const dw = Math.max(1, Math.round(W / block)), dh = Math.max(1, Math.round(H / block));
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(all, 0, 0, W, H, 0, 0, dw, dh);
        ctx.drawImage(cv, 0, 0, dw, dh, 0, 0, W, H);
        if (t > 0.82) cv.style.opacity = String(Math.max(0, 1 - (t - 0.82) / 0.18));
        if (t < 1) raf = requestAnimationFrame(step);
        else ondone?.();
      };
      raf = requestAnimationFrame(step);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
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
