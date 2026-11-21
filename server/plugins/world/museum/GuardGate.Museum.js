/**
 * Varrock Museum cleaning area: the guard at the barrier gate and the gate itself.
 *
 * Wiki (Museum guard, Transcript:Museum guard): the Dig Site cleaning area is entered
 * through the single Open-only gate 24536 (vm_barrier_guard_gate) in the barrier row at
 * 3261,3446. Before The Dig Site the guard (NPC 1910) says "You're not permitted in this
 * area." Once the quest is complete, the first time the player tries to enter after logging
 * in he asks whether they would like to go into the cleaning area; "Yes, I'll go in!" lets
 * them in (the transcript's action step AFy65N). The 2019 QoL change note says he asks only
 * on the first session, so afterwards the gate itself opens like any other gate.
 *
 * The cache places 24537/24538 (vm_barrier_extra/_m) beside the gate; they are actionless
 * barrier pieces, not the gate's open leaf, which is why Doors.plugin's catalog cannot pair
 * 24536 and its generic handler does nothing. The pass-through entry in Doors.plugin opens
 * the leaf into the cleaning room, lets the opener step across and shuts it two ticks later.
 */
"use strict";

const GUARD_ID = 1910;
const GATE_ID = 24536;
const DIG_SITE_KEY = "the_dig_site";
const INSIDE = Object.freeze({ x: 3259, y: 3445, z: 0 });
const VARIANT = Object.freeze({
  BEFORE: "museum-gate-dialogue-before-completing-the-dig-site",
  FIRST: "museum-gate-first-dialogue-after-login-with-the-dig-site-completed",
});
/** The "Yes, I'll go in!" option: "The player is let into the cleaning finds area." */
const LET_IN_STEP = "AFy65N";

let api, core;
/** Players already asked this login: later gate clicks open it without the guard's question. */
const askedThisSession = new WeakSet();

function digSiteComplete(player) {
  const request = { player, key: DIG_SITE_KEY, complete: null };
  api.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

function startDialogue(player, variant) {
  api.emitCustomEvent("npc-dialogue:start", {
    player, npc: null, npcId: GUARD_ID, variant, exact: true, handled: false,
  });
}

function guardVariant({ player, npcId }) {
  if (npcId !== GUARD_ID) return null;
  if (!digSiteComplete(player)) return VARIANT.BEFORE;
  askedThisSession.add(player);
  return VARIANT.FIRST;
}

/** Doors emits this before its own opening. The guard owns the first entry of the session. */
function guardGate(request) {
  if (request.objectId !== GATE_ID || !request.player) return;
  if (!digSiteComplete(request.player)) {
    request.handled = true;
    startDialogue(request.player, VARIANT.BEFORE);
    return;
  }
  if (askedThisSession.has(request.player)) return;
  askedThisSession.add(request.player);
  request.handled = true;
  startDialogue(request.player, VARIANT.FIRST);
}

/**
 * The gate is a face-1 wall loc, so the usual route only accepts the hall side. A player on the
 * cleaning side is already beside it: use their own tile as the approach.
 */
function routeGate(event) {
  if (event.objectId !== GATE_ID) return;
  const at = event.sourceLocation;
  if (Math.abs(at.x - 3261) > 1 || Math.abs(at.y - 3446) > 1 || at.z !== 0) return;
  event.destination = { x: at.x, y: at.y, z: at.z };
}

/** "Yes, I'll go in!": the player is let into the cleaning finds area. */
function letIn(event) {
  if (event.npcId !== GUARD_ID || event.stepId !== LET_IN_STEP) return;
  event.handled = true;
  event.end = true;
  askedThisSession.add(event.player);
  event.player.moveTo(new core.Location(INSIDE.x, INSIDE.y, INSIDE.z));
}

function forgetSession({ player }) {
  askedThisSession.delete(player);
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  pluginApi.onNpcDialogueVariant(guardVariant);
  pluginApi.onCustomEvent("door:toggle", guardGate);
  pluginApi.onCustomEvent("npc-dialogue:action", letIn);
  pluginApi.onObjectRoute(routeGate);
  pluginApi.onPlayerLogin(forgetSession);
  pluginApi.onPlayerLogout(forgetSession);
};

module.exports._test = { GUARD_ID, GATE_ID, VARIANT, LET_IN_STEP, INSIDE, guardVariant, guardGate, routeGate, letIn, digSiteComplete };
