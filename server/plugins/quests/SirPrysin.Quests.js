/**
 * Sir Prysin's post-quest Silverlight/Darklight repurchase when Quests is off.
 *
 * QuestAutoComplete loads only the quest definitions on these worlds, so DemonSlayer.Quest never
 * registers its dialogue conditions or action handler. Sir Prysin therefore plays his standard
 * post-quest transcript, asks for 500 coins and then hands over nothing. The ordinary quest path
 * upgrades the reissued sword to Darklight once Shadow of the Storm is complete; every quest is
 * complete on a Quests-off world, so this copies that result for Sir Prysin's own action.
 */
const SILVERLIGHT_PRICE = 500;
const HAS_ENOUGH_COINS = "kKVgcF";
const NOT_ENOUGH_COINS = "UktebL";
const LACKS_SPACE = "JzUWO5";
const RECEIVE_SILVERLIGHT = "p5BVZ5";

let pluginApi;

function sirPrysinIds() {
  const { NpcIdentifiers } = pluginApi.core;
  return new Set([NpcIdentifiers.SIR_PRYSIN, NpcIdentifiers.SIR_PRYSIN_2, NpcIdentifiers.SIR_PRYSIN_3]);
}

function questComplete(player, key) {
  const request = { player, key, complete: false };
  pluginApi.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

function hasItem(player, itemId) {
  return player.getInventory().getAmount(itemId) > 0;
}

function bankHasItem(player, itemId) {
  return player.getBanks?.()?.some((bank) => bank && bank.getAmount(itemId) > 0) === true;
}

function ownsSword(player) {
  const { ItemIdentifiers } = pluginApi.core;
  const swordIds = [ItemIdentifiers.SILVERLIGHT, ItemIdentifiers.SILVERLIGHT_2, ItemIdentifiers.DARKLIGHT];
  return swordIds.some((itemId) => hasItem(player, itemId) || bankHasItem(player, itemId)
    || (player.getEquipment().getItems() || []).some((item) => item && item.getId?.() === itemId));
}

function hasEnoughCoins(player) {
  return player.getInventory().getAmount(pluginApi.core.ItemIdentifiers.COINS) >= SILVERLIGHT_PRICE;
}

/** The sword Shadow of the Storm leaves behind; on these worlds that quest always counts complete. */
function replacementSword(player) {
  return questComplete(player, "shadow_of_the_storm")
    ? pluginApi.core.ItemIdentifiers.DARKLIGHT
    : pluginApi.core.ItemIdentifiers.SILVERLIGHT;
}

function buySword(player) {
  const inventory = player.getInventory();
  if (ownsSword(player) || !hasEnoughCoins(player) || inventory.isFull()) return false;
  inventory.deleteNumber(pluginApi.core.ItemIdentifiers.COINS, SILVERLIGHT_PRICE);
  inventory.adds(replacementSword(player), 1);
  return true;
}

function answerCondition({ player, npcId, stepId, text }) {
  if (!player || !sirPrysinIds().has(npcId)) return null;
  const value = String(text ?? "").toLowerCase();
  const inventory = player.getInventory();
  if (stepId === HAS_ENOUGH_COINS || value.includes("has at least 500 coins")) {
    return hasEnoughCoins(player) && !inventory.isFull();
  }
  if (stepId === NOT_ENOUGH_COINS || value.includes("does not have at least 500 coins")) {
    return !hasEnoughCoins(player);
  }
  if (stepId === LACKS_SPACE || value.includes("lacks sufficient inventory space")) {
    return inventory.isFull();
  }
  return null;
}

function handleAction(event) {
  if (!event || event.stepId !== RECEIVE_SILVERLIGHT || !sirPrysinIds().has(event.npcId)) return;
  buySword(event.player);
  event.handled = true;
}

module.exports = function attachSirPrysinQuests(api) {
  pluginApi = api;
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:action", handleAction);
};
