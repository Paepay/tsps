/**
 * The Crypt of Tonali's post-quest travel when Quests is off.
 *
 * The Final Dawn keeps the crypt's Strange Tiles and lift in its quest module. On a Quests-off
 * world only that module's definition is loaded, so the tiles never move the player and
 * vmq4_lift_activated (16694) is never set: the lift has no Use option and the Doom of Mokhaiotl
 * cannot be reached. Everything counts complete here, so the post-quest tile links are always
 * live and the lift is activated on login. The pairs, graphics and two-tick delay are the
 * quest's own captured values.
 */
const LIFT_VARBIT = 16694;
const LIFT_ATTRIBUTE = "the-final-dawn:lift-activated";
const STRANGE_TILE_DELAY = 2;
const STRANGE_TILE_SOUND = 4425;
const SUN_GRAPHIC = 3342;
const MOON_GRAPHIC = 3344;
const PAIRS = [
  [[1332, 9382, 0], [1328, 9379, 1]],
  [[1315, 9387, 0], [1319, 9384, 1]],
  [[1303, 9389, 0], [1298, 9383, 1]],
  [[1290, 9396, 0], [1293, 9394, 1]],
  [[1296, 9402, 0], [1292, 9409, 1]],
  [[1320, 9396, 0], [1325, 9397, 1]],
  [[1315, 9409, 0], [1322, 9407, 1]],
];
const LINKS = new Map(PAIRS.flatMap(([a, b]) => [[a.join(","), b], [b.join(","), a]]));
const SUN = new Set(["1332,9382,0", "1328,9379,1", "1303,9389,0", "1298,9383,1",
  "1296,9402,0", "1292,9409,1", "1320,9396,0", "1325,9397,1"]);

let api;
let core;
const arrivals = new WeakMap();

function activateLift(player) {
  if (!player) return;
  player.setAttribute(LIFT_ATTRIBUTE, 1);
  player.getPacketSender().sendVarbit(LIFT_VARBIT, 1);
}

function stepOnTile({ player }) {
  if (!player) return;
  const at = player.getLocation();
  const key = `${at.getX()},${at.getY()},${at.getZ()}`;
  if (arrivals.get(player) === key) {
    arrivals.delete(player);
    return;
  }
  const destination = LINKS.get(key);
  if (!destination) return;
  core.TaskManager.submit(new core.CountdownTask(player, STRANGE_TILE_DELAY, () => {
    if (!player.isRegistered?.()) return;
    const here = player.getLocation();
    if (`${here.getX()},${here.getY()},${here.getZ()}` !== key) return;
    const [x, y, z] = destination;
    arrivals.set(player, `${x},${y},${z}`);
    player.getMovementQueue().reset();
    player.moveTo(new core.Location(x, y, z));
    player.performGraphic(new core.Graphic(SUN.has(key) ? SUN_GRAPHIC : MOON_GRAPHIC));
    player.getPacketSender().sendSound(STRANGE_TILE_SOUND, 1, 0);
  }));
}

module.exports = function attachFinalDawnQuests(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.persistAttribute(LIFT_ATTRIBUTE, 0);
  api.onPlayerLogin(({ player }) => activateLift(player));
  api.onCustomEvent("player:bootstrap-complete", ({ player }) => activateLift(player));
  for (const key of LINKS.keys()) {
    const [x, y, z] = key.split(",").map(Number);
    api.onZoneEnter({ minX: x, maxX: x, minY: y, maxY: y, levels: [z] }, stepOnTile);
  }
};

module.exports.activateLift = activateLift;
module.exports.stepOnTile = stepOnTile;
module.exports.LIFT_ATTRIBUTE = LIFT_ATTRIBUTE;
module.exports.LIFT_VARBIT = LIFT_VARBIT;
module.exports.LINKS = LINKS;