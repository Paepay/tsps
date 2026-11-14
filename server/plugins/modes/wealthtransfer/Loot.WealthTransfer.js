/**
 * When wealth transfer is off: no picking up other players' drops, and PvP loot stays the
 * fallen player's (Ironman wealth rules without the account type).
 */
const Common = require("./Common.WealthTransfer");

function cannotTake(event) {
  if (Common.enabled()) return false;
  const { player, groundItem } = event;
  const owner = groundItem?.getOwner?.();
  if (!owner || owner.toLowerCase() === player.getUsername().toLowerCase()) return false;
  player.sendMessage(Common.message("pickup"));
  return true;
}

function pickup(event) {
  if (cannotTake(event)) event.handled = true;
}

function telegrab(event) {
  if (event.allow !== false && cannotTake(event)) event.allow = false;
}

function playerLoot(event) {
  if (Common.enabled()) return;
  const { player, killer, item, location } = event;
  if (!killer || killer === player || !event.dropEligible) return;
  event.suppressDefaultDrop = true;
  event.handled = true;
  Common.api.core.ItemOnGroundManager.registerLocation(player, item, location);
}

/** `player-death:loot-owner`: the killer never receives the victim's items. */
function lootOwner(event) {
  if (Common.enabled()) return;
  if (event?.killer && event.killer !== event.player) event.owner = event.player;
}

module.exports = function attach(api) {
  api.onGroundItemPickup(pickup);
  api.onCustomEvent("magic:can-telekinetic-grab", telegrab);
  api.onCustomEvent("ground-item:can-store", telegrab);
  api.onPlayerDeathItemDrop(playerLoot);
  api.onCustomEvent("player-death:loot-owner", lootOwner);
};
