"use strict";

/**
 * Ghommal's hilt (https://oldschool.runescape.wiki/w/Ghommal%27s_hilt).
 *
 * Every tier teleports to the God Wars Dungeon entrance by the boulder (2918,3744, the Wiki's
 * entrance pin at 2918,3745): three daily on hilt 1, five on hilt 2, unlimited from hilt 3.
 * Hilts 4 to 6 also teleport to Mor Ul Rek, south-east of the inner city bank (2548,5137),
 * three and five times a day and then unlimited; that one needs the inner city unlocked by
 * showing TzHaar-Ket a fire cape (MorUiRek's access attribute), or it says so and does nothing.
 * Both are ordinary teleports, blocked above level 20 Wilderness as every teleport is.
 */
const TROLLHEIM = { x: 2918, y: 3744, z: 0 };
const MOR_UL_REK = { x: 2548, y: 5137, z: 0 };
const WILDERNESS_LIMIT = 20;
const DAILY_ATTRIBUTE = "ghommals-hilt:daily";
const MOR_UL_REK_ACCESS_ATTRIBUTE = "mor-ul-rek:access";
const NO_CAPE_MESSAGE = "You need to have shown a fire cape to Tzhaar-Ket to use this teleport.";
const NO_TELEPORTS_MESSAGE = "You have used all of your daily teleports from the hilt.";

/** Item ids are the unnoted hilt of each tier; the noted pair shares the name and has no options. */
const TIERS = [
  { level: 1, ids: [25926], trollheim: 3, morUlRek: 0 },
  { level: 2, ids: [25928], trollheim: 5, morUlRek: 0 },
  { level: 3, ids: [25930], trollheim: Infinity, morUlRek: 0 },
  { level: 4, ids: [25932], trollheim: Infinity, morUlRek: 3 },
  { level: 5, ids: [25934], trollheim: Infinity, morUlRek: 5 },
  { level: 6, ids: [25936], trollheim: Infinity, morUlRek: Infinity },
];
const TIER_BY_ID = new Map(TIERS.flatMap((tier) => tier.ids.map((id) => [id, tier])));
const WORN_OPTION_PARAM = 451;
const FIRST_WORN_OPTION_CLICK = 2;

let api = null;
let core = null;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dailyUses(player, key) {
  const state = player.getAttribute(DAILY_ATTRIBUTE);
  if (!state || state.day !== today()) return 0;
  return Number(state.counts?.[key]) || 0;
}

function useDaily(player, key) {
  const state = player.getAttribute(DAILY_ATTRIBUTE);
  const counts = !state || state.day !== today() ? {} : { ...state.counts };
  counts[key] = (Number(counts[key]) || 0) + 1;
  player.setAttribute(DAILY_ATTRIBUTE, { day: today(), counts });
  return counts[key];
}

/** The worn option name for a click index, as the cache lists it (Trollheim, Mor Ul Rek). */
function optionNameOf(event) {
  if (event.option) return String(event.option);
  const index = Number(event.clickType) - FIRST_WORN_OPTION_CLICK;
  if (!Number.isInteger(index) || index < 0) return null;
  return core.CacheDefinitions.getItem(event.itemId)?.params?.get?.(WORN_OPTION_PARAM + index) ?? null;
}

function teleportTo(player, tile) {
  const target = new core.Location(tile.x, tile.y, tile.z);
  if (!core.TeleportHandler.checkReqs(player, target, WILDERNESS_LIMIT)) return;
  core.TeleportHandler.confirm(player, target,
    () => core.TeleportHandler.teleport(player, target, core.TeleportType.NORMAL, false), WILDERNESS_LIMIT);
}

function teleportTrollheim(event) {
  const tier = TIER_BY_ID.get(event.itemId);
  if (!tier) return false;
  if (dailyUses(event.player, "trollheim") >= tier.trollheim) {
    event.player.sendMessage(NO_TELEPORTS_MESSAGE);
    return true;
  }
  if (tier.trollheim !== Infinity) useDaily(event.player, "trollheim");
  teleportTo(event.player, TROLLHEIM);
  return true;
}

function teleportMorUlRek(event) {
  const tier = TIER_BY_ID.get(event.itemId);
  if (!tier || tier.morUlRek === 0) return false;
  if (event.player.getAttribute(MOR_UL_REK_ACCESS_ATTRIBUTE) !== true) {
    event.player.sendMessage(NO_CAPE_MESSAGE);
    return true;
  }
  if (dailyUses(event.player, "mor-ul-rek") >= tier.morUlRek) {
    event.player.sendMessage(NO_TELEPORTS_MESSAGE);
    return true;
  }
  if (tier.morUlRek !== Infinity) useDaily(event.player, "mor-ul-rek");
  teleportTo(event.player, MOR_UL_REK);
  return true;
}

/** One handler per option; the name is enough for both the inventory and worn routes. */
function teleport(event) {
  const option = optionNameOf(event);
  if (option === "Trollheim") return teleportTrollheim(event);
  if (option === "Mor Ul Rek") return teleportMorUlRek(event);
  return false;
}

module.exports = {
  name: "GhommalsHilt",
  description: "Ghommal's hilts: daily Trollheim (God Wars Dungeon entrance) and Mor Ul Rek teleports, the latter behind the fire-cape inner city unlock.",
  members: true,
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;
    api.persistAttribute(DAILY_ATTRIBUTE, null);
    api.onItemAction("Ghommal's hilt 1", { Trollheim: teleport });
    api.onItemAction("Ghommal's hilt 2", { Trollheim: teleport });
    api.onItemAction("Ghommal's hilt 3", { Trollheim: teleport });
    api.onItemAction("Ghommal's hilt 4", { Trollheim: teleport, "Mor Ul Rek": teleport });
    api.onItemAction("Ghommal's hilt 5", { Trollheim: teleport, "Mor Ul Rek": teleport });
    api.onItemAction("Ghommal's hilt 6", { Trollheim: teleport, "Mor Ul Rek": teleport });
  },
  _test: { TIERS, TIER_BY_ID, TROLLHEIM, MOR_UL_REK, NO_CAPE_MESSAGE, NO_TELEPORTS_MESSAGE, dailyUses, useDaily, optionNameOf },
};
