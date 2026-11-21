/** The cleaning-area gate's Museum guard transcript and per-login admission. */
const { startTranscript } = require("../quests/QuestRuntime");
const ENTER_STEP = "AFy65N";
const PAGE = "Museum guard";
const GATE_X = 3261;
const GATE_Y = 3446;
const HALL_Y = 3447;
const CLEANING_Y = 3445;
const CLEANING = Object.freeze({ x: 3259, y: CLEANING_Y, z: 0 });
const BEFORE = "museum-gate-dialogue-before-completing-the-dig-site";
const FIRST = "museum-gate-first-dialogue-after-login-with-the-dig-site-completed";
const askedThisSession = new WeakSet();
const pending = new WeakMap();
let api, core, gateId, guardId;

function completed(player) {
  const request = { player, key: "the_dig_site", complete: false };
  api.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

function atDoor(player, y) {
  const at = player.getLocation();
  return at.getX() === GATE_X && at.getY() === y && at.getZ() === 0 && !player.getPrivateArea();
}

/** The guard's own tile and the tiles beside it: a Talk-to Yes is allowed from this small area. */
function atGuard(player) {
  const at = player.getLocation();
  return Math.abs(at.getX() - GATE_X) <= 2 && Math.abs(at.getY() - GATE_Y) <= 1
    && at.getZ() === 0 && !player.getPrivateArea();
}

function play(player, variant) {
  startTranscript(api, player, guardId, PAGE, variant);
}

function enter(player, object) {
  const request = { player, object, handled: false };
  api.emitCustomEvent("door:open", request);
}

/** Yes moves the player straight into the cleaning finds area, as the transcript action says. */
function letIn(player) {
  player.moveTo(new core.Location(CLEANING.x, CLEANING.y, CLEANING.z));
}

/** The north-south gate row needs its own-tile route from the cleaning side as well as the hall. */
function routeGate(event) {
  if (event.objectId !== gateId) return;
  const at = event.sourceLocation;
  if (Math.abs(at.x - GATE_X) > 1 || Math.abs(at.y - GATE_Y) > 1 || at.z !== 0) return;
  event.destination = { x: at.x, y: at.y, z: at.z };
}

function buildVariant({ player, npcId }) {
  if (npcId !== guardId) return null;
  if (!completed(player)) return BEFORE;
  askedThisSession.add(player);
  pending.delete(player);
  return FIRST;
}

function useGate(event) {
  const { player, object, objectId } = event;
  const at = object?.getLocation();
  if (event.handled || objectId !== gateId || at?.getX() !== GATE_X
      || ![GATE_Y, HALL_Y].includes(at.getY()) || at.getZ() !== 0) return;
  pending.delete(player);
  if (atDoor(player, GATE_Y) || atDoor(player, CLEANING_Y)) return; // Leaving is free.
  event.handled = true;
  if (!atDoor(player, HALL_Y)) return;
  if (!core.WorldDefinition.isMembersWorld()) { play(player, "standard-free-to-play-dialogue"); return; }
  if (!completed(player)) { play(player, BEFORE); return; }
  if (askedThisSession.has(player)) { enter(player, object); return; }
  askedThisSession.add(player);
  pending.set(player, object);
  play(player, FIRST);
}

function accept(event) {
  if (event.handled || event.npcId !== guardId || event.stepId !== ENTER_STEP) return;
  const { player } = event, object = pending.get(player);
  pending.delete(player);
  if (!core.WorldDefinition.isMembersWorld() || !completed(player)) return;
  event.handled = true;
  if (object ? !atDoor(player, HALL_Y) : !atGuard(player)) return;
  event.end = true;
  askedThisSession.add(player);
  if (object) enter(player, object);
  letIn(player);
}

function logout({ player }) { askedThisSession.delete(player); pending.delete(player); }

module.exports = {
  name: "MuseumEntrance",
  description: "Guards entry to the Varrock Museum cleaning area, including on free worlds.",
  register(pluginApi) {
    api = pluginApi;
    core = api.core;
    gateId = core.CacheDefinitions.getLocId("vm_barrier_guard_gate");
    guardId = core.NpcIdentifiers.MUSEUM_GUARD;
    api.onCustomEvent("door:toggle", useGate);
    api.onNpcDialogueVariant(buildVariant);
    api.onCustomEvent("npc-dialogue:action", accept);
    api.onObjectRoute(routeGate);
    api.onPlayerLogout(logout);
  },
};
