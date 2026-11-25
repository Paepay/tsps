// Run after `yarn build`: node --test tests/level-up-world.test.cjs
const assert = require("node:assert/strict");
const { after, test } = require("node:test");

const Rules = require("../plugins/modes/levelup/Rules.LevelUpWorld");

const {
  Server,
} = require("../dist/Server");
Server.installProductionPathResolver();
const { Skill } = require("../dist/game/model/Skill");
const { SkillManager } = require("../dist/game/content/skill/SkillManager");

const RUNTIME_SKILLS = [
  "Attack", "Defence", "Strength", "Hitpoints", "Ranged", "Prayer", "Magic",
  "Cooking", "Woodcutting", "Fletching", "Fishing", "Firemaking", "Crafting",
  "Smithing", "Mining", "Herblore", "Agility", "Thieving", "Slayer", "Farming",
  "Runecrafting", "Construction", "Hunter", "Sailing",
];

function validContract() {
  return {
    schemaVersion: 1,
    ruleset: "level_up",
    enforcedBy: "game-server",
    leagueRelics: true,
    leagueSeason: null,
    hardcore: false,
    pvp: null,
    levelUp: {
      totalSkills: 24,
      initialUnlockedSkills: ["Hitpoints"],
      initialHitpointsLevel: 10,
      startingRegion: "Misthalin",
      skillRequirementFactor: 4,
      regionMilestones: [...Rules.REGION_MILESTONES],
      relicMilestones: [...Rules.RELIC_MILESTONES],
      xpTiers: Rules.XP_TIERS.map((tier) => ({ ...tier })),
    },
  };
}

function createRuntime() {
  const handlers = {};
  const contentData = [];
  const runtimeSkills = RUNTIME_SKILLS.map((name, index) => ({
    getIndex: () => index,
    getName: () => name,
  }));
  const byName = (name) => runtimeSkills.find((skill) => skill.getName() === name);
  const skill = Object.fromEntries(runtimeSkills.map((entry) => [entry.getName().toUpperCase(), entry]));
  const itemDefinitions = new Map();
  const events = [];
  const api = {
    core: {
      Skill: { values: () => runtimeSkills, ...skill },
      Equipment: { WEAPON_SLOT: 3 },
      PrayerHandler: { PROTECT_FROM_MELEE: 18 },
      ItemDefinition: { forId: (id) => itemDefinitions.get(Number(id)) ?? null },
      Location: class {
        constructor(x, y, z) {
          Object.assign(this, { x, y, z });
        }
      },
      PlayerRights: { NONE: 0 },
    },
    getSkillManager: () => ({ getExperienceForLevel: (level) => level * 100 }),
    getPluginConfig: (_key, fallback) => fallback,
    persistAttribute() {},
    log() {},
    setExperienceRate: (rate) => { api.rate = rate; },
    onCustomEvent: (name, handler) => { (handlers[name] ??= []).push(handler); },
    onPlayerLogin: (handler) => { (handlers.login ??= []).push(handler); },
    onPlayerLevelUp: (handler) => { (handlers.levelUp ??= []).push(handler); },
    onNpcDeath: (handler) => { (handlers.npcDeath ??= []).push(handler); },
    onCombatHitResolved: (handler) => { (handlers.hitResolved ??= []).push(handler); },
    onCanGainExperience: (handler) => { handlers.xp = [handler]; },
    registerCommand: (name, handler) => { handlers[`command:${name}`] = [handler]; },
    emitCustomEvent: (name, payload) => {
      events.push({ name, payload });
      for (const handler of handlers[name] ?? []) handler(payload);
    },
  };
  const attributes = new Map();
  const baseLevels = Array(24).fill(1);
  baseLevels[byName("Hitpoints").getIndex()] = 10;
  const currentLevels = [...baseLevels];
  const experiences = Array(24).fill(0);
  const locked = new Set();
  const packets = { varbits: [], configs: [] };
  const strings = [];
  const manager = {
    getMaxLevel: (skill) => baseLevels[skill.getIndex()],
    getCurrentLevel: (skill) => currentLevels[skill.getIndex()],
    getCombatLevel: () => manager.combatLevel,
    setSkillLocked(skill, value) {
      if (value) locked.add(skill.getIndex());
      else locked.delete(skill.getIndex());
      return manager;
    },
    setExperiences(skill, value) { experiences[skill.getIndex()] = value; return manager; },
    setMaxLevels(skill, value) { baseLevels[skill.getIndex()] = value; return manager; },
    setCurrentLevels(skill, value) { currentLevels[skill.getIndex()] = value; return manager; },
    getExperience: (skill) => experiences[skill.getIndex()],
  };
  const player = {
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getSkillManager: () => manager,
    getPacketSender: () => new Proxy({}, {
      get: (_, name) => {
        if (name === "then") return undefined;
        if (name === "sendContentData") {
          return (source, datasets) => contentData.push({ source, datasets });
        }
        if (name === "sendVarbit") return (id, value) => packets.varbits.push({ id, value });
        if (name === "getVarp") return () => 0;
        if (name === "sendConfig") return (id, value) => packets.configs.push({ id, value });
        if (name === "sendString") return (text, id, serverOwned) => strings.push({ text, id, serverOwned });
        return () => {};
      },
    }),
    moveTo: (location) => { player.location = location; },
    sendMessage: (message) => { (player.messages ??= []).push(message); },
  };
  manager.combatLevel = 3;
  return { api, handlers, runtimeSkills, byName, skill, itemDefinitions, attributes, baseLevels, currentLevels, experiences, locked, manager, player, events, contentData, packets, strings };
}

function summaryFor(fake, unlocked, levels = {}, extra = {}) {
  const rawLevels = [...fake.baseLevels];
  for (const [index, level] of Object.entries(levels)) {
    const canonical = Rules.skill(Number(index));
    const runtime = canonical ? fake.byName(canonical.runtimeName ?? canonical.name) : null;
    if (runtime) rawLevels[runtime.getIndex()] = level;
  }
  return fake.plugin.summaryFromSave({
    attributes: {
      "level-up:unlocked-skills": unlocked,
      "level-up:regions": ["misthalin"],
      "level-up:relics": [],
      "level-up:claimed-region-milestones": [],
      "level-up:claimed-relic-milestones": [],
      ...extra,
    },
    getSkills: () => ({ maxLevel: rawLevels }),
  });
}

function login(fake, event) {
  for (const handler of fake.handlers.login ?? []) handler(event);
}

test("Level-Up lists and awards only the combat mastery challenges this cache supports", () => {
  const Common = require("../plugins/modes/leaguemasteries/Common.LeagueCombatMasteries");
  const Points = require("../plugins/modes/leaguemasteries/Points.LeagueCombatMasteries");
  const fake = createRuntime();
  fake.player.isPlayer = () => true;
  fake.api.onCustomEvent("level-up:mastery-profile", (query) => { query.active = true; });
  Common.init(fake.api);

  assert.equal(Common.data.challenges.list.length, 15, "the data carries the cache's ten and five Level-Up additions");
  assert.deepEqual(Points.challenges(fake.player).map(({ key }) => key), [
    "giant", "high-level-kills", "scurrius-solo", "slayer-55", "jad", "combat-100", "zuk",
    "combat-50", "equip-70-attack-weapon", "protect-from-melee", "deal-50-in-one-hit", "combat-skill-99",
  ]);
  assert.deepEqual(Points.challenges().map(({ key }) => key), Common.data.challenges.list
    .filter(({ levelUpOnly }) => !levelUpOnly).map(({ key }) => key), "other modes keep the cache's ten");
  assert.equal(Points.award(fake.player, "echo-boss"), false, "a hidden challenge cannot pay a point");

  fake.player.setAttribute(Common.POINTS_ATTRIBUTE, { giant: 1, "echo-boss": 1, "echo-bosses-2": 1 });
  assert.equal(Common.earned(fake.player), 1, "stale hidden completions neither count nor cap the balance");
  assert.equal(Common.completedChallenges(fake.player), 1);
  assert.equal(Common.available(fake.player), 1);
  assert.equal(Points.award(fake.player, "high-level-kills"), true);
  assert.equal(Common.earned(fake.player), 2);
  assert.equal(Common.completedChallenges(fake.player), 2);

  const future = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`future-source-${index}`, 1]));
  fake.player.setAttribute(Common.POINTS_ATTRIBUTE, { giant: 1, "echo-boss": 1, ...future });
  assert.equal(Common.earned(fake.player), 21, "the point balance is not capped by the seven-task list");
  assert.equal(Common.completedChallenges(fake.player), 1, "bonus points do not become completed tasks");
  fake.player.setAttribute(Common.POINTS_ATTRIBUTE, { giant: 1, "high-level-kills": 1 });

  fake.packets.varbits.length = 0;
  Points.sendPoints(fake.player);
  assert.deepEqual(
    fake.packets.varbits.filter(({ id }) => id >= 11583 && id <= 11594),
    [
      { id: 11585, value: 1 },
      { id: 11586, value: 1 },
      { id: 11587, value: 0 },
      { id: 11588, value: 0 },
      { id: 11589, value: 0 },
      { id: 11590, value: 0 },
      { id: 11591, value: 0 },
      { id: 11592, value: 0 },
      { id: 11593, value: 0 },
      { id: 11594, value: 0 },
      { id: 11584, value: 2 },
      { id: 11583, value: 2 },
    ],
    "hidden challenge unlock varbits are cleared, and point balances are not clamped",
  );
});

test("the journal opens on the Level-Up Leagues panel after login", () => {
  const Common = require("../plugins/modes/leaguemasteries/Common.LeagueCombatMasteries");
  const Interface = require("../plugins/modes/levelup/Interface.LevelUpWorld");
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  const fake = createRuntime();
  fake.player.isPlayer = () => true;
  Common.init(fake.api);
  plugin.register(fake.api);
  assert.equal(plugin._test.configure("level_up", JSON.stringify(validContract())), true);
  try {
    Interface._test.restoreJournal({ player: fake.player });
    assert.ok(
      fake.packets.varbits.some(({ id, value }) => id === 8168 && value === 4),
      "the journal's selected tab is Leagues, so its panel matches what the client shows",
    );
  } finally {
    plugin._test.configure("", null);
  }
});
test("Level-Up lists only working mastery challenges and never caps the point balance", () => {
  const Common = require("../plugins/modes/leaguemasteries/Common.LeagueCombatMasteries");
  const Points = require("../plugins/modes/leaguemasteries/Points.LeagueCombatMasteries");
  const Interface = require("../plugins/modes/levelup/Interface.LevelUpWorld");
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  const fake = createRuntime();
  fake.player.isPlayer = () => true;
  fake.api.onCustomEvent("level-up:mastery-profile", (query) => { query.active = true; });
  plugin.register(fake.api);
  Common.init(fake.api);
  assert.equal(plugin._test.configure("level_up", JSON.stringify(validContract())), true);
  try {
    const row = Interface._test.challengeEnumRow();
    assert.equal(row.enumId, 5695);
    assert.deepEqual(row.entries, [
      [1, 1177], [2, 1178], [3, 1179], [4, 1180], [5, 1181], [6, 1182], [7, 1186],
      [8, 207800], [9, 207801], [10, 207802], [11, 207803], [12, 207804],
    ], "the three Echo challenges are gone; the five Level-Up additions follow the seven working cache tasks");

    const query = { player: fake.player, league: Interface._test.TASK_TYPE, structs: [], enums: [], dbRows: [] };
    fake.api.emitCustomEvent("league:content-rows", query);
    assert.deepEqual(query.enums, [row], "Level-Up replaces the cache's ten-entry enum, other modes do not");
    assert.deepEqual(query.structs, Interface._test.challengeStructs(), "the five new challenge descriptions are overrides");
    assert.equal(query.structs.length, 5);

    fake.player.setAttribute(Common.POINTS_ATTRIBUTE, { zuk: 1 });
    fake.packets.varbits.length = 0;
    Points.sendPoints(fake.player);
    assert.deepEqual(
      fake.packets.varbits.filter(({ id }) => id >= 11585 && id <= 11594),
      [11585, 11586, 11587, 11588, 11589, 11590, 11591, 11592, 11593, 11594]
        .map((id, index) => ({ id, value: index === 6 ? 1 : 0 })),
      "Zuk's completion follows it to the seventh row",
    );

    const future = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`future-source-${index}`, 1]));
    fake.player.setAttribute(Common.POINTS_ATTRIBUTE, future);
    fake.packets.varbits.length = 0;
    Points.sendPoints(fake.player);
    assert.equal(fake.packets.varbits.find(({ id }) => id === 11584)?.value, 25,
      "the displayed earned balance is not clamped to the seven challenge rows");
  } finally {
    plugin._test.configure("", null);
  }
});

test("the mastery screen's two extra Level-Up rows have task completion bits", () => {
  const Common = require("../plugins/modes/leaguemasteries/Common.LeagueCombatMasteries");
  const Tasks = require("../plugins/modes/leaguetasks/Common.LeagueTasks");
  const Complete = require("../plugins/modes/leaguetasks/Complete.LeagueTasks");
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  const fake = createRuntime();
  fake.player.isPlayer = () => true;
  fake.api.onCustomEvent("level-up:mastery-profile", (query) => { query.active = true; });
  Common.init(fake.api);
  Tasks.init(fake.api);
  plugin.register(fake.api);
  assert.equal(plugin._test.configure("level_up", JSON.stringify(validContract())), true);
  try {
    Complete(fake.api);
    fake.player.setAttribute(Common.POINTS_ATTRIBUTE, {
      giant: 1, "high-level-kills": 1, "scurrius-solo": 1, "slayer-55": 1, jad: 1, "combat-100": 1,
      "deal-50-in-one-hit": 1,
    });
    assert.equal(Common.earned(fake.player), 7);
    assert.equal(Common.completedChallenges(fake.player), 7, "seven points are seven completed challenges");

    fake.packets.configs.length = 0;
    fake.api.emitCustomEvent("league:points-changed", { player: fake.player });
    const varp = fake.packets.configs.find(({ id }) => id === 2616)?.value;
    assert.ok(varp !== undefined, "the task completion varp goes to the client");
    assert.notEqual(varp & (1 << 10), 0, "bit 10 is deal-50-in-one-hit, the screen's eleventh row");
    assert.equal(varp & (1 << 11), 0, "combat-skill-99 is still open");

    fake.player.setAttribute(Common.POINTS_ATTRIBUTE, {
      ...Common.pointsEarned(fake.player), "combat-skill-99": 1,
    });
    fake.packets.configs.length = 0;
    fake.api.emitCustomEvent("league:points-changed", { player: fake.player });
    const withNinetyNine = fake.packets.configs.find(({ id }) => id === 2616)?.value;
    assert.notEqual(withNinetyNine & (1 << 11), 0, "bit 11 is combat-skill-99, the twelfth row");
  } finally {
    plugin._test.configure("", null);
  }
});

test("the Level-Up task screen shows one Combat Mastery reward line per row", () => {
  const Common = require("../plugins/modes/leaguemasteries/Common.LeagueCombatMasteries");
  const Interface = require("../plugins/modes/levelup/Interface.LevelUpWorld");
  const Tasks = require("../plugins/modes/leaguetasks/Common.LeagueTasks");
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  const fake = createRuntime();
  fake.player.isPlayer = () => true;
  fake.api.onCustomEvent("level-up:mastery-profile", (query) => { query.active = true; });
  Common.init(fake.api);
  Tasks.init(fake.api);
  plugin.register(fake.api);
  assert.equal(plugin._test.configure("level_up", JSON.stringify(validContract())), true);
  try {
    const uid = (group, child) => (group << 16) | child;
    assert.equal(Tasks.leagueOf(fake.player), Interface._test.TASK_TYPE,
      "the screen opens for a real Level-Up character, not a league profile");
    fake.player.setAttribute(Common.POINTS_ATTRIBUTE, { giant: 1 });

    // Interface.LeagueTasks' open emits this after mounting 657 and running its task wipe.
    fake.strings.length = 0;
    fake.api.emitCustomEvent("league:tasks-opened", { player: fake.player });

    const writes = fake.strings.filter(({ id }) => (id >>> 16) === 657);
    const title = writes.find(({ id }) => id === uid(657, 32811));
    assert.equal(title?.text, "Combat Mastery Tasks <col=ffffff>1/12</col>",
      "script 9428's title text is 657:32811; 32810 is the sprite beside it");
    assert.equal(title?.serverOwned, true);
    const banner = writes.find(({ id }) => id === uid(657, 32785));
    assert.equal(banner?.text, "Complete challenges for Combat Mastery points.");
    assert.equal(banner?.serverOwned, true);

    const total = Common.levelUpChallenges().length;
    assert.equal(total, 12, "the twelve mastery challenges are the screen's rows");
    for (let index = 0; index < total; index++) {
      const nameId = uid(657, 32824 + index * 5);
      const rewardId = uid(657, 32825 + index * 5);
      const rowWrites = writes.filter(({ id }) => {
        const child = id & 0xffff;
        const rowStart = 32820 + index * 5;
        return child > rowStart && child <= rowStart + 5;
      });
      const rewards = rowWrites.filter(({ text }) => /Reward:/i.test(text));
      assert.equal(rewards.length, 1, `row ${index} has exactly one reward line`);
      assert.equal(rewards[0].id, rewardId,
        "script 9429 draws the reward at 32825 + row * 5, not at the name text 32824");
      assert.equal(rewards[0].text, "Reward: <col=ffffff>1 Combat Mastery point");
      assert.equal(rewards[0].serverOwned, true, "the client's redraw may not replace it");
      assert.equal(rowWrites.some(({ id }) => id === nameId), false,
        "the challenge name at 32824 + row * 5 is left intact");
    }
    assert.equal(writes.some(({ text }) => /League Points/i.test(text)), false,
      "no row receives the seasonal League Points reward");
  } finally {
    plugin._test.configure("", null);
  }
});

test("the five Level-Up additions use authoritative events, thresholds and one-time persistence", () => {
  const Common = require("../plugins/modes/leaguemasteries/Common.LeagueCombatMasteries");
  const Points = require("../plugins/modes/leaguemasteries/Points.LeagueCombatMasteries");
  const fake = createRuntime();
  fake.player.isPlayer = () => true;
  fake.api.onCustomEvent("level-up:mastery-profile", (query) => { query.active = true; });
  Common.init(fake.api);
  Points(fake.api);

  const done = (key) => Common.pointsEarned(fake.player)[key] === 1;
  const event = (name, payload) => fake.api.emitCustomEvent(name, payload);

  fake.manager.combatLevel = 49;
  event("league:login", { player: fake.player });
  assert.equal(done("combat-50"), false, "combat 49 is below the new threshold");
  fake.manager.combatLevel = 50;
  event("league:login", { player: fake.player });
  assert.equal(done("combat-50"), true);

  const weak = { getRequirements: () => [69] };
  const qualifying = { getRequirements: () => [70] };
  const godsword = { getRequirements: () => [75] };
  fake.itemDefinitions.set(1001, weak);
  fake.itemDefinitions.set(1002, qualifying);
  fake.itemDefinitions.set(1003, godsword);
  event("equipment:changed", { player: fake.player, equipped: false, itemId: 1002, slot: 3 });
  event("equipment:changed", { player: fake.player, equipped: true, itemId: 1002, slot: 4 });
  event("equipment:changed", { player: fake.player, equipped: true, itemId: 1001, slot: 3 });
  assert.equal(done("equip-70-attack-weapon"), false, "a weapon below the 70 Attack threshold does not count");
  event("equipment:changed", { player: fake.player, equipped: true, itemId: 1003, slot: 3 });
  assert.equal(done("equip-70-attack-weapon"), true, "a Godsword's 75 Attack requirement satisfies the 70 Attack task");

  event("prayer:activated", { player: fake.player, prayerId: 17 });
  assert.equal(done("protect-from-melee"), false, "another protection prayer is not Protect from Melee");
  event("prayer:activated", { player: fake.player, prayerId: 18 });
  assert.equal(done("protect-from-melee"), true);

  const part = () => {
    const observers = [];
    return {
      onApplied(observer) { observers.push(observer); return this; },
      isReflected: () => false,
      getOrigin: () => null,
      apply(damage) { for (const observer of observers) observer(damage); },
    };
  };
  const first = part();
  const second = part();
  fake.handlers.hitResolved[0]({ attacker: fake.player, target: {}, hit: { getHits: () => [first, second] } });
  first.apply(30);
  second.apply(30);
  assert.equal(done("deal-50-in-one-hit"), false, "two hitsplats of 30 are not one hit of 60");
  const third = part();
  fake.handlers.hitResolved[0]({ attacker: fake.player, target: {}, hit: { getHits: () => [third] } });
  third.apply(49);
  assert.equal(done("deal-50-in-one-hit"), false, "the applied damage, not the roll, is what counts");
  const fourth = part();
  fake.handlers.hitResolved[0]({ attacker: fake.player, target: {}, hit: { getHits: () => [fourth] } });
  fourth.apply(50);
  assert.equal(done("deal-50-in-one-hit"), true);
  assert.equal(Common.completedChallengeKeys(fake.player).filter((key) => key === "deal-50-in-one-hit").length, 1);

  fake.manager.setMaxLevels(fake.skill.COOKING, 99);
  fake.handlers.levelUp[0]({ player: fake.player, skill: fake.skill.COOKING, oldLevel: 98, newLevel: 99 });
  assert.equal(done("combat-skill-99"), false, "an unrelated 99 does not count");
  fake.manager.setMaxLevels(fake.skill.PRAYER, 99);
  fake.handlers.levelUp[0]({ player: fake.player, skill: fake.skill.PRAYER, oldLevel: 98, newLevel: 99 });
  assert.equal(done("combat-skill-99"), true);

  const points = { ...Common.pointsEarned(fake.player) };
  const awards = fake.events.filter(({ name }) => name === "league:mastery-point").length;
  for (const key of ["combat-50", "equip-70-attack-weapon", "protect-from-melee", "deal-50-in-one-hit", "combat-skill-99"]) {
    assert.equal(points[key], 1);
    assert.equal(Points.award(fake.player, key), false, `${key} awards once`);
  }
  assert.equal(fake.events.filter(({ name }) => name === "league:mastery-point").length, awards,
    "repeat attempts emit no further point event");
});

test("the Level-Up additions persist through reconnect and check 99s at login", () => {
  const Common = require("../plugins/modes/leaguemasteries/Common.LeagueCombatMasteries");
  const Points = require("../plugins/modes/leaguemasteries/Points.LeagueCombatMasteries");
  const fake = createRuntime();
  fake.player.isPlayer = () => true;
  fake.api.onCustomEvent("level-up:mastery-profile", (query) => { query.active = true; });
  Common.init(fake.api);
  Points(fake.api);

  const done = (runtime, key) => Common.pointsEarned(runtime.player)[key] === 1;
  const awards = (runtime) => runtime.events.filter(({ name }) => name === "league:mastery-point").length;

  fake.manager.combatLevel = 50;
  fake.manager.setMaxLevels(fake.skill.COOKING, 99);
  fake.manager.setMaxLevels(fake.skill.ATTACK, 98);
  fake.api.emitCustomEvent("league:login", { player: fake.player });
  assert.equal(done(fake, "combat-50"), true, "an existing Level-Up character qualifies at login");
  assert.equal(done(fake, "combat-skill-99"), false, "an unrelated 99 does not qualify at login");

  fake.manager.setMaxLevels(fake.skill.ATTACK, 99);
  fake.api.emitCustomEvent("league:login", { player: fake.player });
  assert.equal(done(fake, "combat-skill-99"), true, "a combat 99 qualifies at login");

  const saved = Object.fromEntries(fake.attributes);
  const savedAwards = awards(fake);
  fake.api.emitCustomEvent("league:login", { player: fake.player });
  assert.equal(awards(fake), savedAwards, "relogging does not pay the same challenge twice");
  assert.deepEqual(Object.fromEntries(fake.attributes), saved, "relogging leaves persisted progress unchanged");

  const restarted = createRuntime();
  restarted.player.isPlayer = () => true;
  restarted.api.onCustomEvent("level-up:mastery-profile", (query) => { query.active = true; });
  for (const [key, value] of Object.entries(saved)) restarted.attributes.set(key, value);
  Common.init(restarted.api);
  Points(restarted.api);
  restarted.manager.combatLevel = 50;
  restarted.manager.setMaxLevels(restarted.skill.ATTACK, 99);
  restarted.api.emitCustomEvent("league:login", { player: restarted.player });
  assert.equal(done(restarted, "combat-50"), true, "the combat-level award survives a restart");
  assert.equal(done(restarted, "combat-skill-99"), true, "the 99 award survives a restart");
  assert.equal(awards(restarted), 0, "a restarted server does not award persisted challenges again");
});

test("the five additions are neither listed nor awardable outside Level-Up", () => {
  const Common = require("../plugins/modes/leaguemasteries/Common.LeagueCombatMasteries");
  const Points = require("../plugins/modes/leaguemasteries/Points.LeagueCombatMasteries");
  const fake = createRuntime();
  fake.player.isPlayer = () => true;
  fake.api.onCustomEvent("league:profile", (query) => { query.league = 5; });
  Common.init(fake.api);

  assert.deepEqual(Points.challenges(fake.player).map(({ key }) => key), [
    "giant", "high-level-kills", "scurrius-solo", "slayer-55", "jad", "combat-100",
    "echo-boss", "echo-bosses-2", "echo-bosses-3", "zuk",
  ]);
  assert.equal(Points.award(fake.player, "combat-50"), false);
  assert.equal(Points.award(fake.player, "equip-70-attack-weapon"), false);
  assert.equal(Points.award(fake.player, "protect-from-melee"), false);
  assert.equal(Points.award(fake.player, "deal-50-in-one-hit"), false);
  assert.equal(Points.award(fake.player, "combat-skill-99"), false);
  assert.deepEqual(Common.completedChallengeKeys(fake.player), []);
});

test("the canonical catalogue is the platform's 24-skill schema", () => {
  assert.deepEqual(Rules.SKILLS.map(({ name }) => name), [
    "Attack", "Strength", "Defence", "Ranged", "Prayer", "Magic", "Runecraft",
    "Hitpoints", "Agility", "Herblore", "Thieving", "Crafting", "Fletching",
    "Slayer", "Hunter", "Mining", "Smithing", "Fishing", "Cooking", "Firemaking",
    "Woodcutting", "Farming", "Construction", "Sailing",
  ]);
  assert.equal(Rules.HITPOINTS_INDEX, 7);
  assert.equal(Rules.skillIndexByName("Hitpoints"), 7);
  assert.equal(Rules.skillIndexByName("Runecraft"), 6);
  assert.equal(Rules.skillIndexByName("Runecrafting"), 6, "the runtime's Runecrafting maps to platform Runecraft");
  assert.equal(Rules.skillIndexByName("Sailing"), 23, "Sailing, not Summoning, is skill 24");
});

test("Level-Up XP tiers cover all 24 counts with every contract boundary", () => {
  const expected = [3, 3, 3, 6, 6, 6, 9, 9, 9, 12, 12, 12, 15, 15, 15, 18, 18, 18, 21, 21, 21, 24, 24, 24];
  assert.deepEqual(Array.from({ length: 24 }, (_, index) => Rules.xpMultiplier(index + 1)), expected);
  assert.equal(Rules.xpMultiplier(3), 3);
  assert.equal(Rules.xpMultiplier(4), 6);
  assert.equal(Rules.xpMultiplier(21), 21);
  assert.equal(Rules.xpMultiplier(22), 24);
  assert.equal(Rules.xpMultiplier(24), 24);
});

test("Level-Up unlocks relics from Trailblazer Reloaded's catalog", () => {
  const leagues = require("../plugins/modes/data/league-relics.json").leagues;
  assert.equal(Rules.LEAGUE_STYLE_TYPE, 4, "League type 4 is Leagues IV - Trailblazer Reloaded");
  const tiers = leagues[Rules.LEAGUE_STYLE_TYPE].tiers;
  assert.deepEqual(tiers[1].relics.map((relic) => relic.name),
    ["Fairy's Flight", "Globetrotter"], "tier 2 has the Wiki's two relics");
  assert.deepEqual(tiers[2].relics.map((relic) => relic.name),
    ["Banker's Note", "Fire Sale"], "tier 3 has the Wiki's two relics");
});

test("the relic screen never maps an unselected slot to a real relic", () => {
  const Interface = require("../plugins/modes/levelup/Interface.LevelUpWorld");
  const catalog = { tiers: [{ relics: [{}, {}] }, { relics: [{}] }] };
  assert.deepEqual(Interface._test.slotToRelic(catalog, 0), { tier: 0, slot: 1 });
  assert.deepEqual(Interface._test.slotToRelic(catalog, 2), { tier: 1, slot: 1 });
  assert.equal(Interface._test.slotToRelic(catalog, -1), null, "the open screen's -1 means nothing selected");
  assert.equal(Interface._test.slotToRelic(catalog, 1.5), null);
  assert.equal(Interface._test.slotToRelic(catalog, 3), null);
});

test("removed catalog relics reopen their earned Level-Up tiers for a replacement pick", () => {
  const Common = require("../plugins/modes/leaguerelics/Common.LeagueRelics");
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  const fake = createRuntime();
  fake.plugin = plugin;
  plugin.register(fake.api);
  Common.init(fake.api);
  assert.equal(plugin._test.configure("level_up", JSON.stringify(validContract())), true);
  try {
    // Tier 2 slot 3 was Crystal of Memories; tier 3 slot 3 was the Treasure Seeker preview.
    assert.equal(Common.relic(Rules.LEAGUE_STYLE_TYPE, 1, 3), null);
    assert.equal(Common.relic(Rules.LEAGUE_STYLE_TYPE, 2, 3), null);
    assert.ok(Common.relic(Rules.LEAGUE_STYLE_TYPE, 1, 1));
    assert.ok(Common.relic(Rules.LEAGUE_STYLE_TYPE, 2, 1));

    fake.attributes.set("level-up:unlocked-skills", [7, 0, 1, 2, 3, 4, 5, 8]);
    fake.attributes.set("level-up:claimed-relic-milestones", [2, 5, 8]);
    fake.attributes.set("league:relics", { 0: 1, 1: 3, 2: 3 });
    fake.attributes.set("level-up:relics", [
      { id: "endless-harvest", name: "Endless Harvest" },
      { id: "crystal-of-memories", name: "Crystal of Memories" },
      { id: "treasure-seeker", name: "Treasure Seeker" },
    ]);

    login(fake, { player: fake.player, isNewAccount: false });
    assert.deepEqual(fake.attributes.get("league:relics"), { 0: 1 }, "only still-valid slots remain");
    assert.deepEqual(fake.attributes.get("level-up:claimed-relic-milestones"), [2, 5, 8], "earned milestones stay claimed");
    const pending = plugin._test.pendingRelicSelection(fake.player);
    assert.deepEqual(pending, { milestone: 5, tier: 1, reclaim: true });
    assert.equal(plugin.progress(fake.player).pendingRelicMilestone, 5);
    assert.equal(plugin.progress(fake.player).pendingRelicTier, 1);
    assert.match(fake.player.messages.join("\n"), /tiers 2, 3|no longer available/i);

    assert.equal(plugin.unlockRelic(fake.player, "2"), true, "tier 2 may be replaced with Globetrotter");
    assert.deepEqual(fake.attributes.get("league:relics"), { 0: 1, 1: 2 });
    assert.deepEqual(fake.attributes.get("level-up:claimed-relic-milestones"), [2, 5, 8]);
    assert.equal(plugin.progress(fake.player).pendingRelicTier, 2, "tier 3 is still waiting for a replacement");
    assert.equal(plugin.unlockRelic(fake.player, "1"), true, "tier 3 may be replaced with Banker's Note");
    assert.deepEqual(fake.attributes.get("league:relics"), { 0: 1, 1: 2, 2: 1 });
    assert.equal(plugin.progress(fake.player).pendingRelicMilestone, null);
    assert.deepEqual(
      fake.attributes.get("level-up:relics").map(({ id }) => id),
      ["endless-harvest", "globetrotter", "banker-s-note"],
    );
  } finally {
    plugin._test.configure("", null);
  }
});

test("the relic panel keeps the top tier's cost nonzero so its tracker cannot divide by zero", () => {
  const Common = require("../plugins/modes/leaguerelics/Common.LeagueRelics");
  const Interface = require("../plugins/modes/levelup/Interface.LevelUpWorld");
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  const fake = createRuntime();
  fake.api.core.CacheDefinitions = { getSpriteId: () => 1000 };
  Common.init(fake.api);
  assert.equal(plugin._test.configure("level_up", JSON.stringify(validContract())), true);
  try {
    const tierCost = Common.data.params.tierCost;
    const costs = () => Interface._test.relicCostOverrides(fake.player).map((row) => row.params[tierCost]);
    const pick = (tiers) => fake.attributes.set("league:relics",
      Object.fromEntries(tiers.map((tier) => [tier, 1])));

    fake.attributes.set("level-up:unlocked-skills", Array.from({ length: 24 }, (_value, index) => index));
    fake.attributes.set("level-up:claimed-relic-milestones", [2, 5, 8, 11, 14, 17, 20]);
    pick([0, 1, 2, 3, 4, 5, 6]);
    assert.equal(plugin.progress(fake.player).pendingRelicMilestone, 23);
    assert.equal(plugin.progress(fake.player).pendingRelicTier, 7);

    const top = costs();
    assert.equal(top.length, 8);
    assert.equal(top[7], 1, "the earned top tier costs one point, never zero");
    assert.deepEqual(top.slice(0, 7), Array(7).fill(2), "every locked tier costs two points");
    assert.equal(Interface._test.relicClaimedPoints(fake.player), 1,
      "one claimed point still marks only the earned tier");

    fake.attributes.set("level-up:claimed-relic-milestones", [2]);
    pick([0]);
    assert.equal(plugin.progress(fake.player).pendingRelicTier, 1);
    const lower = costs();
    assert.equal(lower[1], 0, "an earned mid tier keeps the cache's free-tier look");
    assert.deepEqual(lower.filter((_cost, tier) => tier !== 1), Array(7).fill(1));
    assert.equal(Interface._test.relicClaimedPoints(fake.player), 0);

    fake.attributes.set("level-up:claimed-relic-milestones", [2, 5, 8, 11, 14, 17, 20, 23]);
    pick([0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(plugin.progress(fake.player).pendingRelicMilestone, null);
    assert.deepEqual(costs(), Array(8).fill(1), "with nothing pending every tier stays locked");
    assert.equal(Interface._test.relicClaimedPoints(fake.player), 0);
  } finally {
    plugin._test.configure("", null);
  }
});

test("Level-Up's eighth relic pick routes Guardian through the item grant", () => {
  const Common = require("../plugins/modes/leaguerelics/Common.LeagueRelics");
  const Unlock = require("../plugins/modes/leaguerelics/Unlock.LeagueRelics");
  const originalGrant = Unlock.grant;
  const granted = [];
  let plugin;
  Unlock.grant = (player, relic) => granted.push({ player, relic });
  try {
    const fake = createRuntime();
    plugin = require("../plugins/modes/TemplateWorlds.plugin");
    fake.plugin = plugin;
    plugin.register(fake.api);
    Common.init(fake.api);
    plugin._test.configure("level_up", JSON.stringify(validContract()));
    login(fake, { player: fake.player, isNewAccount: true });
    fake.attributes.set("level-up:unlocked-skills", Rules.SKILLS.map(({ index }) => index).slice(0, 23));
    fake.attributes.set("level-up:claimed-relic-milestones", Rules.RELIC_MILESTONES.slice(0, 7));
    fake.attributes.set("league:relics", { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 });
    assert.equal(plugin._test.pendingMilestone(fake.player, "relic"), 23);

    assert.equal(
      fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "relic", "3"] }),
      true,
    );
    assert.deepEqual(fake.attributes.get("league:relics"), { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 3 });
    assert.equal(granted.length, 1, "the pick reaches the item grant");
    assert.equal(granted[0].relic.key, "guardian");
    assert.ok(granted[0].relic.grants.includes("GUARDIAN_HORN"), "the horn is part of the grant");
  } finally {
    Unlock.grant = originalGrant;
    plugin?._test.configure("", null);
  }
});

test("Level-Up relic passive text drops league and combat XP modifier lines", () => {
  assert.equal(
    Rules.stripXpPassiveLines("- League XP multiplier is 5x.<br><br>- Run energy is never drained whilst running."),
    "- Run energy is never drained whilst running.",
  );
  assert.equal(
    Rules.stripXpPassiveLines("- League XP multiplier increased from 5x to 8x."),
    "There are no passive unlocks for this tier.",
  );
  assert.equal(
    Rules.stripXpPassiveLines(
      "- Combat skills (Including Hitpoints & Prayer) have a 2x Multiplier (Multiplicative with other modifiers).<br>- Slayer points are x5 from tasks.",
    ),
    "- Slayer points are x5 from tasks.",
  );
});

test("skill eligibility uses every unlocked skill, the 4xN gate, and 99 at full unlock", () => {
  assert.equal(Rules.eligible([7], { 7: 10 }), true, "HP 10 may immediately unlock skill two");
  assert.equal(Rules.eligible([0, 7], { 0: 8, 7: 8 }), true);
  assert.equal(Rules.eligible([0, 7], { 0: 7, 7: 8 }), false);
  const twentyThree = Array.from({ length: 23 }, (_, index) => index + 1);
  assert.equal(Rules.eligible(twentyThree, Object.fromEntries(twentyThree.map((index) => [index, 91]))), false);
  assert.equal(Rules.eligible(twentyThree, Object.fromEntries(twentyThree.map((index) => [index, 92]))), true);
  assert.equal(Rules.eligible(Array.from({ length: 24 }, (_, index) => index), {}), false);
  assert.equal(Rules.requirement(1), 4);
  assert.equal(Rules.requirement(23), 92);
  assert.equal(Rules.requirement(24), 99);
});

test("region and relic milestones match the contract and never overlap", () => {
  const regions = [];
  const relics = [];
  for (let count = 1; count <= 24; count++) {
    const reward = Rules.rewardAt(count);
    if (reward.region) regions.push(count);
    if (reward.relic) relics.push(count);
    assert.equal(reward.region && reward.relic, false);
  }
  assert.deepEqual(regions, [3, 6, 9, 12, 15, 18, 21, 24]);
  assert.deepEqual(relics, [2, 5, 8, 11, 14, 17, 20, 23]);
});

test("canonical normalisation migrates runtime indexes and old numeric map areas", () => {
  assert.deepEqual(Rules.normaliseSkills([0, 0, -1, 99, 7]), [0, 7]);
  assert.deepEqual(Rules.normaliseSkills([]), [7]);
  assert.deepEqual(Rules.normaliseRegions([1, "karamja", { id: "misthalin" }, "kourend"]).map(({ id }) => id), [
    "misthalin", "karamja", "kourend",
  ]);
  assert.equal(Rules.regionByText("Kharidian Desert").id, "kharidian-desert");
  assert.deepEqual(Rules.REGIONS.map(({ id, area }) => [id, area]), [
    ["misthalin", 1], ["karamja", 2], ["asgarnia", 3], ["kandarin", 4],
    ["morytania", 5], ["kharidian-desert", 6], ["tirannwn", 7], ["fremennik", 8],
    ["wilderness", 11], ["kourend", 20], ["varlamore", 21],
  ]);
  assert.equal(Rules.region(21).id, "varlamore");
  assert.equal(Rules.regionByText("varlamore").id, "varlamore");
  assert.equal(Rules.regionByText("Varlamore").id, "varlamore");
});

test("Level-Up unlocks Varlamore at a pending region milestone", () => {
  const fake = createRuntime();
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  plugin.register(fake.api);
  plugin._test.configure("level_up", validContract());
  fake.attributes.set("level-up:unlocked-skills", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  fake.attributes.set("level-up:regions", ["misthalin", "kandarin", "wilderness"]);
  fake.attributes.set("level-up:claimed-region-milestones", [3, 6]);
  assert.equal(plugin._test.progress(fake.player).pendingRegionMilestone, 9);
  assert.equal(plugin._test.progress(fake.player).unlockedCount, 10);

  const messages = [];
  const originalSend = fake.player.sendMessage.bind(fake.player);
  fake.player.sendMessage = (text) => { messages.push(String(text)); return originalSend(text); };

  plugin.unlockRegion(fake.player, "varlamore");
  assert.deepEqual(plugin._test.progress(fake.player).regions.map(({ id }) => id), [
    "misthalin", "kandarin", "wilderness", "varlamore",
  ]);
  assert.equal(plugin._test.progress(fake.player).pendingRegionMilestone, null);
  assert.match(messages.at(-1), /Varlamore unlocked/i);
  assert.deepEqual(
    fake.attributes.get("level-up:claimed-region-milestones"),
    [3, 6, 9],
  );
});

test("the core skill lock keeps the real level and rejects direct experience gains", () => {
  const sender = new Proxy({}, { get: (_, name) => (name === "then" ? undefined : () => sender) });
  const manager = new SkillManager({ getPacketSender: () => sender, getAttribute: () => undefined });
  manager.setMaxLevel(Skill.ATTACK, 10).setCurrentLevel(Skill.ATTACK, 10, false).setExperience(Skill.ATTACK, 1000);
  manager.setSkillLocked(Skill.ATTACK, true);
  assert.equal(manager.getMaxLevel(Skill.ATTACK), 10);
  assert.equal(manager.getCurrentLevel(Skill.ATTACK), 10);
  assert.equal(manager.getExperience(Skill.ATTACK), 1000);
  manager.addExperience(Skill.ATTACK, 1000, false);
  assert.equal(manager.getExperience(Skill.ATTACK), 1000, "locked skills cannot gain XP at the core");
  manager.setSkillLocked(Skill.ATTACK, false);
  manager.addExperience(Skill.ATTACK, 10, false);
  assert.equal(manager.getExperience(Skill.ATTACK), 1010);
  assert.equal(manager.getMaxLevel(Skill.ATTACK), 10);
});

test("the runtime plugin is fail-closed, persists canonical progress, and restores it on reconnect", () => {
  const Common = require("../plugins/modes/leaguerelics/Common.LeagueRelics");
  const originalRelic = Common.relic;
  Common.relic = (type, tier, slot) => (type === 4
    ? { key: `test-relic-${tier}-${slot}`, name: `Test Relic ${tier + 1} ${slot}`, grants: [] }
    : originalRelic(type, tier, slot));
  after(() => { Common.relic = originalRelic; });

  const fake = createRuntime();
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  fake.plugin = plugin;
  plugin.register(fake.api);
  Common.init(fake.api);

  login(fake, { player: fake.player });
  assert.equal(fake.attributes.has("level-up:unlocked-skills"), false, "plain templates are untouched");
  assert.deepEqual(fake.contentData.at(-1)?.datasets?.[0]?.rows, [], "plain templates send no locked-skill overlay");
  const plainWealth = { enabled: true };
  fake.api.emitCustomEvent("wealth:enabled", plainWealth);
  assert.equal(plainWealth.enabled, true, "other templates keep wealth transfer on");
  const plainProtection = { player: fake.player, protected: true };
  fake.api.emitCustomEvent("combat:developer-protection", plainProtection);
  assert.equal(plainProtection.protected, true, "plain templates keep staff damage protection");

  fake.api.emitCustomEvent("paescape:world-config", {
    canonicalTemplate: "level_up",
    templateContract: { ...validContract(), leagueSeason: 6 },
  });
  assert.equal(plugin._test.active(), false, "a contract with a Demonic Pacts season is refused");
  assert.equal(plugin._test.configure("level_up", JSON.stringify(validContract())), true, "packaged JSON is parsed");
  assert.equal(plugin._test.active(), true);
  const spawned = [];
  fake.api.core.CacheDefinitions = { getNpcId: (name) => (name === "league_tutor_league" ? 315 : null) };
  fake.api.core.World = { getNpcs: () => [] };
  fake.api.spawnNpc = (spec) => (spawned.push(spec), spec);
  plugin._test.spawnLeaguesTutor();
  assert.deepEqual(spawned, [{ id: 315, x: 3226, y: 3215, z: 0, wanderRadius: 0 }], "Level-Up has the league tutor at Lumbridge");
  fake.api.core.World = { getNpcs: () => [{ getId: () => 315 }] };
  plugin._test.spawnLeaguesTutor();
  assert.equal(spawned.length, 1, "the tutor is not duplicated");
  const levelUpProtection = { player: fake.player, protected: true };
  fake.api.emitCustomEvent("combat:developer-protection", levelUpProtection);
  assert.equal(levelUpProtection.protected, false, "Level-Up characters take real damage");
  plugin._test.configure("", null);
  assert.equal(plugin._test.active(), false);

  fake.api.emitCustomEvent("paescape:world-config", {
    canonicalTemplate: "level_up",
    templateContract: validContract(),
  });
  assert.equal(fake.api.rate, 1, "world rate is neutral so the visible tier is not doubled");
  const flags = { player: fake.player, flags: 0 };
  fake.api.emitCustomEvent("world:map-flags", flags);
  assert.equal(flags.flags & (1 << 30), 1 << 30, "Level-Up marks the world for the client's Leagues journal tab");
  // PlayerSave applies registered attribute defaults before login; a new character must
  // still get HP 10 and the Misthalin spawn rather than being mistaken for a saved one.
  fake.attributes.set("level-up:unlocked-skills", [7]);
  fake.packets.varbits.length = 0;
  fake.packets.configs.length = 0;
  fake.events.length = 0;
  login(fake, { player: fake.player, isNewAccount: true });
  assert.ok(fake.events.some(({ name, payload }) => name === "diary:complete-all" && payload?.player === fake.player),
    "Level-Up completes every achievement diary at login");
  const diaryRewards = { player: fake.player, unrestricted: false, includeXpLamps: true };
  fake.api.emitCustomEvent("diary:rewards-unrestricted", diaryRewards);
  assert.equal(diaryRewards.unrestricted, true, "Level-Up still hands out every diary reward tier");
  assert.equal(diaryRewards.includeXpLamps, true, "Level-Up keeps the diaries' XP lamps");
  const levelUpWealth = { enabled: true };
  fake.api.emitCustomEvent("wealth:enabled", levelUpWealth);
  assert.equal(levelUpWealth.enabled, false, "Level-Up vetoes wealth transfer on the live world");
  assert.ok(fake.packets.varbits.some(({ id, value }) => id === 10031 && value === 1), "league account varbit");
  assert.ok(fake.packets.varbits.some(({ id, value }) => id === 10032 && value === 4), "league style varbit");
  assert.ok(fake.packets.varbits.some(({ id, value }) => id === 10037 && value === 14),
    "completed tutorial varbit: script 2449's finished value, so the area screen does not warn (issue #23)");
  assert.ok(fake.packets.configs.some(({ id, value }) => id === 3717 && (value & (1 << 30)) !== 0), "league world map flag");
  assert.ok(fake.packets.configs.some(({ id, value }) => id === 4920 && (value & (1 << 1)) !== 0), "the client's cached league feature flag");

  assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), [7]);
  assert.deepEqual(fake.attributes.get("level-up:regions"), ["misthalin"]);
  assert.deepEqual(fake.attributes.get("level-up:relics"), []);
  assert.equal(fake.manager.getMaxLevel(fake.byName("Hitpoints")), 10);
  assert.equal(fake.manager.getCurrentLevel(fake.byName("Hitpoints")), 10);
  assert.equal(fake.manager.getExperience(fake.byName("Hitpoints")), 1000);
  assert.equal(fake.manager.getMaxLevel(fake.byName("Attack")), 1, "locked skills keep level one");
  assert.equal(fake.contentData.at(-1)?.datasets?.[0]?.active, true, "Level-Up marks the Skills-tab overlay active");
  assert.ok(fake.contentData.at(-1)?.datasets?.[0]?.rows?.includes(Rules.statChild(0)), "locked Attack has an overlay");
  assert.equal(fake.contentData.at(-1)?.datasets?.[0]?.rows?.includes(Rules.statChild(7)), false, "unlocked Hitpoints has no overlay");
  assert.equal(fake.player.location.x, 3222);
  assert.equal(fake.player.location.y, 3219);
  assert.equal(fake.player.location.z, 0);

  const lockedXp = { player: fake.player, skill: fake.byName("Attack"), allow: null, multiplier: 1 };
  fake.handlers.xp[0](lockedXp);
  assert.equal(lockedXp.allow, false);
  const hpXp = { player: fake.player, skill: fake.byName("Hitpoints"), allow: null, multiplier: 1 };
  fake.handlers.xp[0](hpXp);
  assert.equal(hpXp.multiplier, 3);
  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "skill", "Attack"] });
  assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), [0, 7]);
  assert.equal(fake.manager.getMaxLevel(fake.byName("Attack")), 1);
  assert.equal(fake.manager.getCurrentLevel(fake.byName("Attack")), 1);
  assert.equal(fake.manager.getMaxLevel(fake.byName("Strength")), 1, "locked skills stay locked at level one");
  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "skill", "Attack"] });
  assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), [0, 7], "a skill cannot be claimed twice");

  const early = summaryFor(fake, [0, 7], { 0: 1, 7: 10 }, {
    "level-up:claimed-relic-milestones": [],
  });
  assert.equal(early.unlockedCount, 2);
  assert.equal(early.requiredLevel, 8);
  assert.equal(early.xpMultiplier, 3);
  assert.equal(early.nextSkillEligible, false);
  assert.equal(early.pendingRelicMilestone, 2);
  assert.deepEqual(early.unlockedSkills.map(({ index, name, level }) => ({ index, name, level })), [
    { index: 0, name: "Attack", level: 1 },
    { index: 7, name: "Hitpoints", level: 10 },
  ]);

  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "skill", "Strength"] });
  assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), [0, 7], "below 4xN refuses the third skill");
  fake.manager.setMaxLevels(fake.byName("Attack"), 8);
  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "skill", "Strength"] });
  assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), [0, 1, 7]);
  fake.manager.setMaxLevels(fake.byName("Hitpoints"), 12);
  fake.manager.setMaxLevels(fake.byName("Attack"), 12);
  fake.manager.setMaxLevels(fake.byName("Strength"), 12);

  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "region", "Karamja"] });
  assert.deepEqual(fake.attributes.get("level-up:regions"), ["misthalin", "karamja"]);
  assert.deepEqual(fake.attributes.get("level-up:claimed-region-milestones"), [3]);
  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "region", "Karamja"] });
  assert.deepEqual(fake.attributes.get("level-up:regions"), ["misthalin", "karamja"], "a region cannot be claimed twice");

  const areaQuery = { player: fake.player };
  fake.api.emitCustomEvent("level-up:area-profile", areaQuery);
  assert.deepEqual(areaQuery.unlocked, [1, 2]);
  const relicQuery = { player: fake.player };
  fake.api.emitCustomEvent("level-up:relic-profile", relicQuery);
  assert.equal(relicQuery.league, 4, "relic effects see the league catalog without a seasonal profile");
  assert.equal(relicQuery.active, true, "the seasonal relic interface stays out of Level-Up's way");
  assert.equal(Common.levelUpOwns(fake.player), true);

  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "skill", "Defence"] });
  assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), [0, 1, 2, 7], "the next unlock is allowed below the next milestone");
  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "skill", "Ranged"] });
  assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), [0, 1, 2, 7], "a second reward cannot be left pending");
  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "relic", "1"] });
  assert.deepEqual(fake.attributes.get("level-up:relics"), [{ id: "test-relic-1-1", name: "Test Relic 1 1" }]);
  assert.deepEqual(fake.attributes.get("level-up:claimed-relic-milestones"), [2]);
  assert.deepEqual(fake.attributes.get("league:relics"), { 0: 1 });

  fake.handlers["command:resetrelics"][0]({ player: fake.player, parts: ["resetrelics"] });
  assert.deepEqual(fake.attributes.get("level-up:relics"), []);
  assert.deepEqual(fake.attributes.get("level-up:claimed-relic-milestones"), []);
  assert.deepEqual(fake.attributes.get("league:relics"), {});
  assert.ok(fake.events.some(({ name }) => name === "league:relics-reset"));
  assert.match(fake.player.messages.at(-1), /relics have been reset/i);
  assert.equal(plugin._test.pendingMilestone(fake.player, "relic"), 2, "earned relic milestones return after ::resetrelics");
  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "relic", "2"] });
  assert.deepEqual(fake.attributes.get("league:relics"), { 0: 2 });

  fake.handlers["command:resetareas"][0]({ player: fake.player, parts: ["resetareas"] });
  assert.deepEqual(fake.attributes.get("level-up:regions"), ["misthalin"]);
  assert.deepEqual(fake.attributes.get("level-up:claimed-region-milestones"), []);
  assert.ok(fake.events.some(({ name }) => name === "level-up:regions-reset"));
  assert.match(fake.player.messages.at(-1), /areas have been reset to Misthalin/i);
  assert.equal(plugin._test.pendingMilestone(fake.player, "region"), 3, "earned region milestones return after ::resetareas");
  fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "region", "Asgarnia"] });
  assert.deepEqual(fake.attributes.get("level-up:regions"), ["misthalin", "asgarnia"]);

  const beforeReconnect = { ...Object.fromEntries(fake.attributes) };
  const reconnectSummary = plugin._test.progress(fake.player);
  login(fake, { player: fake.player });
  assert.deepEqual({ ...Object.fromEntries(fake.attributes) }, beforeReconnect, "login restores rather than rewrites progress");
  assert.deepEqual(plugin._test.progress(fake.player), reconnectSummary);
  assert.equal(fake.locked.has(fake.byName("Attack").getIndex()), false);
  assert.equal(fake.locked.has(fake.byName("Strength").getIndex()), false);
  assert.equal(fake.locked.has(fake.byName("Ranged").getIndex()), true);

  const fullLevels = Object.fromEntries(Rules.SKILLS.map(({ index }) => [index, 99]));
  const regionRewards = Rules.REGIONS.filter(({ starting }) => !starting).slice(0, Rules.REGION_MILESTONES.length);
  const relicRewards = Rules.RELIC_MILESTONES.map((milestone) => ({ id: `relic-${milestone}`, name: `Relic ${milestone}` }));
  const full = summaryFor(fake, Rules.SKILLS.map(({ index }) => index), fullLevels, {
    "level-up:regions": ["misthalin", ...regionRewards.map(({ id }) => id)],
    "level-up:relics": relicRewards,
    "level-up:claimed-region-milestones": [...Rules.REGION_MILESTONES],
    "level-up:claimed-relic-milestones": [...Rules.RELIC_MILESTONES],
  });
  assert.equal(full.unlockedCount, 24);
  assert.equal(full.requiredLevel, 99);
  assert.equal(full.nextSkillEligible, false);
  assert.equal(full.xpMultiplier, 24);
  assert.equal(full.nextRegionMilestone, null);
  assert.equal(full.nextRelicMilestone, null);
  assert.equal(full.pendingRegionMilestone, null);
  assert.equal(full.pendingRelicMilestone, null);
  assert.equal(full.regions.length, 9, "Misthalin plus eight milestone regions");
  assert.equal(full.relics.length, 8);
  assert.deepEqual(full.unlockedSkills.map(({ index }) => index), Array.from({ length: 24 }, (_, index) => index));
  for (const entry of [...full.regions, ...full.relics]) {
    assert.match(entry.id, /^[a-z0-9-]{1,40}$/);
    assert.ok(entry.name.length >= 1 && entry.name.length <= 40);
  }
  assert.equal("attributes" in full, false, "arbitrary save attributes never cross the control boundary");

  const { buildStateDocument } = require("../plugins/persistence/PaeScapePlayerPersistence.plugin");
  const offline = {
    attributes: Object.fromEntries(fake.attributes),
    getSkills: () => ({ maxLevel: [...fake.baseLevels] }),
  };
  const state = buildStateDocument(offline, JSON.stringify({ inventory: [] }));
  assert.deepEqual(state.levelUpProgress, plugin.summaryFromSave(offline));
  assert.equal(state.levelUpProgress.schemaVersion, 1, "hosted state carries the platform-validated document");

  // A save touched by an older build may carry a full seasonal relic/area set with no
  // Level-Up milestones. The next login presents only earned progress, not that residue.
  fake.attributes.set("level-up:unlocked-skills", [7]);
  fake.attributes.set("level-up:regions", Rules.REGIONS.map(({ id }) => id));
  fake.attributes.set("level-up:relics", Array.from({ length: 8 }, (_, tier) => ({ id: `stale-${tier}`, name: `Stale ${tier}` })));
  fake.attributes.set("league:relics", Object.fromEntries(Array.from({ length: 8 }, (_, tier) => [tier, 1])));
  fake.attributes.set("level-up:claimed-region-milestones", []);
  fake.attributes.set("level-up:claimed-relic-milestones", []);
  login(fake, { player: fake.player });
  assert.deepEqual(fake.attributes.get("level-up:regions"), ["misthalin"]);
  assert.deepEqual(fake.attributes.get("level-up:relics"), []);
  assert.deepEqual(fake.attributes.get("league:relics"), {});
  assert.deepEqual(plugin._test.progress(fake.player).regions.map(({ id }) => id), ["misthalin"]);
  assert.deepEqual(plugin._test.progress(fake.player).relics, []);

  plugin._test.configure("osrs", null);
  assert.equal(buildStateDocument(offline, JSON.stringify({ inventory: [] })).levelUpProgress, undefined);
  assert.equal(plugin.summaryFromSave({ attributes: {}, getSkills: () => ({ maxLevel: [] }) }), undefined);
  assert.equal(plugin._test.active(), false, "Level-Up progress is absent outside the level_up template");
});

test("::levelup master unlocks all skills at level 99", () => {
  const fake = createRuntime();
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  fake.plugin = plugin;
  plugin.register(fake.api);
  assert.equal(plugin._test.configure("level_up", JSON.stringify(validContract())), true);
  try {
    login(fake, { player: fake.player, isNewAccount: true });
    assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), [Rules.HITPOINTS_INDEX]);

    assert.equal(
      fake.handlers["command:levelup"][0]({ player: fake.player, parts: ["levelup", "master"] }),
      true,
    );

    const allSkills = Rules.SKILLS.map(({ index }) => index);
    assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), allSkills);
    for (const { name, runtimeName } of Rules.SKILLS) {
      const runtime = fake.byName(runtimeName ?? name);
      assert.equal(fake.locked.has(runtime.getIndex()), false, `${name} is unlocked`);
      assert.equal(fake.manager.getMaxLevel(runtime), 99, `${name} is level 99`);
      assert.equal(fake.manager.getCurrentLevel(runtime), 99, `${name} has 99 current`);
      assert.equal(fake.manager.getExperience(runtime), 9900, `${name} has level-99 experience`);
    }
    assert.deepEqual(fake.contentData.at(-1)?.datasets?.[0]?.rows, [], "the locked-skill overlay is cleared");
    assert.equal(plugin._test.progress(fake.player).unlockedCount, 24);
    assert.equal(plugin._test.progress(fake.player).requiredLevel, 99);
    assert.match(fake.player.messages.at(-1), /all 24 skills unlocked at level 99/i);
  } finally {
    plugin._test.configure("", null);
  }
});

test("unlocking Herblore starts it at level 3 while other skills still start at 1", () => {
  const fake = createRuntime();
  const plugin = require("../plugins/modes/TemplateWorlds.plugin");
  fake.plugin = plugin;
  plugin.register(fake.api);
  plugin._test.configure("level_up", JSON.stringify(validContract()));
  login(fake, { player: fake.player, isNewAccount: true });

  assert.equal(Rules.startingLevel(9), 3, "Herblore's canonical index opens at 3");
  assert.equal(Rules.startingLevel(0), 1);
  assert.equal(Rules.startingLevel(20), 1);
  assert.equal(plugin.unlockSkill(fake.player, "Herblore"), true);

  const herblore = fake.byName("Herblore");
  assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), [7, 9]);
  assert.equal(fake.manager.getMaxLevel(herblore), 3);
  assert.equal(fake.manager.getCurrentLevel(herblore), 3);
  assert.equal(fake.manager.getExperience(herblore), 300, "XP matches getExperienceForLevel(3)");
  assert.equal(fake.locked.has(herblore.getIndex()), false);

  plugin._test.configure("", null);
});

test("the Level-Up area mask covers every area past the six selection slots", () => {
  const Interface = require("../plugins/modes/levelup/Interface.LevelUpWorld");
  const AreaData = require("../plugins/modes/data/league-areas.json");
  const { AREA_MASK_VARP, areaMask } = Interface._test;
  const areas = Rules.REGIONS.map(({ area }) => area);

  assert.equal(AREA_MASK_VARP, 7989, "the map mask has a free varp");
  const mask = areaMask(areas);
  for (const area of areas) {
    assert.ok((mask & (1 << area)) !== 0, `area ${area} is in the mask`);
  }
  assert.equal(mask & (1 << 0), 0, "bit zero is unused");
  assert.equal(mask & (1 << 21), 1 << 21, "Varlamore, the highest area id, is included");

  // A full Level-Up run unlocks Misthalin plus eight picks. Every one of them sets a bit;
  // the seventh to ninth unlocks (areas 7, 8 and 11) fall outside the cache's six slots.
  const unlocked = [
    "misthalin", "karamja", "asgarnia", "kandarin", "morytania", "kharidian-desert",
    "tirannwn", "fremennik", "wilderness",
  ].map((id) => Rules.region(id).area);
  const unlockedMask = areaMask(unlocked);
  assert.equal(unlockedMask.toString(2).replace(/0/g, "").length, 9, "nine areas set nine bits");
  for (const area of [7, 8, 11]) {
    const slot = unlocked.indexOf(area);
    assert.ok(slot >= 6, `area ${area} is unlock ${slot + 1}, past the six selection slots`);
    assert.ok((unlockedMask & (1 << area)) !== 0, `area ${area} is in the mask`);
  }
  assert.notEqual(AREA_MASK_VARP, AreaData.varps.unlockedCount, "the mask leaves the count varp alone");
  assert.equal(AreaData.varbits.selection.length, 6, "the cache still has six selection slots");
});
