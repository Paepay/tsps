"use strict";

/**
 * Barlak (https://oldschool.runescape.wiki/w/Barlak) buys long and curved bones from the
 * inventory and the bank: 1,000 coins and 4,500 Construction experience for a long bone,
 * 2,000 coins and 6,750 experience for a curved one. The experience needs level 30
 * Construction and a player-owned house; the coins do not. Barlak takes every bone at once.
 * The Carpenter's outfit does not boost this experience, so it is added directly.
 */
const BARLAK = 2344;
const CONSTRUCTION_LEVEL = 30;
const BONE_VARIANT = "with-curved-bones-or-long-bones-in-the-player-s-inventory-or-bank";
/** "Barlak gives you a short lecture and you learn more about Construction." */
const LECTURE_STEP_ID = "ydyVKP";

let api = null;
let core = null;

function boneTypes() {
  const I = core.ItemIdentifiers;
  return [
    { ids: [I.LONG_BONE, I.LONG_BONE_2], coins: 1000, experience: 4500 },
    { ids: [I.CURVED_BONE, I.CURVED_BONE_2], coins: 2000, experience: 6750 },
  ];
}

/** Every bank tab but the search tab, which only mirrors the others. */
function bankTabs(player) {
  const excluded = core.Bank.BANK_SEARCH_TAB_INDEX;
  return (player.getBanks?.() ?? []).filter((bank, tab) => bank && tab !== excluded);
}

function countInContainers(containers, ids) {
  return containers.reduce((total, container) => total + ids.reduce((sum, id) => sum + (container.getAmount?.(id) ?? 0), 0), 0);
}

function boneCounts(player) {
  const containers = [player.getInventory(), ...bankTabs(player)];
  return boneTypes().map((bone) => ({ ...bone, amount: countInContainers(containers, bone.ids) }));
}

function totalCoins(counts) {
  return counts.reduce((sum, bone) => sum + bone.amount * bone.coins, 0);
}

function hasBones(player) {
  return boneCounts(player).some((bone) => bone.amount > 0);
}

function selectVariant({ player, npcId }) {
  if (npcId !== BARLAK || !hasBones(player)) return null;
  return BONE_VARIANT;
}

/** The transcript's "[X] gp" is the offer for everything the player is carrying. */
function fillLine(event) {
  if (event.npcId !== BARLAK || typeof event.text !== "string" || !event.text.includes("[X]")) return;
  event.text = event.text.replace("[X]", totalCoins(boneCounts(event.player)).toLocaleString("en-US"));
}

function ownsHouse(player) {
  const query = { player, owns: false };
  api.emitCustomEvent("construction:owns-house", query);
  return query.owns === true;
}

function knowsConstruction(player) {
  return player.getSkillManager().getCurrentLevel(core.Skill.CONSTRUCTION) >= CONSTRUCTION_LEVEL && ownsHouse(player);
}

function takeBones(player) {
  const inventory = player.getInventory();
  const banks = bankTabs(player);
  for (const bone of boneTypes()) {
    for (const id of bone.ids) {
      const held = inventory.getAmount(id);
      if (held > 0) inventory.deleteNumber(id, held);
      for (const bank of banks) {
        const banked = bank.getAmount(id);
        if (banked > 0) bank.deleteNumber(id, banked);
      }
    }
  }
  inventory.refreshItems?.();
  if (core.Bank.isOpen?.(player)) player.getBank(player.getCurrentBankTab?.() ?? 0).refreshItems();
}

function buyBones(event) {
  if (event.npcId !== BARLAK || event.stepId !== LECTURE_STEP_ID) return;
  const { player } = event;
  const counts = boneCounts(player);
  const coins = totalCoins(counts);
  if (coins <= 0) return;
  const inventory = player.getInventory();
  const payment = new core.Item(core.ItemIdentifiers.COINS, coins);
  if (inventory.getAddableAmount(payment) < coins) {
    player.sendMessage("You need a free inventory slot to take Barlak's coins.");
    return;
  }
  takeBones(player);
  inventory.addItem(payment);
  if (knowsConstruction(player)) {
    const experience = counts.reduce((sum, bone) => sum + bone.amount * bone.experience, 0);
    if (experience > 0) player.getSkillManager().addExperiences(core.Skill.CONSTRUCTION, experience);
    player.sendMessage(`Barlak gives you ${coins.toLocaleString("en-US")} coins and teaches you about Construction.`);
  } else {
    player.sendMessage(`Barlak gives you ${coins.toLocaleString("en-US")} coins.`);
  }
}

module.exports = {
  name: "Barlak",
  description: "Barlak buys long and curved bones from the inventory and bank for coins and Construction experience.",
  members: true,
  _test: { boneCounts, totalCoins, selectVariant, fillLine, buyBones, LECTURE_STEP_ID, BONE_VARIANT },
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;
    api.onNpcDialogueVariant(selectVariant);
    api.onCustomEvent("npc-dialogue:line", fillLine);
    api.onCustomEvent("npc-dialogue:action", buyBones);
  },
};
