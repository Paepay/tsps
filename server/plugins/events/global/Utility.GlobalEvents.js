"use strict";

/**
 * Utility Global Events (Paepay/tsps#65).
 *
 * Rags to Riches adds a multiplicative chance to unique-only NPC drops (and to the named raid
 * unique rollers). Accelerate multiplies every experience gain once, through the core's
 * multiplier hook, so no XP source is left out and no gain recurses. Prodigy raises every
 * skill's resting level by 12 and refreshes the current level each tick, excluding Hitpoints
 * and Prayer so it cannot restore them endlessly.
 */

const Common = require("./Common.GlobalEvents");

let api;
let core;

function enabled(player, eventId) {
  return Common.effectsEnabled(player, eventId);
}

/* ------------------------------------------------------- Rags to Riches --- */

function uniqueRule(event) {
  if (!event?.player || !Array.isArray(event.rules) || !enabled(event.player, "rags-to-riches")) return;
  const multiplier = Number(Common.effectOf("rags-to-riches")?.multiplier
    ?? Common.definition("rags-to-riches")?.config?.multiplier ?? 1.1);
  if (multiplier > 1) event.rules.push({ pattern: /.*/, multiplier });
}

function raidRule(event) {
  if (!event?.player || !Array.isArray(event.rules) || !enabled(event.player, "rags-to-riches")) return;
  const raids = Common.config().uniqueDropChance?.raids ?? [];
  if (!raids.includes(event.source)) return;
  const multiplier = Number(Common.effectOf("rags-to-riches")?.multiplier
    ?? Common.definition("rags-to-riches")?.config?.multiplier ?? 1.1);
  if (multiplier > 1) event.rules.push({ pattern: /.*/, multiplier });
}

/* -------------------------------------------------------------- Accelerate --- */

function accelerate(event) {
  if (!event?.player || !enabled(event.player, "accelerate")) return;
  const multiplier = Number(Common.effectOf("accelerate")?.multiplier
    ?? Common.definition("accelerate")?.config?.multiplier ?? 2);
  if (multiplier > 0) event.multiplier = (Number(event.multiplier) || 1) * multiplier;
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

/** Keep every non-excluded skill at least at base + 12, without lowering a higher boost. */
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
  api.onCustomEvent("npc-drops:unique-chance", uniqueRule);
  api.onCustomEvent("drops:chance", raidRule);
}

module.exports = { attach, _test: { uniqueRule, raidRule, accelerate, restingLevel, refresh } };
