/**
 * Eblis's post-Desert Treasure I ancient staff offer when Quests is off.
 *
 * QuestAutoComplete loads only the quest definitions on these worlds, so DesertTreasureI.Quest
 * never registers the dialogue variant or purchase hooks. Eblis therefore falls back to his
 * generic transcript even though every quest counts complete. The staff and price below mirror
 * that quest's post-quest offer; only the two cache Eblis spawns and their event variants are
 * claimed here.
 */
const PAGE = "Desert Treasure I";
const VARIANT = "post-quest-eblis";
const ANCIENT_STAFF_PRICE = 80_000;
const HAS_ENOUGH_GOLD = "nLCVju";
const NOT_ENOUGH_GOLD = "u6h-Hh";
const EBLIS_HAS_ENOUGH_GOLD = "m45i4l";
const EBLIS_NOT_ENOUGH_GOLD = "FHTjUy";
const RECEIVE_ANCIENT_STAFF = "J_39m0";

let pluginApi;

function complete(player) {
  const request = { player, key: "desert_treasure_i", complete: false };
  pluginApi.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

function eblisIds() {
  const { NpcIdentifiers } = pluginApi.core;
  return new Set([NpcIdentifiers.EBLIS, NpcIdentifiers.EBLIS_2, 1966, 1967]);
}

function hasCoins(player) {
  return player.getInventory().getAmount(pluginApi.core.ItemIdentifiers.COINS) >= ANCIENT_STAFF_PRICE;
}

function buyAncientStaff(player) {
  const { ItemIdentifiers } = pluginApi.core;
  const inventory = player.getInventory();
  if (!hasCoins(player)) {
    player.sendMessage("You need 80,000 coins to buy the ancient staff.");
    return false;
  }
  if (inventory.getFreeSlots() < 1) {
    player.sendMessage("You need a free inventory slot to carry the ancient staff.");
    return false;
  }
  inventory.deleteNumber(ItemIdentifiers.COINS, ANCIENT_STAFF_PRICE);
  inventory.adds(ItemIdentifiers.ANCIENT_STAFF, 1);
  player.sendMessage("Eblis hands you an ancient staff.");
  return true;
}

function selectVariant({ player, npcId }) {
  if (!player || !eblisIds().has(npcId) || !complete(player)) return null;
  return { page: PAGE, variant: VARIANT };
}

function answerCondition({ player, npcId, stepId, text }) {
  if (!player || !eblisIds().has(npcId) || !complete(player)) return null;
  const value = String(text ?? "").toLowerCase();
  if (stepId === HAS_ENOUGH_GOLD || value.includes("has enough gold to purchase")) return hasCoins(player);
  if (stepId === NOT_ENOUGH_GOLD || value.includes("doesn't have enough gold")
    || value.includes("does not have enough gold")) return !hasCoins(player);
  if (stepId === EBLIS_HAS_ENOUGH_GOLD || value.includes("has 80,000 coins")) return hasCoins(player);
  if (stepId === EBLIS_NOT_ENOUGH_GOLD || value.includes("does not have 80,000 coins")) return !hasCoins(player);
  return null;
}

function handleCondition({ player, npcId, stepId, text }) {
  if (!player || !eblisIds().has(npcId) || !complete(player)) return;
  const value = String(text ?? "").toLowerCase();
  if (stepId === null || stepId === undefined) {
    if (!value.includes("has enough gold to purchase")) return;
  } else if (stepId !== HAS_ENOUGH_GOLD) {
    return;
  }
  buyAncientStaff(player);
}

function handleAction(event) {
  if (event?.stepId !== RECEIVE_ANCIENT_STAFF || !event.player || !complete(event.player)) return;
  buyAncientStaff(event.player);
  event.handled = true;
}

module.exports = function attachEblisQuests(api) {
  pluginApi = api;
  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:condition", handleCondition);
  api.onCustomEvent("npc-dialogue:action", handleAction);
};
