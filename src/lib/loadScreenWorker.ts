/// <reference lib="webworker" />
// Load-screen renderer — runs on a Web Worker, drawing to an OffscreenCanvas.
// Because it lives on its own thread, the whole loading sequence keeps animating
// at 60fps even while the main thread is fully blocked by the game's WASM
// compile + Godot boot (which freezes any main-thread/DOM animation). The main
// thread just transfers the canvas + feeds state; everything visual is here.

type Card =
  | { kind: "text"; title: string; rows?: [string, string][]; lines?: string[]; quote?: string }
  | { kind: "sprite"; name: string; role: string; blurb: string; idleUrl?: string | null; attackUrl?: string | null };

type Frame = { bmp: ImageBitmap; dur: number };

interface InitMsg {
  type: "init";
  canvas: OffscreenCanvas;
  dpr: number;
  cssW: number;
  cssH: number;
  cards: Card[];
  isMobile?: boolean;
  cfg: { studioMs: number; studioSettleMs: number; studioFadeMs: number; cardMs: number; cardMinMs: number };
  /** Index of the card the DOM is already showing — see GodotEmbed. */
  startCard?: number;
}

const FONT = "AllByteCustom";
const DARK = "#050608";

let ctx: OffscreenCanvasRenderingContext2D;
let W = 0, H = 0, dpr = 1;
let cards: Card[] = [];
let cfg: InitMsg["cfg"];
let fontReady = false;
let started = 0;
let sceneReady = false;
let revealed = false;
let cardIdx = 0;
let cardShownAt = 0;
let studioBits = [1, 1, 1, 0, 1, 1, 0, 0];
let lastScramble = 0;
let scrambleInterval = 15; // starts a near-60fps blur (barely legible), grows fast
let bitsSettled = false;
// One-shot latches for the two studio-phase notifications to the page.
let studioFadeAnnounced = false;
let studioEndAnnounced = false;
let spinner: ImageBitmap | null = null; // in-game LoadingIcon.png (6× 32×32 strip)

/**
 * Pre-rendered studio glyphs, drawn on the MAIN thread where ModernGoth is a
 * real loaded face.
 *
 * Why they exist: OffscreenCanvas text inside a dedicated worker CANNOT use a
 * font added through `self.fonts`. `new FontFace(...)` resolves, `face.load()`
 * succeeds and `self.fonts.status` reports "loaded" — and `measureText` is
 * still byte-identical to the Georgia fallback (verified 2026-09-02: 319.14px
 * both before and after adding the face, vs 254.56px for the same string in
 * ModernGoth on the main thread). So `fontReady` was reporting success for
 * something that never took effect, and the whole studio scene has been
 * rendering in Georgia — which is what made the animated wordmark look like a
 * different typeface from the static shell that precedes it.
 *
 * Each tile carries the metrics needed to place it exactly where fillText would
 * have, so drawStudio()'s geometry is unchanged.
 */
interface Glyph {
  bmp: ImageBitmap;
  /** Advance width of the text in CSS px — what measureText would have returned. */
  w: number;
  /** Left padding inside the tile, CSS px. */
  pad: number;
  /** Alphabetic baseline offset from the tile top, CSS px. */
  base: number;
  /** Tile size in CSS px. */
  tw: number;
  th: number;
}
let gWord: Glyph | null = null;
let gBit: (Glyph | null)[] = [null, null]; // index by bit value 0/1

/** Draw a pre-rendered glyph as fillText(text, x, y) would with
 *  textAlign "center" + textBaseline "alphabetic". */
function drawGlyph(g: Glyph, x: number, y: number) {
  ctx.drawImage(g.bmp, x - g.w / 2 - g.pad, y - g.base, g.tw, g.th);
}
// Faithful to the in-game LoadingIcon (Arc, LoadingIcon.gd): TWO nested rings,
// the sprite strip IS the tumble; both rings rotate CW; the inner ring is a
// child so it spins ~2× the outer and sits at a 45° offset, and is slightly
// larger (outer scale 0.75, inner effective ~0.81). Frames play synced.
// The game blits at an oscillating ~5.6–11.25fps (avg ~7–8) and steps its
// rotation every 0.25s; the owner wants it SMOOTHER, so we blit a steady ~8.5fps
// (above the game's floor — 5.6 read as choppy) and rotate continuously.
const SPIN_FPS = 8.5;
const SPIN_W = 0.42; // rad/s, outer ring CW (~24°/s, mid of the game's 8–32°/s pulse)
const INNER_SCALE = 1.083; // inner effective 0.8125 / outer 0.75 — barely larger
const INNER_OFFSET = 0.785398; // 45° initial rotation on the inner ring
let spriteSeq: Frame[] = []; // living-sprite card frames (idle bob → attack → loop)
let spriteSeqTotal = 1;

// ---- poison-trail card transition (owner-designed; see project_poison_loader) ----
// A VSlime zig-zags an iso poison grid to Elias, who strikes; the slime runs the
// real Dissolve shader; on load-complete Elias plays victory, then we cut over.
// Runs in the bottom band of the load screen (replaces the spinner+dots).
type PCell = { cx: number; cy: number; fill: number };
let poisonTile: ImageBitmap | null = null;
let emptyTile: ImageBitmap | null = null;
let slimeFrames: Frame[] = [], slimeTotal = 1;
let eIdle: Frame[] = [], eAttack: Frame[] = [], eVictory: Frame[] = [];
let eIdleTotal = 1, eAttackTotal = 1, eVictoryTotal = 1;
const PZ = { N: 6, RUN: 2500, WIDTH: 0.55, SCALE: 0.75, ATTACK: 680, DEATH: 1300, VICTORY: 1050, PAUSE: 360 };
// Elias feet anchors (Arc-measured); idle/attack mirror to face down-left, victory front-facing.
const EANCH = {
  idle: { fx: 0.497, fy: 0.909, mirror: true, base: 132 },
  attack: { fx: 0.451, fy: 0.733, mirror: true, base: 225 },
  victory: { fx: 0.5, fy: 0.905, mirror: false, base: 132 },
};
let isMobile = false;
let scenePhase: "run" | "attack" | "victory" | "pause" = "run";
let sceneT0 = 0, sceneStarted = false;
let eliasMode: "idle" | "attack" | "victory" = "idle";
let cardsDone = 0;
let pcells: PCell[] = [], pwalk: PCell[] = [], pbetween: PCell[] = [];
let phw = 0, phh = 0, pElias = { fx: 0, fy: 0 }, pGridTop = 0;
let deathBase: Uint8ClampedArray | null = null, deathW = 0, deathH = 0;
let scratch: OffscreenCanvas | null = null, sctx: OffscreenCanvasRenderingContext2D | null = null;
const hasPoison = () => !!(poisonTile && emptyTile && slimeFrames.length && eIdle.length);

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function pickCard(prev: number): number {
  if (cards.length <= 1) return 0;
  return (prev + 1 + Math.floor(Math.random() * (cards.length - 1))) % cards.length;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "init") {
    const msg = m as InitMsg;
    dpr = msg.dpr; W = msg.cssW; H = msg.cssH;
    cards = msg.cards; cfg = msg.cfg; isMobile = !!msg.isMobile;
    const cv = msg.canvas;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx = cv.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.scale(dpr, dpr);
    // Open on the card the page is ALREADY showing in DOM, so this takeover
    // is a continuation rather than a visible content swap.
    cardIdx = typeof msg.startCard === "number" && msg.startCard >= 0 && msg.startCard < cards.length
      ? msg.startCard
      : Math.floor(Math.random() * cards.length);
    // Assets (font, spinner, sprite gifs) can't be fetched by URL from inside a
    // blob worker under cross-origin isolation — no-CORP same-origin subresource
    // loads NetworkError there. The main thread fetches them and hands the bytes
    // over via the messages below; until they arrive we render with the Georgia
    // fallback + procedural spinner, then upgrade in place.
    started = performance.now();
    lastScramble = started;
    loop();
  } else if (m.type === "font") {
    try {
      // @ts-ignore — FontFace + self.fonts exist in worker scope
      const face = new FontFace(FONT, m.buf);
      await face.load();
      // @ts-ignore
      self.fonts.add(face);
      fontReady = true;
    } catch { fontReady = false; }
  } else if (m.type === "studioGlyphs") {
    // Main-thread-rendered ModernGoth tiles — see the Glyph docs above for why
    // the worker cannot render this text itself.
    gWord = (m.word as Glyph) || null;
    gBit = [(m.bit0 as Glyph) || null, (m.bit1 as Glyph) || null];
  } else if (m.type === "spinner") {
    spinner = (m.bmp as ImageBitmap) || null;
  } else if (m.type === "sprite") {
    loadSprite(m.idle as ArrayBuffer | null, m.attack as ArrayBuffer | null);
  } else if (m.type === "poisonTiles") {
    poisonTile = (m.poison as ImageBitmap) || null;
    emptyTile = (m.empty as ImageBitmap) || null;
  } else if (m.type === "poisonSlime") {
    slimeFrames = await decodeGif(m.buf as ArrayBuffer);
    slimeTotal = slimeFrames.reduce((s, f) => s + f.dur, 0) || 1;
  } else if (m.type === "poisonElias") {
    if (m.idle) { eIdle = await decodeGif(m.idle as ArrayBuffer); eIdleTotal = eIdle.reduce((s, f) => s + f.dur, 0) || 1; }
    if (m.attack) { eAttack = await decodeGif(m.attack as ArrayBuffer); eAttackTotal = eAttack.reduce((s, f) => s + f.dur, 0) || 1; }
    if (m.victory) { eVictory = await decodeGif(m.victory as ArrayBuffer); eVictoryTotal = eVictory.reduce((s, f) => s + f.dur, 0) || 1; }
  } else if (m.type === "resize") {
    // Viewport rotated/resized mid-load. Re-size the OffscreenCanvas backing
    // store and re-apply the DPR scale so the frame fills the new box (fixes the
    // "half screen" on a portrait→landscape flip), and update W/H/isMobile so
    // the banner layout + poison grid re-lay-out. ensurePoisonGeo's geoW/geoH
    // guard recomputes automatically once W/H change; drawManual reads W/H live.
    if (!ctx) return;
    W = m.cssW; H = m.cssH;
    if (typeof m.dpr === "number" && m.dpr > 0) dpr = m.dpr;
    if (typeof m.isMobile === "boolean") isMobile = !!m.isMobile;
    const cv = ctx.canvas as OffscreenCanvas;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // width/height reset the transform
  } else if (m.type === "scene") {
    sceneReady = true;
  }
};

function loop() {
  if (revealed) return;
  const now = performance.now();
  const t = now - started;
  if (t < cfg.studioMs) drawStudio(now, t);
  else {
    if (!studioEndAnnounced) {
      studioEndAnnounced = true;
      (self as any).postMessage({ type: "studioEnd" }); // page unmounts the wordmark overlay
    }
    if (cardShownAt === 0) { cardShownAt = now; }
    drawManual(now, t);
    if (hasPoison()) {
      // poison-trail transition drives card flips + reveal (AllByte + ≥1 full
      // card, cut over only at a card boundary after Elias' victory).
      if (poisonScene(now)) {
        revealed = true;
        (self as any).postMessage({ type: "reveal" });
        return;
      }
    } else {
      // fallback (assets not yet arrived / unsupported): timer rotation + reveal
      if (now - cardShownAt >= cfg.cardMs) { cardIdx = pickCard(cardIdx); cardShownAt = now; }
      if (sceneReady && now - cardShownAt >= Math.min(cfg.cardMinMs, cfg.cardMs)) {
        revealed = true;
        (self as any).postMessage({ type: "reveal" });
        return;
      }
    }
  }
  // The corner spinner is NOT drawn here any more — it is a DOM element with a
  // CSS transform animation (see .load-spin in GodotEmbed.svelte). Paced by
  // this setTimeout loop it visibly paused; on the compositor it cannot.
  setTimeout(loop, 16);
}

// Bottom-right corner spinner — small, fixed to the screen edge (not part of the
// scene composition), present the entire load.
function drawCornerSpinner(now: number) {
  // 25% smaller than the first pass (owner) — a discreet corner cue, not a focal point.
  const r = clamp(Math.min(W, H) * 0.021, 9, 15);
  const margin = clamp(Math.min(W, H) * 0.045, 16, 30);
  drawSpinner(now, W - margin - r, H - margin - r, r);
}

// ---------- studio ----------
function drawStudio(now: number, t: number) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = DARK;
  ctx.fillRect(0, 0, W, H);

  // bit scramble: fast → exponential slow → settle
  if (!bitsSettled) {
    if (now - lastScramble >= scrambleInterval) {
      lastScramble = now;
      studioBits = studioBits.map(() => (Math.random() < 0.5 ? 0 : 1));
      scrambleInterval *= 1.55; // steep decel — flips thin out fast, then stop
    }
    if (t >= cfg.studioSettleMs) bitsSettled = true;
  }

  const fading = t > cfg.studioMs - cfg.studioFadeMs;
  const fade = fading
    ? clamp(1 - (t - (cfg.studioMs - cfg.studioFadeMs)) / cfg.studioFadeMs, 0, 1)
    : 1;
  ctx.globalAlpha = fade;
  // Tell the page when to fade the overlaid wordmark, so it leaves with the
  // bits rather than on a page-side timer that could drift from this clock.
  if (fading && !studioFadeAnnounced) {
    studioFadeAnnounced = true;
    (self as any).postMessage({ type: "studioFade" });
  }

  // Nothing is drawn here but the ground.
  //
  // The whole studio scene — wordmark AND bits — is DOM, mounted from before
  // hydration and layered above this canvas. Two reasons it moved:
  //   1. Nothing visible should wait on the worker. The bits used to appear
  //      only once the blob worker had been created, handed the canvas and
  //      rendered a frame, which on a cold load was seconds after the wordmark.
  //   2. One source means no swap, so no blip and no chance of two copies
  //      disagreeing about position or typeface.
  // This canvas still paints DARK so the ground is continuous when the DOM
  // layer fades out and the card scene takes over.
  ctx.globalAlpha = 1;
  // (spinner now drawn once per frame in loop(), pinned bottom-right)
}

// ---------- manual ----------
function drawManual(now: number, t: number) {
  // parchment-dark radial
  const g = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, Math.max(W, H) * 1.1);
  g.addColorStop(0, "#201812"); g.addColorStop(0.55, "#17110c"); g.addColorStop(1, "#0e0a07");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  const card = cards[cardIdx];
  const cx = W / 2;
  const pad = Math.min(W * 0.09, 64);

  // fade the card in as it changes
  const shown = now - cardShownAt;
  ctx.globalAlpha = clamp(shown / 240, 0, 1);

  // kicker
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.font = `${clamp(H * 0.028, 10, 13)}px ui-monospace, "Courier New", monospace`;
  ctx.fillStyle = "#c69a4c";
  const kicker = card.kind === "sprite" ? "FROM THE WORLD OF NESIS" : "FROM THE MANUAL";
  // Raise the text when the poison scene occupies the bottom, and cap it above
  // the grid so long cards can't overlap the load image.
  if (hasPoison()) ensurePoisonGeo();
  const textLimit = hasPoison() ? pGridTop : H * 0.92;
  const kickerY = card.kind === "sprite" ? H * 0.11 : (hasPoison() ? H * 0.135 : H * 0.2);
  ctx.fillText(spaced(kicker), cx, kickerY);
  let y = kickerY + H * 0.055;

  if (card.kind === "text") {
    ctx.font = `700 ${clamp(H * 0.072, 22, 44)}px ${FONT}, Georgia, serif`;
    ctx.fillStyle = "#f6eccf";
    y = wrapCenter(card.title, cx, y, W - pad * 2, clamp(H * 0.08, 24, 48)) + H * 0.025;
    if (card.rows) {
      const rowH = Math.max(16, Math.min(clamp(H * 0.062, 26, 40), (textLimit - y) / card.rows.length));
      const rowFont = Math.min(clamp(H * 0.036, 14, 19), rowH * 0.5);
      const colX = cx - (W - pad * 2) / 2;
      const dtW = (W - pad * 2) * 0.34;
      ctx.textAlign = "left";
      for (const [dt, dd] of card.rows) {
        ctx.font = `700 ${rowFont}px ${FONT}, Georgia, serif`;
        ctx.fillStyle = "#e7b866"; ctx.fillText(dt, colX, y);
        ctx.font = `${rowFont * 0.95}px ${FONT}, Georgia, serif`;
        ctx.fillStyle = "#cdbf9e"; ctx.fillText(dd, colX + dtW + 12, y);
        y += rowH;
      }
      ctx.textAlign = "center";
    } else if (card.lines) {
      const lineH = Math.max(15, Math.min(clamp(H * 0.05, 18, 26), (textLimit - y) / (card.lines.length * 1.7)));
      ctx.font = `${Math.min(clamp(H * 0.04, 15, 21), lineH * 0.82)}px ${FONT}, Georgia, serif`;
      ctx.fillStyle = "#d9cba9";
      for (const line of card.lines) {
        y = wrapCenter(line, cx, y, W - pad * 2, lineH) + lineH * 0.35;
      }
    }
  } else {
    // living-sprite card — the animated character (turns, attacks) + lore
    const frame = currentSpriteFrame(shown);
    if (frame) {
      const dh = clamp(H * 0.34, 90, 220);
      const dw = frame.width * (dh / frame.height);
      ctx.imageSmoothingEnabled = false; // pixel art
      ctx.drawImage(frame, cx - dw / 2, y, dw, dh);
      y += dh + H * 0.055;
    } else {
      y = H * 0.5;
    }
    ctx.font = `700 ${clamp(H * 0.075, 26, 46)}px ${FONT}, Georgia, serif`;
    ctx.fillStyle = "#f6eccf";
    ctx.fillText(card.name, cx, y); y += H * 0.05;
    ctx.font = `${clamp(H * 0.028, 11, 15)}px ui-monospace, monospace`;
    ctx.fillStyle = "#c69a4c";
    ctx.fillText(spaced(card.role.toUpperCase()), cx, y); y += H * 0.048;
    if (card.blurb) {
      ctx.font = `${clamp(H * 0.036, 14, 19)}px ${FONT}, Georgia, serif`;
      ctx.fillStyle = "#d9cba9";
      wrapCenter(card.blurb, cx, y, W * 0.72, clamp(H * 0.046, 17, 24));
    }
  }
  ctx.globalAlpha = 1;

  // Bottom progress dots (fallback path only — the poison-trail scene replaces
  // them once its assets arrive). The spinner is no longer drawn here; it's the
  // persistent bottom-right corner indicator from loop().
  if (!hasPoison()) {
    const lit = clamp(Math.floor((now - cardShownAt) / 1000) + 1, 1, 3);
    const dr = clamp(H * 0.012, 4, 6), dgap = dr * 3.2;
    const dy = H - H * 0.075;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(cx + (i - 1) * dgap, dy, dr, 0, 7);
      ctx.fillStyle = "#e7b866";
      ctx.globalAlpha = i < lit ? 1 : 0.25;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function spaced(s: string): string { return s.split("").join(" "); }

// Decode an animated GIF to frames (ImageDecoder / WebCodecs, on the worker
// thread). Falls back to a single static frame if ImageDecoder is unavailable
// (e.g. Safari) or decoding fails.
async function decodeGif(buf: ArrayBuffer): Promise<Frame[]> {
  try {
    const ID = (self as any).ImageDecoder;
    if (ID) {
      const dec = new ID({ data: buf, type: "image/gif" });
      await dec.tracks.ready;
      const count = dec.tracks.selectedTrack?.frameCount ?? 1;
      const out: Frame[] = [];
      for (let i = 0; i < count; i++) {
        const res = await dec.decode({ frameIndex: i });
        const dur = (res.image.duration ?? 100000) / 1000;
        out.push({ bmp: await createImageBitmap(res.image), dur });
        res.image.close?.();
      }
      if (out.length) return out;
    }
  } catch {
    /* fall through */
  }
  try {
    return [{ bmp: await createImageBitmap(new Blob([buf], { type: "image/gif" })), dur: 1000 }];
  } catch {
    return [];
  }
}

async function loadSprite(idleBuf: ArrayBuffer | null, attackBuf: ArrayBuffer | null) {
  const idle = idleBuf ? await decodeGif(idleBuf) : [];
  const attack = attackBuf ? await decodeGif(attackBuf) : [];
  // idle a couple of cycles → one attack → back to idle, looped
  const seq: Frame[] = [...idle, ...idle, ...attack, ...idle];
  if (!seq.length) return;
  spriteSeq = seq;
  spriteSeqTotal = seq.reduce((s, f) => s + f.dur, 0) || 1;
}

function currentSpriteFrame(elapsed: number): ImageBitmap | null {
  if (!spriteSeq.length) return null;
  let t = elapsed % spriteSeqTotal;
  for (const f of spriteSeq) {
    if (t < f.dur) return f.bmp;
    t -= f.dur;
  }
  return spriteSeq[spriteSeq.length - 1].bmp;
}

// The in-game loader (Arc's LoadingIcon.gd): the 6-frame strip tumbles the ring;
// two nested copies both turn CW, the inner one at ~2× the outer's rate with a
// 45° offset and a hair larger — the depth cue. Time-driven → spins on the worker
// thread regardless of the main-thread block. Falls back to two rings if the PNG
// hasn't arrived yet.
function drawSpinner(now: number, cx: number, cy: number, r: number) {
  const tsec = now / 1000;
  const outer = r * 2.1;
  const inner = outer * INNER_SCALE;
  if (spinner) {
    const frame = Math.floor(tsec * SPIN_FPS) % 6;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(cx, cy);
    // outer ring
    ctx.save();
    ctx.rotate(tsec * SPIN_W);
    ctx.drawImage(spinner, frame * 32, 0, 32, 32, -outer / 2, -outer / 2, outer, outer);
    ctx.restore();
    // inner ring — 2× spin (child inherits outer + own), +45°, slightly larger
    ctx.save();
    ctx.rotate(INNER_OFFSET + tsec * SPIN_W * 2);
    ctx.drawImage(spinner, frame * 32, 0, 32, 32, -inner / 2, -inner / 2, inner, inner);
    ctx.restore();
    ctx.restore();
    return;
  }
  // fallback: two rings, both CW, inner faster + offset
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, r * 0.13);
  ctx.strokeStyle = "#e7b866";
  ctx.beginPath();
  ctx.arc(cx, cy, r, tsec * SPIN_W, tsec * SPIN_W + Math.PI * 1.5);
  ctx.stroke();
  ctx.strokeStyle = "rgba(231,184,102,0.7)";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.92, INNER_OFFSET + tsec * SPIN_W * 2, INNER_OFFSET + tsec * SPIN_W * 2 + Math.PI * 1.5);
  ctx.stroke();
  ctx.restore();
}

// ================= poison-trail card transition =================
let geoW = -1, geoH = -1;
function ensurePoisonGeo() {
  if (geoW === W && geoH === H && pcells.length) return;
  geoW = W; geoH = H;
  const landscape = W > H;
  const margin = 20;
  // Reserve space at the bottom for the mobile touch pads (grid sits ABOVE them on
  // portrait, between them on landscape); small margin on desktop.
  const inset = isMobile ? (landscape ? H * 0.05 : H * 0.24) : H * 0.055;
  // The load bar TARGETS a ~150px-tall scene (scene ≈ 1.68·TW), and only shrinks to
  // fit the viewport WIDTH or the vertical band left above the reserved card-text
  // area + the touch pads — so it fills the space rather than sitting tiny.
  const targetTW = 150 / 1.68;
  const widthTW = (W - 2 * margin) / (PZ.N + 1.6) * 0.98;
  const heightTW = Math.max(24, ((H - inset) - H * 0.34) / 1.68);
  let TW = Math.max(20, Math.min(targetTW, widthTW, heightTW));
  phw = TW / 2; phh = phw * (74 / 120);
  const eliasW = phh * 3.79;
  const gridW = PZ.N * TW, overhangR = phw + eliasW * 0.42;
  const startX = (W - (gridW + overhangR)) / 2;
  const baseY = H - phh - inset;
  pcells = []; pbetween = [];
  for (let i = 0; i < PZ.N; i++) pcells.push({ cx: startX + phw + i * TW, cy: baseY, fill: 0 });
  for (let i = 0; i < PZ.N; i++) pbetween.push({ cx: pcells[i].cx + phw, cy: baseY - phh, fill: 0 });
  pwalk = [];
  for (let i = 0; i < PZ.N; i++) { pwalk.push(pcells[i]); if (i < PZ.N - 1) pwalk.push(pbetween[i]); }
  pElias = { fx: pbetween[PZ.N - 1].cx, fy: pbetween[PZ.N - 1].cy };
  // the y above which the card text must stay: Elias' head (tallest element) with margin
  const eliasHeadY = (baseY - phh + 4) - EANCH.idle.fy * eliasW;
  pGridTop = Math.min(baseY - 2 * phh, eliasHeadY) - H * 0.02;
}
function frameAt(frames: Frame[], total: number, elapsed: number, loop = true): ImageBitmap | null {
  if (!frames.length) return null;
  let t = loop ? ((elapsed % total) + total) % total : Math.min(Math.max(elapsed, 0), total - 0.001);
  for (const f of frames) { if (t < f.dur) return f.bmp; t -= f.dur; }
  return frames[frames.length - 1].bmp;
}
function ensureScratch(w: number, h: number) {
  if (!scratch || scratch.width < w || scratch.height < h) {
    scratch = new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
    sctx = scratch.getContext("2d");
  }
}
function setPoisonFills(prog: number) {
  const seg = prog * (pwalk.length - 1), lead = Math.floor(seg);
  for (const c of pcells) c.fill = 0; for (const c of pbetween) c.fill = 0;
  for (let k = 0; k < pwalk.length; k++) pwalk[k].fill = k < lead ? 1 : (k === lead ? seg - lead : 0);
}
function drawPoisonCell(c: PCell, emptyAlpha: number) {
  const dw = 2 * phw, dh = 2 * phh;
  ctx.globalAlpha = emptyAlpha;
  ctx.drawImage(emptyTile as ImageBitmap, c.cx - phw, c.cy - phh, dw, dh);
  ctx.globalAlpha = 1;
  if (c.fill > 0) {
    ctx.save();
    ctx.beginPath(); ctx.rect(c.cx - phw, c.cy - phh, Math.ceil(dw * c.fill), dh); ctx.clip();
    ctx.drawImage(poisonTile as ImageBitmap, c.cx - phw, c.cy - phh, dw, dh);
    ctx.restore();
  }
}
function drawPoisonGrid() {
  ctx.imageSmoothingEnabled = false;
  for (const c of pbetween) drawPoisonCell(c, 0.5);
  for (const c of pcells) drawPoisonCell(c, 0.62);
}
function slimePx() { return phh * 2.73; }
function drawTintedSlime(frame: ImageBitmap, dx: number, dy: number, size: number) {
  ensureScratch(size, size);
  const s = sctx!; s.clearRect(0, 0, size, size); s.imageSmoothingEnabled = false;
  s.globalCompositeOperation = "source-over"; s.drawImage(frame, 0, 0, size, size);
  s.globalCompositeOperation = "multiply"; s.fillStyle = "rgb(128,255,128)"; s.fillRect(0, 0, size, size);
  s.globalCompositeOperation = "destination-in"; s.drawImage(frame, 0, 0, size, size);
  s.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch as OffscreenCanvas, 0, 0, size, size, dx, dy, size, size);
}
function drawSlimeWalking(now: number, prog: number) {
  const frame = frameAt(slimeFrames, slimeTotal, now - sceneT0);
  if (!frame) return;
  const seg = prog * (pwalk.length - 1), ci = Math.min(pwalk.length - 2, Math.floor(seg)), frac = seg - ci;
  const from = pwalk[ci], to = pwalk[ci + 1];
  const x = from.cx + (to.cx - from.cx) * frac, y = from.cy + (to.cy - from.cy) * frac;
  const px = slimePx(), bob = Math.sin(now / 1000 * 9) * px * 0.09, drop = phh * 0.62;
  drawTintedSlime(frame, x - px / 2, (y + drop - bob) - px, px);
}
function captureDeathSlime(now: number) {
  const frame = frameAt(slimeFrames, slimeTotal, now - sceneT0) || slimeFrames[0].bmp;
  const size = Math.ceil(slimePx());
  ensureScratch(size, size);
  const s = sctx!; s.clearRect(0, 0, size, size); s.imageSmoothingEnabled = false; s.drawImage(frame, 0, 0, size, size);
  deathW = size; deathH = size; deathBase = s.getImageData(0, 0, size, size).data.slice();
}
function drawDissolveSlime(dt: number) {
  if (!deathBase) return;
  const w = deathW, h = deathH;
  const out = sctx!.createImageData(w, h), od = out.data, src = deathBase;
  const state = 1 - 2 * Math.min(1, dt / PZ.DEATH), flashF = Math.max(0, 1 - dt / 170);
  for (let yy = 0; yy < h; yy++) {
    const v = yy / h, thr = state + v;
    for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) << 2;
      if (src[i + 3] === 0) { od[i + 3] = 0; continue; }
      const cfx = (xx / w * 10) % 1 - 0.5, cfy = (v * 10) % 1 - 0.5;
      if (Math.sqrt(cfx * cfx + cfy * cfy) <= thr) {
        let r = 128, g = src[i + 1], b = src[i + 2] * 0.5;
        if (flashF > 0) { r += (255 - r) * flashF; g += (255 - g) * flashF; b += (255 - b) * flashF; }
        od[i] = r; od[i + 1] = g; od[i + 2] = b; od[i + 3] = src[i + 3];
      } else od[i + 3] = 0;
    }
  }
  sctx!.putImageData(out, 0, 0);
  const p = pcells[PZ.N - 1], px = slimePx(), drop = phh * 0.62;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch as OffscreenCanvas, 0, 0, w, h, p.cx - px / 2, (p.cy + drop) - px, w, h);
}
function drawElias(now: number) {
  const a = (EANCH as any)[eliasMode] as { fx: number; fy: number; mirror: boolean; base: number };
  const frames = eliasMode === "attack" ? eAttack : eliasMode === "victory" ? eVictory : eIdle;
  const total = eliasMode === "attack" ? eAttackTotal : eliasMode === "victory" ? eVictoryTotal : eIdleTotal;
  if (!frames.length) return;
  const frame = frameAt(frames, total, now - sceneT0, eliasMode === "idle");
  if (!frame) return;
  const px = phh * 3.79 * (a.base / 132);
  const feetX = pElias.fx, feetY = pElias.fy + 4;
  const fx = a.mirror ? 1 - a.fx : a.fx;
  const left = feetX - fx * px, top = feetY - a.fy * px;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (a.mirror) { ctx.translate(left + px, top); ctx.scale(-1, 1); ctx.drawImage(frame, 0, 0, px, px); }
  else ctx.drawImage(frame, left, top, px, px);
  ctx.restore();
}
// One scene tick: advance the state machine + draw grid/slime/Elias. Returns true
// when it's time to reveal (after victory on a load-complete card boundary).
function poisonScene(now: number): boolean {
  ensurePoisonGeo();
  if (!sceneStarted) { sceneStarted = true; sceneT0 = now; scenePhase = "run"; eliasMode = "idle"; }
  const dt = now - sceneT0;
  if (scenePhase === "run") {
    const prog = clamp(dt / PZ.RUN, 0, 1);
    setPoisonFills(prog); drawPoisonGrid(); drawSlimeWalking(now, prog); drawElias(now);
    if (prog >= 1) { scenePhase = "attack"; sceneT0 = now; eliasMode = "attack"; deathBase = null; }
  } else if (scenePhase === "attack") {
    for (const c of pwalk) c.fill = 1; drawPoisonGrid();
    if (!deathBase) captureDeathSlime(now);
    if (dt > PZ.ATTACK && eliasMode === "attack") eliasMode = "idle"; // swing once, then watch
    drawDissolveSlime(dt); drawElias(now);
    if (dt >= PZ.DEATH) {
      cardsDone++;
      deathBase = null;
      if (sceneReady && cardsDone >= 1) { scenePhase = "victory"; sceneT0 = now; eliasMode = "victory"; }
      else { cardIdx = pickCard(cardIdx); cardShownAt = now; scenePhase = "pause"; sceneT0 = now; eliasMode = "idle"; }
    }
  } else if (scenePhase === "victory") {
    for (const c of pwalk) c.fill = 1; drawPoisonGrid(); drawElias(now);
    if (dt >= PZ.VICTORY) return true; // load complete → cut to title
  } else if (scenePhase === "pause") {
    for (const c of pcells) c.fill = 0; for (const c of pbetween) c.fill = 0;
    drawPoisonGrid(); drawElias(now);
    if (dt >= PZ.PAUSE) { scenePhase = "run"; sceneT0 = now; }
  }
  return false;
}

function wrapCenter(text: string, cx: number, y: number, maxW: number, lineH: number): number {
  const words = text.split(" ");
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, cx, y); y += lineH; line = w;
    } else line = test;
  }
  if (line) { ctx.fillText(line, cx, y); y += lineH; }
  return y; // one line below the last drawn line — ready for the next block
}
