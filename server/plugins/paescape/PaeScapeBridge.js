"use strict";

/**
 * A tiny shared hand-off between the PaeScape world plugin and the PaeScape
 * persistence adapter.
 *
 * The two are separate plugins with no guaranteed load order, and the adapter
 * needs the platform origin and a live lease token that only the PaeScape plugin
 * holds. Rather than reach into each other's module state, the PaeScape plugin
 * publishes accessor functions here at registration time and the persistence
 * adapter reads them lazily when a login or a save actually happens (long after
 * startup). Reading through closures means the adapter always sees the current
 * lease, including one obtained after the enrollment handshake finished.
 *
 * The bridge also carries the hosted-world authorization state: whether this
 * world must be authorized with the platform before it may operate (a hosted
 * world with a platform URL and no world secret). The PaeScape plugin marks it
 * authorized once the enrollment handshake yields a lease, and unauthorized when
 * the lease is lost. Plugins that would otherwise run before authorization (the
 * player-bot system) wait on this instead of touching platform-backed
 * persistence too early, which previously crashed the server on startup.
 */

let access = null;
let authorized = false;
const authorizationListeners = new Set();

/** Publish the platform accessors (called once, by the PaeScape plugin). */
function setPlatformAccess(value) {
  access = value && typeof value === "object" ? value : null;
  // Only lose authorization when the bridge itself is withdrawn; a re-publish must
  // not reset a lease the plugin already obtained.
  if (!access) setAuthorized(false);
}

/** The published accessors, or null when the PaeScape plugin is not loaded. */
function getPlatformAccess() {
  return access;
}

/**
 * Record whether the hosted world currently holds a valid platform authorization
 * lease. Fires listeners only on a change, so a routine lease renewal does not
 * re-notify and a one-shot bot start cannot fork.
 */
function setAuthorized(value) {
  const next = Boolean(value);
  if (next === authorized) return;
  authorized = next;
  for (const listener of [...authorizationListeners]) {
    try {
      listener(authorized);
    } catch {
      /* a listener must never break the authorization transition */
    }
  }
}

/** Whether the hosted world currently holds a valid platform authorization lease. */
function isAuthorized() {
  return authorized;
}

/** Subscribe to authorization changes; returns an unsubscribe function. */
function onAuthorizationChange(listener) {
  if (typeof listener !== "function") return () => {};
  authorizationListeners.add(listener);
  return () => authorizationListeners.delete(listener);
}

module.exports = { setPlatformAccess, getPlatformAccess, setAuthorized, isAuthorized, onAuthorizationChange };
