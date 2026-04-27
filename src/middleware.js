// Set COOP/COEP on every dev response so the /play/ page can host a
// cross-origin-isolated iframe (required for Godot HTML5's SharedArrayBuffer).
// In prod these headers come from CloudFront; this middleware is a dev-only
// parity layer (SSG builds strip middleware).
//
// /test/in-flight/ is exempt: it embeds Grafana cross-origin, and Grafana
// doesn't send Cross-Origin-Resource-Policy, so under require-corp the iframe
// renders blank. The in-flight view doesn't need SharedArrayBuffer, so it's
// safe to drop COEP for this route.
export async function onRequest(context, next) {
  const response = await next();
  if (context.url.pathname.startsWith("/test/in-flight")) {
    return response;
  }
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return response;
}
