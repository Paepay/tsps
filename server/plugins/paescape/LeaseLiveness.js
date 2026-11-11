/**
 * Lease-renewal cadence for a hosted world.
 *
 * The platform treats a lease renewal as the world's liveness signal: the
 * renewal refreshes `worlds.last_heartbeat_at`, and a world whose heartbeat is
 * older than 90 s (platform/src/worlds.ts `HEARTBEAT_STALE_MS`) is reported
 * offline and offered no login tickets. A hosted server therefore has to renew
 * on a short fixed cadence, not merely "shortly before the lease expires":
 * with the 15-minute lease TTL that older schedule renewed roughly every 14
 * minutes, so a healthy world flapped offline for most of every lease period.
 *
 * Kept dependency-free so the cadence contract can be unit-tested without
 * loading the game engine.
 */

/** How often a hosted world renews its lease. Must stay inside the 90 s window. */
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 30_000;

/** A renewal older than this makes the platform report the world offline. */
const PLATFORM_STALE_MS = 90_000;

/** A hard floor so a bad override cannot turn the renewal timer into a busy loop. */
const MIN_RENEW_INTERVAL_MS = 1_000;

/**
 * The effective renewal interval. It is overridable for tests and development
 * (`PAESCAPE_LEASE_RENEW_INTERVAL_MS`) but clamped strictly below the platform's
 * staleness window, so no override can ever let a healthy world go stale. An
 * override may only ever shorten the cadence; the default is 30 s.
 */
function renewIntervalMs() {
  const raw = Number(process.env && process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS);
  if (!Number.isFinite(raw)) return DEFAULT_LEASE_RENEW_INTERVAL_MS;
  return Math.min(Math.max(raw, MIN_RENEW_INTERVAL_MS), PLATFORM_STALE_MS - 1);
}

/**
 * When the next renewal should run, in milliseconds.
 *
 * Always short enough that the platform never sees the world as stale, and
 * never later than one minute before the lease would expire. A missing or
 * already-expired lease still yields a positive retry delay so the renewal
 * loop never dies.
 */
function leaseRenewalDelayMs(expiresAt, now = Date.now()) {
  const interval = renewIntervalMs();
  const untilExpiry = (Number(expiresAt) || now) - now;
  // The usable ceiling is the interval, or sooner when the lease is nearly up;
  // the floor keeps a superseded (missing/expired) lease retrying rather than
  // spinning, and shrinks with the interval so a short test cadence still fires.
  const ceiling = Math.min(interval, untilExpiry - 60_000);
  return Math.max(Math.min(15_000, interval), ceiling);
}

module.exports = {
  DEFAULT_LEASE_RENEW_INTERVAL_MS,
  LEASE_RENEW_INTERVAL_MS: DEFAULT_LEASE_RENEW_INTERVAL_MS,
  PLATFORM_STALE_MS,
  renewIntervalMs,
  leaseRenewalDelayMs,
};
