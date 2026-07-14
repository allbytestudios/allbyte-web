// Data layer for the one-click "promote develop -> demo (+ demo-debug)" button.
// Talks to the admin-gated orchestrator (allbyte-studio-demo-promote stack): it
// resolves develop's current commit from channels.json and StartBuilds the target
// channel projects at that SHA. Admin-gated server-side (JWT tier == admin).

export const PROMOTE_BASE =
  "https://5deecoa9g8.execute-api.us-east-1.amazonaws.com";

export interface PromoteBuild {
  channel: string;
  label: string;
  status: "started" | "unavailable" | "error";
  buildId?: string;
  error?: string;
}
export interface PromoteResult {
  promotingSha: string;
  version: string;
  builds: PromoteBuild[];
}
export interface BuildStatus {
  id: string;
  status: string; // IN_PROGRESS | SUCCEEDED | FAILED | STOPPED | FAULT | TIMED_OUT
  phase: string;
}

export async function promoteDevelop(token: string): Promise<PromoteResult> {
  const res = await fetch(`${PROMOTE_BASE}/promote`, {
    method: "POST",
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }
  return (await res.json()) as PromoteResult;
}

export async function fetchBuildStatus(
  token: string,
  ids: string[]
): Promise<BuildStatus[]> {
  if (!ids.length) return [];
  const res = await fetch(
    `${PROMOTE_BASE}/status?ids=${encodeURIComponent(ids.join(","))}`,
    { cache: "no-store", headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data.builds ?? []) as BuildStatus[];
}
