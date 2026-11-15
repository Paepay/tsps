/**
 * Trickster (https://oldschool.runescape.wiki/w/Trickster), Trailblazer Reloaded's tier 1 relic:
 * Thieving, Agility, Hunter and Firemaking actions always succeed, the coin pouch limit is
 * tripled, a pickpocket repeats itself and its loot is doubled and noted, box traps lure faster
 * (ours: the trap's look for prey every 2 ticks instead of 5) with double loot and XP, impling
 * jars never break, and up to nine logs burn in one action. It grants Sage's greaves (the custom
 * item); wearing them pays Agility XP while the player runs (Common.watchRunXp, the Wiki's
 * 10 + floor(Agility level x 2/3) every 10 run ticks).
 */
const Common = require("./Common.LeagueRelics");

let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

/** The pickpocket always lands, and the pouch limit is tripled. */
function pickpocketTarget(request) {
  if (!request.target || !active(request.player)) return;
  request.alwaysSucceeds = true;
  request.pouchLimit *= effect.pouchLimitMultiplier;
}

/** Doubled and noted (coins as a second pouch: ours; a clue, or an item that neither stacks nor notes, once). */
function loot(request) {
  if (active(request.player)) request.loot = Common.multipliedLoot(request.loot, effect.lootMultiplier);
}

function pickpocketAgain(request) {
  if (request.kind === "pickpocket" && active(request.player)) request.again = true;
}

function succeeds(request) {
  if (active(request.player)) request.success = true;
}

function catchChance(request) {
  if (active(request.player)) request.chance = 1;
}

/** Box traps: double loot and XP, and a quicker look for prey. */
function boxRewards(request) {
  if (request.kind !== "box" || !active(request.player)) return;
  request.rewards = request.rewards.map(([itemId, amount]) => [itemId, amount * effect.boxTrapMultiplier]);
  request.xp *= effect.boxTrapMultiplier;
}

function boxLure(request) {
  if (request.kind === "box" && active(request.player)) request.ticks = effect.boxTrapLureTicks;
}

function jarKept(request) {
  if (active(request.player)) request.kept = true;
}

function logsPerAction(request) {
  if (active(request.player)) request.amount = effect.logsPerAction;
}

/** The greaves' run XP: started at login and on wear or unlock, stopped when they come off. */
function watchFromEvent({ player }) {
  Common.watchRunXp(player, effect);
}

module.exports = function attach(api) {
  effect = Common.data.effects.trickster;
  api.onCustomEvent("thieving:pickpocket-target", pickpocketTarget);
  api.onCustomEvent("thieving:loot", loot);
  api.onCustomEvent("thieving:done", pickpocketAgain);
  api.onCustomEvent("agility:roll", succeeds);
  api.onCustomEvent("hunter:catch-chance", catchChance);
  api.onCustomEvent("hunter:rewards", boxRewards);
  api.onCustomEvent("hunter:lure-interval", boxLure);
  api.onCustomEvent("hunter:jar-kept", jarKept);
  api.onCustomEvent("firemaking:light-roll", succeeds);
  api.onCustomEvent("firemaking:logs-per-action", logsPerAction);
  api.onCustomEvent("league:login", watchFromEvent);
  api.onCustomEvent("league:relic-unlocked", watchFromEvent);
  api.onCustomEvent("equipment:changed", watchFromEvent);
  api.onCustomEvent("player:bootstrap-complete", watchFromEvent);
};
