"use strict";

/**
 * Dismantling Zulrah's tradeable uniques (Wiki: Serpentine visage, Magic fang,
 * Tanzanite fang). Each asks "Dismantle <item>" and Yes consumes the item for
 * 20,000 Zulrah's scales. The blowpipe's own Dismantle stays in
 * ToxicBlowpipe.plugin.js because its empty and charged states are pipe-specific.
 */
const { PRESET_TEXT, restricted } = require("./PoweredStaff");

const DISMANTLE_SCALES = 20000;
const NO_SPACE = "You don't have enough free inventory space to do that.";
const DISMANTLE_ITEM_NAMES = ["Serpentine visage", "Magic fang", "Tanzanite fang"];

let core;
let pluginApi;

/** Inventory.add merges only when both the item id and the metadata match. */
function sameStack(held, item) {
  return held.getId() === item.getId() &&
    JSON.stringify(held.getMeta() ?? null) === JSON.stringify(item.getMeta() ?? null);
}

/** Checked again after Yes: the item may have moved, changed or become restricted meanwhile. */
function completeDismantle(player, item, slot, itemId) {
  const inventory = player.getInventory();
  if (inventory.getItems()[slot] !== item || item.getId() !== itemId) return;
  if (restricted(item)) {
    player.sendMessage(PRESET_TEXT);
    return;
  }

  const scales = new core.Item(core.ItemIdentifiers.ZULRAHS_SCALES, DISMANTLE_SCALES);
  if (inventory.getItems().some((held, index) => index !== slot && held && sameStack(held, scales))) {
    if (inventory.getAddableAmount(scales) < DISMANTLE_SCALES) {
      player.sendMessage(NO_SPACE);
      return;
    }
    inventory.deleteAtSlot(slot, 1);
    inventory.add(scales, true);
  } else {
    inventory.setItem(slot, scales);
    inventory.refreshItems();
  }
  pluginApi.emitCustomEvent("zulrah:unique-dismantled", { player, itemId });
}

function dismantle({ player, item, slot, itemId }) {
  if (restricted(item)) {
    player.sendMessage(PRESET_TEXT);
    return true;
  }
  const name = item.getDefinition()?.getName?.() ?? "";
  pluginApi.sendMultiChatboxPrompt(player, `Dismantle ${name}`,
    "Yes.", () => completeDismantle(player, item, slot, itemId),
    "No.", () => {});
  return true;
}

function attach(api) {
  core = api.core;
  pluginApi = api;
  for (const name of DISMANTLE_ITEM_NAMES) {
    api.onItemAction(name, { Dismantle: dismantle });
  }
}

module.exports = {
  name: "ZulrahScaleUniques",
  description: "Dismantles a serpentine visage, magic fang or tanzanite fang for 20,000 Zulrah's scales.",
  members: true,
  _test: { completeDismantle, dismantle, DISMANTLE_SCALES },
  register(api) {
    attach(api);
  },
};
