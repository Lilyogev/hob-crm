/**
 * Security headers applied to every Worker response (wired in src/server.ts).
 *
 * The CSP is deliberately permissive where the app needs it: inline scripts
 * (the boot watchdog in __root.tsx, the public collab/delivery pages),
 * Google Fonts, Shopify CDN images, and reels streamed from /media. What it
 * closes: scripts from any other origin, framing by other sites, and form
 * posts leaving the site — so an injected string on a public page cannot
 * pull in a remote script or ship the board cookie elsewhere.
 */
export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  // עמוד בארגז חול (/p/, HTML שמודל כתב) מביא CSP מחמיר משלו: לא דורסים אותו בכללי.
  const own = headers.get("Content-Security-Policy");
  if (!own || !/^\s*sandbox\b/.test(own)) headers.set(
    "Content-Security-Policy",
    "default-src 'self'; " +
      // cloudflareinsights = the Web Analytics beacon Cloudflare injects itself.
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' data: https://fonts.gstatic.com; " +
      "img-src 'self' data: blob: https:; " +
      "media-src 'self' blob: https:; " +
      "connect-src 'self' https:; " +
      "frame-ancestors 'self'; " +
      "base-uri 'self'; " +
      "form-action 'self'; " +
      "object-src 'none'",
  );
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // microphone=(self): the voice button in Hobi's chat.
  headers.set("Permissions-Policy", "geolocation=(), microphone=(self)");
  headers.set("X-XSS-Protection", "0");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
