/**
 * The Bamboo Gate on Ape Atoll when Quests is off.
 *
 * QuestAutoComplete marks Monkey Madness I complete, but MonkeyMadnessI.Quest's object hooks are
 * registered through a definition-only proxy, so its gate handler never exists. The gate itself
 * is a normal door once the quest is done: a human walks through, and the monkey archers no
 * longer jail them. Only the two cache leaves (4787/4788) at 2720,2766 are involved.
 */
const BAMBOO_GATE_SOUTH = { x: 2720, y: 2765, z: 0 };
const BAMBOO_GATE_NORTH = { x: 2720, y: 2767, z: 0 };

let api;

function openGate({ player }) {
  if (!player) return;
  const location = player.getLocation();
  const north = location.getY() >= BAMBOO_GATE_NORTH.y;
  player.moveTo(new api.core.Location(north ? BAMBOO_GATE_SOUTH.x : BAMBOO_GATE_NORTH.x,
    north ? BAMBOO_GATE_SOUTH.y : BAMBOO_GATE_NORTH.y, north ? BAMBOO_GATE_SOUTH.z : BAMBOO_GATE_NORTH.z));
}

module.exports = {
  name: "ApeAtollGate",
  description: "Opens Ape Atoll's Bamboo Gate on a Quests-off world, where Monkey Madness I counts as complete.",
  members: true,
  register(pluginApi) {
    api = pluginApi;
    pluginApi.onObjectInteraction("Bamboo Gate", { Open: openGate });
  },
  _test: { openGate, BAMBOO_GATE_SOUTH, BAMBOO_GATE_NORTH },
};