/**
 * Cam Torum's surface entrance when Quests is off.
 *
 * The Perilous Moons module owns object 51375's Pass-through route. Its hooks are absent on a
 * Quests-off world, so the entrance is a plain object and the city cannot be reached from
 * Varlamore. Every quest counts complete there, so the post-quest route is always open.
 */
const ENTRANCE = 51375;
const SURFACE = [[1435, 3128, 0], [1436, 3128, 0]];
const UNDER = [[1439, 9509, 1], [1440, 9509, 1]];
const LANDING = { x: 1439, y: 9509, z: 1 };
const RETURN = { x: 1435, y: 3128, z: 0 };

let api;

function onSurface(x, y, z) {
  return z === 0 && SURFACE.some(([sx, sy]) => sx === x && sy === y);
}

function onUnder(x, y, z) {
  return z === 1 && UNDER.some(([ux, uy]) => ux === x && uy === y);
}

function passThrough(event) {
  if (event.objectId !== ENTRANCE) return false;
  const option = event.definition?.getInteractions?.()?.[event.clickType - 1] ?? "";
  if (option !== "Pass-through") return false;
  const at = event.location ?? event.object?.getLocation?.();
  if (!at) return false;
  const x = at.getX?.() ?? at.x;
  const y = at.getY?.() ?? at.y;
  const z = at.getZ?.() ?? at.z;
  if (onSurface(x, y, z)) event.player.moveTo(new api.core.Location(LANDING.x, LANDING.y, LANDING.z));
  else if (onUnder(x, y, z)) event.player.moveTo(new api.core.Location(RETURN.x, RETURN.y, RETURN.z));
  else return false;
  return true;
}

module.exports = function attachCamTorumQuests(pluginApi) {
  api = pluginApi;
  api.onObjectInteraction((event) => {
    if (event.handled) return;
    if (passThrough(event)) event.handled = true;
  });
};

module.exports.passThrough = passThrough;
module.exports.ENTRANCE = ENTRANCE;