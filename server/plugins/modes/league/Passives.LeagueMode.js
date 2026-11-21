/**
 * The relic tiers' passive effects other than the XP rate (docs/leagues.md; the Wiki's Relics
 * pages' "Tier N" bullets; data: leagues.json `passives`). Each applies to a league character
 * from the 1-based tier its `fromTier` names, read from the highest tier the character chose
 * (`league:highest-tier`, LeagueRelics), and never to a main character or a plain world. The
 * effects live where the game decides them: running's energy drain (the drain modifier), the
 * combat skills' XP (the can-gain-experience hook), minigame points (`minigame:points`, asked by
 * each minigame as it awards them), Slayer task points and superiors (`slayer:task-reward`,
 * `slayer:superior-spawn`, asked by the Slayer plugin) and clue scrolls dropping as scroll boxes
 * (`treasure-trails:scroll-boxes`, asked by ClueCapacity). The drop boost is
 * BoostedDrops.LeagueMode.js.
 */
const Common = require("./Common.LeagueMode");
const Relics = require("../leaguerelics/Common.LeagueRelics");

/** Saved clue-step progress, by tier name, while the clue-step passive is active. */
const CLUE_PROGRESS_ATTRIBUTE = "league:clue-progress";

/** A seasonal league character, or a Level-Up world's Trailblazer Reloaded relic catalog. */
function leagueOf(player) {
  const type = Common.leagueOf(player);
  if (type !== null) return type;
  // Level-Up and PaeScape templates use a relic catalog without a seasonal league
  // profile; the relic catalog's league is still the passive source/effect namespace.
  return Relics.leagueOf(player);
}

/** Whether this world saved its own passive rows (rather than keeping its league's defaults). */
function hasCustomPassives() {
  return Relics.passivesWorldState().custom === true;
}

function customEntries(player, effectType) {
  const type = leagueOf(player);
  return type === null ? [] : Relics.activePassiveValues(player, effectType, type);
}

function maxEffect(entries, field = "multiplier") {
  return entries.reduce((best, passive) => Math.max(best, Number(passive.effect[field]) || 0), 0);
}

/** The configured grants as the old bundled shape, for the handlers and external callers. */
function customPassive(player, key) {
  if (key === "runEnergy") {
    return customEntries(player, "runEnergy").length ? { fromTier: 1 } : null;
  }
  if (key === "dropRate") {
    const entries = customEntries(player, "dropRate");
    return entries.length ? { fromTier: {}, values: entries.map((passive) => passive.effect.multiplier) } : null;
  }
  if (key === "minigamePoints") {
    const entries = customEntries(player, "minigamePoints");
    if (entries.length === 0) return null;
    return {
      fromTier: {},
      minigames: [...new Set(entries.flatMap((passive) => passive.effect.minigames ?? []))],
    };
  }
  if (key === "combatXp") {
    const entries = customEntries(player, "combatXp");
    if (entries.length === 0) return null;
    return {
      fromTier: {},
      multiplier: maxEffect(entries),
      skills: [...new Set(entries.flatMap((passive) => passive.effect.skills ?? []))],
    };
  }
  if (key === "slayer") {
    const bigger = customEntries(player, "biggerAndBadder");
    const superior = customEntries(player, "superiorSlayer");
    const points = customEntries(player, "slayerPoints");
    const free = customEntries(player, "slayerFreeTasks");
    if (bigger.length + superior.length + points.length + free.length === 0) return null;
    return {
      fromTier: {},
      biggerAndBadder: bigger.length > 0,
      superiorChance: superior.length ? Math.min(...superior.map((passive) => passive.effect.chance)) : Number.POSITIVE_INFINITY,
      pointsMultiplier: points.length ? maxEffect(points) : 1,
      freeTasks: free.length ? Math.min(...free.map((passive) => passive.effect.freeTasks)) : Number.POSITIVE_INFINITY,
    };
  }
  if (key === "scrollBoxes") {
    return customEntries(player, "scrollBoxes").length ? { fromTier: 1 } : null;
  }
  if (key === "clueStepProgress") {
    return customEntries(player, "clueStepProgress").length ? { fromTier: 1 } : null;
  }
  return null;
}

/** The passive `key` of the player's league if its gate tier (`fromTier`, a number) is reached, else null. */
function passive(player, key) {
  if (!Relics.relicsEnabled()) return null;
  const type = leagueOf(player);
  if (type === null) return null;
  if (hasCustomPassives()) return customPassive(player, key);
  const entry = Common.passives(type)[key];
  if (!entry) return null;
  const reached = Common.highestTier(player) + 1;
  if (typeof entry.fromTier === "number") return reached >= entry.fromTier ? entry : null;
  if (entry.fromTier && typeof entry.fromTier === "object") {
    return Object.keys(entry.fromTier).some((from) => reached >= Number(from)) ? entry : null;
  }
  return null;
}

/** The value of the passive `key` for the highest tier reached (`fromTier` a map of tier -> value), or null below its first tier. */
function tierValue(player, key) {
  if (!Relics.relicsEnabled()) return null;
  const type = leagueOf(player);
  if (type === null) return null;
  if (hasCustomPassives()) {
    const effectType = { dropRate: "dropRate", minigamePoints: "minigamePoints" }[key];
    if (!effectType) return null;
    const entries = customEntries(player, effectType);
    return entries.length ? maxEffect(entries) : null;
  }
  const entry = Common.passives(type)[key];
  if (!entry || typeof entry.fromTier !== "object") return null;
  const reached = Common.highestTier(player) + 1;
  let best = null;
  for (const [from, value] of Object.entries(entry.fromTier)) {
    if (reached >= Number(from) && (best === null || Number(from) > best.from)) best = { from: Number(from), value: Number(value) };
  }
  return best?.value ?? null;
}

/** Run energy is never drained whilst running (tier 1 of both leagues). */
function runEnergyDrain(entity, amount) {
  return passive(entity, "runEnergy") ? 0 : amount;
}

/** Raging Echoes tier 3: the combat skills' XP, Hitpoints and Prayer included, x2 on top of the league's rate. */
function combatExperience(event) {
  const combat = passive(event.player, "combatXp");
  if (!combat) return;
  const { Skill } = Common.core;
  if (combat.skills.some((name) => Skill[name] === event.skill)) event.multiplier *= combat.multiplier;
}

/** `minigame:points` { player, minigame, points }: the points a minigame the passive lists is about to award, multiplied. */
function minigamePoints(request) {
  if (!request?.player || !(request.points > 0)) return;
  const entry = passive(request.player, "minigamePoints");
  if (!entry?.minigames?.includes(request.minigame)) return;
  const multiplier = tierValue(request.player, "minigamePoints");
  if (multiplier) request.points = Math.floor(request.points * multiplier);
}

/**
 * `minigame:yield` { player, minigame, amount }: the items a minigame the passive lists is about
 * to award, multiplied by the same tier as its points (the Tithe Farm's fruit).
 */
function minigameYield(request) {
  if (!request?.player || !(request.amount > 0)) return;
  const entry = passive(request.player, "minigamePoints");
  if (!entry?.minigames?.includes(request.minigame)) return;
  const multiplier = tierValue(request.player, "minigamePoints");
  if (multiplier) request.amount = Math.floor(request.amount * multiplier);
}

/** Demonic Pacts' starting master is Chaeldar: master levels do not gate assignments. Task requirements still apply. */
function slayerMasterAccess(request) {
  if (request?.player && Common.leagueOf(request.player) === 6) request.allowed = true;
}

/** `slayer:task-reward` { player, master, freeTasks, multiplier }: 5x task points, from the first task. */
function slayerTaskReward(request) {
  const slayer = request?.player ? passive(request.player, "slayer") : null;
  if (!slayer) return;
  if (Number.isFinite(slayer.freeTasks)) request.freeTasks = Math.min(request.freeTasks, slayer.freeTasks);
  if (slayer.pointsMultiplier > 1) request.multiplier *= slayer.pointsMultiplier;
}

/** `slayer:superior-spawn` { player, npc, unlocked, chance }: Bigger and Badder for free, superiors 1 in 50. */
function superiorSpawn(request) {
  const slayer = request?.player ? passive(request.player, "slayer") : null;
  if (!slayer) return;
  if (slayer.biggerAndBadder) request.unlocked = true;
  if (Number.isFinite(slayer.superiorChance)) request.chance = Math.min(request.chance, slayer.superiorChance);
}

/** `treasure-trails:scroll-boxes` { player, unlocked, capacity }: every clue drops as a stackable scroll box, without a limit. */
function scrollBoxes(request) {
  if (!request?.player || !passive(request.player, "scrollBoxes")) return;
  request.unlocked = true;
  request.capacity = Number.POSITIVE_INFINITY;
}

/** `farming:growth-rate` { player, rate, tickMinutes }: the fastest configured farming tick. */
function farmingGrowthRate(event) {
  if (!event?.player) return;
  const tickMinutes = Number(event.tickMinutes) || 5;
  const rates = customEntries(event.player, "farmingTicks")
    .map((entry) => Number(entry.effect.minutes))
    .filter((minutes) => minutes > 0)
    .map((minutes) => tickMinutes / minutes);
  if (rates.length) event.rate = Math.max(Number(event.rate) || 1, ...rates);
}

function clueProgressMap(player) {
  const saved = player?.getAttribute?.(CLUE_PROGRESS_ATTRIBUTE);
  return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
}

function setClueProgress(player, tier, completed) {
  const saved = { ...clueProgressMap(player), [tier]: Math.max(0, Number(completed) || 0) };
  player.setAttribute(CLUE_PROGRESS_ATTRIBUTE, saved);
}

/**
 * `treasure-trails:clue-progress` { player, tier, event, completed, saved }: a fresh clue asks
 * for its tier's saved progress (`start`; the listener sets `saved`), a completed step stores
 * its count (`step`) and a received casket clears it (`casket`). Only a league character with
 * the clue-step grant carries progress, and each tier is independent.
 */
function clueProgress(request) {
  if (!request?.player || customEntries(request.player, "clueStepProgress").length === 0) return;
  const tier = String(request.tier ?? "");
  if (!tier) return;
  if (request.event === "start") {
    request.saved = Math.max(0, Number(clueProgressMap(request.player)[tier]) || 0);
  } else if (request.event === "step") {
    setClueProgress(request.player, tier, request.completed);
  } else if (request.event === "casket") {
    setClueProgress(request.player, tier, 0);
  }
}

module.exports = function attach(api) {
  api.persistAttribute?.(CLUE_PROGRESS_ATTRIBUTE, {});
  api.registerRunEnergyDrainModifier(runEnergyDrain);
  api.onCanGainExperience(combatExperience);
  api.onCustomEvent("minigame:points", minigamePoints);
  api.onCustomEvent("minigame:yield", minigameYield);
  api.onCustomEvent("slayer:master-access", slayerMasterAccess);
  api.onCustomEvent("slayer:task-reward", slayerTaskReward);
  api.onCustomEvent("slayer:superior-spawn", superiorSpawn);
  api.onCustomEvent("treasure-trails:scroll-boxes", scrollBoxes);
  api.onCustomEvent("farming:growth-rate", farmingGrowthRate);
  api.onCustomEvent("treasure-trails:clue-progress", clueProgress);
};

module.exports.passive = passive;
module.exports.tierValue = tierValue;
module.exports.leagueType = leagueOf;
module.exports.hasCustomPassives = hasCustomPassives;
module.exports.xpMultiplier = (player) => {
  if (!hasCustomPassives()) return null;
  const entries = customEntries(player, "xpRate");
  return entries.length ? maxEffect(entries) : 0;
};
