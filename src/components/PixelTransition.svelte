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

  // Fine grain (high pixel count) + gentle — a very slight mosaic shimmer over a
  // smooth fade, so it reads as an intentional dissolve, never a glitch.
  const MAX_BLOCK = 5;
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
    // Crisp-ish internal buffer (capped for perf) so the mosaic stays fine.
    const scale = Math.min(1, 900 / window.innerWidth);
    cv.width = Math.max(160, Math.round(window.innerWidth * scale));
    cv.height = Math.max(100, Math.round(window.innerHeight * scale));
    const W = cv.width, H = cv.height;
    let raf = 0;
    let cancelled = false;

    if (mode === "obscure") {
      const video = document.querySelector(".hero-video") as HTMLVideoElement | null;
      const scratch = document.createElement("canvas");
      scratch.width = W; scratch.height = H;
      const sx = scratch.getContext("2d")!;
      const t0 = performance.now(), DUR = 440;
      const step = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - t0) / DUR);
        const e = t * t; // easeIn
        const block = Math.max(1, Math.round(1 + e * MAX_BLOCK));
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
        // gentle continuous darken toward the /play ground — no hard cut
        ctx.globalAlpha = e;
        ctx.fillStyle = DARK;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
        if (t < 1) raf = requestAnimationFrame(step);
        else { ctx.fillStyle = DARK; ctx.fillRect(0, 0, W, H); ondone?.(); }
      };
      raf = requestAnimationFrame(step);
    } else {
      const all = document.createElement("canvas");
      all.width = W; all.height = H;
      paintAllByte(all.getContext("2d")!, W, H);
      const scr = document.createElement("canvas");
      scr.width = W; scr.height = H;
      const sc = scr.getContext("2d")!;
      const t0 = performance.now(), DUR = 460;
      const step = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - t0) / DUR);
        const de = (1 - t) * (1 - t); // subtle de-pixel, eased
        const block = Math.max(1, Math.round(1 + de * MAX_BLOCK));
        const dw = Math.max(1, Math.round(W / block)), dh = Math.max(1, Math.round(H / block));
        // fine-pixelate the AllByte frame into a scratch buffer
        sc.imageSmoothingEnabled = false;
        sc.clearRect(0, 0, W, H);
        sc.drawImage(all, 0, 0, W, H, 0, 0, dw, dh);
        sc.drawImage(scr, 0, 0, dw, dh, 0, 0, W, H);
        // dark ground, then fade the frame in gently over it
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = DARK;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = Math.min(1, t / 0.7);
        ctx.drawImage(scr, 0, 0);
        ctx.globalAlpha = 1;
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
