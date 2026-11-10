"use strict";

/**
 * Hosted-world authorization gate.
 *
 * A distributed server.exe is a hosted world: the platform owns character
 * persistence, so nothing may read or write a character until the enrollment
 * handshake has yielded a valid authorization lease. The player-bot system,
 * however, spawns at server startup and its name checks call
 * `persistence.exists` - which, on a hosted world with no lease, fails closed and
 * throws `PersistenceFailure`, crashing the server before enrollment can finish.
 *
 * This gate lets plugins that would otherwise run too early wait for
 * authorization. It is deliberately tiny and has no PaeScape dependency of its
 * own: it reads hosted mode from the same source the persistence adapter uses
 * (`PaeScapePersistenceMode`), and authorization state from the shared bridge
 * (`PaeScapeBridge`), which the PaeScape plugin drives.
 *
 * Standalone worlds (no platform URL, or a configured world secret) are never
 * gated: bots start immediately, exactly as before. A hosted world starts its
 * bots the moment it is authorized, and never a second time on a later lease
 * renewal.
 */

const bridge = require("./PaeScapeBridge.js");

let hostedProbe = null;

/** Whether this world is a hosted world that must be authorized before operating. */
function isHosted() {
  if (hostedProbe === null) {
    try {
      const { isHostedPersistence } = require("../persistence/PaeScapePersistenceMode.js");
      hostedProbe = typeof isHostedPersistence === "function" ? isHostedPersistence() : false;
    } catch {
      // The persistence adapter is not present in this deployment: not hosted.
      hostedProbe = false;
    }
  }
  return hostedProbe === true;
}

/** Whether the gate is currently blocking (hosted and not yet authorized). */
function isBlocked() {
  return isHosted() && !bridge.isAuthorized();
}

/**
 * Invoke `callback` as soon as this world may operate:
 *   - standalone: immediately;
 *   - hosted and already authorized: immediately;
 *   - hosted and not yet authorized: when the PaeScape plugin reports a lease.
 *
 * Returns a cancel function. The callback is guaranteed to run at most once for a
 * given call, so a later lease renewal (which does not change authorization) can
 * never trigger a duplicate start.
 */
function whenAuthorized(callback) {
  if (typeof callback !== "function") return () => {};
  let done = false;
  let unsubscribe = null;
  const fire = () => {
    if (done) return;
    done = true;
    if (unsubscribe) unsubscribe();
    callback();
  };
  if (!isBlocked()) {
    fire();
    return () => {};
  }
  unsubscribe = bridge.onAuthorizationChange((authorized) => {
    if (authorized) fire();
  });
  return () => {
    done = true;
    if (unsubscribe) unsubscribe();
  };
}

/** Test seam: force the hosted probe (undefined resets it). */
function setHostedProbe(value) {
  hostedProbe = value === undefined ? null : value;
}

module.exports = { isHosted, isBlocked, whenAuthorized, setHostedProbe };
