"use strict";

/**
 * Red chinchompa hunting ground (https://oldschool.runescape.wiki/w/Red_chinchompa_hunting_ground):
 * the cave south of the Feldip Hills hunting area. Its entrance (19039, 2525,2893) and the
 * dungeon's exit (19037, 2533,9293) are both cache scenery with no destination of their own.
 * Entry needs the hard Western Provinces Diary; the Hunting expert (5529) beside the entrance
 * refuses players who lack it with the transcript variant named below.
 */
const ENTRANCE = 19039;
const EXIT = 19037;
/** Walkable tiles beside each cave; the caves themselves fill their footprints. */
const LANDING_INSIDE = [2532, 9294, 0];
const LANDING_OUTSIDE = [2527, 2894, 0];
const GUARD = 5529;
const REFUSAL_VARIANT = "standard-dialogue-attempting-to-enter-the-red-chinchompa-hunting-ground-without-having-the-requirements";
const DIARY_COMPLETE = "If the player has completed the hard tier of the Western Provinces achievement diary:";
const DIARY_INCOMPLETE = "If the player has not completed the hard tier of the Western Provinces achievement diary:";

let api;
let core;

function hardDiary(player) {
  const request = { player, diary: "western", tier: "hard", complete: null };
  api.emitCustomEvent("diary:is-complete", request);
  return request.complete === true;
}

function refuse(player) {
  api.emitCustomEvent("npc-dialogue:start", {
    player, npcId: GUARD, variant: REFUSAL_VARIANT, exact: true,
  });
}

function enter({ player, objectId }) {
  if (objectId !== ENTRANCE) return false;
  if (!hardDiary(player)) {
    refuse(player);
    return true;
  }
  player.moveTo(new core.Location(...LANDING_INSIDE));
  return true;
}

function exit({ player, objectId }) {
  if (objectId !== EXIT) return false;
  player.moveTo(new core.Location(...LANDING_OUTSIDE));
  return true;
}

function condition({ player, npcId, text }) {
  if (npcId !== GUARD) return null;
  if (text === DIARY_COMPLETE) return hardDiary(player);
  if (text === DIARY_INCOMPLETE) return !hardDiary(player);
  return null;
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  pluginApi.onObjectInteraction("Cave", { Enter: enter, Exit: exit });
  pluginApi.onNpcDialogueCondition(condition);
}

module.exports = {
  ENTRANCE, EXIT, LANDING_INSIDE, LANDING_OUTSIDE, GUARD,
  REFUSAL_VARIANT, DIARY_COMPLETE, DIARY_INCOMPLETE,
  enter, exit, condition, attach,
};
