/**
 * Duke Horacio's anti-dragon shield when Quests is off.
 *
 * QuestAutoComplete loads DragonSlayer.Quest only for its definition, so its transcript action
 * hook is absent. The generic Duke conversation still plays (and still says the Duke hands over
 * the shield), but nothing gives it. Every quest counts complete on these worlds, so the same
 * shield the quest hands over is given at those message steps, once per character.
 */
const SHIELD_STEPS = new Set(["KoKING", "LnbjYr", "if_uB3", "igRDii", "emj6I8"]);

let core;

function dukeIds() {
  const { NpcIdentifiers } = core;
  return new Set([
    NpcIdentifiers.DUKE_HORACIO,
    NpcIdentifiers.DUKE_HORACIO_2,
    NpcIdentifiers.DUKE_HORACIO_3,
    NpcIdentifiers.DUKE_HORACIO_4,
  ]);
}

function shieldIds() {
  const { ItemIdentifiers } = core;
  return [ItemIdentifiers.ANTI_DRAGON_SHIELD, ItemIdentifiers.ANTI_DRAGON_SHIELD_2,
    ItemIdentifiers.ANTI_DRAGON_SHIELD_3, ItemIdentifiers.ANTI_DRAGON_SHIELD_4];
}

function ownsShield(player) {
  const ids = new Set(shieldIds());
  if (player.getInventory().getItems().some((item) => item && ids.has(item.getId()))) return true;
  if ((player.getEquipment().getItems() || []).some((item) => item && ids.has(item.getId()))) return true;
  return player.getBanks?.()?.some((bank) => bank && [...ids].some((id) => bank.getAmount(id) > 0)) === true;
}

function giveShield(player) {
  if (ownsShield(player)) return false;
  const inventory = player.getInventory();
  if (inventory.isFull()) {
    player.sendMessage("You need a free inventory space for the anti-dragon shield.");
    return false;
  }
  inventory.adds(core.ItemIdentifiers.ANTI_DRAGON_SHIELD, 1);
  return true;
}

function handleAction(event) {
  if (!event?.player || !SHIELD_STEPS.has(event.stepId) || !dukeIds().has(event.npcId)) return;
  giveShield(event.player);
  event.handled = true;
}

module.exports = function attachDragonSlayerQuests(api) {
  core = api.core;
  api.onCustomEvent("npc-dialogue:action", handleAction);
};

module.exports.giveShield = giveShield;
module.exports.ownsShield = ownsShield;
module.exports.SHIELD_STEPS = SHIELD_STEPS;