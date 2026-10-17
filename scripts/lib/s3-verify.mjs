/**
 * s3-verify.mjs — ask S3 what it actually stored, instead of trusting the bytes
 * we meant to send.
 *
 * WHY: a publisher that records its own LOCAL hashes proves nothing about the
 * upload. A truncated or corrupted transfer gets recorded with the hash of the
 * healthy local file and looks perfect in the receipt — and the receipt is the
 * thing promote later trusts to decide "these are the bytes QA signed off".
 * So every object is read back with `head-object --checksum-mode ENABLED` and
 * compared against a locally computed value. (DEV_PIPELINE open item #2.)
 *
 * THE MULTIPART TRAP, which is why this file exists at all rather than being
 * three inline lines: for a multipart upload S3 does NOT store the whole-object
 * SHA-256. It stores the SHA-256 *of the concatenated part digests*, base64,
 * with a `-<partCount>` suffix. Verified against a real 20 MB upload
 * (2026-10-17): S3 returned `GzOpWamu…=-3` while the whole-object hash was
 * `34o4R0TA…`. A naive comparison therefore fails on exactly the files that
 * matter most here — index.wasm and the .pck packs are the large ones — and the
 * tempting "skip the ones with a -N suffix" fix would silently verify only the
 * small files while reporting the build as checked.
 *
 * So: compute both forms and accept whichever shape S3 reports.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, statSync } from "node:fs";

/**
 * The CLI's default multipart chunk size. Pin it on the upload side too
 * (AWS_CLI_S3_MULTIPART_CHUNKSIZE) so both halves agree by construction rather
 * than by assumption — the CLI scales this up on its own for very large files
 * to stay under the 10,000-part limit.
 */
export const CHUNK = 8 * 1024 * 1024;

/** Whole-object checksum, as S3 reports it for a single-part upload. */
export function wholeSha256Base64(path) {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("base64");
}

/** Composite checksum, as S3 reports it for a multipart upload: `<b64>-<parts>`. */
export function compositeSha256(path, chunk = CHUNK) {
  const digests = [];
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(chunk);
    for (;;) {
      const n = readSync(fd, buf, 0, chunk, null);
      if (n <= 0) break;
      digests.push(createHash("sha256").update(buf.subarray(0, n)).digest());
    }
  } finally {
    closeSync(fd);
  }
  if (digests.length === 0) return null;
  const top = createHash("sha256").update(Buffer.concat(digests)).digest("base64");
  return `${top}-${digests.length}`;
}

/**
 * What S3 holds for one key: its stored checksum and length.
 * Returns null when the object is absent — an absent key is a failure the
 * caller must name, never an empty success.
 */
export function headObject(bucket, key, aws = defaultAws) {
  try {
    const out = aws([
      "s3api", "head-object",
      "--bucket", bucket,
      "--key", key,
      "--checksum-mode", "ENABLED",
      "--query", "{sum:ChecksumSHA256,len:ContentLength}",
      "--output", "json",
    ]);
    const o = JSON.parse(out);
    return { checksum: o.sum || null, length: typeof o.len === "number" ? o.len : null };
  } catch {
    return null;
  }
}

function defaultAws(args) {
  return execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Verify every uploaded object against its local source.
 *
 * `entries` is [{ key, path }]. Returns { ok, checked, failures[] } where each
 * failure names WHICH check failed — missing, length, or checksum — because
 * "upload corrupted" and "upload never happened" want different responses.
 */
export function verifyUploaded(bucket, entries, { aws = defaultAws, chunk = CHUNK } = {}) {
  const failures = [];
  let checked = 0;

  for (const { key, path } of entries) {
    const head = headObject(bucket, key, aws);
    if (!head) {
      failures.push({ key, reason: "missing", detail: "head-object found nothing at this key" });
      continue;
    }

    const localLen = statSync(path).size;
    if (head.length !== null && head.length !== localLen) {
      failures.push({
        key,
        reason: "length",
        detail: `S3 has ${head.length} bytes, local file is ${localLen}`,
      });
      continue;
    }

    if (!head.checksum) {
      // The object exists and the length agrees, but S3 is holding no checksum
      // — it was uploaded without --checksum-algorithm. Report it rather than
      // treating a length match as verification; equal length is not equal bytes.
      failures.push({
        key,
        reason: "no-checksum",
        detail: "object has no stored SHA-256 (uploaded without --checksum-algorithm?)",
      });
      continue;
    }

    const expected = head.checksum.includes("-")
      ? compositeSha256(path, chunk)
      : wholeSha256Base64(path);

    if (expected !== head.checksum) {
      failures.push({
        key,
        reason: "checksum",
        detail: `S3 stored ${head.checksum}, local computes ${expected}`,
      });
      continue;
    }
    checked++;
  }

  return { ok: failures.length === 0, checked, failures };
}
