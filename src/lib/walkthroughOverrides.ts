/**
 * Client access to the walkthrough edit OVERLAY (owner's inline prose edits).
 *
 * Dev: the writeback middleware in astro.config.mjs (GET the store, POST an
 * edit — which also appends the diff to Quinn's learning feed).
 * Prod: an admin-gated S3+Lambda stack — PHASE 2. Until PROD_API is set, prod
 * has no overlay source and simply serves Quinn's base prose (fetch no-ops).
 */

const DEV = import.meta.env.DEV;
// Prod overlay stack (allbyte-studio-walkthrough-overlay): public GET applies the
// overlay for every visitor; admin POST saves an edit + appends to Quinn's feed.
const PROD_API = "https://p3xadxo3l7.execute-api.us-east-1.amazonaws.com";

/** Whether inline editing is wired for this environment. Dev = yes (writeback
 *  middleware); prod = only once the Phase-2 overlay stack (PROD_API) is set.
 *  Gates the admin Edit affordance so it never appears where Save would fail. */
export const canEdit = DEV || !!PROD_API;

export interface WalkthroughOverride {
  id: string;
  code: string;
  scene?: string;
  edited_md: string;
  base_md?: string;
  note?: string;
  ts?: string;
}

function overridesUrl(): string {
  if (DEV) return "/api/walkthrough-overrides/";
  return PROD_API ? `${PROD_API}/walkthrough-overrides` : "";
}
function saveUrl(): string {
  if (DEV) return "/api/walkthrough-override/";
  return PROD_API ? `${PROD_API}/walkthrough-override` : "";
}

/** All current overrides, keyed by scene code. Empty when there's no source. */
export async function fetchOverrides(): Promise<Record<string, WalkthroughOverride>> {
  const url = overridesUrl();
  if (!url) return {};
  try {
    const r = await fetch(url);
    if (!r.ok) return {};
    const data = await r.json();
    return (data?.overrides ?? data ?? {}) as Record<string, WalkthroughOverride>;
  } catch {
    return {};
  }
}

/** Persist an inline edit (and, server-side, append it to Quinn's feed). */
export async function saveOverride(
  input: { code: string; scene?: string; edited_md: string; base_md: string; note?: string },
  token: string | null,
): Promise<{ ok: boolean; override?: WalkthroughOverride; error?: string }> {
  const url = saveUrl();
  if (!url) return { ok: false, error: "No overlay endpoint yet — the prod stack is Phase 2." };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data?.error ?? `HTTP ${r.status}` };
    return { ok: true, override: (data?.override ?? data) as WalkthroughOverride };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
