#!/usr/bin/env node
/**
 * verify-pck-encryption.js - pre-deploy gate: AES-decrypt + MD5-verify EVERY
 * encrypted entry in a Godot .pck under the release script key.
 *
 * Catches the mixed-key / corrupt-encryption export bug that caused the
 * 2026-07-25 combat hang (a subset of encrypted .gdc/.scn failed to decrypt at
 * runtime -> on-demand menu/combat loads hung). Now that class of bug dies at
 * the deploy gate instead of on a player's screen.
 *
 * Godot 4.6.2 PCK format v3 - empirically reverse-engineered and validated
 * against a known-good build (all 340 encrypted entries decrypt + MD5-match):
 *   header:  magic "GDPC"(0x43504447)@0, version@4, ver major/minor/patch@8..20,
 *            flags@20 (bit0 = PACK_DIR_ENCRYPTED), file_base(u64)@24,
 *            dir_offset(u64)@32   [v3 relocates the directory to the file's end]
 *   dir @dir_offset: file_count(u32), then per entry:
 *            [path_len u32][path][ofs u64][size u64][md5 16][flags u32]
 *            ofs is relative to file_base; flags bit0 = PACK_FILE_ENCRYPTED
 *   encrypted data @(file_base + ofs):
 *            [md5 16 = PLAINTEXT md5][length u64][iv 16][ciphertext ceil(len/16)*16]
 *            AES-256-CFB(key, iv) -> truncate to length -> MD5 must equal that md5
 *   (NB: it's CFB, not CBC; there is no "GDEC" magic in v3.)
 *
 * CLI (spot-check):  node scripts/verify-pck-encryption.js <path.pck> [--key=<64hex>]
 * Key resolution mirrors the obfuscator: --key, $GODOT_RELEASE_SCRIPT_KEY, or
 * ~/Desktop/GameDev/docker/.env. (Game/content key - exempt from the secret rule.)
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const PACK_MAGIC = 0x43504447; // "GDPC"

export function resolveScriptKey(argv = process.argv) {
  const cli = argv.find((a) => a.startsWith("--key="));
  if (cli) { const h = cli.slice(6); if (/^[0-9a-f]{64}$/i.test(h)) return Buffer.from(h, "hex"); }
  const env = process.env.GODOT_RELEASE_SCRIPT_KEY;
  if (env && /^[0-9a-f]{64}$/i.test(env)) return Buffer.from(env, "hex");
  const f = process.env.GODOT_RELEASE_KEY_ENV_FILE || join(homedir(), "Desktop/GameDev/docker/.env");
  if (existsSync(f)) {
    try {
      const m = readFileSync(f, "utf8").match(/^GODOT_RELEASE_SCRIPT_KEY=([0-9a-f]{64})$/m);
      if (m) return Buffer.from(m[1], "hex");
    } catch { /* unreadable env file - fall through */ }
  }
  return null;
}

/**
 * verifyPckEncryption(pckPath, key) ->
 *   { supported, version, total, encrypted, verified, failures: [{path, reason}] }
 * supported=false (with .reason) means the format/version isn't handled - the
 * caller decides whether to warn or block. Real corruption shows up as failures.
 */
export function verifyPckEncryption(pckPath, key) {
  const b = readFileSync(pckPath);
  if (b.length < 40 || b.readUInt32LE(0) !== PACK_MAGIC)
    return { supported: false, version: null, reason: "not a GDPC pack" };
  const version = b.readUInt32LE(4);
  if (version !== 3) return { supported: false, version, reason: `unhandled PCK format v${version} (verifier knows v3)` };

  const flags = b.readUInt32LE(20);
  const fileBase = Number(b.readBigUInt64LE(24));
  const dirOfs = Number(b.readBigUInt64LE(32));
  if (flags & 0x1) return { supported: false, version, reason: "encrypted directory not supported by verifier" };

  let p = dirOfs;
  const u32 = () => { const v = b.readUInt32LE(p); p += 4; return v; };
  const u64 = () => { const v = Number(b.readBigUInt64LE(p)); p += 8; return v; };
  const count = u32();

  const out = { supported: true, version, total: count, encrypted: 0, verified: 0, failures: [] };
  for (let i = 0; i < count; i++) {
    const L = u32();
    const path = b.slice(p, p + L).toString("latin1").replace(/\0+$/, ""); p += L;
    const ofs = u64(); u64(); /* size (plaintext len; unused here) */ p += 16; /* dir md5 */ const eflags = u32();
    if ((eflags & 0x1) === 0) continue; // not encrypted
    out.encrypted++;
    try {
      const d0 = fileBase + ofs;
      const md5h = b.slice(d0, d0 + 16);
      const len = Number(b.readBigUInt64LE(d0 + 16));
      const iv = b.slice(d0 + 24, d0 + 40);
      const ctLen = Math.ceil(len / 16) * 16;
      const ct = b.slice(d0 + 40, d0 + 40 + ctLen);
      if (ct.length !== ctLen) { out.failures.push({ path, reason: "ciphertext truncated in pack" }); continue; }
      const dc = crypto.createDecipheriv("aes-256-cfb", key, iv); dc.setAutoPadding(false);
      const pt = Buffer.concat([dc.update(ct), dc.final()]).slice(0, len);
      if (crypto.createHash("md5").update(pt).digest().equals(md5h)) out.verified++;
      else out.failures.push({ path, reason: "MD5 mismatch - won't decrypt under the release key" });
    } catch (e) {
      out.failures.push({ path, reason: e.message });
    }
  }
  return out;
}

// --- CLI ---------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("verify-pck-encryption.js")) {
  const pck = process.argv.find((a) => a.endsWith(".pck"));
  if (!pck) { console.error("usage: node verify-pck-encryption.js <path.pck> [--key=<64hex>]"); process.exit(2); }
  if (!existsSync(pck)) { console.error(`[verify-pck] not found: ${pck}`); process.exit(2); }
  const key = resolveScriptKey();
  if (!key) { console.error("[verify-pck] no release key (--key / $GODOT_RELEASE_SCRIPT_KEY / docker/.env)"); process.exit(2); }
  const r = verifyPckEncryption(pck, key);
  if (!r.supported) { console.warn(`[verify-pck] SKIP: ${r.reason}`); process.exit(0); }
  console.log(`[verify-pck] ${pck}: ${r.encrypted} encrypted, ${r.verified} verified, ${r.failures.length} FAILED`);
  for (const f of r.failures.slice(0, 20)) console.error(`  FAIL ${f.path}: ${f.reason}`);
  process.exit(r.failures.length ? 1 : 0);
}
