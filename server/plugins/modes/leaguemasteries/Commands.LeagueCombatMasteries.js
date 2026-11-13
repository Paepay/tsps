/**
 * Developer commands: `::mastery` shows the character's tiers, points and challenges;
 * `::mastery <melee|ranged|magic> <tier 1-6>` unlocks through the usual checks;
 * `::mastery point <1-10>` awards a challenge's point through the real path (the only way to the
 * echo boss challenges, whose bosses this cache lacks).
 */
const Common = require("./Common.LeagueCombatMasteries");
const Points = require("./Points.LeagueCombatMasteries");
const Unlock = require("./Unlock.LeagueCombatMasteries");

function status(player) {
  const tiers = Common.masteries(player);
  const done = Common.completedChallengeKeys(player);
  player.sendMessage(Common.message("masteryStatus", {
    melee: tiers.melee, ranged: tiers.ranged, magic: tiers.magic, passive: Common.passiveTier(player),
    available: Common.available(player), earned: Common.earned(player),
    challenges: done.length ? done.join(", ") : Common.message("challengeNone"),
  }));
}

function masteryCommand({ player, parts }) {
  if (!Common.isEchoes(player)) {
    player.sendMessage(Common.message("notLeague"));
    return true;
  }
  const what = String(parts[1] ?? "").trim().toLowerCase();
  if (!what) {
    status(player);
    return true;
  }
  if (what === "point") {
    const entry = Points.challenges(player)[Number(parts[2]) - 1];
    if (!entry || !Number.isInteger(Number(parts[2]))) {
      player.sendMessage(Common.message("masteryUsage"));
      return true;
    }
    const awarded = Points.award(player, entry.key);
    player.sendMessage(Common.message(awarded ? "pointAwarded" : "pointRepeat", { key: entry.key }));
    return true;
  }
  const tier = Number(parts[2]);
  if (!Common.style(what) || !Number.isInteger(tier) || tier < 1 || tier > 6) {
    player.sendMessage(Common.message("masteryUsage"));
    return true;
  }
  Unlock.unlock(player, what, tier);
  return true;
}

module.exports = function attach(api) {
  api.registerCommand("mastery", masteryCommand, api.core.PlayerRights.DEVELOPER,
    "Your combat masteries; unlock one: ::mastery <melee|ranged|magic> <tier 1-6>; earn a point: ::mastery point <1-10>");
};
