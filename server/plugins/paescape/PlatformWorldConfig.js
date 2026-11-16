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
 * Scope: it emits the keys the runtime reads live - spawn/respawn, XP rate, world
 * name/description, gameframe, zone tags and the members (FreeToPlay) flag - and the
 * plugin switches/pluginConfig that must be persisted for the next startup. PaeScape
 * writes the accepted overlay to world.platform.json, which WorldDefinition layers
 * into the startup configuration; a world whose owner changes a plugin setting must
 * be restarted for it to take effect, which is also true of world.json.
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

/** A relic toggle from a boolean or an editor object ({ enabled }), else null. */
function relicToggle(value) {
  if (typeof value === "boolean") return value;
  if (isObject(value) && typeof value.enabled === "boolean") return value.enabled;
  return null;
}

/** A relic tier list from an array, an editor object ({ tiers }), or its JSON string, else null. */
function relicTiers(value) {
  if (Array.isArray(value)) return value.length ? value : null;
  if (isObject(value) && Array.isArray(value.tiers)) return value.tiers.length ? value.tiers : null;
  if (typeof value === "string" && value.trim()) return value;
  return null;
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
 * Website setting -> the plugin switch the runtime loads (PaeScape_Realms world-options.ts).
 * Plugin switches are resolved while plugins load, before the platform handshake answers,
 * so PaeScape persists the compiled form as data/definitions/world.platform.json. Keeping
 * this table here means a hosted restart applies every switch the owner chose.
 */
const PLUGIN_SWITCHES = Object.freeze({
  tutorialIsland: "TutorialIsland",
  voiceChat: "VoiceChat",
  presets: "PvpMode",
  setSkillLevel: "SetSkillLevel",
  ironmanAccounts: "Ironman",
  quests: "Quests",
  achievementDiaries: "AchievementDiaries",
  combatAchievements: "CombatAchievements",
  collectionLog: "CollectionLog",
  pets: "Pets",
  gravestones: "Gravestones",
  duelStaking: "DuelStaking",
  grandExchange: "GrandExchange",
  customShops: "CustomShops",
  osrsNpcs: "NpcSpawns",
  playerBots: "PlayerBots",
  randomEvents: "RandomEvents",
  shootingStars: "ShootingStars",
  customAccountTab: "CustomCharacterSummary",
});

/** Website setting -> flat pluginConfig key (PaeScape_Realms world-options.ts). */
const PLUGIN_CONFIG = Object.freeze({
  tutorialSkippable: "TutorialIsland:allowSkip",
  levelUpInterruptions: "SkillLevelUp:interruptActions",
  equipmentRequirements: "quests:equipment-requirements",
  bossDropRate: "NpcDrops:bossRareMultiplier",
  crossFloorVisibility: "CrossFloor:visibility",
  crossFloorCombat: "CrossFloor:combat",
});

/** The largest player cap the website can submit (world-options.ts maxPlayers.max). */
const MAX_PLAYERS_LIMIT = 1000;

function playerCap(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PLAYERS_LIMIT ? value : undefined;
}

/** The plugin switches the platform settings select, including FreeToPlay and CrossFloor. */
function pluginSwitches(settings, notes) {
  const plugins = {};
  for (const [setting, plugin] of Object.entries(PLUGIN_SWITCHES)) {
    const value = settings[setting];
    if (typeof value === "boolean") plugins[plugin] = value;
    else if (value !== undefined) notes.push(`${setting} is not true or false; keeping the packaged plugin default`);
  }
  // The runtime derives members/F2P from the FreeToPlay plugin switch, not a membersWorld flag.
  if (typeof settings.f2pWorld === "boolean") plugins.FreeToPlay = settings.f2pWorld;
  // CrossFloor is opt-in and loads only when its switch is on. Combat without visibility is
  // not a meaningful runtime state, so either website option enables the plugin;
  // CrossFloor:combat still decides whether attacks cross planes.
  if (typeof settings.crossFloorVisibility === "boolean" || typeof settings.crossFloorCombat === "boolean") {
    plugins.CrossFloor = settings.crossFloorVisibility === true || settings.crossFloorCombat === true;
  }
  // The platform connector is infrastructure, not a player-facing toggle. Every
  // platform-managed world needs it to register the control handler, ticket login,
  // staff ranks and platform persistence after a restart. Its exported default stays
  // off so a manually exported world.json never tries to enrol on its own.
  plugins.PaeScape = true;
  return plugins;
}

/** The flat pluginConfig values the platform settings select. */
function pluginConfigFromSettings(settings, config, notes) {
  const pluginConfig = isObject(config.pluginConfig) ? { ...config.pluginConfig } : {};
  for (const [setting, key] of Object.entries(PLUGIN_CONFIG)) {
    // Tutorial Island skip only exists while Tutorial Island itself is on.
    if (setting === "tutorialSkippable" && settings.tutorialIsland === false) continue;
    const value = settings[setting];
    if (typeof value === "boolean" || typeof value === "number") pluginConfig[key] = value;
    else if (value !== undefined) notes.push(`${setting} has an unsupported value; ignoring ${key}`);
  }
  if (isObject(settings.commandPermissions) && Object.keys(settings.commandPermissions).length) {
    pluginConfig["commands:permissions"] = settings.commandPermissions;
  }
  // League relics: the website's Relics toggle and editor. The canonical setting names are
  // leagueRelics / relicTiers; an editor may send one { enabled, tiers } object, and the
  // shorter aliases keep older payloads working.
  const relicSetting = settings.leagueRelics ?? settings.relics;
  const toggle = relicToggle(relicSetting);
  if (toggle !== null) pluginConfig["league:relics"] = toggle;
  else if (relicSetting !== undefined) notes.push("leagueRelics is not true, false or { enabled }; keeping the packaged relic toggle");
  const tiers = relicTiers(settings.relicTiers ?? settings.leagueRelicTiers
    ?? (isObject(relicSetting) ? relicSetting.tiers : undefined));
  if (tiers !== null) {
    pluginConfig["league:relic-tiers"] = tiers;
  } else if (settings.relicTiers !== undefined || settings.leagueRelicTiers !== undefined
    || (isObject(relicSetting) && relicSetting.tiers !== undefined)) {
    notes.push("relicTiers must be an array of tiers; ignoring league:relic-tiers");
  }
  return pluginConfig;
}

/** The template contract the platform authenticates, carried into the runtime config. */
function templateConfig(config, pluginConfig) {
  const template = typeof config.template === "string" ? config.template : config.canonicalTemplate;
  if (typeof template === "string" && template) pluginConfig["template:id"] = template;
  if (isObject(config.templateContract)) pluginConfig["template:contract"] = config.templateContract;
  if (config.firstPartyContent !== undefined) pluginConfig["template:firstPartyContent"] = config.firstPartyContent;
  const levelUp = isObject(config.templateContract) && isObject(config.templateContract.levelUp)
    ? config.templateContract.levelUp
    : null;
  if (levelUp && Array.isArray(levelUp.xpTiers) && Number.isFinite(levelUp.xpTiers[0]?.multiplier)) {
    pluginConfig["template:initialXpMultiplier"] = levelUp.xpTiers[0].multiplier;
  }
  const pvp = isObject(config.templateContract) ? config.templateContract.pvp : null;
  if (isObject(pvp)) pluginConfig["template:pvp"] = pvp;
  // Rules with a real runtime consumer are compiled to it rather than left as metadata.
  const rules = isObject(config.templateContract) ? config.templateContract : {};
  if (rules.hardcore === true) pluginConfig["HardcoreWorld:enabled"] = true;
  if (Number.isInteger(rules.leagueSeason) && rules.leagueSeason > 0) pluginConfig["league:type"] = rules.leagueSeason;
  // The template contract's relic rule is a runtime setting, not just metadata. Explicit
  // website settings (above) and an explicit pluginConfig win over the template fallback.
  const toggle = relicToggle(rules.leagueRelics);
  if (toggle !== null && pluginConfig["league:relics"] === undefined) {
    pluginConfig["league:relics"] = toggle;
  }
  const tiers = relicTiers(rules.relicTiers ?? rules.leagueRelicTiers
    ?? (isObject(rules.leagueRelics) ? rules.leagueRelics.tiers : undefined));
  if (tiers !== null && pluginConfig["league:relic-tiers"] === undefined) {
    pluginConfig["league:relic-tiers"] = tiers;
  }
}

/**
 * The runtime world.json overlay for a platform world config blob.
 *
 * `config` may be the platform blob (`{ settings: {...} }`) or, defensively, an
 * already-flat world.json-shaped object; the platform settings win when both are
 * present. Returns `{ overlay, notes, experienceRate, maxPlayers }`:
 *
 *   overlay         the world.json keys to layer over the running world, or null
 *                   when the blob carries nothing the runtime can apply;
 *   notes           human-readable lines for the log, one per dropped/invalid field;
 *   experienceRate  the XP multiplier to set on the live engine, or undefined;
 *   maxPlayers      the owner player cap from the config, or undefined when unset.
 */
function toWorldOverlay(config) {
  const notes = [];
  if (!isObject(config)) return { overlay: null, notes: ["world configuration is not an object"], experienceRate: undefined, maxPlayers: undefined };
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

  // The platform world name is authoritative and is what the welcome screen shows.
  if (typeof config.name === "string" && config.name.trim()) overlay.name = config.name.trim().slice(0, 64);

  if (GAMEFRAMES.has(settings.gameframe)) {
    overlay.gameframe = settings.gameframe;
  } else if (settings.gameframe !== undefined) {
    notes.push(`ignoring unknown gameframe ${JSON.stringify(settings.gameframe)}`);
  }

  const zones = normalizeZones(settings.zones, settings.globalPvp, settings.allBuildingsSafe);
  if (zones) overlay.zones = zones;

  overlay.plugins = pluginSwitches(settings, notes);
  overlay.pluginConfig = pluginConfigFromSettings(settings, config, notes);
  templateConfig(config, overlay.pluginConfig);

  const maxPlayers = playerCap(settings.maxPlayers) ?? playerCap(config.maxPlayers);
  if (settings.maxPlayers !== undefined && maxPlayers === undefined) {
    notes.push(`ignoring a max player count of ${JSON.stringify(settings.maxPlayers)}; expected 1-${MAX_PLAYERS_LIMIT}`);
  }

  return { overlay, notes, experienceRate: overlay.experienceMultiplier, maxPlayers };
}

module.exports = { toWorldOverlay, normalizeZones, normalizeSpawn, GAMEFRAMES, DESCRIPTION_MAX };
