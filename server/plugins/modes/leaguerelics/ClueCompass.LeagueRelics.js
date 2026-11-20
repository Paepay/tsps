/**
 * Clue Compass (https://oldschool.runescape.wiki/w/Clue_Compass), Raging Echoes' tier 3 relic:
 * the clue compass teleports to any STASH unit (built or not) and to Falo the Bard; Current-step
 * goes to where the clue read last leads (not a step that asks for a kill); Last-destination
 * repeats the last; all in unlocked areas, from any Wilderness level. Used on Falo, it is the
 * item he asks for (Wiki). Not here: the Wiki's three Varlamore units left out near the Twilight
 * Temple (this server's units all count); beginner clues' steps (their trails are kept apart);
 * a hot-cold step (ours: its spot is the puzzle).
 */
const Common = require("./Common.LeagueRelics");
const Teleports = require("./Teleports.LeagueRelics");

const KEY = "clue-compass";
const TIERS = ["beginner", "easy", "medium", "hard", "elite", "master"];

let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function falo() {
  const spawn = Teleports.spawnsNamed("Falo the Bard")[0];
  return spawn ? { label: "Falo the Bard", location: new core.Location(spawn.x, spawn.y, spawn.level ?? 0) } : null;
}

function stashes(player) {
  const units = Teleports.ask("treasure-trails:stashes");
  const byTier = TIERS.map((tier) => [tier, units.filter((unit) => unit.tier === tier)]).filter(([, list]) => list.length > 0);
  const regions = byTier.map(([tier, list]) => ({
    label: `${tier[0].toUpperCase()}${tier.slice(1)} STASH units`,
    destinationTitle: Common.message("stashTitle"),
    destinations: list.map((unit, index) => {
      const destination = {
        label: Common.message("stashUnit", { tier, number: index + 1, x: unit.location.x, y: unit.location.y }),
        location: new core.Location(unit.location.x, unit.location.y, unit.location.z ?? 0),
      };
      return { label: destination.label, choose: () => Teleports.go(player, KEY, destination) };
    }),
  }));
  const bard = falo();
  if (bard) regions.push({
    label: bard.label,
    destinationTitle: Common.message("clueCompassTitle"),
    destinations: [{ label: bard.label, choose: () => Teleports.go(player, KEY, bard) }],
  });
  Teleports.openMenu(player, { key: KEY, title: Common.message("clueCompassTitle"), regions });
}

function currentStep(player) {
  const step = { player, location: null, target: null, family: null };
  Common.api.emitCustomEvent("treasure-trails:current-step", step);
  if (!step.location) {
    player.sendMessage(Common.message("noClueStep"));
    return;
  }
  // A hot-cold step's spot is the puzzle itself (ours: the compass does not give it away).
  if (step.target === "kill" || step.family === "hotcold") {
    player.sendMessage(Common.message(step.target === "kill" ? "clueStepKill" : "clueStepHidden"));
    return;
  }
  const { x, y, z } = step.location;
  Teleports.go(player, KEY, { label: "Current step", location: new core.Location(x, y, z ?? 0) });
}

function faloItem(request) {
  if (request.kind === "falo" && request.itemId === core.ItemIdentifiers.CLUE_COMPASS && active(request.player)) request.waived = true;
}

/** An option's handler for the relic's owner; anyone else's click goes on to the game's own (false). */
function only(fn) {
  return (event) => {
    if (!active(event.player)) return false;
    event.handled = true;
    fn(event.player);
  };
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.clueCompass;
  Teleports.attachMenu(api);
  api.persistAttribute(Teleports.lastAttribute(KEY), null);
  api.onItemAction(effect.toolName, {
    Teleport: only(stashes),
    "Current-step": only(currentStep),
    "Last-destination": only((player) => Teleports.goLast(player, KEY)),
  });
  api.onCustomEvent("treasure-trails:requirement-waived", faloItem);
};
