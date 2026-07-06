#!/usr/bin/env node
/**
 * Per-release obfuscation of the Godot 4 web export script encryption key.
 *
 * Finds the 32-byte script_encryption_key in index.wasm via KeyDot's marker
 * pattern, XORs it with a per-release random mask, and patches index.html
 * to load a small JS shim that intercepts fetch() and XORs the bytes back
 * at runtime. Engine sees plaintext bytes in linear memory; the .wasm on
 * disk does not surrender the key to a static scan.
 *
 * Speed-bump tier (Godot upstream's own framing): defeats KeyDot's static
 * scan; an attacker who runs/instruments the page can still recover the
 * key. Per Port (2026-05-11), Godot 4.6.2 web exports have no runtime
 * key-supply hook in engine.js or platform/web — WASM-side obfuscation is
 * the only path.
 *
 * NO-OP if the KeyDot marker is absent or the 32-byte slot is all zeros
 * (dev exports with script_encryption_key=""). Safe to run on any export.
 *
 * SAFETY: if pck-key-shim.js already exists, the script checks the
 * WASM_SHA256 marker embedded in the shim against the current WASM:
 *   - matching SHA + HTML already patched   → no-op
 *   - matching SHA + HTML unpatched         → re-patch HTML (self-heal case
 *                                              after a Godot re-export that
 *                                              overwrote index.html but
 *                                              kept the obfuscated WASM)
 *   - mismatched SHA                        → refuse (WASM was re-exported;
 *                                              shim's mask doesn't apply)
 *   - legacy shim with no SHA marker        → refuse (can't verify safely)
 * In all refuse cases the user is told exactly what to do.
 *
 * Usage:
 *   node scripts/obfuscate-godot-export.js [target-dir]
 *   npm run obfuscate-godot
 *
 * Default target: public/godot/
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";

const TARGET_DIR = process.argv[2] || "public/godot";
const WASM_PATH = join(TARGET_DIR, "index.wasm");
const HTML_PATH = join(TARGET_DIR, "index.html");
const SHIM_PATH = join(TARGET_DIR, "pck-key-shim.js");
const SHIM_REL = "pck-key-shim.js";

// KeyDot marker bytes (KeyDot v1, Godot 3.5.x / 4.1.x layout) — see
// github.com/Titoot/KeyDot/blob/main/src/wasm/wasm_scanner.cpp. Godot 4.6.2
// uses a different LEB128 framing AND places the key block ~17KB from end,
// not within KeyDot's last-3KB window. So this marker-scan is a legacy
// fallback; the primary path is now key-from-env (read game key from
// docker/.env, scan whole WASM for those exact bytes). Game keys are exempt
// from the no-secrets policy per the owner's 2026-05-11 clarification.
const START_MARKER = Buffer.from([0x00, 0x1b, 0x00, 0x00, 0x00, 0x00, 0x40]);
const END_MARKER = Buffer.from([0x09, 0x00]);
const KEY_LEN = 32;
const SCAN_TAIL_BYTES = 3 * 1024;

/** Marker-scan fallback. Works on older Godot layouts (3.5.x, 4.1.x). */
function findKeyByMarker(wasm) {
	const tailStart = Math.max(0, wasm.length - SCAN_TAIL_BYTES);
	const tail = wasm.subarray(tailStart);
	for (let i = tail.length - END_MARKER.length; i >= START_MARKER.length + KEY_LEN; i--) {
		if (tail[i] !== END_MARKER[0] || tail[i + 1] !== END_MARKER[1]) continue;
		const keyStart = i - KEY_LEN;
		const markerStart = keyStart - START_MARKER.length;
		if (markerStart < 0) continue;
		if (
			tail.compare(
				START_MARKER,
				0,
				START_MARKER.length,
				markerStart,
				markerStart + START_MARKER.length,
			) !== 0
		) {
			continue;
		}
		return tailStart + keyStart;
	}
	return -1;
}

/** Find the plaintext key in the WASM. Returns offset or -1. */
function findKeyByValue(wasm, keyBuf) {
	if (keyBuf.length !== KEY_LEN) return -1;
	return wasm.indexOf(keyBuf);
}

/**
 * Resolve the plaintext key from CLI / env / .env file. Returns a 32-byte
 * Buffer or null. Looked up in priority order:
 *   1. --key=<64-hex> CLI arg
 *   2. $GODOT_RELEASE_SCRIPT_KEY env var
 *   3. GODOT_RELEASE_SCRIPT_KEY line in $GODOT_RELEASE_KEY_ENV_FILE (default:
 *      ~/Desktop/GameDev/docker/.env) via targeted single-line
 *      regex match — never reads the whole file.
 */
function resolveKey(argv) {
	const cliArg = argv.find((a) => a.startsWith("--key="));
	if (cliArg) {
		const hex = cliArg.slice("--key=".length);
		if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
	}
	const envValue = process.env.GODOT_RELEASE_SCRIPT_KEY;
	if (envValue && /^[0-9a-f]{64}$/i.test(envValue)) {
		return Buffer.from(envValue, "hex");
	}
	const envFile = process.env.GODOT_RELEASE_KEY_ENV_FILE || join(homedir(), "Desktop/GameDev/docker/.env");
	if (existsSync(envFile)) {
		try {
			const text = readFileSync(envFile, "utf8");
			const m = text.match(/^GODOT_RELEASE_SCRIPT_KEY=([0-9a-f]+)$/m);
			if (m && /^[0-9a-f]{64}$/i.test(m[1])) return Buffer.from(m[1], "hex");
		} catch {}
	}
	return null;
}

function isAllZeros(buf, offset, len) {
	for (let i = 0; i < len; i++) {
		if (buf[offset + i] !== 0) return false;
	}
	return true;
}

function sha256Hex(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

/** Read SHA-256 of the obfuscated WASM that a previous run embedded in
 *  the shim. Returns the hex digest, or null if the marker is missing
 *  (legacy shim from before SHA verification was added). */
function extractShimWasmSha(shimText) {
	const m = shimText.match(/^\/\/ WASM_SHA256:\s+([0-9a-f]{64})\s*$/m);
	return m ? m[1] : null;
}

function generateShim(offset, mask, wasmSha) {
	const maskHex = Buffer.from(mask).toString("hex");
	return `// pck-key-shim.js — generated by scripts/obfuscate-godot-export.js.
// Per-release random mask; regenerated on every release export. DO NOT edit.
// WASM_SHA256: ${wasmSha}
(function () {
\tvar KEY_OFFSET = ${offset};
\tvar KEY_LEN = ${KEY_LEN};
\tvar MASK_HEX = "${maskHex}";
\tvar mask = new Uint8Array(KEY_LEN);
\tfor (var i = 0; i < KEY_LEN; i++) {
\t\tmask[i] = parseInt(MASK_HEX.substr(i * 2, 2), 16);
\t}
\tvar originalFetch = window.fetch.bind(window);
\twindow.fetch = function (input, init) {
\t\tvar url = typeof input === "string" ? input : (input && input.url) || "";
\t\tif (/index\\.wasm/.test(url)) {
\t\t\treturn originalFetch(input, init).then(function (resp) {
\t\t\t\treturn resp.arrayBuffer().then(function (buf) {
\t\t\t\t\tvar view = new Uint8Array(buf);
\t\t\t\t\tfor (var j = 0; j < KEY_LEN; j++) view[KEY_OFFSET + j] ^= mask[j];
\t\t\t\t\t// Clean headers: keep the wasm content-type but DROP content-encoding
\t\t\t\t\t// and content-length. buf is the already-decoded body; index.wasm is
\t\t\t\t\t// served gzip-encoded for transport, so copying those headers onto this
\t\t\t\t\t// synthetic plaintext Response would make instantiateStreaming try to
\t\t\t\t\t// re-decode plain bytes / mismatch the length on some engines.
\t\t\t\t\tvar cleanHeaders = new Headers();
\t\t\t\t\tcleanHeaders.set("content-type", resp.headers.get("content-type") || "application/wasm");
\t\t\t\t\treturn new Response(buf, {
\t\t\t\t\t\tstatus: resp.status,
\t\t\t\t\t\tstatusText: resp.statusText,
\t\t\t\t\t\theaders: cleanHeaders,
\t\t\t\t\t});
\t\t\t\t});
\t\t\t});
\t\t}
\t\treturn originalFetch(input, init);
\t};
})();
`;
}

function patchHtml(html) {
	const shimTag = `<script src="${SHIM_REL}"></script>`;
	if (html.includes(shimTag)) return html;
	const enginePattern = /<script src="index\.js[^"]*"><\/script>/;
	const match = html.match(enginePattern);
	if (!match) {
		throw new Error(
			`could not find <script src="index.js..."></script> in ${HTML_PATH} — engine loader tag missing or shape changed`,
		);
	}
	return html.replace(enginePattern, `${shimTag}\n\t\t${match[0]}`);
}

// ---- main ----

if (!existsSync(WASM_PATH)) {
	console.error(`[obfuscate] ${WASM_PATH} not found`);
	process.exit(1);
}
if (!existsSync(HTML_PATH)) {
	console.error(`[obfuscate] ${HTML_PATH} not found`);
	process.exit(1);
}

if (existsSync(SHIM_PATH)) {
	// Existing shim — figure out whether it matches the current WASM.
	const shimText = readFileSync(SHIM_PATH, "utf8");
	const embeddedSha = extractShimWasmSha(shimText);

	if (!embeddedSha) {
		console.error(`[obfuscate] ${SHIM_PATH} exists but has no WASM_SHA256 marker (legacy shim).`);
		console.error(`[obfuscate] Can't verify it matches the current WASM, and a blind re-XOR`);
		console.error(`[obfuscate] would corrupt the key. Re-export from Godot, delete ${SHIM_REL},`);
		console.error(`[obfuscate] then re-run.`);
		process.exit(2);
	}

	const currentSha = sha256Hex(readFileSync(WASM_PATH));

	if (embeddedSha !== currentSha) {
		console.error(`[obfuscate] ${SHIM_PATH} was generated against a different WASM:`);
		console.error(`[obfuscate]   shim WASM SHA256: ${embeddedSha}`);
		console.error(`[obfuscate]   curr WASM SHA256: ${currentSha}`);
		console.error(`[obfuscate] Godot was re-exported after obfuscation. The old shim's XOR mask`);
		console.error(`[obfuscate] won't restore the new WASM's key. Delete ${SHIM_REL} and re-run`);
		console.error(`[obfuscate] to fully re-obfuscate.`);
		process.exit(2);
	}

	// Shim matches current WASM — self-heal: make sure the HTML still loads it.
	// This handles the common case where a Godot re-export overwrote index.html
	// without touching the obfuscated WASM, leaving the shim orphaned.
	const html = readFileSync(HTML_PATH, "utf8");
	const patched = patchHtml(html);
	if (patched === html) {
		console.log(`[obfuscate] OK (no-op — WASM already obfuscated, HTML already loads shim).`);
	} else {
		writeFileSync(HTML_PATH, patched);
		console.log(`[obfuscate] OK (self-heal — re-patched HTML to load existing shim).`);
		console.log(`[obfuscate]   wasm:   unchanged (SHA matches existing shim)`);
		console.log(`[obfuscate]   html:   added <script src="${SHIM_REL}"> before index.js`);
	}
	process.exit(0);
}

const wasm = readFileSync(WASM_PATH);

// Primary path: key-from-env (works on any Godot version that compiles the
// key as raw 32 contiguous bytes — Godot 3.5+ through current).
const knownKey = resolveKey(process.argv.slice(2));
let offset = -1;
let detection = "";
if (knownKey) {
	offset = findKeyByValue(wasm, knownKey);
	if (offset !== -1) detection = `key-from-env (found plaintext key at offset ${offset})`;
}

// Fallback: KeyDot-style marker scan, last-3KB of WASM (legacy Godot layout).
if (offset === -1) {
	offset = findKeyByMarker(wasm);
	if (offset !== -1) detection = `KeyDot marker (last ${SCAN_TAIL_BYTES} bytes)`;
}

if (offset === -1) {
	if (knownKey) {
		console.log(
			`[obfuscate] plaintext key not found anywhere in ${WASM_PATH} and KeyDot marker absent — skipping (likely dev export built against a template without the key compiled in).`,
		);
	} else {
		console.log(
			`[obfuscate] no key source configured (set $GODOT_RELEASE_SCRIPT_KEY or pass --key=<64-hex>) and KeyDot marker absent in last ${SCAN_TAIL_BYTES} bytes — skipping.`,
		);
	}
	process.exit(0);
}

if (isAllZeros(wasm, offset, KEY_LEN)) {
	console.log(
		`[obfuscate] key slot at offset ${offset} is all zeros — skipping (script_encryption_key="").`,
	);
	process.exit(0);
}

const mask = randomBytes(KEY_LEN);
for (let i = 0; i < KEY_LEN; i++) wasm[offset + i] ^= mask[i];
writeFileSync(WASM_PATH, wasm);

const wasmSha = sha256Hex(wasm);
writeFileSync(SHIM_PATH, generateShim(offset, mask, wasmSha));

const html = readFileSync(HTML_PATH, "utf8");
const patched = patchHtml(html);
const htmlChanged = patched !== html;
if (htmlChanged) writeFileSync(HTML_PATH, patched);

console.log(`[obfuscate] OK`);
console.log(`[obfuscate]   detect: ${detection}`);
console.log(`[obfuscate]   wasm:   XOR'd 32 key bytes at offset ${offset} in ${WASM_PATH}`);
console.log(`[obfuscate]   shim:   wrote ${SHIM_PATH}`);
console.log(`[obfuscate]   html:   ${htmlChanged ? "patched (added shim <script> before index.js)" : "unchanged (already patched)"}`);
