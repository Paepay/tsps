/**
 * Corner Cutter (https://oldschool.runescape.wiki/w/Corner_Cutter_(Raging_Echoes_League)), Raging
 * Echoes' tier 2 relic: Agility actions always succeed, a lap counts twice and pays 25% more, and
 * a mark of grace spawns with 10,000 coins. Its Sage's greaves are granted by the unlock; their
 * run-XP effect is Common.watchRunXp (the Wiki's 10 + floor(Agility level x 2/3) every 10 run
 * ticks while they are worn). Not here either: the doubled pyramid tops, hallowed marks, vouchers
 * and shards (their plugins hand them out without a seam).
 */
const Common = require("./Common.LeagueRelics");

let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function succeeds(request) {
  if (active(request.player)) request.success = true;
}

function lapReward(request) {
  if (!active(request.player)) return;
  request.count = effect.lapCount;
  request.xp *= effect.lapXpMultiplier;
}

function markCoins(request) {
  if (active(request.player)) request.items.push([core.ItemIdentifiers.COINS, effect.markCoins]);
}

/** The greaves' run XP: started at login and on wear or unlock, stopped when they come off. */
function watchFromEvent({ player }) {
  Common.watchRunXp(player, effect);
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.cornerCutter;
  api.onCustomEvent("agility:roll", succeeds);
  api.onCustomEvent("agility:lap-reward", lapReward);
  api.onCustomEvent("agility:mark", markCoins);
  api.onCustomEvent("league:login", watchFromEvent);
  api.onCustomEvent("league:relic-unlocked", watchFromEvent);
  api.onCustomEvent("equipment:changed", watchFromEvent);
  api.onCustomEvent("player:bootstrap-complete", watchFromEvent);
};
