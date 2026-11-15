/**
 * Corner Cutter (https://oldschool.runescape.wiki/w/Corner_Cutter_(Raging_Echoes_League)), Raging
 * Echoes' tier 2 relic: Agility actions always succeed, a lap counts twice and pays 25% more, and
 * a mark of grace spawns with 10,000 coins. Its Sage's greaves are granted by the unlock; their
 * run-XP effect is not here. Not here either: the doubled pyramid tops, hallowed marks, vouchers
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

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.cornerCutter;
  api.onCustomEvent("agility:roll", succeeds);
  api.onCustomEvent("agility:lap-reward", lapReward);
  api.onCustomEvent("agility:mark", markCoins);
};
