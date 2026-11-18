/**
 * Claiming diary rewards from each diary's NPC, as captured with Two-pints: Talk-to while a
 * finished tier is unclaimed plays that tier's claim conversation (from the Wiki transcript,
 * stored in the data file), and the items and the reward varbit come where it says "reward" -
 * right after "Yes please!". With nothing to claim, Talk-to falls through to the NPC's transcript,
 * whose "<NPC> gives you another ..." line hands back a lost reward item.
 */
const QuestRuntime = require("../../quests/QuestRuntime");
const { TIERS, BY_NPC, LAMPS } = require("./Data.AchievementDiaries");
const Progress = require("./Progress.AchievementDiaries");

const REWARD_NPCS = [...BY_NPC.keys()];

let pluginApi;

/** The tier to claim: the lowest finished, unclaimed one whose lower tiers are all finished. */
function claimableTier(player, diary) {
  const claimed = Progress.claimedTiers(player, diary);
  for (const tier of TIERS) {
    if (!Progress.isTierComplete(player, diary, tier)) return null;
    if (!claimed.has(tier)) return tier;
  }
  return null;
}

/**
 * When AchievementDiaries is off, its stand-in completes every tier and hands out the rewards
 * regardless of stats. That fallback withholds the tier's antique lamp: completing the tasks was
 * not earned, so its experience must not be either. The unique item and its perks stay claimable.
 */
function rewardPolicy(player) {
  const request = { player, unrestricted: false, includeXpLamps: true };
  pluginApi.emitCustomEvent("diary:rewards-unrestricted", request);
  return request;
}

/** The tier's reward items, with lamps omitted when the completion was automatic. */
function claimItems(diary, tier, { includeXpLamps = true } = {}) {
  return diary.tiers[tier].rewardItems.filter((id) => includeXpLamps || !LAMPS.has(id));
}

/**
 * The claim transcript without the lines that promise the antique lamp. Karamja's reward NPC
 * names the lamp inside the tier's description, and one tier splits "lamp" and "too." across
 * two boxes, so remove the sentence and any dangling continuation rather than the whole box.
 */
const LAMP_PROMISE = /\s*(?:Ye|You) can have (?:this|that) lamp(?: too)?\.?\s*/i;

function claimSteps(claim, includeXpLamps = true) {
  if (includeXpLamps) return claim;
  const steps = [];
  let lampTail = false;
  for (const step of claim) {
    const speaker = step.player !== undefined ? "player" : step.npc !== undefined ? "npc" : null;
    if (!speaker) {
      steps.push(step);
      continue;
    }
    const text = String(step[speaker]);
    const stripped = text.replace(LAMP_PROMISE, " ").replace(/\s+/g, " ").trim();
    const promisedLamp = stripped !== text.trim();
    if (!stripped) {
      lampTail = promisedLamp;
      continue;
    }
    if (lampTail && /^too\.?$/i.test(stripped)) {
      lampTail = false;
      continue;
    }
    lampTail = promisedLamp;
    steps.push({ ...step, [speaker]: stripped });
  }
  return steps;
}

function meetsRequirement(player, requirement) {
  if (!requirement || rewardPolicy(player).unrestricted === true) return true;
  const skill = pluginApi.core.Skill.values().find((entry) => entry.getName().toLowerCase() === requirement.skill.toLowerCase());
  return !skill || player.getSkillManager().getCurrentLevel(skill) >= requirement.level;
}

function grant(player, diary, tier, generation) {
  const inventory = player.getInventory();
  const items = claimItems(diary, tier, rewardPolicy(player));
  if (Progress.tierGeneration(player, diary, tier) !== generation || claimableTier(player, diary) !== tier
    || !meetsRequirement(player, diary.tiers[tier].requirement)
    || inventory.getFreeSlots() < items.length
    || (typeof inventory.getAddableAmount === "function"
      && items.some((id) => inventory.getAddableAmount(new pluginApi.core.Item(id, 1)) < 1))) {
    player.sendMessage(inventory.getFreeSlots() < items.length
      ? `You need ${items.length} free inventory spaces to claim your reward.`
      : "You can no longer claim this reward.");
    return false;
  }
  for (const id of items) inventory.adds(id, 1);
  Progress.claimTier(player, diary, tier);
  return true;
}

function claimedHighestTier(player, diary) {
  const claimed = Progress.claimedTiers(player, diary);
  return [...TIERS].reverse().find((tier) => claimed.has(tier)) ?? null;
}

/** Another copy is handed back only while the player owns none in the inventory, worn or bank. */
function owns(player, itemId) {
  return pluginApi.core.Bank.owns(player, itemId);
}

function giveAnotherCloak(player, diary) {
  const tier = claimedHighestTier(player, diary);
  if (!tier || owns(player, diary.tiers[tier].rewardItems[0])) {
    player.sendMessage(`You don't need another ${diary.itemNoun} right now.`);
    return false;
  }
  const inventory = player.getInventory();
  if (inventory.getFreeSlots() < 1) {
    player.sendMessage("You don't have enough inventory space.");
    return false;
  }
  inventory.adds(diary.tiers[tier].rewardItems[0], 1);
  return true;
}

function toSteps(claim, onReward) {
  return claim.map((step) => step.reward ? { exec: onReward, stopOnFalse: true }
    : step.npc !== undefined ? { npc: [step.npc] } : { player: [step.player] });
}

function talkTo(event) {
  const { player, definition } = event;
  const diary = BY_NPC.get(definition.getName());
  const tier = diary && claimableTier(player, diary);
  if (!tier) return false;
  const data = diary.tiers[tier];
  const policy = rewardPolicy(player);
  const items = claimItems(diary, tier, policy);
  const claim = claimSteps(data.claim, policy.includeXpLamps);
  const context = { npcId: definition.getId() };
  const opening = claim.find((step) => step.player !== undefined);
  const generation = Progress.tierGeneration(player, diary, tier);
  if (!meetsRequirement(player, data.requirement)) {
    QuestRuntime.startDialogue(pluginApi, player, context, [
      { player: [opening.player] },
      ...data.requirement.refusal.map((line) => ({ npc: [line] })),
      { exec: () => QuestRuntime.startTranscript(pluginApi, player, definition.getId(), "Two-pints", "standard-dialogue", (steps) => steps.slice(1)) },
    ]);
    return true;
  }
  if (player.getInventory().getFreeSlots() < items.length) {
    player.sendMessage(`You need ${items.length} free inventory spaces to claim your reward.`);
    return true;
  }
  QuestRuntime.startDialogue(pluginApi, player, context, toSteps(claim, () => grant(player, diary, tier, generation)));
  return true;
}

/** "<NPC> gives you another ...": the highest claimed tier's item, when none is owned. */
function reclaim(action) {
  if (action.kind !== "message" || !/gives you (another|some more)/i.test(String(action.text ?? ""))) return;
  const diary = BY_NPC.get(action.definition?.getName?.());
  if (!diary) return;
  const { player } = action;
  action.handled = true;
  if (!giveAnotherCloak(player, diary)) {
    return;
  }
  player.sendMessage(String(action.text));
}

module.exports = function attachRewards(api) {
  pluginApi = api;
  api.onNpcsInteraction(REWARD_NPCS, { "Talk-to": talkTo });
  api.onCustomEvent("npc-dialogue:action", reclaim);
};

Object.assign(module.exports, { claimableTier, claimItems, claimSteps, rewardPolicy, talkTo, reclaim, owns });
