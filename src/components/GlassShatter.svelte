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
    tint: number; // per-shard glass brightness (catches "light" differently)
  };
  type Crack = { pts: string; w: number }; // polyline points + stroke weight

  function polar(a: number, r: number): [number, number] {
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  }
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  let shards = $state<Shard[]>([]);
  let cracks = $state<Crack[]>([]);
  let phase = $state<"crack" | "hold" | "light" | "fall">("crack");
  let reduce = false;

  // Real glass from an impact: radial cracks shoot out (jagged, some die early)
  // and irregular concentric cracks ring them — the rings are NOT circles, each
  // spoke sits at a jittered radius, so the shards are irregular angular pieces.
  function build() {
    const spokes = 13;
    const ang: number[] = [];
    for (let i = 0; i < spokes; i++) {
      // uneven angular spacing — real cracks aren't evenly spread
      ang.push((i / spokes) * Math.PI * 2 + rnd(-0.22, 0.22));
    }
    const rings = [0, 6, 15, 30, 55, 175]; // 0 = impact; last overshoots corners
    // A jittered point grid shared by shards AND cracks so they always align.
    // grid[j][i] = the vertex on ring j along spoke i, at a per-vertex radius.
    const grid: [number, number][][] = [];
    for (let j = 0; j < rings.length; j++) {
      const row: [number, number][] = [];
      for (let i = 0; i < spokes; i++) {
        if (rings[j] === 0) row.push([CX, CY]);
        else row.push(polar(ang[i], rings[j] * rnd(0.78, 1.22)));
      }
      grid.push(row);
    }
    // Some radial cracks die before the edge (common in glass) — mark the
    // outer ring each spoke reaches.
    const reach: number[] = ang.map(() =>
      Math.random() < 0.3 ? rings.length - 2 : rings.length - 1,
    );

    const sh: Shard[] = [];
    for (let j = 0; j < rings.length - 1; j++) {
      for (let i = 0; i < spokes; i++) {
        const i1 = (i + 1) % spokes;
        const pts: [number, number][] =
          j === 0
            ? [grid[0][0], grid[1][i], grid[1][i1]]
            : [grid[j][i], grid[j][i1], grid[j + 1][i1], grid[j + 1][i]];
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        sh.push({
          pts: pts.map((p) => `${p[0]}% ${p[1]}%`).join(", "),
          ox: `${cx}%`,
          oy: `${cy}%`,
          dx: (cx - CX) * 0.14 + rnd(-9, 9),
          rot: rnd(-75, 75),
          delay: Math.round((rings[j] / 175) * 140 + rnd(0, 150)),
          tint: rnd(0.05, 0.2),
        });
      }
    }
    shards = sh;

    const cr: Crack[] = [];
    // Radial cracks (jagged — they bend through the jittered ring vertices).
    for (let i = 0; i < spokes; i++) {
      const pl: string[] = [`${CX},${CY}`];
      for (let j = 1; j <= reach[i]; j++) pl.push(`${grid[j][i][0]},${grid[j][i][1]}`);
      cr.push({ pts: pl.join(" "), w: rnd(0.7, 1.4) });
    }
    // Concentric cracks (irregular closed polylines — the ring edges).
    for (let j = 1; j < rings.length - 1; j++) {
      const pl: string[] = [];
      for (let i = 0; i <= spokes; i++) {
        const g = grid[j][i % spokes];
        pl.push(`${g[0]},${g[1]}`);
      }
      cr.push({ pts: pl.join(" "), w: rnd(0.6, 1.0) });
    }
    // Secondary dead-end cracks branching off a random radial vertex.
    for (let k = 0; k < 6; k++) {
      const i = Math.floor(Math.random() * spokes);
      const j = 1 + Math.floor(Math.random() * (rings.length - 3));
      const [bx, by] = grid[j][i];
      const [ex, ey] = polar(ang[i] + rnd(-0.5, 0.5), rings[j] * rnd(1.15, 1.6));
      cr.push({ pts: `${bx},${by} ${ex},${ey}`, w: rnd(0.4, 0.8) });
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
            style="clip-path: polygon({s.pts}); transform-origin: {s.ox} {s.oy}; --dx:{s.dx}; --rot:{s.rot}deg; --delay:{s.delay}ms; --tint:{s.tint};"
          ></div>
        {/each}
      </div>
      <svg class="glass-cracks" viewBox="0 0 100 100" preserveAspectRatio="none">
        {#each cracks as c}
          <polyline points={c.pts} style="stroke-width:{c.w}" />
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
      rgba(216, 230, 255, var(--tint, 0.14)),
      rgba(150, 180, 230, 0.03) 55%,
      rgba(200, 220, 255, calc(var(--tint, 0.14) * 0.7))
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
