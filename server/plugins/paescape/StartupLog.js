"use strict";

/**
 * Startup logging helpers shared by the PaeScape world plugin.
 *
 * A distributed server.exe prints a running commentary while it enrolls and
 * authenticates. Two rules make that commentary useful to the world owner:
 *
 *   - every line carries a local wall-clock timestamp, so the launcher's lines
 *     (the batch file) and the server's lines interleave as one timeline;
 *   - no line ever contains a secret. The platform issues installation
 *     credentials (wsi_), nonces, lease tokens, login tickets and bearer tokens;
 *     none of them may reach the console or logs, so every message is passed
 *     through redact() before it is printed.
 *
 * The numbered startup stages are numbered once here (and named identically in
 * the launcher, server/scripts/release/StartServer.bat) so the two processes
 * agree on what "stage 5/7" means:
 *   1 launcher: release manifest and signature validation
 *   2 launcher: download, resume and hash verification (and install)
 *   3 server:   cache revision check
 *   4 server:   platform connectivity and public-key retrieval
 *   5 server:   world authentication / enrollment
 *   6 server:   handshake and lease
 *   7 server:   world readiness and bot initialization
 */

/** Placeholders matched by redact() are replaced with this sentinel. */
const REDACTED = "<redacted>";

/**
 * Strip anything that could be a credential from an arbitrary log message.
 * Tolerates undefined/null and non-string values (numbers, errors) by coercion.
 */
function redact(value) {
  if (value === undefined || value === null) return value;
  let text = String(value);
  // A bearer token anywhere in the text.
  text = text.replace(/(bearer\s+)[A-Za-z0-9._\-]+/gi, `$1${REDACTED}`);
  // The platform's own credential prefixes: installation key (wsk_), installation
  // credential (wsi_), and lease/ticket tokens (wsm_/wst_).
  text = text.replace(/\bws[ikmt]_[A-Za-z0-9_\-]{6,}/g, `ws_${REDACTED}`);
  // Credential-shaped query parameters.
  text = text.replace(
    /([?&](?:token|secret|key|ticket|credential|password|code)=)[^&\s'"]+/gi,
    `$1${REDACTED}`,
  );
  return text;
}

/** Local wall-clock HH:MM:SS. */
function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The standard `[HH:MM:SS] [paescape] ...` prefix, with the body redacted. */
function line(level, message) {
  const tag = level && level !== "log" ? ` [${level}]` : "";
  return `[${timestamp()}] [paescape]${tag} ${redact(message)}`;
}

/** A numbered startup-stage announcement line. */
function stageLine(number, name) {
  return `[${timestamp()}] [paescape] [stage ${number}/7] ${name}`;
}

/**
 * Run one platform request with a bounded lifetime and merge an optional caller
 * signal into it. A platform (or a host's network) that accepts the connection
 * and then never answers must not stall startup stages 4-7 forever: the request
 * is aborted after `timeoutMs` and the caller sees a plain transport error it can
 * report and retry. Extracted here (rather than inline in the plugin) so it is
 * unit-tested without a running server or a live platform.
 */
async function boundedFetch(url, { timeoutMs = 30000, signal, fetchImpl = globalThis.fetch, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  const forward = signal ? () => controller.abort() : null;
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forward, { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    // Distinguish our own deadline from the caller's cancellation and from a real
    // transport error (DNS, refused connection), so the console says which.
    if (controller.signal.aborted && !(signal && signal.aborted)) {
      const failure = new Error(`the platform did not answer within ${Math.round(timeoutMs / 1000)} s (${url})`);
      failure.name = "PlatformTimeoutError";
      failure.code = "PLATFORM_TIMEOUT";
      throw failure;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && forward) signal.removeEventListener("abort", forward);
  }
}

module.exports = { REDACTED, redact, timestamp, line, stageLine, boundedFetch };
