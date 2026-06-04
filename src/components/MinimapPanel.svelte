<script lang="ts">
  // Left-letterbox minimap panel.
  //
  // Consumes the protocol Arc landed in
  //   Desktop/GameDev/CON_CLAUDE_MINIMAP_LEFT_LETTERBOX.md  (asset + manifest)
  //   Desktop/GameDev/CON_CLAUDE_MINIMAP_RESIZE_DONE.md     (596x266 regen)
  //   Desktop/GameDev/APP_CLAUDE_MINIMAP_LEFT_LETTERBOX_REPLY.md  (fog-of-war additions)
  //
  // Protocol summary (game → web):
  //
  //   allbyte:ready
  //     theme block: minimap.{ enabled, image_url, manifest_url, panel_bg,
  //                            panel_border, highlight_color,
  //                            highlight_border_w, discovered_scenes }
  //   allbyte:current-scene        { scene }
  //   allbyte:current-scene-clear
  //   allbyte:scene-discovered     { scene }
  //
  // The game owns visual identity (image, colors, font). This panel is a
  // dumb renderer — no website theme bleeds into it. The chrome matches
  // the combat-log right-letterbox panel (olive + black border) per the
  // existing convention.
  //
  // Rendering:
  //   - SVG with viewBox = canvas dimensions, preserveAspectRatio so the
  //     map scales to fit whatever letterbox width is available
  //   - <clipPath> containing only the discovered scenes' rects → applied
  //     to the master <image> → fog-of-war just works
  //   - <rect> outline on the current scene's rect → the gold highlight
  //
  // Visibility:
  //   - Desktop only via @media (pointer: fine) and (min-width: 1101px)
  //   - Hidden until at least one scene is discovered OR a current-scene
  //     event fires (covers the "Title → first dungeon scene" mount case
  //     where ready arrived with enabled:false)

  import { onMount, onDestroy } from "svelte";

  interface SceneRect {
    rect: [number, number, number, number]; // x, y, w, h
    grid: [number, number];
    backdrop: string;
  }
  interface Manifest {
    version: number;
    canvas: { width: number; height: number };
    scenes: Record<string, SceneRect>;
  }
  interface MinimapTheme {
    enabled: boolean;
    image_url: string;
    manifest_url: string;
    panel_bg: string;
    panel_border: string;
    highlight_color: string;
    highlight_border_w: number;
    discovered_scenes?: string[];
  }

  // Reactive state
  let theme = $state<MinimapTheme | null>(null);
  let manifest = $state<Manifest | null>(null);
  let manifestError = $state<string | null>(null);
  let currentScene = $state<string | null>(null);
  let discovered = $state<Set<string>>(new Set());
  let hasEverHadScene = $state(false);

  // The panel renders only after one of:
  //   - ready provided enabled:true AND discovered_scenes is non-empty
  //   - any current-scene or scene-discovered event has been observed
  //
  // This handles the "Title (enabled:false) → first dungeon" mount case
  // without needing a separate "show panel" event.
  let shouldRender = $derived(
    !!manifest &&
      (hasEverHadScene || discovered.size > 0)
  );

  // ---- Message dispatch ----

  function handleMessage(ev: MessageEvent) {
    const data = ev.data;
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;

    switch (data.type) {
      case "allbyte:ready":
        if (data.minimap) {
          theme = data.minimap as MinimapTheme;
          if (Array.isArray(data.minimap.discovered_scenes)) {
            discovered = new Set(data.minimap.discovered_scenes);
          }
          loadManifest(data.minimap.manifest_url);
        }
        break;
      case "allbyte:current-scene":
        if (typeof data.scene === "string") {
          currentScene = data.scene;
          hasEverHadScene = true;
          // Defensive: discover-on-enter even if game forgot to emit
          // scene-discovered. Idempotent because Set.
          if (!discovered.has(data.scene)) {
            discovered = new Set([...discovered, data.scene]);
          }
        }
        break;
      case "allbyte:current-scene-clear":
        currentScene = null;
        break;
      case "allbyte:scene-discovered":
        if (typeof data.scene === "string" && !discovered.has(data.scene)) {
          discovered = new Set([...discovered, data.scene]);
        }
        break;
    }
  }

  async function loadManifest(url: string) {
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) {
        manifestError = `HTTP ${res.status}`;
        return;
      }
      const data = (await res.json()) as Manifest;
      // Light shape check — bad manifest shouldn't crash the panel
      if (!data?.scenes || !data?.canvas) {
        manifestError = "manifest shape invalid";
        return;
      }
      manifest = data;
      manifestError = null;
    } catch (e) {
      manifestError = String(e);
    }
  }

  // ---- Dev-mode simulation hook ----
  //
  // Lets me develop the panel against the real asset before Arc's emits
  // start firing on staging. Open the page in /play/, then in the dev
  // console:
  //   window.__minimapSimulate.ready()
  //   window.__minimapSimulate.scene("Waterway3")
  //   window.__minimapSimulate.discover("Waterway4")
  //   window.__minimapSimulate.clear()
  // Once Arc's emits land, this can stay — production never calls into
  // window.__minimapSimulate, it just hangs unused on `window`.

  function installDevHooks() {
    if (typeof window === "undefined") return;
    (window as any).__minimapSimulate = {
      ready(opts?: Partial<MinimapTheme>) {
        const ev = new MessageEvent("message", {
          data: {
            type: "allbyte:ready",
            minimap: {
              enabled: true,
              image_url: "/godot/minimap/waterway_minimap.png",
              manifest_url: "/godot/minimap/waterway_minimap.json",
              panel_bg: "#aaaa84",
              panel_border: "#000000",
              highlight_color: "#fcd34d",
              highlight_border_w: 3,
              discovered_scenes: ["Waterway1", "Waterway2"],
              ...(opts ?? {}),
            },
          },
        });
        window.dispatchEvent(ev);
      },
      scene(name: string) {
        const ev = new MessageEvent("message", {
          data: { type: "allbyte:current-scene", scene: name },
        });
        window.dispatchEvent(ev);
      },
      discover(name: string) {
        const ev = new MessageEvent("message", {
          data: { type: "allbyte:scene-discovered", scene: name },
        });
        window.dispatchEvent(ev);
      },
      clear() {
        const ev = new MessageEvent("message", {
          data: { type: "allbyte:current-scene-clear" },
        });
        window.dispatchEvent(ev);
      },
    };
  }

  // ---- Lifecycle ----

  onMount(() => {
    window.addEventListener("message", handleMessage);
    installDevHooks();
  });

  onDestroy(() => {
    window.removeEventListener("message", handleMessage);
  });

  // ---- Per-render helpers ----

  // The discovered set might contain scenes not in the manifest (e.g.,
  // legacy save data from before a scene was renamed). Filter to manifest
  // members only so we don't crash when looking up rects.
  let discoveredRects = $derived.by(() => {
    if (!manifest) return [];
    const out: { name: string; r: [number, number, number, number] }[] = [];
    for (const name of discovered) {
      const entry = manifest.scenes[name];
      if (entry) out.push({ name, r: entry.rect });
    }
    return out;
  });

  let currentRect = $derived(
    manifest && currentScene ? manifest.scenes[currentScene]?.rect ?? null : null
  );

  // Stable clip-path id so SVG re-renders don't accidentally orphan it.
  // Using a fixed id is fine because there's only one MinimapPanel on the page.
  const CLIP_ID = "minimap-discovered-clip";
</script>

{#if shouldRender && manifest && theme}
  <div
    class="minimap-panel"
    style:--bg={theme.panel_bg}
    style:--border={theme.panel_border}
    style:--highlight={theme.highlight_color}
    style:--highlight-w="{theme.highlight_border_w}px"
  >
    <svg
      class="minimap-svg"
      viewBox="0 0 {manifest.canvas.width} {manifest.canvas.height}"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Dungeon minimap"
    >
      <defs>
        <clipPath id={CLIP_ID}>
          {#each discoveredRects as { name, r } (name)}
            <rect x={r[0]} y={r[1]} width={r[2]} height={r[3]} />
          {/each}
        </clipPath>
      </defs>

      <!-- Master image, clipped to the discovered rects -->
      <image
        href={theme.image_url}
        x="0"
        y="0"
        width={manifest.canvas.width}
        height={manifest.canvas.height}
        clip-path="url(#{CLIP_ID})"
      />

      <!-- Current-scene highlight -->
      {#if currentRect}
        <rect
          x={currentRect[0]}
          y={currentRect[1]}
          width={currentRect[2]}
          height={currentRect[3]}
          fill="none"
          stroke="var(--highlight)"
          stroke-width="var(--highlight-w)"
          stroke-linejoin="miter"
        />
      {/if}
    </svg>
  </div>
{/if}

<style>
  /* Mount in the left letterbox bar, desktop only.
     Same media-query convention as the virtual gamepad (touch-only) and
     the future combat-log right panel — except inverted: this is
     pointer:fine (mouse) at desktop widths. */
  .minimap-panel {
    position: fixed;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    /* Width clamps to whatever's available in the letterbox area without
       overlapping the iframe canvas. The native PNG is 596px wide but it
       scales down via SVG preserveAspectRatio. min(220px) covers the
       narrowest realistic desktop letterbox (~215px at 1920 width with
       a 1270x920 game canvas). max(380px) keeps it from getting comically
       large on ultrawide displays. */
    width: clamp(180px, 22vw, 380px);
    padding: 6px;
    box-sizing: border-box;
    background: var(--bg, #aaaa84);
    border: 2px solid var(--border, #000000);
    border-left: none;
    border-radius: 0 4px 4px 0;
    z-index: 50;
    /* No box-shadow / blur effects — keep it looking like a game-side
       element, not a webby HUD overlay. */
    display: none; /* gated by the media query below */
  }

  .minimap-svg {
    display: block;
    width: 100%;
    height: auto;
    image-rendering: pixelated; /* keep tile edges crisp */
  }

  /* Desktop with a precise pointer only. Mobile / touch devices already
     use the virtual gamepad in the letterbox bars and the in-game UI
     for navigation feedback; the minimap would crowd that. */
  @media (pointer: fine) and (min-width: 1101px) {
    .minimap-panel {
      display: block;
    }
  }
</style>
