"use strict";

/**
 * Combat Global Events (Paepay/tsps#65).
 *
 * Berserker, Deadeye and Mystique make a player's matching attacks land on NPCs through every
 * defensive bonus and protection prayer. Onslaught raises the damage of each landed hit by 50%
 * (and therefore the maximum hit by 50%). Bloodthirst gives every style the Amulet of blood
 * fury's proc, with no charges.
 *
 * Every hook checks that the target is an NPC. A player-versus-player hit is left completely
 * untouched, as the issue requires.
 */

const Common = require("./Common.GlobalEvents");

let api;
let core;

function playerOf(attacker) {
  return attacker?.getAsPlayer?.() ?? (attacker?.isPlayer?.() ? attacker : null);
}

function pvm(attacker, target) {
  return !!playerOf(attacker) && target?.isNpc?.() === true;
}

function enabled(player, eventId) {
  return Common.effectsEnabled(player, eventId);
}

const ACCURACY_EVENTS = [
  { eventId: "berserker", fallbackStyle: "melee" },
  { eventId: "deadeye", fallbackStyle: "ranged" },
  { eventId: "mystique", fallbackStyle: "magic" },
];

function styleOf(entry) {
  const effect = Common.effectOf(entry.eventId);
  const name = String(effect?.style ?? Common.definition(entry.eventId)?.config?.combatType ?? entry.fallbackStyle);
  return core.CombatType[name.toUpperCase()] ?? null;
}

/** A matching accuracy event forces an accurate roll and ignores the target's protection prayer. */
function hitRoll(roll) {
  if (!roll || !pvm(roll.attacker, roll.target)) return;
  const player = playerOf(roll.attacker);
  for (const entry of ACCURACY_EVENTS) {
    if (!enabled(player, entry.eventId)) continue;
    if (roll.combatType !== styleOf(entry)) continue;
    roll.forceAccurate = true;
    roll.bypassProtectionPrayer = true;
    return;
  }
}

/** Onslaught: 50% more damage on each landed NPC hit, so its maximum hit is 50% higher. */
function onslaught(event) {
  if (!event || !pvm(event.attacker, event.target)) return;
  const player = playerOf(event.attacker);
  if (!enabled(player, "onslaught")) return;
  const damage = Number(event.damage?.getDamage?.() ?? 0);
  if (!(damage > 0)) return;
  const effect = Common.effectOf("onslaught");
  const multiplier = Number(effect?.multiplier ?? Common.definition("onslaught")?.config?.maxHitMultiplier ?? 1.5);
  event.damage.setDamage(Math.max(1, Math.floor(damage * multiplier)));
}

/** Bloodthirst: the Blood Fury roll, heal and graphic for every style, against NPCs only. */
function bloodthirst({ player, target, hit }) {
  const owner = playerOf(player);
  if (!owner || target?.isNpc?.() !== true || !enabled(owner, "bloodthirst")) return;
  const config = Common.definition("bloodthirst")?.config ?? {};
  const chance = Number(config.procChance ?? 0.2);
  const fraction = Number(config.healFraction ?? 0.3);
  const graphicId = Number(config.graphic ?? 1542);
  const graphicHeight = Number(config.graphicHeight ?? 92);
  let shown = false;
  for (const resolved of Array.isArray(hit?.getHits?.()) ? hit.getHits() : []) {
    if (!(Number(resolved?.getDamage?.() ?? 0) > 0)) continue;
    // The Amulet of blood fury rolls getRandom(4); use the same roll so this is its mechanic,
    // not a re-tuned approximation of it.
    const procs = core.Misc?.getRandom ? core.Misc.getRandom(4) === 0 : Math.random() < chance;
    if (!procs) continue;
    if (!shown) target.performGraphic?.(new core.Graphic(graphicId, 0, graphicHeight));
    shown = true;
    // Heal from the health actually lost when the hitsplat lands, so overkill and earlier
    // same-cycle damage do not count.
    resolved.onApplied?.((damageTaken) => {
      const heal = Math.floor(Number(damageTaken) * fraction);
      if (heal > 0) owner.heal(heal);
    });
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCombatHitRoll(hitRoll);
  api.onCombatHitDamage(onslaught);
  api.onCustomEvent("combat:hit-queued", bloodthirst);
}

module.exports = { attach, _test: { hitRoll, onslaught, bloodthirst } };
