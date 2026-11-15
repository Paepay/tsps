/**
 * Treasure Seeker (https://oldschool.runescape.wiki/w/Treasure_Seeker), Trailblazer Reloaded's
 * tier 5 relic: the shared clue perks (1 in 15 clue
 * scrolls, 10 times the clue vessels, the fewest steps, the most casket rolls), and an opened
 * reward casket may bring another of its tier, which may be a tier higher. The Wiki gives no
 * chances for the last: ours, 1 in 5 for a beginner casket down to 1 in 20 for a master one, and 1
 * in 4 of those a tier higher (never above master).
 */
const Common = require("./Common.LeagueRelics");
const attachClues = require("./Clues.LeagueRelics");

const TIERS = ["beginner", "easy", "medium", "hard", "elite", "master"];

let core;
let effect;

function casketId(tier) {
  return core.ItemIdentifiers[`REWARD_CASKET_${tier.toUpperCase()}_`];
}

/** Another casket: in the inventory, else the bank; none when neither has room. */
function giveCasket(player, itemId) {
  const inventory = player.getInventory();
  if (inventory.getFreeSlots() > 0) {
    inventory.add(new core.Item(itemId, 1));
    return true;
  }
  return Common.bank(player, itemId, 1);
}

function bonusCasket({ player, tier }) {
  if (!Common.effectActive(player, effect)) return;
  const oneIn = effect.bonusCasket[tier];
  if (!(oneIn > 0) || Math.floor(Math.random() * oneIn) !== 0) return;
  const index = TIERS.indexOf(tier);
  const upgraded = index >= 0 && index < TIERS.length - 1 && Math.floor(Math.random() * effect.upgradeOneIn) === 0;
  const given = upgraded ? TIERS[index + 1] : tier;
  const itemId = casketId(given);
  if (!Number.isInteger(itemId)) return;
  if (!giveCasket(player, itemId)) {
    player.sendMessage(Common.message("noRoom"));
    return;
  }
  player.sendMessage(Common.message(upgraded ? "bonusCasketUpgraded" : "bonusCasket", { tier: given }));
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.treasureSeeker;
  attachClues(api, effect);
  api.onCustomEvent("treasure-trails:casket-opened", bonusCasket);
};
