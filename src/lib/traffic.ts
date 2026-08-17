// Site traffic + navigation panel data layer. Reads the admin-gated aggregate
// from the allbyte-studio-traffic stack (daily aggregator over the CloudFront
// access logs; render-ready page-hit bars + a pre-computed user-flow Sankey).
// Same admin gate as the play funnel: server verifies the Bearer JWT + tier.

// ReadEndpoint of the allbyte-studio-traffic stack (us-east-1). CORS allows
// https://allbyte.studio + http://localhost:4321, so dev hits it directly too.
export const TRAFFIC_URL =
  "https://5ouei12hh0.execute-api.us-east-1.amazonaws.com/traffic";

export interface SankeyNode {
  x: number; y: number; w: number; h: number;
  color: string; label: string; col: number; val: number;
}
export interface SankeyRibbon { d: string; color: string; op: number; tip: string; }
export interface SankeyLabel {
  x: number; y: number; anchor: string; text: string; pct?: string; cls: string;
}
export interface SankeyColhead { x: number; anchor: string; text: string; }
export interface Sankey {
  viewBox: string; h: number;
  nodes: SankeyNode[]; ribbons: SankeyRibbon[];
  labels: SankeyLabel[]; colheads: SankeyColhead[];
}

export interface TrafficMeta {
  date_range: [string, string];
  n_files: number;
  raw_page_hits: number;
  bot_hits: number;
  bot_pct: number;
  /**
   * Our own Deploy QA / smoke runs against prod, removed from the figures above.
   * They used to read as play traffic and swamped the real players (~50:1 on the
   * busiest deploy days), which is what made this panel disagree with the play
   * funnel. Surfaced rather than silently dropped so a misfiring filter is
   * visible. Optional: aggregates written before the filter shipped lack them.
   */
  ci_hits?: number;
  ci_ips?: number;
  human_pageviews: number;
  n_sessions: number;
  avg_pages: number;
  mobile_pct: number;
  desktop_pct: number;
  generatedAt: number;
}
export interface Traffic {
  meta: TrafficMeta;
  top_pages: [string, number, string][];
  section_totals: [string, number][];
  entry_sources: [string, number][];
  ext_referrers: [string, number][];
  device_split: { mobile: number; desktop: number };
  sankey: Sankey;
}

// Section palette — matches the site "Engine" accent family. Shared by the bar
// chart (page section) and the Sankey (node colouring is baked server-side).
export const SECTION_COLOR: Record<string, string> = {
  home: "#a7f3d0", play: "#5eead4", devlog: "#7dd3fc",
  console: "#c4b5fd", other: "#fcd34d",
};
export const SECTION_LABEL: Record<string, string> = {
  home: "Home", play: "Play", devlog: "Devlog",
  console: "Dev console", other: "Other pages",
};

/** Admin-gated fetch. Returns null when there's no aggregate yet. */
export async function fetchTraffic(token: string): Promise<Traffic | null> {
  const res = await fetch(TRAFFIC_URL, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data || (data as any).empty) return null;
  return data as Traffic;
}
