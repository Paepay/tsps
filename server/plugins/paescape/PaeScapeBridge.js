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
 */

let access = null;

/** Publish the platform accessors (called once, by the PaeScape plugin). */
function setPlatformAccess(value) {
  access = value && typeof value === "object" ? value : null;
}

/** The published accessors, or null when the PaeScape plugin is not loaded. */
function getPlatformAccess() {
  return access;
}

module.exports = { setPlatformAccess, getPlatformAccess };
