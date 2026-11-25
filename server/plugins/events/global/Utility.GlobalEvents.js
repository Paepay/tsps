"use strict";

/**
 * Utility Global Events (Paepay/tsps#65, PaeScape_Realms#110 follow-ups).
 *
 * Rags to Riches multiplies eligible unique rolls by 1.1: a boss NPC's unique table through
 * `npc-drops:chance` (uniqueOnly, so ordinary loot never moves) and the unique-only rollers of
 * the named bosses, raids and skilling encounters through `drops:chance`. Clue caskets, ordinary
 * loot and PvP are never boosted, and each reward asks once so nothing applies twice.
 *
 * Accelerate multiplies every experience gain once, through the core's multiplier hook, so no XP
 * source is left out and no gain recurses. Prodigy raises the resting level of the other 21
 * skills by 12 and refreshes the current level each tick, never Hitpoints or Prayer and never
 * below a boost the player already had.
 */

const Common = require("./Common.GlobalEvents");

let api;
let core;

function enabled(player, eventId) {
  return Common.effectsEnabled(player, eventId);
}

/* ------------------------------------------------------- Rags to Riches --- */

function multiplier() {
  return Number(Common.effectOf("rags-to-riches")?.multiplier
    ?? Common.definition("rags-to-riches")?.config?.multiplier ?? 1.1);
}

/** Boss NPC uniques: the same chance roll every entry uses, gated to unique rows. */
function uniqueRule(event) {
  if (!event?.player || !Array.isArray(event.rules) || !enabled(event.player, "rags-to-riches")) return;
  const factor = multiplier();
  if (factor > 1) event.rules.push({ pattern: /.*/, multiplier: factor, uniqueOnly: true });
}

/**
 * The unique-only rollers (raids, boss chests and skilling encounters). Each names its source on
 * `drops:chance` and only multiplies unique rows by the matching rule, so the whole-roll pattern
 * cannot reach ordinary supplies.
 */
function encounterRule(event) {
  if (!event?.player || !Array.isArray(event.rules) || !enabled(event.player, "rags-to-riches")) return;
  const sources = Common.config().uniqueDropChance?.sources ?? [];
  if (!sources.includes(event.source)) return;
  const factor = multiplier();
  if (factor > 1) event.rules.push({ pattern: /.*/, multiplier: factor });
}

/* -------------------------------------------------------------- Accelerate --- */

function accelerate(event) {
  if (!event?.player || !enabled(event.player, "accelerate")) return;
  const factor = Number(Common.effectOf("accelerate")?.multiplier
    ?? Common.definition("accelerate")?.config?.multiplier ?? 2);
  if (factor > 0) event.multiplier = (Number(event.multiplier) || 1) * factor;
}

/* ----------------------------------------------------------------- Prodigy --- */

function excludedSkills() {
  const names = Common.definition("prodigy")?.config?.excludedSkills ?? ["HITPOINTS", "PRAYER"];
  return new Set(names.map((name) => core.Skill[name]).filter(Boolean));
}

function prodigyBoost(player) {
  return enabled(player, "prodigy")
    ? Number(Common.effectOf("prodigy")?.levels ?? Common.definition("prodigy")?.config?.levelBoost ?? 12)
    : 0;
}

/** Prodigy never raises stats for a player fighting or standing in PvP. */
function inPvp(player) {
  if (player?.getCombat?.()?.getTarget?.()?.isPlayer?.() === true) return true;
  return core.Wilderness?.isPvpArea?.(player?.getLocation?.()) === true;
}

/** The resting level every skill decays toward while Prodigy is on. */
function restingLevel(player, skill, level) {
  const excluded = excludedSkills();
  if (excluded.has(skill) || inPvp(player)) return level;
  const boost = prodigyBoost(player);
  return boost > 0 ? level + boost : level;
}

/** Keep every other skill at least at base + 12, without lowering a higher boost. */
function refresh({ player }) {
  if (!player?.isPlayer?.() || !enabled(player, "prodigy") || inPvp(player)) return;
  const boost = prodigyBoost(player);
  if (boost <= 0) return;
  const excluded = excludedSkills();
  const skills = player.getSkillManager();
  for (const skill of core.Skill.values()) {
    if (excluded.has(skill)) continue;
    const floor = skills.getMaxLevel(skill) + boost;
    if (skills.getCurrentLevel(skill) < floor) skills.setCurrentLevel(skill, floor, true);
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.registerRestingLevelModifier(restingLevel);
  api.onPlayerProcess(refresh);
  api.onCanGainExperience(accelerate);
  api.onCustomEvent("npc-drops:chance", uniqueRule);
  api.onCustomEvent("drops:chance", encounterRule);
}

module.exports = { attach, _test: { uniqueRule, encounterRule, accelerate, restingLevel, refresh } };
