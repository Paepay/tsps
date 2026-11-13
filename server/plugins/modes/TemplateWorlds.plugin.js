"use strict";

const Rules = require("./levelup/Rules.LevelUpWorld");

const ATTR = Object.freeze({
  skills: "level-up:unlocked-skills",
  regions: "level-up:regions",
  relics: "level-up:relics",
  regionClaims: "level-up:claimed-region-milestones",
  relicClaims: "level-up:claimed-relic-milestones",
  leagueRelics: "league:relics",
});

const REGION_ID = /^[a-z0-9-]{1,40}$/;

let api = null;
let templateId = null;
let contract = null;

function integers(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(Number).filter(Number.isInteger))];
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validLevelUpContract(value) {
  const levelUp = value?.levelUp;
  return value?.schemaVersion === 1 && value?.ruleset === "level_up" && value?.enforcedBy === "game-server" &&
    value?.leagueRelics === true && value?.leagueSeason === null && value?.hardcore === false &&
    levelUp?.totalSkills === Rules.TOTAL_SKILLS && levelUp?.initialHitpointsLevel === 10 &&
    levelUp?.startingRegion === "Misthalin" && levelUp?.skillRequirementFactor === 4 &&
    sameJson(levelUp?.initialUnlockedSkills, ["Hitpoints"]) &&
    sameJson(levelUp?.regionMilestones, Rules.REGION_MILESTONES) &&
    sameJson(levelUp?.relicMilestones, Rules.RELIC_MILESTONES) &&
    sameJson(levelUp?.xpTiers, Rules.XP_TIERS);
}

function deactivate(message) {
  templateId = null;
  contract = null;
  if (message) api?.log?.(message);
}

function applyConfiguration(id, rules) {
  const nextId = typeof id === "string" ? id.trim() : "";
  const nextRules = parseJsonObject(rules);
  if (nextId === "level_up" && !validLevelUpContract(nextRules)) {
    deactivate("refusing an invalid Level-Up template contract");
    return false;
  }
  templateId = nextId || null;
  contract = nextRules;
  if (active()) api?.setExperienceRate(1);
  return true;
}

function configurePackaged(template, rules) {
  return applyConfiguration(String(template ?? ""), rules);
}

/** Hosted activation is fail-closed: both authenticated fields must be present. */
function configureHosted(config) {
  if (!config || typeof config !== "object") {
    deactivate("refusing a template configuration that is not an object");
    return false;
  }
  // The authenticated platform may send the template as canonicalTemplate (handshake/lease)
  // or template (world API); either is authenticated. The contract is still validated below.
  const id = typeof config.canonicalTemplate === "string" ? config.canonicalTemplate : config.template;
  if (typeof id !== "string") {
    deactivate("refusing a template configuration without an authenticated template id");
    return false;
  }
  return applyConfiguration(id, config.templateContract);
}

function active() {
  return templateId === "level_up" && validLevelUpContract(contract);
}

function runtimeSkill(canonicalIndex, skillValues = api?.core?.Skill?.values?.() ?? []) {
  const wanted = Rules.skill(canonicalIndex);
  if (!wanted) return null;
  const runtimeName = wanted.runtimeName ?? wanted.name;
  return skillValues.find((skill) => String(skill?.getName?.() ?? "").toLowerCase() === runtimeName.toLowerCase()) ?? null;
}

function levelsFromRuntime(skillValues, rawLevels) {
  return Rules.SKILLS.map(({ index }) => {
    const skill = runtimeSkill(index, skillValues);
    return skill ? Number(rawLevels?.[skill.getIndex()]) || 0 : 0;
  });
}

function skills(player) {
  return Rules.normaliseSkills(player.getAttribute(ATTR.skills));
}

function levels(player) {
  const manager = player.getSkillManager();
  return Rules.SKILLS.map(({ index }) => {
    const skill = runtimeSkill(index);
    return skill ? manager.getMaxLevel(skill) : 0;
  });
}

function regions(player) {
  return claimedRegions({
    [ATTR.regions]: player.getAttribute(ATTR.regions),
    [ATTR.regionClaims]: player.getAttribute(ATTR.regionClaims),
  });
}

function normaliseRelics(value) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const id = String(entry?.id ?? "").trim();
    const name = String(entry?.name ?? "").trim();
    if (!REGION_ID.test(id) || !name || name.length > 40 || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name });
  }
  return result;
}

function relicsFromChosen(chosen, maxTiers = 8) {
  const Common = require("./leaguerelics/Common.LeagueRelics");
  const result = [];
  for (const [rawTier, rawSlot] of Object.entries(chosen ?? {}).sort(([left], [right]) => Number(left) - Number(right))) {
    const tier = Number(rawTier);
    const slot = Number(rawSlot);
    if (!Number.isInteger(tier) || tier < 0 || tier >= maxTiers || !Number.isInteger(slot) || slot < 1 || slot > 3) continue;
    const relic = Common.relic(4, tier, slot);
    if (!relic) continue;
    const id = Rules.slug(relic.name);
    if (REGION_ID.test(id) && !result.some((entry) => entry.id === id)) result.push({ id, name: String(relic.name) });
  }
  return result;
}

/** Region choices are earned one milestone at a time; stale seasonal data is not progress. */
function claimedRegions(attributes) {
  const regions = Rules.normaliseRegions(attributes?.[ATTR.regions]);
  const claims = integers(attributes?.[ATTR.regionClaims]).length;
  if (claims === 0) return regions.filter((entry) => entry.starting);
  return regions.slice(0, claims + 1);
}

/**
 * Relic choices follow claimed relic milestones. Older builds could leave a full seasonal
 * `league:relics` map on a save with no Level-Up claims; never present that as progress.
 */
function claimedRelics(attributes) {
  const claims = integers(attributes?.[ATTR.relicClaims]).length;
  if (claims === 0) return [];
  const stored = normaliseRelics(attributes?.[ATTR.relics]).slice(0, claims);
  if (stored.length >= claims) return stored;
  try {
    for (const relic of relicsFromChosen(attributes?.[ATTR.leagueRelics], claims)) {
      if (!stored.some((entry) => entry.id === relic.id)) stored.push(relic);
    }
  } catch {
    // The catalog may not be loaded while a world is still initialising.
  }
  return stored.slice(0, claims);
}

function relics(player) {
  return claimedRelics({
    [ATTR.relics]: player.getAttribute(ATTR.relics),
    [ATTR.relicClaims]: player.getAttribute(ATTR.relicClaims),
    [ATTR.leagueRelics]: player.getAttribute(ATTR.leagueRelics),
  });
}

/** Locked skills keep their real level but reject XP in the core manager, not only at save time. */
function enforceSkillLevels(player) {
  const unlocked = new Set(skills(player));
  const manager = player.getSkillManager();
  for (const { index } of Rules.SKILLS) {
    const skill = runtimeSkill(index);
    if (skill) manager.setSkillLocked(skill, !unlocked.has(index));
  }
}

function initialise({ player, isNewAccount }) {
  if (!active()) {
    sendLockState(player);
    return;
  }
  const manager = player.getSkillManager();
  if (isNewAccount || !Array.isArray(player.getAttribute(ATTR.skills))) {
    player.setAttribute(ATTR.skills, [Rules.HITPOINTS_INDEX]);
    player.setAttribute(ATTR.regions, ["misthalin"]);
    player.setAttribute(ATTR.relics, []);
    player.setAttribute(ATTR.regionClaims, []);
    player.setAttribute(ATTR.relicClaims, []);
    player.setAttribute(ATTR.leagueRelics, {});
    const hitpoints = runtimeSkill(Rules.HITPOINTS_INDEX);
    if (hitpoints) {
      manager.setSkillLocked(hitpoints, false);
      manager.setExperiences(hitpoints, api.getSkillManager().getExperienceForLevel(10), false);
      manager.setMaxLevels(hitpoints, 10, false);
      manager.setCurrentLevels(hitpoints, 10, true);
    }
    player.moveTo(new api.core.Location(3222, 3219, 0));
  } else {
    player.setAttribute(ATTR.skills, skills(player));
    player.setAttribute(ATTR.regions, regions(player).map((region) => region.id));
    player.setAttribute(ATTR.relics, relics(player));
    if (!Array.isArray(player.getAttribute(ATTR.regionClaims))) player.setAttribute(ATTR.regionClaims, []);
    if (!Array.isArray(player.getAttribute(ATTR.relicClaims))) player.setAttribute(ATTR.relicClaims, []);
    if (integers(player.getAttribute(ATTR.relicClaims)).length === 0) player.setAttribute(ATTR.leagueRelics, {});
  }
  enforceSkillLevels(player);
  sendLockState(player);
  player.sendMessage("Level-Up World: use ::levelup to view your progression and available choices.");
}

function canGainExperience(event) {
  if (!active()) return;
  const index = Rules.skillIndexByName(event.skill.getName());
  if (index === null || !skills(event.player).includes(index)) {
    event.allow = false;
    return;
  }
  event.multiplier *= Rules.xpMultiplier(skills(event.player).length);
}

/** Level-Up treats death as part of play, so staff ranks must not make a character invulnerable. */
function developerProtection(request) {
  if (active() && request?.player) request.protected = false;
}

/** The Skills tab overlay reads the locked component ids from one client dataset. */
function sendLockState(player) {
  if (!player?.getPacketSender) return;
  const isActive = active();
  let locked = [];
  if (isActive) {
    const unlocked = new Set(skills(player));
    locked = Rules.SKILLS
      .filter(({ index }) => !unlocked.has(index))
      .map(({ index }) => Rules.statChild(index))
      .filter((child) => Number.isInteger(child));
  }
  player.getPacketSender().sendContentData("server", [{
    key: "levelUpLockedSkills",
    active: isActive,
    rows: isActive ? locked : [],
  }]);
}

function pendingMilestoneFrom(attributes, count, kind) {
  const milestones = kind === "region" ? Rules.REGION_MILESTONES : Rules.RELIC_MILESTONES;
  const claims = integers(attributes?.[kind === "region" ? ATTR.regionClaims : ATTR.relicClaims]);
  const reached = Rules.reachedMilestones(milestones, count);
  return claims.length < reached.length ? reached[claims.length] : null;
}

function pendingMilestone(player, kind) {
  const attributes = {
    [ATTR.regionClaims]: player.getAttribute(ATTR.regionClaims),
    [ATTR.relicClaims]: player.getAttribute(ATTR.relicClaims),
  };
  return pendingMilestoneFrom(attributes, skills(player).length, kind);
}

function markClaimed(player, kind, milestone) {
  const key = kind === "region" ? ATTR.regionClaims : ATTR.relicClaims;
  player.setAttribute(key, [...integers(player.getAttribute(key)), milestone].sort((left, right) => left - right));
}

/** The platform can carry only one pending reward per kind. Do not outrun that shape. */
function milestonesCanAdvance(player, nextCount) {
  for (const kind of ["region", "relic"]) {
    const milestones = kind === "region" ? Rules.REGION_MILESTONES : Rules.RELIC_MILESTONES;
    const claims = integers(player.getAttribute(kind === "region" ? ATTR.regionClaims : ATTR.relicClaims));
    if (Rules.reachedMilestones(milestones, nextCount).length - claims.length > 1) return false;
  }
  return true;
}

function findSkill(text) {
  const index = Rules.skillIndexByName(text);
  return index === null ? null : { canonical: Rules.skill(index), runtime: runtimeSkill(index) };
}

function unlockSkill(player, text) {
  const found = findSkill(text);
  if (!found?.runtime) return player.sendMessage(`Unknown skill '${text}'. Use its full skill name.`), true;
  const unlocked = skills(player);
  const index = found.canonical.index;
  if (unlocked.includes(index)) return player.sendMessage(`${found.canonical.name} is already unlocked.`), true;
  if (!Rules.eligible(unlocked, levels(player))) {
    return player.sendMessage(`Every unlocked skill must be level ${Rules.requirement(unlocked.length)} before the next unlock.`), true;
  }
  if (!milestonesCanAdvance(player, unlocked.length + 1)) {
    return player.sendMessage("Choose your pending region or relic reward before passing another milestone."), true;
  }
  const next = Rules.normaliseSkills([...unlocked, index]);
  player.setAttribute(ATTR.skills, next);
  const manager = player.getSkillManager();
  manager.setSkillLocked(found.runtime, false);
  manager.setExperiences(found.runtime, 0, false);
  manager.setMaxLevels(found.runtime, 1, false);
  manager.setCurrentLevels(found.runtime, 1, true);
  const reward = Rules.rewardAt(next.length);
  player.sendMessage(`${found.canonical.name} unlocked. Your XP tier is now ${Rules.xpMultiplier(next.length)}x.`);
  if (reward.region) player.sendMessage("A new region is available! Open the Level-Up journal's Areas screen to choose it.");
  if (reward.relic) player.sendMessage("A new relic is available! Open the Level-Up journal's Relics screen to choose it.");
  sendLockState(player);
  api.emitCustomEvent("level-up:skill-unlocked", { player, skill: index, count: next.length });
  return true;
}

function unlockRegion(player, text) {
  const milestone = pendingMilestone(player, "region");
  if (milestone === null) return player.sendMessage("You do not have an unclaimed region milestone."), true;
  const chosen = Rules.regionByText(text);
  if (!chosen || chosen.starting) return player.sendMessage("Choose an eligible region by id or full name."), true;
  if (regions(player).some((region) => region.id === chosen.id)) {
    return player.sendMessage(`${chosen.name} is already unlocked.`), true;
  }
  player.setAttribute(ATTR.regions, [...regions(player).map((region) => region.id), chosen.id]);
  markClaimed(player, "region", milestone);
  player.sendMessage(`${chosen.name} unlocked for the ${milestone}-skill milestone.`);
  api.emitCustomEvent("level-up:region-unlocked", { player, region: chosen.id, area: chosen.area, milestone });
  return true;
}

function unlockRelic(player, text) {
  const milestone = pendingMilestone(player, "relic");
  if (milestone === null) return player.sendMessage("You do not have an unclaimed relic milestone."), true;
  const slot = Number(text);
  if (!Number.isInteger(slot) || slot < 1 || slot > 3) return player.sendMessage("Choose relic slot 1, 2 or 3."), true;
  const tier = integers(player.getAttribute(ATTR.relicClaims)).length;
  const Common = require("./leaguerelics/Common.LeagueRelics");
  const relic = Common.relic(4, tier, slot);
  if (!relic) return player.sendMessage("That relic choice is unavailable."), true;
  const id = Rules.slug(relic.name);
  if (!REGION_ID.test(id)) return player.sendMessage("That relic has no platform-safe id."), true;
  const currentRelics = relics(player);
  if (currentRelics.some((entry) => entry.id === id)) return player.sendMessage(`${relic.name} is already unlocked.`), true;
  const chosen = { ...(player.getAttribute(ATTR.leagueRelics) ?? {}), [tier]: slot };
  player.setAttribute(ATTR.leagueRelics, chosen);
  player.setAttribute(ATTR.relics, [...currentRelics, { id, name: String(relic.name) }]);
  markClaimed(player, "relic", milestone);
  try {
    require("./leaguerelics/Unlock.LeagueRelics").grant?.(player, relic);
  } catch {
    // The effect is still active; a full bank/inventory must not discard the platform reward.
  }
  player.sendMessage(`${relic.name} unlocked for the ${milestone}-skill milestone.`);
  api.emitCustomEvent("league:relic-unlocked", { player, league: 4, tier, slot, relic: relic.key, levelUp: true });
  return true;
}

function progressFrom(attributes, unlockedValue, currentLevels, relicValue) {
  const unlocked = Rules.normaliseSkills(unlockedValue);
  const required = Rules.requirement(unlocked.length);
  const levelByIndex = Object.fromEntries(Rules.SKILLS.map(({ index }) => [index, Number(currentLevels[index]) || 0]));
  const regionList = claimedRegions(attributes);
  return {
    schemaVersion: 1,
    unlockedSkills: unlocked.map((index) => ({
      index,
      name: Rules.skill(index).name,
      level: Math.max(1, Math.min(99, levelByIndex[index] || 1)),
      required,
    })),
    unlockedCount: unlocked.length,
    requiredLevel: required,
    nextSkillEligible: Rules.eligible(unlocked, levelByIndex),
    xpMultiplier: Rules.xpMultiplier(unlocked.length),
    nextRegionMilestone: Rules.nextRegionMilestone(unlocked.length),
    nextRelicMilestone: Rules.nextRelicMilestone(unlocked.length),
    pendingRegionMilestone: pendingMilestoneFrom(attributes, unlocked.length, "region"),
    pendingRelicMilestone: pendingMilestoneFrom(attributes, unlocked.length, "relic"),
    regions: regionList.map(({ id, name }) => ({ id, name })),
    relics: claimedRelics({ ...attributes, [ATTR.relics]: relicValue }),
  };
}

function progress(player) {
  return progressFrom({
    [ATTR.regions]: player.getAttribute(ATTR.regions),
    [ATTR.regionClaims]: player.getAttribute(ATTR.regionClaims),
    [ATTR.relicClaims]: player.getAttribute(ATTR.relicClaims),
  }, skills(player), levels(player), relics(player));
}

/** A deliberately narrow, JSON-safe view of Level-Up state from an offline save. */
function summaryFromSave(save) {
  if (!active() || !save) return undefined;
  const attributes = save.attributes && typeof save.attributes === "object" && !Array.isArray(save.attributes)
    ? save.attributes
    : {};
  const skillValues = api?.core?.Skill?.values?.() ?? [];
  const rawLevels = save.getSkills?.()?.maxLevel ?? [];
  return progressFrom(attributes, attributes[ATTR.skills], levelsFromRuntime(skillValues, rawLevels), attributes[ATTR.relics]);
}

function command({ player, parts }) {
  if (!active()) return false;
  const action = String(parts[1] ?? "").toLowerCase();
  const value = parts.slice(2).join(" ").trim();
  if (action === "skill" && value) return unlockSkill(player, value);
  if (action === "region" && value) return unlockRegion(player, value);
  if (action === "relic" && value) return unlockRelic(player, value);
  const state = progress(player);
  player.sendMessage(`Level-Up: ${state.unlockedCount}/24 skills, ${state.xpMultiplier}x XP, requirement ${state.requiredLevel}.`);
  player.sendMessage(`Regions: ${state.regions.map((region) => region.name).join(", ")}. Relics chosen: ${state.relics.length}.`);
  if (state.pendingRegionMilestone) player.sendMessage(`Region reward pending at ${state.pendingRegionMilestone} skills.`);
  if (state.pendingRelicMilestone) player.sendMessage(`Relic reward pending at ${state.pendingRelicMilestone} skills.`);
  player.sendMessage("Choices: ::levelup skill <name> | ::levelup region <id/name> | ::levelup relic <1-3>.");
  return true;
}

function answerProgress(query) {
  if (!active() || !query?.player) return;
  query.active = true;
  query.progress = progress(query.player);
}

function answerAreaProfile(query) {
  if (!active() || !query?.player) return;
  query.active = true;
  query.unlocked = regions(query.player).map((region) => region.area);
}

function answerRelicProfile(query) {
  if (!query?.player || (templateId !== "level_up" && templateId !== "paescape")) return;
  query.league = 4;
  if (templateId === "level_up") query.active = true;
}

/** Approved PaeScape content can grant a catalog relic without enabling seasonal league rules. */
function grantPaescapeRelic(request) {
  if (templateId !== "paescape" || !request?.player) return;
  const tier = Number(request.tier);
  const slot = Number(request.slot);
  if (!Number.isInteger(tier) || tier < 0 || tier >= 8 || !Number.isInteger(slot) || slot < 1 || slot > 3) return;
  const Common = require("./leaguerelics/Common.LeagueRelics");
  const relic = Common.relic(4, tier, slot);
  if (!relic) return;
  const chosen = request.player.getAttribute(ATTR.leagueRelics);
  const current = chosen && typeof chosen === "object" && !Array.isArray(chosen) ? chosen : {};
  if (current[tier] !== undefined) return;
  request.player.setAttribute(ATTR.leagueRelics, { ...current, [tier]: slot });
  request.granted = true;
  api.emitCustomEvent("league:relic-unlocked", { player: request.player, league: 4, tier, slot, relic: relic.key, paescape: true });
}

module.exports = {
  name: "TemplateWorlds",
  description: "Authoritative runtime rules selected by the PaeScape platform world-template contract.",
  register(pluginApi) {
    api = pluginApi;
    // These are created by initialise() on the character's first login, not defaults:
    // pre-seeding [Hitpoints] makes a new character look like one with saved progress.
    for (const key of [ATTR.skills, ATTR.regions, ATTR.relics, ATTR.regionClaims, ATTR.relicClaims]) {
      api.persistAttribute(key);
    }
    configurePackaged(api.getPluginConfig("template:id", ""), api.getPluginConfig("template:contract", null));
    api.onCustomEvent("paescape:world-config", configureHosted);
    api.onCustomEvent("level-up:progress", answerProgress);
    api.onCustomEvent("level-up:area-profile", answerAreaProfile);
    api.onCustomEvent("level-up:relic-profile", answerRelicProfile);
    api.onCustomEvent("paescape:grant-relic", grantPaescapeRelic);
    api.onPlayerLogin(initialise);
    api.onCanGainExperience(canGainExperience);
    api.onCustomEvent("combat:developer-protection", developerProtection);
    api.registerCommand("levelup", command, api.core.PlayerRights.NONE, "View Level-Up progression or choose a skill, region or relic");
    require("./levelup/Interface.LevelUpWorld").attach(api);
  },
  progress,
  unlockSkill,
  unlockRegion,
  unlockRelic,
  isActive: active,
  sendLockState,
  summaryFromSave,
  _test: {
    configure: configurePackaged,
    configureHosted,
    active,
    progress,
    summaryFromSave,
    pendingMilestone,
    enforceSkillLevels,
    ATTR,
  },
};
