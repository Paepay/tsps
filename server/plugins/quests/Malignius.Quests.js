/**
 * Malignius Mortifer's post-Fairytale magic secateurs repurchase when Quests is off.
 *
 * QuestAutoComplete loads only the quest definitions on these worlds, so
 * FairytaleIGrowingPains.Quest never registers its dialogue conditions or action handler.
 * Malignius still plays the generated transcript and accepts "Ok, great.", but nothing takes
 * the 40,000 coins or hands over the secateurs. This mirrors that quest's own purchase branch.
 */
const PRICE = 40_000;
const BUY_OPTION = "Ok, great.";
const HAS_COINS_AND_SPACE = "tAFeme";
const HAS_COINS_NO_SPACE = "QsUXgu";
const NOT_ENOUGH_COINS = "cTNZkA";
const RECEIVE_SECATEURS = "nMncT7";

let pluginApi;
const purse = new WeakMap();

function maligniusNpcId() {
  return pluginApi.core.NpcIdentifiers.MALIGNIUS_MORTIFER;
}

function readPurse(player) {
  const inventory = player.getInventory();
  return {
    coins: inventory.getAmount(pluginApi.core.ItemIdentifiers.COINS) >= PRICE,
    space: inventory.getFreeSlots() > 0,
  };
}

function rememberChoice({ player, npcId, option }) {
  if (!player || npcId !== maligniusNpcId()) return;
  if (option === BUY_OPTION) purse.set(player, readPurse(player));
  else purse.delete(player);
}

function answerCondition({ player, npcId, stepId, text }) {
  if (!player || npcId !== maligniusNpcId()) return null;
  const value = String(text ?? "").toLowerCase();
  const snapshot = purse.get(player) ?? readPurse(player);
  if (stepId === HAS_COINS_AND_SPACE || value.includes("has at least 40,000 coins, and enough inventory space")) {
    return snapshot.coins && snapshot.space;
  }
  if (stepId === HAS_COINS_NO_SPACE || value.includes("has at least 40,000 coins, but no inventory space")) {
    return snapshot.coins && !snapshot.space;
  }
  if (stepId === NOT_ENOUGH_COINS || value.includes("does not have at least 40,000 coins")) {
    return !snapshot.coins;
  }
  return null;
}

function buySecateurs(player) {
  const inventory = player.getInventory();
  const current = readPurse(player);
  if (!current.coins || !current.space) return false;
  inventory.deleteNumber(pluginApi.core.ItemIdentifiers.COINS, PRICE);
  inventory.adds(pluginApi.core.ItemIdentifiers.MAGIC_SECATEURS, 1);
  return true;
}

function handleAction(event) {
  if (!event || event.npcId !== maligniusNpcId()) return;
  const receivesSecateurs = event.stepId === RECEIVE_SECATEURS
    || (event.action === "receive" && /^magic secateurs$/i.test(String(event.text ?? "")));
  if (!receivesSecateurs) return;
  event.handled = true;
  buySecateurs(event.player);
}

module.exports = function attachMaligniusQuests(api) {
  pluginApi = api;
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:choice", rememberChoice);
  api.onCustomEvent("npc-dialogue:action", handleAction);
};
