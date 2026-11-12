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

let api = null;
let templateId = null;
let contract = null;

function integers(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(Number).filter(Number.isInteger))];
}

function validLevelUpContract(value) {
  const levelUp = value?.levelUp;
  return value?.schemaVersion === 1 && value?.ruleset === "level_up" && levelUp?.totalSkills === 24 &&
    JSON.stringify(levelUp.regionMilestones) === JSON.stringify(Rules.REGION_MILESTONES) &&
    JSON.stringify(levelUp.relicMilestones) === JSON.stringify(Rules.RELIC_MILESTONES);
}

function configure(config) {
  const id = String(config?.canonicalTemplate ?? config?.template ?? config?.id ?? "");
  const rules = config?.templateContract ?? config?.contract ?? null;
  if (id === "level_up" && !validLevelUpContract(rules)) {
    templateId = null;
    contract = null;
    api.log?.("refusing an invalid Level-Up template contract");
    return;
  }
  templateId = id || null;
  contract = rules;
  if (templateId === "level_up") api.setExperienceRate(1);
}

function active() {
  return templateId === "level_up" && validLevelUpContract(contract);
}

function skills(player) {
  return Rules.normaliseSkills(player.getAttribute(ATTR.skills));
}

function regions(player) {
  const list = integers(player.getAttribute(ATTR.regions)).filter((id) => id === 1 || Rules.REGION_IDS.includes(id));
  return list.includes(1) ? list : [1, ...list];
}

function levels(player) {
  const manager = player.getSkillManager();
  return api.core.Skill.values().map((skill) => manager.getMaxLevel(skill));
}

function initialise({ player }) {
  if (!active()) return;
  if (!Array.isArray(player.getAttribute(ATTR.skills))) {
    player.setAttribute(ATTR.skills, [Rules.HITPOINTS_INDEX]);
    player.setAttribute(ATTR.regions, [1]);
    player.setAttribute(ATTR.relics, {});
    player.setAttribute(ATTR.regionClaims, []);
    player.setAttribute(ATTR.relicClaims, []);
    player.setAttribute(ATTR.leagueRelics, {});
    const hitpoints = api.core.Skill.HITPOINTS;
    const manager = player.getSkillManager();
    const experience = api.getSkillManager().getExperienceForLevel(10);
    manager.setExperiences(hitpoints, experience, false);
    manager.setMaxLevels(hitpoints, 10, false);
    manager.setCurrentLevels(hitpoints, 10, true);
    player.moveTo(new api.core.Location(3222, 3219, 0));
  } else {
    player.setAttribute(ATTR.skills, skills(player));
    player.setAttribute(ATTR.regions, regions(player));
  }
  player.sendMessage("Level-Up World: use ::levelup to view your progression and available choices.");
}

function canGainExperience(event) {
  if (!active()) return;
  const unlocked = skills(event.player);
  if (!unlocked.includes(event.skill.getIndex())) {
    event.allow = false;
    return;
  }
  event.multiplier *= Rules.xpMultiplier(unlocked.length);
}

function canUseSkill(query) {
  if (!active() || !query?.player || !query.skill) return;
  const index = typeof query.skill.getIndex === "function" ? query.skill.getIndex() : Number(query.skill);
  if (!skills(query.player).includes(index)) {
    query.allow = false;
    query.reason = "That skill is still locked in this Level-Up World.";
  }
}

function pendingMilestone(player, kind) {
  const count = skills(player).length;
  const milestones = kind === "region" ? Rules.REGION_MILESTONES : Rules.RELIC_MILESTONES;
  const claims = integers(player.getAttribute(kind === "region" ? ATTR.regionClaims : ATTR.relicClaims));
  return milestones.find((milestone) => milestone <= count && !claims.includes(milestone)) ?? null;
}

function markClaimed(player, kind, milestone) {
  const key = kind === "region" ? ATTR.regionClaims : ATTR.relicClaims;
  player.setAttribute(key, [...integers(player.getAttribute(key)), milestone].sort((a, b) => a - b));
}

function findSkill(text) {
  const wanted = String(text ?? "").trim().toLowerCase();
  return api.core.Skill.values().find((skill) => skill.getName().toLowerCase() === wanted) ?? null;
}

function unlockSkill(player, text) {
  const skill = findSkill(text);
  if (!skill) return player.sendMessage(`Unknown skill '${text}'. Use its full skill name.`), true;
  const unlocked = skills(player);
  const index = skill.getIndex();
  if (unlocked.includes(index)) return player.sendMessage(`${skill.getName()} is already unlocked.`), true;
  if (!Rules.eligible(unlocked, levels(player))) {
    return player.sendMessage(`Every unlocked skill must be level ${Rules.requirement(unlocked.length)} before the next unlock.`), true;
  }
  const next = [...unlocked, index];
  player.setAttribute(ATTR.skills, next);
  const reward = Rules.rewardAt(next.length);
  player.sendMessage(`${skill.getName()} unlocked. Your XP tier is now ${Rules.xpMultiplier(next.length)}x.`);
  if (reward.region) player.sendMessage("A region choice is available: ::levelup region <id or name>.");
  if (reward.relic) player.sendMessage("A relic choice is available: ::levelup relic <slot 1-3>.");
  api.emitCustomEvent("level-up:skill-unlocked", { player, skill: index, count: next.length });
  return true;
}

function areaByText(text) {
  const Common = require("./leagueareas/Common.LeagueAreaUnlocks");
  return /^\d+$/.test(text) ? Common.area(Number(text)) : Common.areaByName(text);
}

function unlockRegion(player, text) {
  const milestone = pendingMilestone(player, "region");
  if (milestone === null) return player.sendMessage("You do not have an unclaimed region milestone."), true;
  const area = areaByText(text);
  if (!area || !Rules.REGION_IDS.includes(area.id)) return player.sendMessage("Choose an eligible region by id or full name."), true;
  const unlocked = regions(player);
  if (unlocked.includes(area.id)) return player.sendMessage(`${area.name} is already unlocked.`), true;
  player.setAttribute(ATTR.regions, [...unlocked, area.id]);
  markClaimed(player, "region", milestone);
  player.sendMessage(`${area.name} unlocked for the ${milestone}-skill milestone.`);
  api.emitCustomEvent("level-up:region-unlocked", { player, area: area.id, milestone });
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
  const chosen = { ...(player.getAttribute(ATTR.leagueRelics) ?? {}), [tier]: slot };
  player.setAttribute(ATTR.leagueRelics, chosen);
  player.setAttribute(ATTR.relics, chosen);
  markClaimed(player, "relic", milestone);
  player.sendMessage(`${relic.name} unlocked for the ${milestone}-skill milestone.`);
  api.emitCustomEvent("league:relic-unlocked", { player, league: 4, tier, slot, relic: relic.key, levelUp: true });
  return true;
}

function progress(player) {
  const unlocked = skills(player);
  const currentLevels = levels(player);
  const required = Rules.requirement(unlocked.length);
  const selectedRelics = player.getAttribute(ATTR.relics) ?? {};
  return {
    schemaVersion: 1,
    unlockedSkills: unlocked.map((index) => ({ index, name: api.core.Skill.values()[index].getName(), level: currentLevels[index], required })),
    unlockedCount: unlocked.length,
    nextSkillEligible: Rules.eligible(unlocked, currentLevels),
    xpMultiplier: Rules.xpMultiplier(unlocked.length),
    nextRegionMilestone: Rules.nextRegionMilestone(unlocked.length),
    nextRelicMilestone: Rules.nextRelicMilestone(unlocked.length),
    pendingRegionMilestone: pendingMilestone(player, "region"),
    pendingRelicMilestone: pendingMilestone(player, "relic"),
    regions: regions(player),
    relics: selectedRelics,
  };
}

function command({ player, parts }) {
  if (!active()) return false;
  const action = String(parts[1] ?? "").toLowerCase();
  const value = parts.slice(2).join(" ").trim();
  if (action === "skill" && value) return unlockSkill(player, value);
  if (action === "region" && value) return unlockRegion(player, value);
  if (action === "relic" && value) return unlockRelic(player, value);
  const state = progress(player);
  player.sendMessage(`Level-Up: ${state.unlockedCount}/24 skills, ${state.xpMultiplier}x XP, requirement ${Rules.requirement(state.unlockedCount)}.`);
  player.sendMessage(`Regions: ${state.regions.join(", ")}. Relics chosen: ${Object.keys(state.relics).length}.`);
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
  query.unlocked = regions(query.player);
}

function answerRelicProfile(query) {
  if (!active() || !query?.player) return;
  query.league = 4;
}

module.exports = {
  name: "TemplateWorlds",
  description: "Authoritative runtime rules selected by the PaeScape platform world-template contract.",
  register(pluginApi) {
    api = pluginApi;
    for (const [key, fallback] of Object.entries({
      [ATTR.skills]: [Rules.HITPOINTS_INDEX], [ATTR.regions]: [1], [ATTR.relics]: {},
      [ATTR.regionClaims]: [], [ATTR.relicClaims]: [],
    })) api.persistAttribute(key, fallback);
    configure({ template: api.getPluginConfig("template:id", ""), contract: api.getPluginConfig("template:contract", null) });
    api.onCustomEvent("paescape:world-config", configure);
    api.onCustomEvent("level-up:progress", answerProgress);
    api.onCustomEvent("level-up:can-use-skill", canUseSkill);
    api.onCustomEvent("level-up:area-profile", answerAreaProfile);
    api.onCustomEvent("level-up:relic-profile", answerRelicProfile);
    api.onPlayerLogin(initialise);
    api.onCanGainExperience(canGainExperience);
    api.registerCommand("levelup", command, api.core.PlayerRights.NONE, "View Level-Up progression or choose a skill, region or relic");
  },
  _test: { configure, active, progress, pendingMilestone, ATTR },
};
