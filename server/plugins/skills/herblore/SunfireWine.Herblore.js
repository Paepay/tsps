/**
 * Jugs of sunfire wine (https://oldschool.runescape.wiki/w/Jug_of_sunfire_wine): two sunfire
 * splinters used on a jug of wine, with a pestle and mortar carried, make a jug of sunfire wine.
 * It is not a Herblore mix: there is no level and no experience, and the pestle is a tool, not an
 * ingredient. Splinters cannot be added to a jug of blessed wine.
 *
 * The Wiki's creation row is 1 tick with the note "Crushing sunfire splinters is 1, then 4 ticks":
 * the first jug comes a tick after the use and the next every 4 ticks. No success line is
 * captured, so the mix is silent; the pestle's grind animation and the Herblore mix sound are
 * used. Recording 1141 has the refusal for a missing component (docs/ralos-rise.md).
 */
const Common = require("./Common.Herblore");
const DATA = require("../data/herblore.json").sunfireWine;

const obj = (name) => Common.gameval("obj", name);

function ids() {
  return {
    splinters: obj(DATA.splinters),
    wine: obj(DATA.wine),
    blessedWine: obj(DATA.blessedWine),
    product: obj(DATA.product),
    tool: obj(DATA.tool),
  };
}

/** Whether the pair is sunfire splinters with a wine (blessed or not), in either order. */
function isSunfirePair(usedItemId, usedWithItemId, id) {
  return (usedItemId === id.splinters && (usedWithItemId === id.wine || usedWithItemId === id.blessedWine))
    || (usedWithItemId === id.splinters && (usedItemId === id.wine || usedItemId === id.blessedWine));
}

/** The first plain jug of wine the inventory holds; blessed wine never counts (Wiki). */
function wineSlot(inventory, id) {
  return inventory.getItems().findIndex((item) => item?.getId() === id.wine && !Common.restricted(item));
}

function canMake(inventory, id) {
  return Common.plainAmount(inventory, id.splinters) >= DATA.splintersPerJug && wineSlot(inventory, id) >= 0;
}

/** One jug: two splinters and the wine go, and the product takes the wine's slot. */
function makeOne(player, id) {
  const inventory = player.getInventory();
  if (Common.plainAmount(inventory, id.splinters) < DATA.splintersPerJug) return false;
  const slot = wineSlot(inventory, id);
  if (slot < 0) return false;
  Common.takePlain(inventory, id.splinters, DATA.splintersPerJug);
  inventory.setItem(slot, new Common.core.Item(id.product, 1));
  inventory.refreshItems();
  Common.animate(player, DATA.animation);
  Common.sound(player, Common.MIX_SOUND);
  Common.api.emitCustomEvent("herblore:made", { player, itemId: id.product });
  Common.api.emitCustomEvent("skills:produced", {
    player, skill: Common.core.Skill.HERBLORE, itemId: id.product, amount: 1, xp: 0, kind: "mix",
  });
  return true;
}

function makeable(inventory, id) {
  const wines = inventory.getItems().reduce((sum, item) =>
    item?.getId() === id.wine && !Common.restricted(item) ? sum + item.getAmount() : sum, 0);
  return Math.min(Math.floor(Common.plainAmount(inventory, id.splinters) / DATA.splintersPerJug), wines);
}

function start(player, id, amount) {
  Common.core.TaskManager.cancelTasks(player.getIndex());
  Common.animate(player, DATA.animation);
  Common.sound(player, Common.MIX_SOUND);
  let remaining = amount;
  let wait = DATA.firstTicks;
  Common.run(player, () => {
    if (--wait > 0) return true;
    if (!makeOne(player, id) || --remaining <= 0) return false;
    wait = DATA.ticks;
    return true;
  });
}

function offer(player, id) {
  const most = makeable(player.getInventory(), id);
  if (most <= 1) {
    start(player, id, most);
    return;
  }
  const { CreationMenu } = Common.core;
  player.getPacketSender().sendCreationMenu(new CreationMenu(
    "How many do you wish to make?",
    [id.product],
    { execute: (_itemId, amount) => start(player, id, Math.min(amount, makeable(player.getInventory(), id))) },
    { mode: 0, maxAmount: most, lastAmount: most },
  ));
}

/** Sunfire splinters and a jug of wine (either order), with a pestle and mortar carried. */
function use(event) {
  const { player, usedItemId, usedWithItemId } = event;
  const id = ids();
  if (!isSunfirePair(usedItemId, usedWithItemId, id)) return;
  event.handled = true;
  const inventory = player.getInventory();
  // A blessed jug is never a base for sunfire wine, even when a plain jug is also carried.
  if (usedItemId === id.blessedWine || usedWithItemId === id.blessedWine) {
    player.sendMessage(DATA.refusal);
    return;
  }
  if (!inventory.contains(id.tool) || !canMake(inventory, id)) {
    // The ingredients are there, but only as restricted (preset) copies: say so instead of the
    // missing-component line. Otherwise (a missing pestle, one splinter, no wine) it is the
    // captured refusal.
    const holdsEnough = inventory.getAmount(id.splinters) >= DATA.splintersPerJug && inventory.getAmount(id.wine) > 0;
    const onlyRestricted = holdsEnough && !canMake(inventory, id);
    player.sendMessage(onlyRestricted ? Common.PRESET_REFUSAL : DATA.refusal);
    return;
  }
  offer(player, id);
}

module.exports = function attachSunfireWine(api) {
  api.onItemOnItem(use, { noted: false });
};

module.exports._test = { ids, isSunfirePair };
