"use strict";

/**
 * A demonic gorilla's protection prayer (Wiki, rsprox captures):
 *
 * - It protects against one style, shown by which of its three ids it is, and a hit in that
 *   style does nothing. Verac's set gets through, and so do the ancient mace and dragon sword
 *   specials (22 October 2025 update); other special attacks don't.
 * - Once it has taken four damaging hits and 70 damage in styles it doesn't protect against,
 *   it protects against the style of the hit that took it there: it changes id and beats its
 *   chest on the same tick.
 *
 * Hits are checked as they are queued, so a blocked hit gives no XP, and again as they land,
 * so a hit already on its way when it changes prayer does nothing either.
 */
const { DEMONIC_IDS, PRAYER_SWITCH_HITS, PRAYER_SWITCH_DAMAGE, SEQ } = require("./Data.DemonicGorillas");
const State = require("./State.DemonicGorillas");

let core = null;

function styleOf(combatType) {
  const { CombatType } = core;
  if (combatType === CombatType.MELEE) return "melee";
  if (combatType === CombatType.RANGED) return "ranged";
  if (combatType === CombatType.MAGIC) return "magic";
  return null;
}

function isDemonic(npc) {
  return npc?.isNpc?.() && DEMONIC_IDS.includes(npc.getId());
}

/** Whether its prayer stops this hit. */
function blocks(npc, hit) {
  const style = styleOf(hit.getCombatType?.());
  return style !== null && style === State.protecting(npc) && !hit.bypassesProtectionPrayer?.();
}

function nullify(hit) {
  for (const part of hit.getHits()) part.setDamage(0);
  hit.updateTotalDamage();
}

/** Off-prayer damage adds up; at the threshold it protects against this hit's style. */
function countOffPrayer(npc, hit) {
  const style = styleOf(hit.getCombatType?.());
  const damage = hit.getTotalDamage();
  if (style === null || damage <= 0) return;
  const state = State.stateOf(npc);
  state.offPrayerHits++;
  state.offPrayerDamage += damage;
  if (state.offPrayerHits < PRAYER_SWITCH_HITS || state.offPrayerDamage < PRAYER_SWITCH_DAMAGE) return;
  state.offPrayerHits = 0;
  state.offPrayerDamage = 0;
  npc.setNpcTransformationId(State.familyOf(npc.getId())[style]);
  // Over the block the landing hit plays next: the capture shows only the chest beat.
  npc.performAnimation(new core.Animation(SEQ.smashChest, core.Priority.HIGH));
}

/** As a player's hit is queued, before its XP. */
function blockQueuedHit({ target, hit }) {
  if (isDemonic(target) && blocks(target, hit)) nullify(hit);
}

/** A league mastery's protection query: the gorilla's id is its overhead prayer. */
function answerScriptedProtection(query) {
  if (!query || query.protecting || !isDemonic(query.target)) return;
  const style = styleOf(query.combatType);
  if (style !== null && style === State.protecting(query.target)) query.protecting = true;
}

/** As any hit lands (thralls and allies included). */
function landHit({ npc, hit }) {
  if (!isDemonic(npc)) return;
  if (blocks(npc, hit)) {
    nullify(hit);
    return;
  }
  countOffPrayer(npc, hit);
}

module.exports = function attachPrayer(api) {
  core = api.core;
  api.onPlayerDealtDamage(blockQueuedHit);
  api.onNpcHitModify(landHit);
  api.onCustomEvent("combat:scripted-protection", answerScriptedProtection);
};

Object.assign(module.exports, { blocks, countOffPrayer, styleOf });
