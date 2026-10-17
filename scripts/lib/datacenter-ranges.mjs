/**
 * Cloud / datacenter / crawler origins — ONE list, shared by every tool in this
 * repo that has to answer "is this a real player?".
 *
 * It exists because the answer was being re-derived per tool and the copies
 * drifted: the promote pre-flight blocked a release on two IPs the traffic
 * aggregator already classified as datacenter (2026-10-16). A gate that fires
 * on our own infrastructure gets overridden by habit, and an overridden gate
 * protects nothing.
 *
 * KNOWN DUPLICATE: the traffic-analytics Lambda carries its own copy, because
 * it is inline Python in a private CloudFormation template and cannot import
 * from this repo. When you change this list, change that one too — it is the
 * only copy that cannot be removed, and it is listed here so nobody discovers
 * it by surprise.
 *
 * A player's game download comes from a consumer ISP. These ranges are CI
 * runners, crawlers, prefetchers and cloud eggress.
 */
export const DATACENTER_RE = new RegExp(
  "^(" +
    [
      // Azure / GitHub-hosted runners (our own Deploy QA matrix).
      // Azure holds 4.128.0.0/9 — i.e. 4.128 through 4.255. The original
      // "4.1xx" entry stopped at 4.199, so the macOS-WebKit leg of our own QA
      // matrix (seen at 4.246.135.65, 2026-10-17) read as a stranger
      // mid-download and blocked a promote the owner had just authorised.
      "13\\.", "20\\.", "40\\.", "52\\.", "4\\.1[0-9][0-9]\\.", "4\\.2[0-5][0-9]\\.", "48\\.", "51\\.",
      "65\\.5[0-2]\\.", "68\\.21[0-9]\\.", "135\\.", "20\\.1[5-9][0-9]\\.",
      "172\\.1[6-9]", "172\\.2[0-9]", "104\\.20", "74\\.23",
      // AWS (our own prod smoke, exporters)
      "3\\.", "18\\.", "34\\.", "35\\.", "54\\.", "107\\.2[0-3]\\.",
      // Google (crawlers, prefetch, proxies)
      "74\\.125\\.", "66\\.249\\.", "64\\.23", "35\\.19[0-9]\\.",
      // Bing and other cloud
      "157\\.55\\.", "207\\.46\\.", "158\\.23\\.", "132\\.196\\.",
      // IBM Cloud
      "9\\.",
    ].join("|") +
    ")",
);

/** Self-identifying automation: crawlers, and our own harnesses. */
export const BOT_UA_RE =
  /(bot|crawl|spider|slurp|headless|playwright|lighthouse|monitor|curl|wget|python)/i;

/** True when this request is ours or a machine's, not a player's. */
export function isInfrastructure(ip, userAgent = "", query = "") {
  return DATACENTER_RE.test(ip || "") || BOT_UA_RE.test(userAgent || "") || String(query).includes("qa=1");
}
