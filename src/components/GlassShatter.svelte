<script lang="ts">
  // JRPG glass-fracture transition that spans the homepage → /play navigation.
  //   mode="obscure" (homepage): the fracture spiders out and the frost thickens
  //     until the homepage is fully hidden, then ondone() fires → navigate.
  //   mode="reveal"  (/play): the SAME fracture (matched by `seed`) is already
  //     there; it lights up and the shards fall away, revealing the AllByte
  //     screen behind. Then ondone().
  // Everything animates on the compositor (transform/opacity), so it stays smooth
  // while the game's WASM downloads/compiles underneath.
  import { onMount } from "svelte";

  let {
    seed = 1,
    mode = "obscure",
    ondone,
  }: {
    seed?: number;
    mode?: "obscure" | "reveal";
    ondone?: () => void;
  } = $props();

  const CX = 50;
  const CY = 45; // impact point

  // Seeded PRNG (mulberry32) so obscure + reveal generate an identical fracture.
  function makeRng(s: number) {
    let a = s >>> 0 || 1;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  type Shard = { pts: string; ox: string; oy: string; dx: number; rot: number; delay: number; tint: number };
  type Crack = { pts: string; w: number };

  let shards = $state<Shard[]>([]);
  let cracks = $state<Crack[]>([]);
  let phase = $state<"crack" | "hold" | "cover" | "light" | "fall">(
    mode === "reveal" ? "cover" : "crack",
  );
  let reduce = false;

  function polar(a: number, r: number): [number, number] {
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  }

  function build() {
    const rng = makeRng(seed);
    const rnd = (a: number, b: number) => a + rng() * (b - a);
    const spokes = 15;
    const ang: number[] = [];
    for (let i = 0; i < spokes; i++) {
      ang.push((i / spokes) * Math.PI * 2 + rnd(-0.24, 0.24));
    }
    const rings = [0, 5, 13, 26, 46, 80, 185];
    // Jittered vertex grid (radius AND angle jitter per vertex) shared by shards
    // and cracks — irregular, angular pieces rather than clean concentric rings.
    const grid: [number, number][][] = [];
    for (let j = 0; j < rings.length; j++) {
      const row: [number, number][] = [];
      for (let i = 0; i < spokes; i++) {
        if (rings[j] === 0) row.push([CX, CY]);
        else row.push(polar(ang[i] + rnd(-0.08, 0.08), rings[j] * rnd(0.62, 1.4)));
      }
      grid.push(row);
    }
    const reach = ang.map(() => (rng() < 0.28 ? rings.length - 2 : rings.length - 1));

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
          rot: rnd(-80, 80),
          delay: Math.round((rings[j] / 185) * 130 + rnd(0, 150)),
          tint: rnd(0.1, 0.32),
        });
      }
    }
    shards = sh;

    const cr: Crack[] = [];
    for (let i = 0; i < spokes; i++) {
      const pl: string[] = [`${CX},${CY}`];
      for (let j = 1; j <= reach[i]; j++) pl.push(`${grid[j][i][0]},${grid[j][i][1]}`);
      cr.push({ pts: pl.join(" "), w: rnd(0.7, 1.5) });
    }
    for (let j = 1; j < rings.length - 1; j++) {
      const pl: string[] = [];
      for (let i = 0; i <= spokes; i++) {
        const g = grid[j][i % spokes];
        pl.push(`${g[0]},${g[1]}`);
      }
      cr.push({ pts: pl.join(" "), w: rnd(0.5, 1.0) });
    }
    // Extra irregularity: dead-end branch cracks + chords across a shard.
    for (let k = 0; k < 9; k++) {
      const i = Math.floor(rng() * spokes);
      const j = 1 + Math.floor(rng() * (rings.length - 3));
      const [bx, by] = grid[j][i];
      const [ex, ey] = polar(ang[i] + rnd(-0.55, 0.55), rings[j] * rnd(1.12, 1.7));
      cr.push({ pts: `${bx},${by} ${ex},${ey}`, w: rnd(0.4, 0.85) });
    }
    for (let k = 0; k < 5; k++) {
      const j = 1 + Math.floor(rng() * (rings.length - 2));
      const i = Math.floor(rng() * spokes);
      const a = grid[j][i];
      const b = grid[Math.min(j + 1, rings.length - 1)][(i + 2) % spokes];
      cr.push({ pts: `${a[0]},${a[1]} ${b[0]},${b[1]}`, w: rnd(0.4, 0.7) });
    }
    cracks = cr;
  }

  onMount(() => {
    reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    build();
    const t: number[] = [];
    if (reduce) {
      t.push(setTimeout(() => ondone?.(), mode === "obscure" ? 380 : 380));
    } else if (mode === "obscure") {
      t.push(setTimeout(() => (phase = "hold"), 360));
      t.push(setTimeout(() => (phase = "cover"), 820));
      t.push(setTimeout(() => ondone?.(), 980)); // fully hidden → navigate
    } else {
      // reveal: already fractured + covering → light → fall → done
      t.push(setTimeout(() => (phase = "light"), 160));
      t.push(setTimeout(() => (phase = "fall"), 400));
      t.push(setTimeout(() => ondone?.(), 940));
    }
    return () => t.forEach(clearTimeout);
  });
</script>

<div class="glass glass-{phase} mode-{mode}" class:reduce aria-hidden="true">
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

  /* Frost — blur + slight darken while the glass forms, so you still read the
     homepage behind the cracks. */
  .glass-frost {
    position: absolute;
    inset: 0;
    background: rgba(8, 10, 16, 0.32);
    backdrop-filter: blur(7px) brightness(0.62) saturate(0.85);
    -webkit-backdrop-filter: blur(7px) brightness(0.62) saturate(0.85);
    opacity: 0;
  }
  .mode-obscure .glass-frost {
    animation: frostIn 0.34s ease forwards;
  }
  /* Cover step + the whole reveal phase start NEAR-OPAQUE (not relying on the
     backdrop filter), so the page swap underneath is invisible. */
  .glass-cover .glass-frost,
  .mode-reveal .glass-frost {
    opacity: 1;
    background: rgba(4, 6, 10, 0.93);
    backdrop-filter: blur(11px) brightness(0.4) saturate(0.8);
    -webkit-backdrop-filter: blur(11px) brightness(0.4) saturate(0.8);
    transition: background 0.16s ease;
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

  .glass-reveal {
    position: absolute;
    inset: 0;
  }
  /* Spider the fracture in from the impact point (obscure only). */
  .mode-obscure .glass-reveal {
    clip-path: circle(0% at 50% 45%);
    animation: crackReveal 0.34s ease-out forwards;
  }
  @keyframes crackReveal {
    to {
      clip-path: circle(170% at 50% 45%);
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
    stroke: rgba(228, 240, 255, 0.9);
    vector-effect: non-scaling-stroke;
    stroke-linejoin: round;
    /* dark halo so the bright crack reads over light OR dark areas */
    filter: drop-shadow(0 0 1.2px rgba(6, 12, 26, 0.95));
  }
  .glass-light .glass-cracks polyline,
  .glass-fall .glass-cracks polyline {
    stroke: rgba(200, 240, 255, 1);
    filter: drop-shadow(0 0 3px rgba(150, 220, 255, 0.95))
      drop-shadow(0 0 1px rgba(6, 12, 26, 0.9));
    transition: stroke 0.18s ease, filter 0.18s ease;
  }
  .glass-fall .glass-cracks {
    animation: cracksOut 0.42s ease forwards;
  }
  @keyframes cracksOut {
    to {
      opacity: 0;
    }
  }

  /* Reduced motion: just a brief opaque darken across the swap. */
  .glass.reduce .glass-frost {
    opacity: 1;
    background: rgba(4, 6, 10, 0.9);
  }
</style>
