"use strict";

/**
 * Reverting crystal weapons to a crystal weapon seed (issue #163).
 * https://oldschool.runescape.wiki/w/Crystal_weapon_seed
 *
 * The cache gives crystal bows, shields and halberds a Revert option, and the Wiki says the
 * seed is got back by reverting the weapon rather than being recharged: the charges are
 * forfeited (no crystal shards come back) and the seed can be sung into any of the three.
 * Charged, inactive and freshly sung forms all revert; the pre-2019 staged forms (4214-4234 and
 * their (i) copies) carry their progress in the item id, have no Revert option, and are left alone.
 *
 * The message is ours: the Wiki records the option, not its wording.
 */
const REVERTED = "You revert the crystal bow to a crystal weapon seed.";
const REVERTED_SHIELD = "You revert the crystal shield to a crystal weapon seed.";
const REVERTED_HALBERD = "You revert the crystal halberd to a crystal weapon seed.";

/** Cache display names with a Revert option, and the charge metadata the item may hold. */
const WEAPONS = [
  { name: "Crystal bow", kind: "bow", metaKeys: ["crystal-bow:shots-in-stage"] },
  { name: "Crystal bow (inactive)", kind: "bow", metaKeys: ["crystal-bow:shots-in-stage"] },
  { name: "Crystal shield", kind: "shield", metaKeys: [] },
  { name: "Crystal shield (inactive)", kind: "shield", metaKeys: [] },
  { name: "Crystal halberd", kind: "halberd", metaKeys: ["crystal-halberd"] },
  { name: "Crystal halberd (inactive)", kind: "halberd", metaKeys: ["crystal-halberd"] },
];

const MESSAGE = { bow: REVERTED, shield: REVERTED_SHIELD, halberd: REVERTED_HALBERD };

let core = null;
/** Cache display name -> the weapon's row. */
let byName = new Map();

function refresh(player) {
  player.getInventory().refreshItems();
  player.getEquipment().refreshItems();
  core.BonusManager.update(player);
  player.getUpdateFlag().flag(core.Flag.APPEARANCE);
  core.WeaponInterfaceManager.assign(player);
}

/** Revert: the weapon becomes one crystal weapon seed in the same inventory slot. */
function revert(event) {
  const { player, item } = event;
  const row = byName.get(core.CacheDefinitions.getItem(event.itemId)?.name);
  if (!row) return;
  const inventory = player.getInventory();
  const worn = event.interfaceId === core.Equipment.INVENTORY_INTERFACE_ID;
  let slot = event.slot;
  if (worn) {
    if (!core.EquipPacketListener.unequip(player, event.slot)) return;
    slot = inventory.getItems().indexOf(item);
  }
  for (const key of row.metaKeys) item.setMetaValue(key, undefined);
  inventory.deleteItem(item, slot);
  inventory.adds(core.ItemIdentifiers.CRYSTAL_WEAPON_SEED, 1);
  refresh(player);
  player.sendMessage(MESSAGE[row.kind]);
}

module.exports = {
  name: "CrystalWeaponRevert",
  description: "Reverts crystal bows, shields and halberds to a crystal weapon seed, forfeiting their charges (Wiki: Revert).",
  members: true,
  _test: { WEAPONS, revert },
  register(api) {
    core = api.core;
    byName = new Map(WEAPONS.map((row) => [row.name, row]));
    for (const row of WEAPONS) api.onItemAction(row.name, { Revert: revert });
    api.log("registered", { weapons: WEAPONS.length });
  },
};
