"use strict";

/**
 * Platform base-URL normalisation, shared by the PaeScape world plugin and the
 * release packaging so the two never disagree about where the platform lives.
 *
 * The website serves the platform behind a public path prefix (Vite proxies
 * `/platform`, and the production reverse proxy routes `/platform/*` to the
 * platform service). A configured platform URL may therefore be a bare origin
 * (`https://paescape.online`), an origin that already carries the prefix
 * (`https://paescape.online/platform`), or an explicit development/alternative
 * base. This module turns any of those into the single base every world-to-platform
 * call is appended to (`/api/server/...`, `/api/platform/public-key`, ...), so a
 * bare origin gains the prefix exactly once and an already-prefixed URL is never
 * double-prefixed.
 */

/** The public path the website mounts the platform under, unless overridden. */
const DEFAULT_PUBLIC_PATH = "/platform";

/** Normalise a path fragment to either "" (root) or "/segment[/segment...]". */
function normalisePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "/") return "";
  const withLead = raw.startsWith("/") ? raw : `/${raw}`;
  return withLead.replace(/\/+$/, "");
}

/**
 * The public path prefix to use: an explicit override wins, then the environment
 * (`PAESCAPE_PLATFORM_PUBLIC_PATH`, then the platform's own `PLATFORM_PUBLIC_PATH`),
 * then the default `/platform`.
 */
function resolvePublicPath(explicit) {
  // An explicit value (including "" meaning the origin root) wins over the environment.
  if (explicit !== undefined && explicit !== null) {
    return normalisePath(explicit);
  }
  try {
    const env = process.env || {};
    // A defined-but-empty value means "mount at the origin root": honour it, do not
    // fall through to the default.
    if (env.PAESCAPE_PLATFORM_PUBLIC_PATH !== undefined) return normalisePath(env.PAESCAPE_PLATFORM_PUBLIC_PATH);
    if (env.PLATFORM_PUBLIC_PATH !== undefined) return normalisePath(env.PLATFORM_PUBLIC_PATH);
  } catch {
    /* no process.env (bundled/obfuscated context): fall through to the default */
  }
  return DEFAULT_PUBLIC_PATH;
}

/**
 * Turn a configured platform URL into the single base API paths are appended to.
 *
 *   normalisePlatformBase("https://paescape.online")                     -> "https://paescape.online/platform"
 *   normalisePlatformBase("https://paescape.online/platform")            -> "https://paescape.online/platform"
 *   normalisePlatformBase("https://paescape.online/platform/")           -> "https://paescape.online/platform"
 *   normalisePlatformBase("http://localhost:5176")                       -> "http://localhost:5176/platform"
 *   normalisePlatformBase("https://dev.example.test/custom")             -> "https://dev.example.test/custom"
 *   normalisePlatformBase("")                                            -> ""
 *
 * A bare origin gains the public path; a URL that already ends in it is left
 * alone; an explicit alternative path is preserved as-is. The result never ends
 * in a slash, so `base + "/api/..."` has exactly one separator.
 */
function normalisePlatformBase(raw, options = {}) {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return "";
  const prefix = resolvePublicPath(options.publicPath);
  let parsed;
  try {
    parsed = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    // Not a parseable URL: hand the trimmed value back unchanged rather than guess.
    return value;
  }
  const origin = parsed.origin;
  const existing = parsed.pathname.replace(/\/+$/, "");
  if (!existing) return origin + prefix;
  // Already carries the prefix (exactly, or as a leading segment): normalise only.
  if (prefix && (existing === prefix || existing.startsWith(`${prefix}/`))) {
    return origin + existing;
  }
  // An explicit alternative path (development / custom deployment): keep it.
  return origin + existing;
}

module.exports = { DEFAULT_PUBLIC_PATH, normalisePath, resolvePublicPath, normalisePlatformBase };
