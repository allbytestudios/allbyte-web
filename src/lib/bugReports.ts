// Bug-reports read source (allbyte-studio-bug-reports stack, us-east-1).
// Admin-gated server-side (tier=="admin"); the ReadEndpoint returns reports
// newest-first. Shared between BugReportsApp (full list) and TestNav (count badge).
export const BUG_READ_URL = "https://g5byr6mvm9.execute-api.us-east-1.amazonaws.com/reports";

export interface BugCounts {
  total: number;
  /** Untriaged reports — status "new" or absent. The "needs attention" number. */
  unread: number;
}

/** Count total + unread bug reports for the nav badge. Returns null on missing
 *  token / auth failure / error so the nav can just hide the badge instead of
 *  showing a wrong number (non-admin subscribers get 403 here — that's expected). */
export async function fetchBugCounts(
  token: string | null | undefined
): Promise<BugCounts | null> {
  if (!token) return null;
  try {
    const res = await fetch(BUG_READ_URL, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const reports = (data?.reports ?? []) as Array<{ status?: string }>;
    const total = reports.length;
    const unread = reports.filter((r) => !r.status || r.status === "new").length;
    return { total, unread };
  } catch {
    return null;
  }
}
