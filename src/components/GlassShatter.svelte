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
  type Pt = [number, number];

  let shards = $state<Shard[]>([]);
  let cracks = $state<Crack[]>([]);
  let phase = $state<"crack" | "hold" | "cover" | "light" | "fall">(
    mode === "reveal" ? "cover" : "crack",
  );
  let reduce = false;

  // Delaunay triangulation (Bowyer–Watson) → irregular angular shards across the
  // WHOLE screen (not a radial web). Shards = triangles, cracks = their edges.
  function triangulate(points: Pt[]): number[][] {
    const p = points.slice();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const dmax = Math.max(maxX - minX, maxY - minY) * 20;
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    const s0 = p.length;
    p.push([mx - dmax, my - dmax], [mx, my + dmax], [mx + dmax, my - dmax]);
    let tris: number[][] = [[s0, s0 + 1, s0 + 2]];
    const inCircum = (t: number[], px: number, py: number) => {
      const [ax, ay] = p[t[0]], [bx, by] = p[t[1]], [cx, cy] = p[t[2]];
      const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(d) < 1e-9) return false;
      const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
      const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
      const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
      return (px - ux) ** 2 + (py - uy) ** 2 < (ax - ux) ** 2 + (ay - uy) ** 2;
    };
    for (let i = 0; i < s0; i++) {
      const bad = tris.filter((t) => inCircum(t, p[i][0], p[i][1]));
      const edges: number[][] = [];
      for (const t of bad) {
        for (const e of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
          let shared = false;
          for (const t2 of bad) {
            if (t2 === t) continue;
            for (const e2 of [[t2[0], t2[1]], [t2[1], t2[2]], [t2[2], t2[0]]]) {
              if ((e[0] === e2[0] && e[1] === e2[1]) || (e[0] === e2[1] && e[1] === e2[0])) {
                shared = true;
                break;
              }
            }
            if (shared) break;
          }
          if (!shared) edges.push(e);
        }
      }
      tris = tris.filter((t) => !bad.includes(t));
      for (const e of edges) tris.push([e[0], e[1], i]);
    }
    return tris.filter((t) => t[0] < s0 && t[1] < s0 && t[2] < s0);
  }

  function build() {
    const rng = makeRng(seed);
    const rnd = (a: number, b: number) => a + rng() * (b - a);
    // Scatter: a jittered grid (guarantees full coverage incl. overscan past the
    // corners) + a few random extras + a slightly denser cluster, so the shatter
    // is irregular all over rather than centred.
    const pts: Pt[] = [];
    const cols = 7, rows = 5;
    for (let gx = 0; gx <= cols; gx++) {
      for (let gy = 0; gy <= rows; gy++) {
        pts.push([(gx / cols) * 128 - 14 + rnd(-9, 9), (gy / rows) * 128 - 14 + rnd(-9, 9)]);
      }
    }
    for (let k = 0; k < 14; k++) pts.push([rnd(2, 98), rnd(2, 98)]);
    const clx = rnd(25, 75), cly = rnd(25, 70);
    for (let k = 0; k < 8; k++) pts.push([clx + rnd(-16, 16), cly + rnd(-16, 16)]);

    const tris = triangulate(pts);

    const sh: Shard[] = [];
    for (const t of tris) {
      const tp = [pts[t[0]], pts[t[1]], pts[t[2]]];
      const cx = (tp[0][0] + tp[1][0] + tp[2][0]) / 3;
      const cy = (tp[0][1] + tp[1][1] + tp[2][1]) / 3;
      sh.push({
        pts: tp.map((q) => `${q[0]}% ${q[1]}%`).join(", "),
        ox: `${cx}%`,
        oy: `${cy}%`,
        dx: rnd(-10, 10),
        rot: rnd(-85, 85),
        // top pieces let go first (gravity), plus jitter — a cascade, not a ring.
        delay: Math.round(Math.max(0, cy) * 1.4 + rnd(0, 120)),
        tint: rnd(0.1, 0.34),
      });
    }
    shards = sh;

    // Cracks = unique triangle edges.
    const cr: Crack[] = [];
    const seen = new Set<string>();
    for (const t of tris) {
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cr.push({ pts: `${pts[a][0]},${pts[a][1]} ${pts[b][0]},${pts[b][1]}`, w: rnd(0.5, 1.2) });
      }
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
