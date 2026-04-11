// Set COOP/COEP on every dev response so the /play/ page can host a
// cross-origin-isolated iframe (required for Godot HTML5's SharedArrayBuffer).
// In prod these headers come from CloudFront; this middleware is a dev-only
// parity layer (SSG builds strip middleware).
export async function onRequest(context, next) {
  const response = await next();
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return response;
}
