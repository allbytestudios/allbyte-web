<script lang="ts">
  // JRPG-style glass-fracture entrance for /play. Timeline (~1.8s total):
  //   crack  (0–0.32s): fractures spider out from an impact point; behind the
  //                     glass the scene is blurred + darkened (frost layer).
  //   hold   (0.32–1.15s): sits fractured.
  //   light  (1.15–1.35s): the fracture lines glow (light behind the glass).
  //   fall   (1.35–1.8s): the shards drop away, revealing the scene; frost clears.
  // Runs entirely on the compositor (transform/opacity), so it stays smooth even
  // while the game's WASM is downloading/compiling underneath.
  import { onMount } from "svelte";

  let { ondone }: { ondone?: () => void } = $props();

  const CX = 50;
  const CY = 45; // impact point, in viewBox/% units (slightly above center)

  type Shard = {
    pts: string; // clip-path polygon points, "x% y%, ..."
    ox: string;
    oy: string; // transform-origin (centroid)
    dx: number; // horizontal drift on fall (vw)
    rot: number; // rotation on fall (deg)
    delay: number; // fall delay (ms)
  };

  function polar(a: number, r: number): [number, number] {
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  }

  let shards = $state<Shard[]>([]);
  let cracks = $state<string[]>([]); // SVG polyline point strings
  let phase = $state<"crack" | "hold" | "light" | "fall">("crack");
  let reduce = false;

  function build() {
    const spokes = 10;
    const ang: number[] = [];
    for (let i = 0; i < spokes; i++) {
      ang.push((i / spokes) * Math.PI * 2 + (Math.random() - 0.5) * 0.3);
    }
    const rings = [0, 9, 22, 44, 165]; // last ring overshoots the corners
    const sh: Shard[] = [];
    for (let j = 0; j < rings.length - 1; j++) {
      for (let i = 0; i < spokes; i++) {
        const a0 = ang[i];
        const a1 = ang[(i + 1) % spokes] + (i === spokes - 1 ? Math.PI * 2 : 0);
        const r0 = rings[j];
        const r1 = rings[j + 1];
        const pts: [number, number][] =
          r0 === 0
            ? [[CX, CY], polar(a0, r1), polar(a1, r1)]
            : [polar(a0, r0), polar(a1, r0), polar(a1, r1), polar(a0, r1)];
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        sh.push({
          pts: pts.map((p) => `${p[0]}% ${p[1]}%`).join(", "),
          ox: `${cx}%`,
          oy: `${cy}%`,
          dx: (cx - CX) * 0.16 + (Math.random() - 0.5) * 10,
          rot: (Math.random() - 0.5) * 70,
          delay: Math.round((r0 / 165) * 150 + Math.random() * 140),
        });
      }
    }
    shards = sh;

    // Crack network: radial spokes + the ring polylines (the shard edges).
    const cr: string[] = [];
    for (let i = 0; i < spokes; i++) {
      const [x, y] = polar(ang[i], 165);
      cr.push(`${CX},${CY} ${x},${y}`);
    }
    for (const r of [9, 22, 44]) {
      const ringPts: string[] = [];
      for (let i = 0; i <= spokes; i++) {
        const [x, y] = polar(ang[i % spokes], r);
        ringPts.push(`${x},${y}`);
      }
      cr.push(ringPts.join(" "));
    }
    cracks = cr;
  }

  onMount(() => {
    reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    build();
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (reduce) {
      // No shatter: a brief darken, then hand off.
      timers.push(setTimeout(() => ondone?.(), 450));
    } else {
      timers.push(setTimeout(() => (phase = "hold"), 340));
      timers.push(setTimeout(() => (phase = "light"), 1150));
      timers.push(setTimeout(() => (phase = "fall"), 1350));
      timers.push(setTimeout(() => ondone?.(), 1820));
    }
    return () => timers.forEach(clearTimeout);
  });
</script>

<div
  class="glass glass-{phase}"
  class:reduce
  aria-hidden="true"
>
  <div class="glass-frost"></div>
  {#if !reduce}
    <div class="glass-reveal">
      <div class="glass-shards">
        {#each shards as s}
          <div
            class="shard"
            style="clip-path: polygon({s.pts}); transform-origin: {s.ox} {s.oy}; --dx:{s.dx}; --rot:{s.rot}deg; --delay:{s.delay}ms;"
          ></div>
        {/each}
      </div>
      <svg class="glass-cracks" viewBox="0 0 100 100" preserveAspectRatio="none">
        {#each cracks as c}
          <polyline points={c} />
        {/each}
      </svg>
    </div>
  {/if}
</div>

<style>
  .glass {
    position: fixed;
    inset: 0;
    z-index: 100;
    pointer-events: none;
    overflow: hidden;
  }

  /* Blur + darken whatever is behind the glass. */
  .glass-frost {
    position: absolute;
    inset: 0;
    background: rgba(6, 8, 14, 0.34);
    backdrop-filter: blur(7px) brightness(0.55) saturate(0.85);
    -webkit-backdrop-filter: blur(7px) brightness(0.55) saturate(0.85);
    opacity: 0;
    animation: frostIn 0.3s ease forwards;
  }
  .glass-fall .glass-frost {
    animation: frostOut 0.42s ease forwards;
  }
  @keyframes frostIn {
    to {
      opacity: 1;
    }
  }
  @keyframes frostOut {
    to {
      opacity: 0;
    }
  }

  /* Spider reveal — clip the fracture in from the impact point outward. */
  .glass-reveal {
    position: absolute;
    inset: 0;
    clip-path: circle(0% at 50% 45%);
    animation: crackReveal 0.32s ease-out forwards;
  }
  @keyframes crackReveal {
    to {
      clip-path: circle(160% at 50% 45%);
    }
  }

  .glass-shards,
  .glass-cracks {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .shard {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      135deg,
      rgba(214, 228, 255, 0.16),
      rgba(150, 180, 230, 0.05) 55%,
      rgba(214, 228, 255, 0.13)
    );
    will-change: transform, opacity;
  }
  .glass-fall .shard {
    animation: shardFall 0.5s cubic-bezier(0.45, 0, 0.85, 0.35) forwards;
    animation-delay: var(--delay);
  }
  @keyframes shardFall {
    to {
      transform: translate(calc(var(--dx) * 1vw), 122vh) rotate(var(--rot));
      opacity: 0;
    }
  }

  .glass-cracks polyline {
    fill: none;
    stroke: rgba(222, 236, 255, 0.5);
    stroke-width: 1.1;
    vector-effect: non-scaling-stroke;
    stroke-linejoin: round;
  }
  /* Light behind the glass — the fractures glow. */
  .glass-light .glass-cracks polyline,
  .glass-fall .glass-cracks polyline {
    stroke: rgba(190, 234, 255, 0.95);
    filter: drop-shadow(0 0 2px rgba(150, 220, 255, 0.9));
    transition: stroke 0.2s ease, filter 0.2s ease;
  }
  .glass-fall .glass-cracks {
    animation: cracksOut 0.42s ease forwards;
  }
  @keyframes cracksOut {
    to {
      opacity: 0;
    }
  }

  /* Reduced motion: just a brief frosted darken, no shatter. */
  .glass.reduce .glass-frost {
    animation: frostIn 0.25s ease forwards, frostOut 0.25s ease 0.2s forwards;
  }
</style>
