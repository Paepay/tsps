/**
 * Shared by the LeagueCombatMasteries units: the data (league-combat-masteries.json), whether a
 * character is a Raging Echoes one (LeagueMode's `league:profile`), its masteries, its points
 * and the lookups the other units need.
 */
const fs = require("fs");
const path = require("path");

/** Unlocked tiers per style: { melee, ranged, magic } (0-6). */
const MASTERIES_ATTRIBUTE = "league:masteries";
/** Combat Mastery points earned: challenge key -> 1. */
const POINTS_ATTRIBUTE = "league:mastery-points";
/** Progress towards the counted challenges: challenge key -> a count, or the distinct names seen. */
const PROGRESS_ATTRIBUTE = "league:mastery-progress";

const STYLE_KEYS = ["melee", "ranged", "magic"];

let api = null;
let core = null;
let data = null;

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "league-combat-masteries.json"), "utf8"));
}

/** Whether the player is on the Level-Up world. */
function isLevelUp(player) {
  if (player?.isPlayer?.() !== true) return false;
  const levelUp = { player, active: false };
  api.emitCustomEvent("level-up:mastery-profile", levelUp);
  return levelUp.active === true;
}

/** Whether the player is a character of the league these masteries belong to (Raging Echoes or Level-Up). */
function isEchoes(player) {
  if (player?.isPlayer?.() !== true) return false;
  const query = { player, league: null };
  api.emitCustomEvent("league:profile", query);
  if (Number(query.league) === data.league) return true;
  // Level-Up enables the same mastery challenge and unlock systems without a
  // Raging Echoes league save or seasonal tasks.
  return isLevelUp(player);
}

/** Level-Up's challenge list without entries this cache cannot support. */
function levelUpChallenges() {
  return data.challenges.list.filter((challenge) => !challenge._missing);
}

function emptyMasteries() {
  return { melee: 0, ranged: 0, magic: 0 };
}

function masteries(player) {
  const value = player.getAttribute(MASTERIES_ATTRIBUTE);
  const tiers = emptyMasteries();
  if (value && typeof value === "object") {
    for (const style of STYLE_KEYS) tiers[style] = Math.max(0, Math.min(6, Number(value[style]) | 0));
  }
  return tiers;
}

function style(key) {
  return data.styles[key] ?? null;
}

/** The style whose attacks are of `combatType`. */
function styleOfCombatType(combatType) {
  return STYLE_KEYS.find((key) => core.CombatType[data.styles[key].combatType] === combatType) ?? null;
}

function mastery(styleKey, tier) {
  return style(styleKey)?.masteries[tier - 1] ?? null;
}

/** The mastery a tier's data says it `requires` ({ styleKey, tier, name }), or null for a first tier. */
function required(styleKey, tierNumber) {
  const key = mastery(styleKey, tierNumber)?.requires;
  if (!key) return null;
  for (const otherStyle of STYLE_KEYS) {
    const found = style(otherStyle).masteries.find((entry) => entry.key === key);
    if (found) return { styleKey: otherStyle, tier: found.tier, name: found.name };
  }
  return null;
}

/** The unlocked tier (0-6) of a style. */
function tier(player, styleKey) {
  return masteries(player)[styleKey] ?? 0;
}

/** Whether a Raging Echoes character has reached `tierNumber` of `styleKey`. */
function has(player, styleKey, tierNumber) {
  return isEchoes(player) && tier(player, styleKey) >= tierNumber;
}

/** The effect numbers of a style's tier when the player has it, else null. */
function effect(player, styleKey, tierNumber) {
  return has(player, styleKey, tierNumber) ? mastery(styleKey, tierNumber).effect : null;
}

/** The highest tier reached in any style: the passives apply up to it. */
function passiveTier(player) {
  const tiers = masteries(player);
  return Math.max(tiers.melee, tiers.ranged, tiers.magic);
}

function passive(tierNumber) {
  return data.passives[tierNumber - 1] ?? null;
}

/** The passive's effect numbers when a Raging Echoes character has reached its tier in any style, else null. */
function passiveEffect(player, tierNumber) {
  return isEchoes(player) && passiveTier(player) >= tierNumber ? passive(tierNumber).effect : null;
}

function pointsEarned(player) {
  const value = player.getAttribute(POINTS_ATTRIBUTE);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function earned(player) {
  const done = pointsEarned(player);
  if (!isLevelUp(player)) return Object.keys(done).length;
  const hidden = new Set(data.challenges.list.filter((challenge) => challenge._missing).map((challenge) => challenge.key));
  return Object.keys(done).filter((key) => !hidden.has(key)).length;
}

/** The challenge ids actually completed, separately from an uncapped mastery point balance. */
function completedChallengeKeys(player) {
  const done = pointsEarned(player);
  const challenges = isLevelUp(player) ? levelUpChallenges() : data.challenges.list;
  return challenges.filter((challenge) => done[challenge.key]).map((challenge) => challenge.key);
}

/** Challenges actually completed. */
function completedChallenges(player) {
  return completedChallengeKeys(player).length;
}

function spent(player) {
  const tiers = masteries(player);
  return tiers.melee + tiers.ranged + tiers.magic;
}

function available(player) {
  return Math.max(0, earned(player) - spent(player));
}

function progress(player) {
  const value = player.getAttribute(PROGRESS_ATTRIBUTE);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * The attacker's max hit for a combat type against `target`: magic through the target-aware hit
 * bounds a cast is rolled from (a barrage's secondary target has its own), the rest from the
 * formulas' source max hit.
 */
function maxHit(attacker, combatType, target) {
  const max = combatType === core.CombatType.MAGIC
    ? core.DamageFormulas.sourceHitBounds(attacker, combatType, target ?? undefined).maximum
    : core.DamageFormulas.sourceMaxHit(attacker, combatType);
  return Math.max(0, Math.floor(max));
}

function uid(group, child) {
  return (group << 16) | child;
}

function message(key, values = {}) {
  return data.messages[key].text.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
}

module.exports = {
  init, isLevelUp, isEchoes, levelUpChallenges, emptyMasteries, masteries, style, styleOfCombatType, mastery, required, tier, has, effect,
  passiveTier, passive, passiveEffect, pointsEarned, earned, completedChallengeKeys, completedChallenges, spent, available, progress, maxHit, uid, message,
  MASTERIES_ATTRIBUTE, POINTS_ATTRIBUTE, PROGRESS_ATTRIBUTE, STYLE_KEYS,
  get data() { return data; },
  get api() { return api; },
  get core() { return core; },
};
