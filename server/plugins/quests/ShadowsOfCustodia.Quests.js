/**
 * Shadows of Custodia's Stalker Den entrance when Quests is off.
 *
 * QuestAutoComplete marks the quest complete (stage 24), but ShadowsOfCustodia.Quest's object
 * hooks are registered through a definition-only proxy, so its main Cave never moves the player.
 * The den's map is a normal area (the quest's private scene only carried the cutscene), so the
 * main entrance and exit use the same DEN_LANDING and CAVE_MOUTH tiles as the quest module.
 *
 * The southern crawling shortcut (57278/57279) is owned by the Agility plugin and asks
 * "quest:is-complete"; QuestAutoComplete answers that, so it needs no shim here.
 */
const CAVE_ENTER_OBJECT_ID = 56439; // "Cave" Enter at 1295,3373
const CAVE_EXIT_OBJECT_ID = 56440; // "Cave" Exit at 1295,9768
const DEN_LANDING = { x: 1296, y: 9767, z: 0 };
const CAVE_MOUTH = { x: 1295, y: 3376, z: 0 };

let api;

function enterDen({ player, objectId }) {
  // Other "Cave" objects share the name: leave them to their own handler.
  if (!player || objectId !== CAVE_ENTER_OBJECT_ID) return false;
  player.moveTo(new api.core.Location(DEN_LANDING.x, DEN_LANDING.y, DEN_LANDING.z));
}

function leaveDen({ player, objectId }) {
  if (!player || objectId !== CAVE_EXIT_OBJECT_ID) return false;
  player.moveTo(new api.core.Location(CAVE_MOUTH.x, CAVE_MOUTH.y, CAVE_MOUTH.z));
}

module.exports = {
  name: "ShadowsOfCustodia",
  description: "Enters and leaves the Stalker Den through its main Cave on a Quests-off world, where Shadows of Custodia counts as complete.",
  members: true,
  register(pluginApi) {
    api = pluginApi;
    pluginApi.onObjectInteraction("Cave", { Enter: enterDen, Exit: leaveDen });
  },
  _test: { enterDen, leaveDen, CAVE_ENTER_OBJECT_ID, CAVE_EXIT_OBJECT_ID, DEN_LANDING, CAVE_MOUTH },
};
