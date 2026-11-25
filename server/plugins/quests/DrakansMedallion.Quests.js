/**
 * Drakan's medallion's destinations when Quests is off.
 *
 * QuestAutoComplete loads Sins of the Father and The Blood Moon Rises only for their
 * definitions, so their "drakan-medallion:destinations" hooks are never registered and the
 * medallion offers only Ver Sinhaza. On a Quests-off world every quest counts complete, so
 * both post-quest destinations are unlocked. Slepe's tablet is not a quest reward, but these
 * worlds are meant to expose the whole medallion menu, so the login opens it too.
 *
 * The tiles mirror SinsOfTheFather.Quest.js's DARKMEYER_MEDALLION_TILE and
 * TheBloodMoonRises.Quest.js's CASTLE_TELEPORT_TILE.
 */
const SLEPE_UNLOCKED_ATTRIBUTE = "drakans-medallion:slepe-unlocked";
const DESTINATIONS_EVENT = "drakan-medallion:destinations";
const QUEST_DESTINATIONS = Object.freeze([
  Object.freeze({ label: "Darkmeyer", tile: Object.freeze({ x: 3592, y: 3337, z: 0 }) }),
  Object.freeze({ label: "Castle Drakan", tile: Object.freeze({ x: 3166, y: 7711, z: 0 }) }),
]);

function addQuestDestinations(event) {
  if (!Array.isArray(event?.destinations)) return;
  for (const destination of QUEST_DESTINATIONS) {
    event.destinations.push({ label: destination.label, tile: { ...destination.tile } });
  }
}

function unlockSlepe({ player } = {}) {
  if (!player || player.isPlayerBot?.() || player.getAttribute(SLEPE_UNLOCKED_ATTRIBUTE) === true) return;
  player.setAttribute(SLEPE_UNLOCKED_ATTRIBUTE, true);
}

function register(api) {
  api.onCustomEvent(DESTINATIONS_EVENT, addQuestDestinations);
  api.onPlayerLogin(unlockSlepe);
  api.onCustomEvent("player:bootstrap-complete", unlockSlepe);
}

module.exports = {
  register,
  addQuestDestinations,
  unlockSlepe,
  QUEST_DESTINATIONS,
  SLEPE_UNLOCKED_ATTRIBUTE,
};
