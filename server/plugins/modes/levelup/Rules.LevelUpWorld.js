"use strict";

const TOTAL_SKILLS = 24;
const HITPOINTS_INDEX = 7;
const REGION_MILESTONES = Object.freeze([3, 6, 9, 12, 15, 18, 21, 24]);
const RELIC_MILESTONES = Object.freeze([2, 5, 8, 11, 14, 17, 20, 23]);
const XP_TIERS = Object.freeze([
  Object.freeze({ minUnlocked: 1, maxUnlocked: 3, multiplier: 3 }),
  Object.freeze({ minUnlocked: 4, maxUnlocked: 6, multiplier: 6 }),
  Object.freeze({ minUnlocked: 7, maxUnlocked: 9, multiplier: 9 }),
  Object.freeze({ minUnlocked: 10, maxUnlocked: 12, multiplier: 12 }),
  Object.freeze({ minUnlocked: 13, maxUnlocked: 15, multiplier: 15 }),
  Object.freeze({ minUnlocked: 16, maxUnlocked: 18, multiplier: 18 }),
  Object.freeze({ minUnlocked: 19, maxUnlocked: 21, multiplier: 21 }),
  Object.freeze({ minUnlocked: 22, maxUnlocked: 24, multiplier: 24 }),
]);

/** The platform's LEVEL_UP_SKILLS order is part of schema 1; runtime indexes are unrelated. */
const SKILLS = Object.freeze([
  Object.freeze({ index: 0, name: "Attack" }),
  Object.freeze({ index: 1, name: "Strength" }),
  Object.freeze({ index: 2, name: "Defence" }),
  Object.freeze({ index: 3, name: "Ranged" }),
  Object.freeze({ index: 4, name: "Prayer" }),
  Object.freeze({ index: 5, name: "Magic" }),
  Object.freeze({ index: 6, name: "Runecraft", runtimeName: "Runecrafting" }),
  Object.freeze({ index: 7, name: "Hitpoints" }),
  Object.freeze({ index: 8, name: "Agility" }),
  Object.freeze({ index: 9, name: "Herblore" }),
  Object.freeze({ index: 10, name: "Thieving" }),
  Object.freeze({ index: 11, name: "Crafting" }),
  Object.freeze({ index: 12, name: "Fletching" }),
  Object.freeze({ index: 13, name: "Slayer" }),
  Object.freeze({ index: 14, name: "Hunter" }),
  Object.freeze({ index: 15, name: "Mining" }),
  Object.freeze({ index: 16, name: "Smithing" }),
  Object.freeze({ index: 17, name: "Fishing" }),
  Object.freeze({ index: 18, name: "Cooking" }),
  Object.freeze({ index: 19, name: "Firemaking" }),
  Object.freeze({ index: 20, name: "Woodcutting" }),
  Object.freeze({ index: 21, name: "Farming" }),
  Object.freeze({ index: 22, name: "Construction" }),
  Object.freeze({ index: 23, name: "Sailing" }),
]);

/** Stable platform ids, mapped to the cache/map area ids used by region enforcement. */
const REGIONS = Object.freeze([
  Object.freeze({ id: "misthalin", name: "Misthalin", area: 1, starting: true }),
  Object.freeze({ id: "karamja", name: "Karamja", area: 2 }),
  Object.freeze({ id: "asgarnia", name: "Asgarnia", area: 3 }),
  Object.freeze({ id: "kandarin", name: "Kandarin", area: 4 }),
  Object.freeze({ id: "morytania", name: "Morytania", area: 5 }),
  Object.freeze({ id: "kharidian-desert", name: "Kharidian Desert", area: 6 }),
  Object.freeze({ id: "tirannwn", name: "Tirannwn", area: 7 }),
  Object.freeze({ id: "fremennik", name: "Fremennik", area: 8 }),
  Object.freeze({ id: "wilderness", name: "Wilderness", area: 11 }),
  Object.freeze({ id: "kourend", name: "Kourend", area: 20 }),
]);

const REGION_BY_ID = new Map(REGIONS.map((region) => [region.id, region]));
const REGION_BY_AREA = new Map(REGIONS.map((region) => [region.area, region]));
const SKILL_BY_INDEX = new Map(SKILLS.map((skill) => [skill.index, skill]));

/** Platform skill index -> the Skills tab (320) component that shows it. */
const STAT_CHILD = Object.freeze({
  0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 9,
  8: 10, 9: 11, 10: 12, 11: 13, 12: 14, 13: 15, 14: 16, 15: 17,
  16: 18, 17: 19, 18: 20, 19: 21, 20: 22, 21: 23, 22: 8, 23: 24,
});

function normalizeSkillName(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const SKILL_BY_RUNTIME_NAME = new Map();
for (const skill of SKILLS) {
  SKILL_BY_RUNTIME_NAME.set(normalizeSkillName(skill.name), skill);
  if (skill.runtimeName) SKILL_BY_RUNTIME_NAME.set(normalizeSkillName(skill.runtimeName), skill);
}

function skill(index) {
  return SKILL_BY_INDEX.get(Number(index)) ?? null;
}

function statChild(index) {
  return STAT_CHILD[Number(index)] ?? null;
}

function skillIndexByName(name) {
  return SKILL_BY_RUNTIME_NAME.get(normalizeSkillName(name))?.index ?? null;
}

function normaliseSkills(value) {
  const result = [...new Set((Array.isArray(value) ? value : []).map(Number)
    .filter((index) => Number.isInteger(index) && SKILL_BY_INDEX.has(index)))].sort((left, right) => left - right);
  if (!result.includes(HITPOINTS_INDEX)) result.push(HITPOINTS_INDEX);
  return result.sort((left, right) => left - right).slice(0, TOTAL_SKILLS);
}

function requirement(unlockedCount) {
  const count = Math.max(1, Math.min(TOTAL_SKILLS, Number(unlockedCount) || 1));
  return count === TOTAL_SKILLS ? 99 : 4 * count;
}

function xpMultiplier(unlockedCount) {
  const count = Math.max(1, Math.min(TOTAL_SKILLS, Number(unlockedCount) || 1));
  return XP_TIERS.find((tier) => count >= tier.minUnlocked && count <= tier.maxUnlocked).multiplier;
}

function eligible(unlocked, levels) {
  const skills = normaliseSkills(unlocked);
  if (skills.length >= TOTAL_SKILLS) return false;
  const needed = requirement(skills.length);
  return skills.every((index) => Number(levels[index]) >= needed);
}

function rewardAt(count) {
  return {
    region: REGION_MILESTONES.includes(count),
    relic: RELIC_MILESTONES.includes(count),
  };
}

function nextMilestone(milestones, count) {
  return milestones.find((milestone) => milestone > count) ?? null;
}

function reachedMilestones(milestones, count) {
  return milestones.filter((milestone) => milestone <= count);
}

function region(idOrArea) {
  const numeric = Number(idOrArea);
  if (Number.isInteger(numeric)) return REGION_BY_AREA.get(numeric) ?? null;
  return REGION_BY_ID.get(String(idOrArea ?? "").trim().toLowerCase().replace(/_/g, "-")) ?? null;
}

function regionByText(text) {
  const wanted = String(text ?? "").trim().toLowerCase().replace(/_/g, " ");
  if (!wanted) return null;
  if (/^\d+$/.test(wanted)) return region(Number(wanted));
  return REGIONS.find((entry) => entry.id === wanted.replace(/\s+/g, "-") || entry.name.toLowerCase() === wanted) ?? null;
}

/** Migration-safe: old numeric area ids become their canonical platform region ids. */
function normaliseRegions(value) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const found = typeof entry === "object" && entry !== null
      ? region(entry.id) ?? region(entry.area) ?? regionByText(entry.name)
      : region(entry) ?? regionByText(entry);
    if (!found || seen.has(found.id)) continue;
    seen.add(found.id);
    result.push(found);
  }
  if (!seen.has("misthalin")) result.unshift(REGION_BY_ID.get("misthalin"));
  return result;
}

function regionArea(id) {
  return region(id)?.area ?? null;
}

function slug(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
}

module.exports = {
  TOTAL_SKILLS,
  HITPOINTS_INDEX,
  SKILLS,
  REGIONS,
  REGION_MILESTONES,
  RELIC_MILESTONES,
  XP_TIERS,
  skill,
  statChild,
  skillIndexByName,
  normaliseSkills,
  requirement,
  xpMultiplier,
  eligible,
  rewardAt,
  nextMilestone,
  reachedMilestones,
  region,
  regionByText,
  normaliseRegions,
  regionArea,
  slug,
  nextRegionMilestone: (count) => nextMilestone(REGION_MILESTONES, count),
  nextRelicMilestone: (count) => nextMilestone(RELIC_MILESTONES, count),
};
