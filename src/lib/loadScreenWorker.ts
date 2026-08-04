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
  cfg: { studioMs: number; studioSettleMs: number; studioFadeMs: number; cardMs: number; cardMinMs: number };
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
let spinner: ImageBitmap | null = null; // in-game LoadingIcon.png (6× 32×32 strip)
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
    cards = msg.cards; cfg = msg.cfg;
    const cv = msg.canvas;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx = cv.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.scale(dpr, dpr);
    cardIdx = Math.floor(Math.random() * cards.length);
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
  } else if (m.type === "spinner") {
    spinner = (m.bmp as ImageBitmap) || null;
  } else if (m.type === "sprite") {
    loadSprite(m.idle as ArrayBuffer | null, m.attack as ArrayBuffer | null);
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
    if (cardShownAt === 0) { cardShownAt = now; }
    drawManual(now, t);
    // rotate
    if (now - cardShownAt >= cfg.cardMs) { cardIdx = pickCard(cardIdx); cardShownAt = now; }
    // reveal
    if (sceneReady && now - cardShownAt >= Math.min(cfg.cardMinMs, cfg.cardMs)) {
      revealed = true;
      (self as any).postMessage({ type: "reveal" });
      return;
    }
  }
  setTimeout(loop, 16);
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

  const fade = t > cfg.studioMs - cfg.studioFadeMs
    ? clamp(1 - (t - (cfg.studioMs - cfg.studioFadeMs)) / cfg.studioFadeMs, 0, 1)
    : 1;
  ctx.globalAlpha = fade;

  const word = "All Byte";
  const letterPx = clamp(H * 0.14, 42, 80);
  ctx.font = `600 ${letterPx}px ${FONT}, Georgia, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const wordW = ctx.measureText(word).width;
  const cx = W / 2;
  const wordY = H / 2 + letterPx * 0.3;

  // bits row, equidistant across the word width
  const bitPx = clamp(letterPx * 0.34, 14, 30);
  ctx.font = `${bitPx}px ${FONT}, Georgia, serif`;
  const left = cx - wordW / 2, right = cx + wordW / 2;
  const gap = studioBits.length > 1 ? (right - left) / (studioBits.length - 1) : 0;
  ctx.fillStyle = "#f4ecd6";
  const bitsY = wordY - letterPx - bitPx * 0.6;
  for (let i = 0; i < studioBits.length; i++) {
    ctx.fillText(String(studioBits[i]), left + i * gap, bitsY);
  }
  // wordmark
  ctx.font = `600 ${letterPx}px ${FONT}, Georgia, serif`;
  ctx.fillStyle = "#f4ecd6";
  ctx.fillText(word, cx, wordY);
  ctx.globalAlpha = 1;

  // spinner is present the whole load, studio included
  drawSpinner(now, cx, H - H * 0.13, clamp(H * 0.04, 16, 28));
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
  const kickerY = card.kind === "sprite" ? H * 0.12 : H * 0.2;
  ctx.fillText(spaced(kicker), cx, kickerY);
  let y = kickerY + H * 0.06;

  if (card.kind === "text") {
    ctx.font = `700 ${clamp(H * 0.075, 24, 44)}px ${FONT}, Georgia, serif`;
    ctx.fillStyle = "#f6eccf";
    y = wrapCenter(card.title, cx, y, W - pad * 2, clamp(H * 0.082, 26, 48)) + H * 0.03;
    if (card.rows) {
      const rowH = clamp(H * 0.062, 26, 40);
      const colX = cx - (W - pad * 2) / 2;
      const dtW = (W - pad * 2) * 0.34;
      ctx.textAlign = "left";
      for (const [dt, dd] of card.rows) {
        ctx.font = `700 ${clamp(H * 0.036, 14, 19)}px ${FONT}, Georgia, serif`;
        ctx.fillStyle = "#e7b866"; ctx.fillText(dt, colX, y);
        ctx.font = `${clamp(H * 0.034, 13, 18)}px ${FONT}, Georgia, serif`;
        ctx.fillStyle = "#cdbf9e"; ctx.fillText(dd, colX + dtW + 12, y);
        y += rowH;
      }
      ctx.textAlign = "center";
    } else if (card.lines) {
      ctx.font = `${clamp(H * 0.04, 15, 21)}px ${FONT}, Georgia, serif`;
      ctx.fillStyle = "#d9cba9";
      for (const line of card.lines) {
        y = wrapCenter(line, cx, y, W - pad * 2, clamp(H * 0.05, 18, 26)) + H * 0.02;
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

  // spinning-rings icon (the in-game loader) above the dots
  drawSpinner(now, cx, H - H * 0.15, clamp(H * 0.04, 16, 28));

  // dots — one lights per second on the current card
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
