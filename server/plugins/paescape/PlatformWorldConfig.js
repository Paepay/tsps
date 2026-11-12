/**
 * Translate the platform's world configuration into the runtime's world.json shape.
 *
 * The website configures a world through its own settings model
 * (PaeScape_Realms `src/lib/world-adapter.ts` `configFromWorld`) and the platform
 * stores and returns that blob unchanged:
 *
 *   { version, mode, template, settings: {...}, shops, mapOverrides }
 *
 * The running server reads a different, flatter model (PaeScape_Realms
 * `src/lib/world-config.ts` `buildWorldConfig`, and the runtime's
 * `WorldDefinition.parseWorldDefinition`): top-level `spawn`, `experienceMultiplier`,
 * `description`, `gameframe`, `zones` and `plugins`. Nothing bridged the two, so a
 * world's configured spawn, XP rate, zones and members flag never reached the
 * server (`applyWorldConfig` read only `settings.experienceMultiplier`, a key the
 * platform never writes).
 *
 * This module is that bridge. It is dependency-free so the translation contract can
 * be unit-tested without loading the game engine (see `LeaseLiveness.js` for the
 * same pattern).
 *
 * Scope: it emits the keys the runtime reads *live* - spawn/respawn, XP rate, world
 * name/description, gameframe, zone tags and the members (FreeToPlay) flag. Plugin
 * *enablement* and per-plugin `pluginConfig` are resolved once, at startup, so they
 * are deliberately not translated here: applying them mid-run would change nothing
 * and would misrepresent the overlay as authoritative. A world whose owner toggles a
 * plugin must be restarted for that to take effect, which is also true of world.json.
 */

/** world.json's own valid gameframe values (WorldDefinition.WORLD_GAMEFRAMES). */
const GAMEFRAMES = new Set(["modern-resizable", "modern-fixed", "317-resizable", "317-fixed"]);

/** world.json's description cap (WorldDefinition.parseWorldDefinition). */
const DESCRIPTION_MAX = 120;

/** The tag marking a whole-map zone building-safe (PaeScape_Realms world-config.ts). */
const BUILDINGS_SAFE_TAG = "all-buildings-safe";

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A world coordinate is an integer inside the world; a plane is 0-3. */
function isCoordinate(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0x3fff;
}

function isPlane(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * The runtime `spawn` from the platform settings, or undefined when it is absent or
 * out of range. A spawn the runtime would reject is left out rather than passed on,
 * so one bad field cannot make the whole overlay fail validation and drop the rest.
 */
function normalizeSpawn(value) {
  if (!isObject(value)) return undefined;
  const { x, y, z } = value;
  const plane = z === undefined ? 0 : z;
  if (!isCoordinate(x) || !isCoordinate(y) || !isPlane(plane)) return undefined;
  return { x, y, z: plane };
}

/**
 * The runtime `zones` from the platform settings, or undefined to leave the world's
 * own zones in place.
 *
 * An empty or absent list means the owner has not authored zones on the website -
 * not "this world has none" - so it must not wipe the shipped zone list (pvp,
 * multi-combat, f2p land). A global-PvP world is compiled the same way the website's
 * `buildZones` does: one whole-map zone tagged `pvp`, plus `all-buildings-safe` when
 * the owner accepted PvP inside buildings.
 */
function normalizeZones(value, globalPvp, allBuildingsSafe) {
  const zones = [];
  if (globalPvp === true) {
    const tags = allBuildingsSafe === true ? ["pvp", BUILDINGS_SAFE_TAG] : ["pvp"];
    zones.push({ tags });
  }
  if (Array.isArray(value)) {
    for (const zone of value) {
      if (!isObject(zone) || !Array.isArray(zone.tags) || zone.tags.length === 0) continue;
      const tags = zone.tags.filter((tag) => typeof tag === "string");
      if (tags.length === 0) continue;
      // A bounded zone keeps its bounds; a plain tag entry stays whole-map.
      const bounded = ["minX", "maxX", "minY", "maxY"].every((key) => Number.isInteger(zone[key]));
      if (bounded) {
        const { minX, maxX, minY, maxY } = zone;
        if (minX > maxX || minY > maxY) continue;
        zones.push({ minX, maxX, minY, maxY, z: isPlane(zone.z) ? zone.z : 0, tags });
      } else {
        zones.push({ tags });
      }
    }
  }
  return zones.length ? zones : undefined;
}

/**
 * The runtime world.json overlay for a platform world config blob.
 *
 * `config` may be the platform blob (`{ settings: {...} }`) or, defensively, an
 * already-flat world.json-shaped object; the platform's `settings` wins when both
 * are present. Returns `{ overlay, notes, experienceRate }`:
 *
 *   overlay         the world.json keys to layer over the running world, or null
 *                   when the blob carries nothing the runtime can apply;
 *   notes           human-readable lines for the log, one per dropped/invalid field;
 *   experienceRate  the XP multiplier to set on the live engine, or undefined.
 */
function toWorldOverlay(config) {
  const notes = [];
  if (!isObject(config)) return { overlay: null, notes: ["world configuration is not an object"], experienceRate: undefined };
  const settings = isObject(config.settings) ? config.settings : config;

  const overlay = {};

  const spawn = normalizeSpawn(settings.spawn);
  if (spawn) overlay.spawn = spawn;
  else if (settings.spawn !== undefined) notes.push("world spawn is missing or out of range; keeping the packaged spawn");

  const experienceRate = firstFinite(settings.xpRate, settings.experienceMultiplier);
  if (experienceRate !== undefined && experienceRate > 0) {
    overlay.experienceMultiplier = experienceRate;
  } else if (experienceRate !== undefined) {
    notes.push(`ignoring an XP rate of ${experienceRate}; it must be a positive number`);
  }

  if (typeof settings.description === "string") {
    overlay.description = settings.description.slice(0, DESCRIPTION_MAX);
  }

  if (GAMEFRAMES.has(settings.gameframe)) {
    overlay.gameframe = settings.gameframe;
  } else if (settings.gameframe !== undefined) {
    notes.push(`ignoring unknown gameframe ${JSON.stringify(settings.gameframe)}`);
  }

  const zones = normalizeZones(settings.zones, settings.globalPvp, settings.allBuildingsSafe);
  if (zones) overlay.zones = zones;

  // The runtime derives members/F2P from the FreeToPlay plugin switch, not from a
  // `membersWorld` flag, so the owner's choice is carried as that switch.
  if (typeof settings.f2pWorld === "boolean") {
    overlay.plugins = { FreeToPlay: settings.f2pWorld };
  }

  const keys = Object.keys(overlay);
  return { overlay: keys.length ? overlay : null, notes, experienceRate: overlay.experienceMultiplier };
}

module.exports = { toWorldOverlay, normalizeZones, normalizeSpawn, GAMEFRAMES, DESCRIPTION_MAX };
