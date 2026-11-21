/**
 * The broken zombie axe (https://oldschool.runescape.wiki/w/Broken_zombie_axe): 70 Smithing
 * (boostable), a hammer and an anvil repair it into the zombie axe, for 500 Smithing experience.
 * The Wiki's creation recipe takes 8 ticks, and the transcript asks "Repair your zombie axe?"
 * before showing "You successfully repair your zombie axe." in an item box.
 */
const Core = require("./Core.Smithing");
const Common = require("./Common.Smithing");
const Sessions = require("./Sessions.Smithing");

const LEVEL = 70;
const XP = 500;
const TICKS = 8;

const brokenAxe = () => Common.obj("zombie_axe_broken");
const zombieAxe = () => Common.obj("zombie_axe");

function canRepair(player) {
  return Common.hasHammer(player) && Common.smithingLevel(player) >= LEVEL;
}

function finish(player, source) {
  const inventory = player.getInventory();
  const items = inventory.getItems?.() ?? [];
  const slot = items.findIndex((item) => item?.getId?.() === brokenAxe());
  if (slot < 0 || !canRepair(player)) return false;
  inventory.setItem(slot, new Core.Item(zombieAxe(), 1));
  inventory.refreshItems?.();
  player.getSkillManager().addExperiences(Core.Skill.SMITHING, XP);
  Common.itemBox(player, zombieAxe(), "You successfully repair your zombie axe.");
  Core.api.emitCustomEvent("smithing:success", {
    player,
    skill: Core.Skill.SMITHING,
    itemId: zombieAxe(),
    ...(source ? { source: "anvil", objectId: source.objectId, location: source.location } : {}),
  });
  return true;
}

function start(player, source) {
  if (!canRepair(player) || !player.getInventory().contains(brokenAxe())) return;
  Sessions.timeline(player, "zombie-axe", [
    { at: 0, run: () => player.performAnimation(Common.hammering()) },
    { at: 4, run: () => player.performAnimation(Common.hammering()) },
    { at: TICKS, run: () => finish(player, source) },
  ]);
}

function sourceOf(event) {
  const objectId = event.object?.getId?.() ?? event.objectId;
  const location = event.object?.getLocation?.() ?? event.location;
  return location ? {
    objectId,
    location: { x: location.getX(), y: location.getY(), z: location.getZ() },
  } : null;
}

/** A broken zombie axe used on an anvil. */
function useOnAnvil(event) {
  if (event.itemId !== brokenAxe()) return false;
  event.handled = true;
  const { player } = event;
  if (!canRepair(player) || !player.getInventory().contains(brokenAxe())) return true;
  Core.api.sendMultiChatboxPrompt(player, "Repair your zombie axe?", "Yes.", () => start(player, sourceOf(event)), "No.", () => {});
  return true;
}

module.exports = { useOnAnvil, LEVEL, XP, TICKS };
