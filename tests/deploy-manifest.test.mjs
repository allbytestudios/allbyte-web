import test from "node:test";
import assert from "node:assert/strict";
import { mergeDeployManifests } from "../scripts/lib/deploy-manifest.mjs";

test("merges local and hosted records and deduplicates commit SHAs", () => {
  const merged = mergeDeployManifests([
    { name: "local", body: `${JSON.stringify({ version: "0.8.10", commits: [{ sha: "a", subject: "local" }] })}\n` },
    { name: "mirror", body: [
      { version: "v0.8.10", commits: [{ sha: "a", subject: "duplicate" }, { sha: "b", subject: "cloud" }] },
      { version: "v0.8.11", commits: [{ sha: "c", subject: "new release" }] },
    ].map(JSON.stringify).join("\n") },
  ]);
  const records = merged.split("\n").map(JSON.parse);
  assert.deepEqual(records.map(({ version }) => version), ["v0.8.10", "v0.8.11"]);
  assert.deepEqual(records[0].commits.map(({ sha }) => sha), ["a", "b"]);
});

test("rejects malformed and unversioned manifest records with source location", () => {
  assert.throws(() => mergeDeployManifests([{ name: "mirror", body: "not json\n" }]), /mirror:1/);
  assert.throws(() => mergeDeployManifests([{ name: "local", body: '{"commits":[]}\n' }]), /missing version.*local:1/);
});
