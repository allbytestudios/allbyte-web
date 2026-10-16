/** Merge local and hosted NDJSON manifests by version, deduplicating commits. */
export function mergeDeployManifests(sources) {
  const byVersion = new Map();
  for (const source of sources) {
    for (const [lineNo, line] of source.body.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { throw new Error(`Invalid manifest JSON at ${source.name}:${lineNo + 1}`); }
      if (!record.version) throw new Error(`Manifest record missing version at ${source.name}:${lineNo + 1}`);
      const version = String(record.version).startsWith("v") ? String(record.version) : `v${record.version}`;
      const merged = byVersion.get(version) || { ...record, version, commits: [] };
      const seen = new Set(merged.commits.map((c) => c.sha || JSON.stringify(c)));
      for (const commit of record.commits || []) {
        const key = commit.sha || JSON.stringify(commit);
        if (!seen.has(key)) { merged.commits.push(commit); seen.add(key); }
      }
      byVersion.set(version, merged);
    }
  }
  return [...byVersion.values()].map((record) => JSON.stringify(record)).join("\n");
}
