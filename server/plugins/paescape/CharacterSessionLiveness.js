"use strict";

/**
 * Gameplay-session renewal cadence for a hosted world.
 *
 * The platform treats a character-session renewal as the lease's liveness
 * signal. A session whose last renewal is older than the reclaim window may be
 * reclaimed by a new login, so an active player must renew well inside that
 * window rather than only before the session expires.
 *
 * Kept dependency-free so the cadence contract can be unit-tested without
 * loading the game engine.
 */

/** The lease duration requested when a hosted world opens a player session. */
const DEFAULT_CHARACTER_SESSION_TTL_SECONDS = 900;

/** How often a hosted character session reports that it is still live. */
const DEFAULT_CHARACTER_SESSION_RENEW_INTERVAL_MS = 30_000;

/** The platform may reclaim a session with no heartbeat for this long. */
const PLATFORM_SESSION_RECLAIM_MS = 60_000;

/** A hard floor so a bad override cannot turn the renewal timer into a busy loop. */
const MIN_CHARACTER_SESSION_RENEW_INTERVAL_MS = 1_000;

/** The longest a failed renewal waits before trying again. */
const MAX_CHARACTER_SESSION_RETRY_MS = 30_000;

/**
 * The effective renewal interval. It is overridable for tests and development
 * (`PAESCAPE_CHARACTER_SESSION_RENEW_INTERVAL_MS`) but never reaches the
 * platform's reclaim window, so a healthy player can never look abandoned.
 */
function characterSessionRenewIntervalMs() {
  const raw = Number(process.env && process.env.PAESCAPE_CHARACTER_SESSION_RENEW_INTERVAL_MS);
  if (!Number.isFinite(raw)) return DEFAULT_CHARACTER_SESSION_RENEW_INTERVAL_MS;
  return Math.min(
    Math.max(Math.floor(raw), MIN_CHARACTER_SESSION_RENEW_INTERVAL_MS),
    PLATFORM_SESSION_RECLAIM_MS - 1,
  );
}

/**
 * Back off after a transient renewal failure, but stay short enough to recover
 * inside the reclaim window. Attempts are one-based: 5 s, 10 s, 20 s, then 30 s
 * at the production cadence.
 */
function characterSessionRetryDelayMs(attempt, intervalMs = characterSessionRenewIntervalMs()) {
  const interval = Math.max(1, Number(intervalMs) || DEFAULT_CHARACTER_SESSION_RENEW_INTERVAL_MS);
  const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const base = Math.min(5_000, Math.max(20, Math.floor(interval / 2)));
  const ceiling = Math.min(interval, MAX_CHARACTER_SESSION_RETRY_MS);
  return Math.min(ceiling, base * 2 ** (normalizedAttempt - 1));
}

/** Only the platform's explicit "session is gone" response ends a live player. */
function isAuthoritativeCharacterSessionRefusal(status) {
  return Number(status) === 409;
}

module.exports = {
  DEFAULT_CHARACTER_SESSION_TTL_SECONDS,
  DEFAULT_CHARACTER_SESSION_RENEW_INTERVAL_MS,
  PLATFORM_SESSION_RECLAIM_MS,
  characterSessionRenewIntervalMs,
  characterSessionRetryDelayMs,
  isAuthoritativeCharacterSessionRefusal,
};
