// Run from server/ after `yarn build`: node --test tests/paescape-lease-liveness.test.cjs
//
// The platform treats a lease renewal as the world's liveness signal: the
// renewal refreshes `worlds.last_heartbeat_at`, and a world whose heartbeat is
// older than 90 s is reported offline (platform/src/worlds.ts). Hosted servers
// used to renew only "shortly before the lease expires" - with a 15-minute
// lease that is roughly every 14 minutes - so a perfectly healthy world
// flapped to offline for most of every lease period and the website refused to
// let players join it.
//
// This pins the cadence contract without a live platform.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { leaseRenewalDelayMs, renewIntervalMs, PLATFORM_STALE_MS: pluginStaleMs } = require("../plugins/paescape/LeaseLiveness");

/** Mirrors platform/src/worlds.ts HEARTBEAT_STALE_MS. */
const PLATFORM_STALE_MS = 90_000;
const LEASE_TTL_MS = 15 * 60_000;

test("a hosted world renews well inside the platform's 90s liveness window", () => {
  const now = Date.now();
  const delay = leaseRenewalDelayMs(now + LEASE_TTL_MS, now);
  assert.ok(delay > 0, `delay is positive, got ${delay}`);
  assert.ok(
    delay < PLATFORM_STALE_MS,
    `renewal every ${delay}ms must be inside the ${PLATFORM_STALE_MS}ms stale window`,
  );
});

test("a renewal is always scheduled within the lease lifetime", () => {
  const now = Date.now();
  for (const ttl of [30_000, 60_000, 120_000, 300_000, LEASE_TTL_MS]) {
    const delay = leaseRenewalDelayMs(now + ttl, now);
    assert.ok(delay > 0, `ttl ${ttl}: delay is positive, got ${delay}`);
    assert.ok(delay <= Math.max(15_000, ttl - 60_000), `ttl ${ttl}: delay ${delay} leaves room before expiry`);
  }
});

test("a missing or already-expired lease still schedules a retry", () => {
  const now = Date.now();
  assert.ok(leaseRenewalDelayMs(undefined, now) > 0, "missing expiry still schedules a retry");
  assert.ok(leaseRenewalDelayMs(now - 60_000, now) > 0, "an expired lease still schedules a retry");
});

test("an override may only shorten the cadence, never cross the offline window", () => {
  const previous = process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS;
  try {
    // A test/development override lets the cadence be observed quickly.
    process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS = "2000";
    assert.equal(renewIntervalMs(), 2000);
    // A hostile or mistaken override cannot push the cadence past the window.
    process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS = String(pluginStaleMs * 10);
    assert.ok(renewIntervalMs() < pluginStaleMs, "an oversized override stays inside the offline window");
    // It cannot become a busy loop either.
    process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS = "0";
    assert.ok(renewIntervalMs() >= 1000, "a zero override is clamped to a safe floor");
  } finally {
    if (previous === undefined) delete process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS;
    else process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS = previous;
  }
});

test("a short override still schedules promptly without spinning", () => {
  const previous = process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS;
  try {
    process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS = "2000";
    const now = Date.now();
    const delay = leaseRenewalDelayMs(now + LEASE_TTL_MS, now);
    assert.ok(delay > 0 && delay <= 2000, `a 2000ms cadence schedules within 2000ms, got ${delay}`);
    // Near expiry the soonest-but-safe delay still applies.
    const tight = leaseRenewalDelayMs(now + 30_000, now);
    assert.ok(tight > 0, "a nearly-expired lease still schedules a retry");
  } finally {
    if (previous === undefined) delete process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS;
    else process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS = previous;
  }
});
