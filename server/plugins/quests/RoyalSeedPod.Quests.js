/**
 * The royal seed pod's Commune (Monkey Madness II's reward). The quest registers it for a world
 * whose Quests plugin is on; QuestAutoComplete registers the same handler when Quests is off and
 * every quest counts complete, so the item keeps working there too. TeleportHandler applies the
 * usual Wilderness, Tele Block and confirmation rules; the Wiki gives the pod level 30.
 */
const WILDERNESS_LIMIT = 30;

function register(api) {
  const { ItemIdentifiers, Location, TeleportHandler, TeleportType } = api.core;
  const destination = new Location(2465, 3496, 0);
  const seedPods = new Set([ItemIdentifiers.ROYAL_SEED_POD, ItemIdentifiers.ROYAL_SEED_POD_2]);

  api.onItemAction((event) => {
    const { player, itemId } = event;
    if (!seedPods.has(itemId) || String(event.option ?? "").toLowerCase() !== "commune") return;
    event.handled = true;
    if (!TeleportHandler.checkReqs(player, destination, WILDERNESS_LIMIT)) return;
    TeleportHandler.confirm(player, destination, () => TeleportHandler.teleport(player, destination.clone(), TeleportType.NORMAL, false,
      () => player.sendMessage("The Royal seed pod teleports you to the Grand Tree.")), WILDERNESS_LIMIT);
  });
}

module.exports = { register, WILDERNESS_LIMIT };
