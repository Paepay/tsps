const assert = require("node:assert/strict");
const { test } = require("node:test");

const Rules = require("../plugins/modes/levelup/Rules.LevelUpWorld");

test("Level-Up XP tiers cover all 24 skill counts exactly", () => {
  const expected = [3, 3, 3, 6, 6, 6, 9, 9, 9, 12, 12, 12, 15, 15, 15, 18, 18, 18, 21, 21, 21, 24, 24, 24];
  assert.deepEqual(Array.from({ length: 24 }, (_, index) => Rules.xpMultiplier(index + 1)), expected);
});

test("skill eligibility requires every unlocked skill at 4 times N", () => {
  assert.equal(Rules.eligible([3], { 3: 10 }), true, "HP 10 may immediately unlock skill two");
  assert.equal(Rules.eligible([3, 0], { 3: 8, 0: 7 }), false);
  assert.equal(Rules.eligible([3, 0], { 3: 8, 0: 8 }), true);
  const twentyThree = Array.from({ length: 23 }, (_, index) => index);
  assert.equal(Rules.eligible(twentyThree, Object.fromEntries(twentyThree.map((index) => [index, 91]))), false);
  assert.equal(Rules.eligible(twentyThree, Object.fromEntries(twentyThree.map((index) => [index, 92]))), true);
  assert.equal(Rules.eligible(Array.from({ length: 24 }, (_, index) => index), {}), false);
});

test("region and relic milestones never overlap or repeat", () => {
  const regions = [], relics = [];
  for (let count = 1; count <= 24; count++) {
    const reward = Rules.rewardAt(count);
    if (reward.region) regions.push(count);
    if (reward.relic) relics.push(count);
    assert.equal(reward.region && reward.relic, false);
  }
  assert.deepEqual(regions, [3, 6, 9, 12, 15, 18, 21, 24]);
  assert.deepEqual(relics, [2, 5, 8, 11, 14, 17, 20, 23]);
});

test("normalisation restores HP once and rejects invalid skill ids", () => {
  assert.deepEqual(Rules.normaliseSkills([0, 0, -1, 99, 3]), [0, 3]);
  assert.deepEqual(Rules.normaliseSkills([]), [3]);
});

test("the runtime plugin is isolated until an authenticated Level-Up contract arrives", () => {
  const handlers = {};
  const skills = Array.from({ length: 24 }, (_, index) => ({
    getIndex: () => index,
    getName: () => index === 3 ? "Hitpoints" : `Skill ${index}`,
  }));
  const api = {
    core: {
      Skill: Object.assign({ values: () => skills, HITPOINTS: skills[3] }, Object.fromEntries(skills.map((skill, i) => [`SKILL_${i}`, skill]))),
      Location: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } },
      PlayerRights: { NONE: 0 },
    },
    getSkillManager: () => ({ getExperienceForLevel: (level) => level * 100 }),
    getPluginConfig: (_key, fallback) => fallback,
    persistAttribute() {},
    setExperienceRate: (rate) => { api.rate = rate; },
    onCustomEvent: (name, handler) => { (handlers[name] ??= []).push(handler); },
    onPlayerLogin: (handler) => { handlers.login = [handler]; },
    onCanGainExperience: (handler) => { handlers.xp = [handler]; },
    registerCommand: (name, handler) => { handlers[`command:${name}`] = [handler]; },
    emitCustomEvent: (name, payload) => { for (const handler of handlers[name] ?? []) handler(payload); },
  };
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  plugin.register(api);

  const attributes = new Map();
  const levels = Array(24).fill(1); levels[3] = 10;
  const manager = {
    getMaxLevel: (skill) => levels[skill.getIndex()],
    setExperiences() { return manager; }, setMaxLevels(skill, level) { levels[skill.getIndex()] = level; return manager; },
    setCurrentLevels() { return manager; },
  };
  const player = {
    getAttribute: (key) => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value),
    getSkillManager: () => manager, moveTo: (location) => { player.location = location; },
    sendMessage: (message) => { (player.messages ??= []).push(message); },
  };
  handlers.login[0]({ player });
  assert.equal(attributes.has("level-up:unlocked-skills"), false, "plain templates are untouched");

  const contract = {
    schemaVersion: 1, ruleset: "level_up", leagueRelics: true, leagueSeason: null, hardcore: false,
    levelUp: { totalSkills: 24, regionMilestones: Rules.REGION_MILESTONES, relicMilestones: Rules.RELIC_MILESTONES },
  };
  api.emitCustomEvent("paescape:world-config", { canonicalTemplate: "level_up", templateContract: contract });
  handlers.login[0]({ player });
  assert.deepEqual(attributes.get("level-up:unlocked-skills"), [3]);
  assert.deepEqual(attributes.get("level-up:regions"), [1]);
  assert.equal(api.rate, 1, "world rate is neutral so the visible tier is not doubled");

  const lockedXp = { player, skill: skills[0], allow: null, multiplier: 1 };
  handlers.xp[0](lockedXp);
  assert.equal(lockedXp.allow, false);
  const hpXp = { player, skill: skills[3], allow: null, multiplier: 1 };
  handlers.xp[0](hpXp);
  assert.equal(hpXp.multiplier, 3);

  handlers["command:levelup"][0]({ player, parts: ["levelup", "skill", "Skill", "0"] });
  assert.deepEqual(attributes.get("level-up:unlocked-skills"), [3, 0]);
  handlers["command:levelup"][0]({ player, parts: ["levelup", "skill", "Skill", "0"] });
  assert.deepEqual(attributes.get("level-up:unlocked-skills"), [3, 0], "a skill cannot be claimed twice");
});
