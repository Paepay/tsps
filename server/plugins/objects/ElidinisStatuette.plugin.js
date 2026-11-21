/**
 * Nardah's Elidinis Statuette (loc 10439, "Pray-at"; the base 10438 before Spirits of the Elid
 * restores it). Wiki (Elidinis Statuette): praying restores Hitpoints, Prayer points, run energy
 * and special attack energy to full, cures poison, venom and bleed, and raises the player's
 * Hitpoints 7 above their maximum.
 */
const { Animation } = require("../../src/main/typescript/elvarg/game/model/Animation");
const { Skill } = require("../../src/main/typescript/elvarg/game/model/Skill");
const { CombatSpecial } = require("../../src/main/typescript/elvarg/game/content/combat/CombatSpecial");
const QuestRuntime = require("../quests/QuestRuntime");

const PRAY_AT_ALTAR_ANIMATION = new Animation(645);
const BLEED_TASK_KEY = "combat:bleed:task-key";
const HITPOINTS_BOOST = 7;
const QUEST = "SpiritsOfTheElid";

let TaskManager = null;

function questComplete(player) {
  const quest = QuestRuntime.getRegisteredQuests().find((entry) => entry.name === QUEST);
  return !quest || quest.isComplete(player);
}

function clearBleed(player) {
  const bleedTaskKey = player.getAttribute?.(BLEED_TASK_KEY);
  if (!bleedTaskKey) return;
  TaskManager?.cancelTasks?.(bleedTaskKey);
  player.setAttribute?.(BLEED_TASK_KEY, null);
}

function prayAtStatuette(event) {
  const player = event.player;
  event.handled = true;
  if (!questComplete(player)) {
    player.sendMessage("The statuette is not yet restored.");
    return;
  }
  const skills = player.getSkillManager();
  const maxHitpoints = skills.getMaxLevel(Skill.HITPOINTS);
  const boostedHitpoints = Math.max(skills.getCurrentLevel(Skill.HITPOINTS), maxHitpoints + HITPOINTS_BOOST);
  player.performAnimation(PRAY_AT_ALTAR_ANIMATION);
  player.setHitpoints(boostedHitpoints);
  skills.setCurrentLevels(Skill.HITPOINTS, boostedHitpoints, true);
  skills.setCurrentLevels(Skill.PRAYER, skills.getMaxLevel(Skill.PRAYER), true);
  player.setPrayerPointDrain(0);
  player.setRunEnergy(100);
  player.getPacketSender?.().sendRunEnergy?.();
  player.setSpecialActivated?.(false);
  player.setRecoveringSpecialAttack?.(false);
  player.setSpecialPercentage?.(100);
  player.getSpecialAttackRestore?.().stop?.();
  CombatSpecial.updateBar?.(player);
  player.setPoisonDamage?.(0);
  player.setVenomed?.(false);
  clearBleed(player);
  player.sendMessage("You feel reinvigorated.");
}

module.exports = {
  name: "ElidinisStatuette",
  description: "Nardah's Elidinis Statuette restores Hitpoints, Prayer, run energy and special attack, cures poison, venom and bleed, and boosts Hitpoints, once Spirits of the Elid is complete.",
  register(api) {
    TaskManager = api.getTaskManager();
    api.onObjectInteraction("Elidinis Statuette", { "Pray-at": prayAtStatuette });
  },
};

module.exports._test = { prayAtStatuette };