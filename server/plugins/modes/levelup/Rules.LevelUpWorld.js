"use strict";

const TOTAL_SKILLS = 24;
const HITPOINTS_INDEX = 3;
const REGION_MILESTONES = Object.freeze([3, 6, 9, 12, 15, 18, 21, 24]);
const RELIC_MILESTONES = Object.freeze([2, 5, 8, 11, 14, 17, 20, 23]);
const REGION_IDS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 11, 20, 21]);

function normaliseSkills(value) {
  const result = [...new Set((Array.isArray(value) ? value : []).map(Number)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < TOTAL_SKILLS))];
  if (!result.includes(HITPOINTS_INDEX)) result.unshift(HITPOINTS_INDEX);
  return result.slice(0, TOTAL_SKILLS);
}

function requirement(unlockedCount) {
  return 4 * Math.max(1, Math.min(TOTAL_SKILLS, unlockedCount | 0));
}

function xpMultiplier(unlockedCount) {
  const count = Math.max(1, Math.min(TOTAL_SKILLS, unlockedCount | 0));
  return Math.min(24, Math.max(3, Math.ceil(count / 3) * 3));
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

module.exports = {
  TOTAL_SKILLS,
  HITPOINTS_INDEX,
  REGION_MILESTONES,
  RELIC_MILESTONES,
  REGION_IDS,
  normaliseSkills,
  requirement,
  xpMultiplier,
  eligible,
  rewardAt,
  nextRegionMilestone: (count) => nextMilestone(REGION_MILESTONES, count),
  nextRelicMilestone: (count) => nextMilestone(RELIC_MILESTONES, count),
};
