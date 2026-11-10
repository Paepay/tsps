"use strict";

/**
 * Bot-side view of the hosted-world authorization gate.
 *
 * The player-bot system spawns at server startup and its name checks call
 * `persistence.exists`, which on a hosted world with no platform lease fails
 * closed and throws `PersistenceFailure` - crashing the server before enrollment
 * can finish. This wrapper defers that startup work until the PaeScape plugin
 * reports a valid lease.
 *
 * It is deliberately tolerant: when the PaeScape integration is not present (a
 * standalone build still ships it, but a fork might not), every function degrades
 * to "not hosted / run now", so bots behave exactly as they always did.
 */

let gate = null;
let gateLoaded = false;

function loadGate() {
  if (gateLoaded) return gate;
  gateLoaded = true;
  try {
    gate = require("../../paescape/AuthorizationGate.js");
  } catch {
    gate = null;
  }
  return gate;
}

/** Whether bots must wait for platform authorization before starting. */
function isBlocked() {
  const g = loadGate();
  try {
    return g ? g.isBlocked() : false;
  } catch {
    return false;
  }
}

/**
 * Run `callback` once the world is allowed to spawn bots: immediately when not
 * hosted or already authorized, otherwise when authorization arrives. Guaranteed
 * to run at most once. Returns a cancel function.
 */
function whenAuthorized(callback) {
  if (typeof callback !== "function") return () => {};
  const g = loadGate();
  if (g && typeof g.whenAuthorized === "function") {
    try {
      return g.whenAuthorized(callback);
    } catch {
      /* fall through to running immediately */
    }
  }
  callback();
  return () => {};
}

/** Test seam: replace the gate module (undefined restores the real lookup). */
function setGate(value) {
  gate = value === undefined ? null : value;
  gateLoaded = true;
}

module.exports = { isBlocked, whenAuthorized, setGate };
