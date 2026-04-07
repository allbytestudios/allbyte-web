import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename, extname, resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const manifest = JSON.parse(readFileSync(join(ROOT, "scripts/asset-manifest.json"), "utf-8"));
const godot = manifest.godotProject;

if (!existsSync(godot)) {
  console.log("⚠ Godot project not found at:", godot);
  console.log("  Skipping asset sync (CI build will use committed assets)");
  process.exit(0);
}

// --- 1. Extract game version ---
const versionSource = readFileSync(join(godot, manifest.versionFile), "utf-8");
const versionMatch = versionSource.match(new RegExp(manifest.versionRegex));
const version = versionMatch ? versionMatch[1] : "unknown";
console.log(`Version: ${version}`);

mkdirSync(join(ROOT, "src/data"), { recursive: true });
writeFileSync(join(ROOT, "src/data/game-version.json"), JSON.stringify({ version }, null, 2));

// --- 2. Sync music ---
const musicDir = join(godot, manifest.music.sourceDir);
const musicOut = join(ROOT, "public/assets/music");
mkdirSync(musicOut, { recursive: true });

const musicFiles = [];
const seenTracks = new Map(); // track name -> preferred file

function walkMusic(dir, relPath = "") {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relPath ? `${relPath}/${entry}` : entry;
    const stat = statSync(full);

    // Skip excluded dirs
    if (stat.isDirectory()) {
      const excluded = manifest.music.exclude.some((pattern) => {
        if (pattern.endsWith("/**")) return rel.startsWith(pattern.replace("/**", ""));
        return false;
      });
      if (!excluded) walkMusic(full, rel);
      continue;
    }

    // Skip excluded file patterns
    const ext = extname(entry).toLowerCase();
    const excluded = manifest.music.exclude.some((pattern) => {
      if (pattern.startsWith("*.")) return ext === pattern.replace("*", "");
      return false;
    });
    if (excluded) continue;

    // Deduplicate: prefer the configured format
    const trackName = basename(entry, ext);
    const existing = seenTracks.get(trackName);
    const preferred = `.${manifest.music.preferFormat}`;

    if (!existing) {
      seenTracks.set(trackName, { full, ext, trackName });
    } else if (ext === preferred && existing.ext !== preferred) {
      seenTracks.set(trackName, { full, ext, trackName });
    }
  }
}

walkMusic(musicDir);

for (const [trackName, { full, ext }] of seenTracks) {
  const destName = `${trackName}${ext}`;
  copyFileSync(full, join(musicOut, destName));
  musicFiles.push({ name: trackName, file: `/assets/music/${destName}` });
  console.log(`  Music: ${destName}`);
}

// --- 3. Sync fonts ---
const fontsOut = join(ROOT, "public/assets/fonts");
mkdirSync(fontsOut, { recursive: true });
const fontFiles = [];

for (const file of manifest.fonts.files) {
  const src = join(godot, file);
  if (!existsSync(src)) {
    console.log(`  ⚠ Font not found: ${file}`);
    continue;
  }
  const name = basename(file);
  copyFileSync(src, join(fontsOut, name));
  fontFiles.push({ name: name.replace(extname(name), ""), file: `/assets/fonts/${name}` });
  console.log(`  Font: ${name}`);
}

// --- 4. Sync sprites ---
const spritesOut = join(ROOT, "public/assets/sprites");
mkdirSync(spritesOut, { recursive: true });
const spriteFiles = [];

for (const file of manifest.sprites.files) {
  const src = join(godot, file);
  if (!existsSync(src)) {
    console.log(`  ⚠ Sprite not found: ${file}`);
    continue;
  }
  const name = basename(file);
  // Include parent folder for context (e.g., Elias/IdleDown.png)
  const parts = file.split("/");
  const contextName = parts.length >= 2 ? `${parts[parts.length - 2]}/${name}` : name;
  const flatName = contextName.replace("/", "_");
  copyFileSync(src, join(spritesOut, flatName));
  spriteFiles.push({ name: contextName.replace("/", " - ").replace(extname(name), ""), file: `/assets/sprites/${flatName}` });
  console.log(`  Sprite: ${flatName}`);
}

// --- 5. Sync backgrounds ---
const bgOut = join(ROOT, "public/assets/backgrounds");
mkdirSync(bgOut, { recursive: true });
const backgroundFiles = [];

for (const file of manifest.backgrounds.files) {
  const src = join(godot, file);
  if (!existsSync(src)) {
    console.log(`  ⚠ Background not found: ${file}`);
    continue;
  }
  const name = basename(file);
  copyFileSync(src, join(bgOut, name));
  backgroundFiles.push({ name: name.replace(extname(name), ""), file: `/assets/backgrounds/${name}` });
  console.log(`  Background: ${name}`);
}

// --- 6. Write asset index ---
const assetIndex = {
  version,
  syncedAt: new Date().toISOString(),
  music: musicFiles,
  fonts: fontFiles,
  sprites: spriteFiles,
  backgrounds: backgroundFiles,
};

writeFileSync(join(ROOT, "src/data/asset-index.json"), JSON.stringify(assetIndex, null, 2));
console.log(`\nAsset index written: ${musicFiles.length} music, ${fontFiles.length} fonts, ${spriteFiles.length} sprites, ${backgroundFiles.length} backgrounds`);
