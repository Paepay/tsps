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
const LEASE_RENEW_INTERVAL_MS = 30_000;

/**
 * When the next renewal should run, in milliseconds.
 *
 * Always short enough that the platform never sees the world as stale, and
 * never later than one minute before the lease would expire. A missing or
 * already-expired lease still yields a positive retry delay so the renewal
 * loop never dies.
 */
function leaseRenewalDelayMs(expiresAt, now = Date.now()) {
  const untilExpiry = (Number(expiresAt) || now) - now;
  return Math.max(15_000, Math.min(LEASE_RENEW_INTERVAL_MS, untilExpiry - 60_000));
}

module.exports = { LEASE_RENEW_INTERVAL_MS, leaseRenewalDelayMs };