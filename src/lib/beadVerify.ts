/**
 * Bead-verification API client (admin only).
 *
 * The owner marks needs-verify beads as verified from the prod /test/ console;
 * rows land in the always-on `allbyte-studio-bead-verify` DynamoDB table via
 * the admin-JWT-gated routes below. Arc later pulls the pending set over the
 * agent bus (via App) and closes the beads with `bd close`; App flips
 * `processed=true` only after Arc acks (bus contract: BEADS_VERIFY envelopes).
 */

const API = "https://api.allbyte.studio";

export interface BeadVerifyRecord {
  beadId: string;
  verified_at: string;
  verified_by: string;
  note?: string;
  processed: boolean;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("allbyte_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Map of beadId → record. Throws on non-OK (401/403 for non-admins). */
export async function fetchVerified(): Promise<Map<string, BeadVerifyRecord>> {
  const res = await fetch(`${API}/admin/beads/verified`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const map = new Map<string, BeadVerifyRecord>();
  for (const item of data.items ?? []) map.set(item.beadId, item as BeadVerifyRecord);
  return map;
}

export async function markVerified(id: string, note?: string): Promise<void> {
  const res = await fetch(`${API}/admin/beads/verify`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(note ? { id, note } : { id }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function unmarkVerified(id: string): Promise<void> {
  const res = await fetch(`${API}/admin/beads/verify/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
