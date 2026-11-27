"use strict";

/**
 * Combat Global Events (Paepay/tsps#65).
 *
 * Berserker, Deadeye and Mystique make a player's matching attacks land on NPCs through every
 * defensive bonus and protection prayer. Onslaught raises the calculated maximum hit by 50% in
 * every style, before the damage roll. Bloodthirst gives every style the Amulet of blood fury's
 * proc, with no charges, and suppresses the amulet's own roll while it is on.
 *
 * Every hook checks that the target is an NPC. A player-versus-player hit is left completely
 * untouched, as the issue requires.
 *
 * Scripted invulnerability stays in force: the accuracy hooks only skip the accuracy roll and the
 * protection prayer, and never TimerKey.ATTACK_IMMUNITY, a boss's phase guards or an inaccessible
 * target (the engine refuses those attacks before a hit is queued).
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

/**
 * Onslaught: +50% calculated max hit in every style against NPCs. It raises the maximum the
 * damage roll uses, not a landed hit, so a minimum hit and an unlucky low roll stay low.
 */
function onslaughtMaxHit(attacker, target, combatType, maxHit) {
  if (!pvm(attacker, target)) return null;
  const player = playerOf(attacker);
  if (!enabled(player, "onslaught")) return null;
  const effect = Common.effectOf("onslaught");
  const multiplier = Number(effect?.multiplier ?? Common.definition("onslaught")?.config?.maxHitMultiplier ?? 1.5);
  if (!(multiplier > 1) || !(maxHit > 0)) return null;
  return Math.max(1, Math.floor(maxHit * multiplier));
}

/** Bloodthirst: the Blood Fury roll, heal and graphic for every style, against NPCs only. */
function bloodthirst({ player, target, hit }) {
  const owner = playerOf(player);
  if (!owner || target?.isNpc?.() !== true || !enabled(owner, "bloodthirst")) return;
  const config = Common.definition("bloodthirst")?.config ?? {};
  const chance = Number(config.procChance ?? 0.25);
  const fraction = Number(config.healFraction ?? 0.3);
  const graphicId = Number(config.graphic ?? 1542);
  const graphicHeight = Number(config.graphicHeight ?? 92);
  let shown = false;
  for (const resolved of Array.isArray(hit?.getHits?.()) ? hit.getHits() : []) {
    if (!(Number(resolved?.getDamage?.() ?? 0) > 0)) continue;
    if (!(Math.random() < chance)) continue;
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

/**
 * The equipped Amulet of blood fury asks before it rolls: while Bloodthirst is enabled the event
 * owns the single proc and heal, so the amulet must not roll a second time on the same hit.
 */
function suppressBloodFury(event) {
  if (!event?.player || !enabled(event.player, "bloodthirst")) return;
  event.suppressed = true;
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCombatHitRoll(hitRoll);
  api.registerMaxHitModifier({ modifyMaxHit: onslaughtMaxHit });
  api.onCustomEvent("combat:hit-queued", bloodthirst);
  api.onCustomEvent("combat:blood-fury-source", suppressBloodFury);
}

module.exports = { attach, _test: { hitRoll, onslaughtMaxHit, bloodthirst, suppressBloodFury } };
