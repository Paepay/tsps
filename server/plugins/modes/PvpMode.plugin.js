const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const { GameConstants } = require("../../src/main/typescript/elvarg/game/GameConstants");
const { PrayerData } = require("../../src/main/typescript/elvarg/game/content/PrayerHandler");
const Presets = require("./pvp/Presets.PvpMode");

function openPresets({ player }) {
  if (player.busy?.()) {
    player.getPacketSender().sendInterfaceRemoval();
  }
  Presets.openPresetInterface(player);
  return true;
}

const OPEN_PRESETS_DELAY_TICKS = 2;
let TaskManager;
let pluginApi = null;

/** The player's respawn point (RespawnPoints.plugin.js: Edgeville, Ferox Enclave ...), else the world's spawn. */
function respawnPointOf(player) {
  const request = { player, location: null };
  pluginApi?.emitCustomEvent?.("respawn-point:location", request);
  return request.location ?? GameConstants.DEFAULT_LOCATION;
}

function isAtRespawnPoint(player) {
  const location = player?.getLocation?.();
  const respawn = respawnPointOf(player);
  if (!location || !respawn) {
    return false;
  }
  return (
    location.getX?.() === respawn.getX?.() &&
    location.getY?.() === respawn.getY?.() &&
    location.getZ?.() === respawn.getZ?.()
  );
}

class OpenPresetsAfterDeath extends Task {
  constructor(player) {
    super(OPEN_PRESETS_DELAY_TICKS, false);
    this.player = player;
  }

  execute() {
    this.stop();
    const player = this.player;
    if (!player.isRegistered?.() || player.getHitpoints?.() <= 0
        || !Presets.shouldOpenOnDeath(player) || !isAtRespawnPoint(player)) return;
    openPresets({ player });
  }
}

function openPresetsAfterDeath({ victim }) {
  if (!victim || victim.isPlayerBot?.() || !Presets.shouldOpenOnDeath(victim) || !Presets.canUsePresets(victim, true)) return;
  TaskManager.submit(new OpenPresetsAfterDeath(victim));
}

/**
 * Presets assume Chivalry and Piety, so PvP mode hands those out without King's Ransom, but only
 * to an account that may load presets: an Ironman (every league character) earns them. Rigour,
 * Augury and Preserve keep their prayer-scroll requirement (#245): those three are earned by
 * reading their scroll, never by the preset bypass.
 */
const SCROLL_PRAYERS = new Set([PrayerData.RIGOUR, PrayerData.AUGURY, PrayerData.PRESERVE]);

function bypassPrayerUnlocks(event) {
  if (SCROLL_PRAYERS.has(event.prayer)) return;
  if (Presets.accountMayUsePresets(event.player)) event.bypass = true;
}

module.exports = {
  name: "PvpMode",
  description: "Adds the ::presets and ::kits commands, opens presets after a PvP death, and lets accounts that may use presets have their prayers without the unlock quests.",
  _test: { OpenPresetsAfterDeath, isAtRespawnPoint },
  register(api) {
    pluginApi = api;
    TaskManager = api.getTaskManager();
    Presets.register(api);
    api.registerCommand("presets", openPresets, api.core.PlayerRights.NONE, "Open the presets interface");
    api.registerCommand("kits", openPresets, api.core.PlayerRights.NONE, "Open the presets interface");
    api.onPlayerDefeated(openPresetsAfterDeath);
    api.onCustomEvent("presets:open", openPresets);
    api.onCustomEvent("prayer:unlocks-bypass", bypassPrayerUnlocks);
  },
};
