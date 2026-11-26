"use strict";

/**
 * Tormented demon remains: the smouldering pile of flesh, heart and gland
 * (https://oldschool.runescape.wiki/w/Smouldering_pile_of_flesh,
 * https://oldschool.runescape.wiki/w/Smouldering_heart,
 * https://oldschool.runescape.wiki/w/Smouldering_gland).
 *
 * The cache gives each its own ground option instead of Take: "Eat-from" on the flesh and
 * "Crush" on the heart and gland (action 3), and none may be telegrabbed. The Wiki's documented
 * values are the flesh's 18 at 99 and four bites, the heart's +20 Attack/Strength/Defence, +14
 * Ranged and +11 Magic at 99 held for two minutes, and the gland's 10-15 Prayer every few seconds
 * for about 49 seconds. Only the level-99 values are published: the lower-level formulas, the
 * flesh's overheal cap below 99 and the gland's exact pulse clock are this server's approximations.
 * Every pile lasts ten minutes on the floor, paused while its owner is logged out.
 */

const { boostSkill } = require("../../items/ConsumableEffects");

const FLESH_BITES = 4;
const FLESH_HEAL_AT_99 = 18;
const LEVEL_99 = 99;
const FLESH_BITES_META = "tormented-remains:bites";

const HEART_HOLD_MS = 2 * 60 * 1000;
const HEART_UNTIL_ATTRIBUTE = "tormented-remains:heart-until";
const HEART_BOOSTS = Object.freeze([
  Object.freeze({ skill: "ATTACK", at99: 20 }),
  Object.freeze({ skill: "STRENGTH", at99: 20 }),
  Object.freeze({ skill: "DEFENCE", at99: 20 }),
  Object.freeze({ skill: "RANGED", at99: 14 }),
  Object.freeze({ skill: "MAGIC", at99: 11 }),
]);

const GLAND_PULSES = 10;
/** Ten pulses eight ticks apart: 48 seconds, the Wiki's "around 49 seconds". */
const GLAND_PULSE_TICKS = 8;
const GLAND_MIN = 10;
const GLAND_MAX = 15;

/** Ten minutes of 0.6-second game ticks. */
const REMAINS_DESPAWN_TICKS = 1000;

const FLESH_MESSAGE = "Even as the flesh burns your throat, you feel your wounds begin to mend.";
const HEART_MESSAGE = "You crush the heart. Dark energy swirls around you...";
const GLAND_MESSAGE = "You crush the gland, releasing its unholy blessing.";

let pluginApi = null;
const glandTasks = new WeakMap();

function core() {
  return pluginApi.core;
}

function remainsIds() {
  const ids = core().ItemIdentifiers;
  return Object.freeze({
    heart: ids.SMOULDERING_HEART,
    flesh: ids.SMOULDERING_PILE_OF_FLESH,
    gland: ids.SMOULDERING_GLAND,
  });
}

function isRemains(itemId) {
  const ids = remainsIds();
  return itemId === ids.heart || itemId === ids.flesh || itemId === ids.gland;
}

/** The Wiki's 18 at 99, scaled down for lower Hitpoints levels. */
function fleshHeal(maxHitpoints) {
  return Math.max(1, Math.floor((maxHitpoints * FLESH_HEAL_AT_99) / LEVEL_99));
}

function fleshBites(item) {
  const saved = item.getMetaValue(FLESH_BITES_META);
  return Number.isInteger(saved) && saved >= 0 ? saved : FLESH_BITES;
}

function eatFlesh(event) {
  event.handled = true;
  const { player, groundItem } = event;
  const item = groundItem.getItem();
  const bites = fleshBites(item);
  if (bites <= 0) {
    core().ItemOnGroundManager.deregister(groundItem);
    return true;
  }

  const skills = player.getSkillManager();
  const max = skills.getMaxLevel(core().Skill.HITPOINTS);
  const heal = fleshHeal(max);
  const cap = max + heal;
  const current = skills.getCurrentLevel(core().Skill.HITPOINTS);
  if (current >= cap) return true;

  player.setHitpoints(Math.min(current + heal, cap));
  player.sendMessage(FLESH_MESSAGE);
  const left = bites - 1;
  if (left > 0) item.setMetaValue(FLESH_BITES_META, left);
  else core().ItemOnGroundManager.deregister(groundItem);
  return true;
}

/** The Wiki's level-99 boosts scaled by the player's base level. */
function heartBoost(baseLevel, at99) {
  return Math.floor((baseLevel * at99) / LEVEL_99);
}

function applyHeartBoosts(player) {
  const skills = player.getSkillManager();
  for (const { skill, at99 } of HEART_BOOSTS) {
    const resolved = core().Skill[skill];
    const amount = heartBoost(skills.getMaxLevel(resolved), at99);
    if (amount > 0) boostSkill(player, resolved, amount, 0);
  }
}

function crushHeart(event) {
  event.handled = true;
  const { player, groundItem } = event;
  core().ItemOnGroundManager.deregister(groundItem);
  player.setAttribute(HEART_UNTIL_ATTRIBUTE, Date.now() + HEART_HOLD_MS);
  applyHeartBoosts(player);
  player.sendMessage(HEART_MESSAGE);
  return true;
}

function holdHeartBoosts({ player, held }) {
  const until = Number(player.getAttribute(HEART_UNTIL_ATTRIBUTE));
  if (!(until > Date.now())) return;
  const skills = player.getSkillManager();
  for (const { skill, at99 } of HEART_BOOSTS) {
    const resolved = core().Skill[skill];
    const max = skills.getMaxLevel(resolved);
    const boost = heartBoost(max, at99);
    if (boost > 0 && skills.getCurrentLevel(resolved) <= max + boost) held.add(resolved.getIndex());
  }
}

function processHeart({ player }) {
  const until = Number(player.getAttribute(HEART_UNTIL_ATTRIBUTE));
  if (until > 0 && Date.now() >= until) player.setAttribute(HEART_UNTIL_ATTRIBUTE, 0);
}

function stopGland(player) {
  const task = glandTasks.get(player);
  if (!task) return;
  task.stop();
  glandTasks.delete(player);
}

function restorePrayer(player, amount) {
  const skills = player.getSkillManager();
  const prayer = core().Skill.PRAYER;
  skills.increaseCurrentLevel(prayer, amount, skills.getMaxLevel(prayer));
}

function crushGland(event) {
  event.handled = true;
  const { player, groundItem } = event;
  core().ItemOnGroundManager.deregister(groundItem);
  player.sendMessage(GLAND_MESSAGE);

  stopGland(player);
  let pulses = GLAND_PULSES;
  const task = new (core().Task)(GLAND_PULSE_TICKS, player);
  task.execute = () => {
    if (player.getHitpoints() <= 0) {
      stopGland(player);
      return;
    }
    restorePrayer(player, GLAND_MIN + Math.floor(Math.random() * (GLAND_MAX - GLAND_MIN + 1)));
    pulses--;
    if (pulses <= 0) stopGland(player);
  };
  glandTasks.set(player, task);
  core().TaskManager.submit(task);
  return true;
}

function endGlandOnTeleport({ player }) {
  if (player) stopGland(player);
}

/** Marks every remaining drop with its ten-minute floor life ("npc-drops:generated"). */
function setRemainsLifetime(event) {
  for (const drop of event?.drops ?? []) {
    if (!isRemains(drop?.itemId)) continue;
    drop.ground = { ...(drop.ground ?? {}), despawnDelay: REMAINS_DESPAWN_TICKS };
  }
}

function pauseRemainsOnLogout({ player }) {
  if (!player?.getUsername) return;
  for (const groundItem of core().ItemOnGroundManager.ownedBy(player.getUsername())) {
    if (isRemains(groundItem.getItem().getId())) groundItem.setAgingPaused(true);
  }
}

function resumeRemainsOnLogin({ player }) {
  if (!player?.getUsername) return;
  for (const groundItem of core().ItemOnGroundManager.ownedBy(player.getUsername())) {
    if (isRemains(groundItem.getItem().getId())) groundItem.setAgingPaused(false);
  }
}

function refuseTelegrab(event) {
  const itemId = event?.groundItem?.getItem?.()?.getId?.();
  if (isRemains(itemId)) event.allow = false;
}

function refuseTake(event) {
  if (!isRemains(event?.itemId)) return;
  event.allow = false;
  event.amount = 0;
}

function attach(api) {
  pluginApi = api;
  api.persistAttribute(HEART_UNTIL_ATTRIBUTE, 0);
  const ids = remainsIds();
  api.onGroundItemClick(ids.flesh, 3, eatFlesh);
  api.onGroundItemClick(ids.heart, 3, crushHeart);
  api.onGroundItemClick(ids.gland, 3, crushGland);
  api.onCustomEvent("npc-drops:generated", setRemainsLifetime);
  api.onCustomEvent("magic:can-telekinetic-grab", refuseTelegrab);
  api.onCustomEvent("ground-items:take", refuseTake);
  api.onCustomEvent("teleport:landed", endGlandOnTeleport);
  api.onCustomEvent("stats:boost-held", holdHeartBoosts);
  api.onPlayerProcess(processHeart);
  api.onPlayerLogout(pauseRemainsOnLogout);
  api.onPlayerLogin(resumeRemainsOnLogin);
}

module.exports = {
  attach,
  _test: {
    FLESH_BITES,
    GLAND_PULSES,
    GLAND_PULSE_TICKS,
    REMAINS_DESPAWN_TICKS,
    FLESH_BITES_META,
    HEART_UNTIL_ATTRIBUTE,
    fleshHeal,
    heartBoost,
    fleshBites,
    setRemainsLifetime,
    pauseRemainsOnLogout,
    resumeRemainsOnLogin,
    refuseTelegrab,
    refuseTake,
    stopGland,
  },
};
