/**
 * Nest box (Wiki "Nest box", Update "Content Poll 25 - Batch 1"). Wyson gives these for noted
 * mole parts; each box holds any number of one nest kind.
 *
 *   Check    the item's box: "The nest box contains N seed nests."
 *   Extract  the nests, but only with a bank open or at the Grand Exchange (Wiki: the 2018
 *            hotfix restricted opening boxes to banks and the exchange). Ours: the nests join
 *            the inventory, as the Ultimate Ironman guide's "Extract 8 seed nests" describes;
 *            with no room the rest stay boxed. Both messages are ours: no capture has them.
 *
 * Contents are in the item's metadata (see ./nest-boxes.js) and survive banking and logout.
 */
const { boxContentsType, boxContents, setBoxCount } = require("./nest-boxes");

const EXTRACT_REFUSAL = "You can only extract nests from a nest box inside a bank or at the Grand Exchange.";
const NO_ROOM_MESSAGE = "You don't have enough inventory space.";
/** ge_offers, as GrandExchange.plugin.js opens the exchange. */
const GRAND_EXCHANGE_INTERFACE_ID = 465;
/**
 * The bank side panel's op 9. For an item whose cache param 595 is set, the client labels it with
 * that param ("Extract" on these boxes) instead of Wear/Wield; Bank.ts emits bank:inventory-op
 * before it treats op 9 as an equip, so the box claims it here.
 */
const BANK_INVENTORY_OP_EVENT = "bank:inventory-op";
const BANK_EXTRACT_OP = 9;
const BOX_NAMES = ["Nest box (empty)", "Nest box (seeds)", "Nest box (ring)"];

function itemBox(player, itemId, text) {
  player.getDialogueManager().startDialogues(new core.DialogueChainBuilder().add(
    new core.ItemStatementDialogue(0, itemId, text),
  ));
}

let core;

function check({ player, item }) {
  const type = boxContentsType(core, item?.getId?.());
  const held = boxContents(item);
  if (!type || !held) return false;
  const text = held.count === 0
    ? "The nest box is empty."
    : `The nest box contains ${held.count.toLocaleString("en-US")} ${type.label} nest${held.count === 1 ? "" : "s"}.`;
  itemBox(player, item.getId(), text);
  return true;
}

function canExtract(player) {
  return core.Bank.isOpen(player) || player.getInterfaceId() === GRAND_EXCHANGE_INTERFACE_ID;
}

function extract({ player, item, slot }) {
  const type = boxContentsType(core, item?.getId?.());
  const held = boxContents(item);
  if (!type || !held) return false;
  if (!canExtract(player)) {
    player.sendMessage(EXTRACT_REFUSAL);
    return true;
  }
  if (held.count === 0) {
    player.sendMessage("The nest box is empty.");
    return true;
  }
  const inventory = player.getInventory();
  const free = inventory.getFreeSlots();
  // A partial extract keeps the box, so it can only use the free slots. A full extract also
  // frees the box's own slot.
  const take = held.count > free + 1 ? free : held.count;
  if (take <= 0) {
    player.sendMessage(NO_ROOM_MESSAGE);
    return true;
  }
  const remaining = held.count - take;
  if (remaining > 0) setBoxCount(item, remaining);
  else inventory.deleteAtSlot(slot, 1, false);
  for (let n = 0; n < take; n++) inventory.add(new core.Item(type.nestId, 1), false);
  inventory.refreshItems();
  if (remaining > 0) player.sendMessage(NO_ROOM_MESSAGE);
  return true;
}

/** A nest box's bank-side op 9: extract without closing the bank (Bank.ts's own equip no-op
 *  would otherwise swallow it, as a box is not equipment). */
function bankInventoryOp(event) {
  if (event?.handled || event?.op !== BANK_EXTRACT_OP) return;
  if (!boxContentsType(core, event.item?.getId?.())) return;
  if (extract({ player: event.player, item: event.item, slot: event.slot })) event.handled = true;
}

module.exports = {
  name: "NestBox",
  description: "Nest boxes from Wyson: Check their contents and Extract nests inside a bank or at the Grand Exchange.",
  members: true,
  register(api) {
    core = api.core;
    for (const name of BOX_NAMES) api.onItemAction(name, { Check: check, Extract: extract });
    api.onCustomEvent(BANK_INVENTORY_OP_EVENT, bankInventoryOp);
  },
};
