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
  const events = [];
  const api = {
    core: {
      Skill: { values: () => runtimeSkills, HITPOINTS: byName("Hitpoints") },
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
  const manager = {
    getMaxLevel: (skill) => baseLevels[skill.getIndex()],
    getCurrentLevel: (skill) => currentLevels[skill.getIndex()],
    getCombatLevel: () => 3,
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
        if (name === "sendConfig") return (id, value) => packets.configs.push({ id, value });
        return () => {};
      },
    }),
    moveTo: (location) => { player.location = location; },
    sendMessage: (message) => { (player.messages ??= []).push(message); },
  };
  return { api, handlers, runtimeSkills, byName, attributes, baseLevels, currentLevels, experiences, locked, manager, player, events, contentData, packets };
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

  assert.equal(Common.data.challenges.list.length, 10, "other modes still see the full challenge data");
  assert.deepEqual(Points.challenges(fake.player).map(({ key }) => key), [
    "giant", "high-level-kills", "scurrius-solo", "slayer-55", "jad", "combat-100", "zuk",
  ]);
  assert.deepEqual(Points.challenges().map(({ key }) => key), Common.data.challenges.list.map(({ key }) => key));
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
    ], "the three Echo challenges are gone; TzKal-Zuk moves into the seventh row");

    const query = { player: fake.player, league: Interface._test.TASK_TYPE, structs: [], enums: [], dbRows: [] };
    fake.api.emitCustomEvent("league:content-rows", query);
    assert.deepEqual(query.enums, [row], "Level-Up replaces the cache's ten-entry enum, other modes do not");

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
    ["wilderness", 11], ["kourend", 20],
  ]);
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
  login(fake, { player: fake.player, isNewAccount: true });
  assert.ok(fake.packets.varbits.some(({ id, value }) => id === 10031 && value === 1), "league account varbit");
  assert.ok(fake.packets.varbits.some(({ id, value }) => id === 10032 && value === 4), "league style varbit");
  assert.ok(fake.packets.varbits.some(({ id, value }) => id === 10037), "completed tutorial varbit");
  assert.ok(fake.packets.configs.some(({ id, value }) => id === 3717 && (value & (1 << 30)) !== 0), "league world map flag");

  assert.deepEqual(fake.attributes.get("level-up:unlocked-skills"), [7]);
  assert.deepEqual(fake.attributes.get("level-up:regions"), ["misthalin"]);
  assert.deepEqual(fake.attributes.get("level-up:relics"), []);
  assert.equal(fake.manager.getMaxLevel(fake.byName("Hitpoints")), 10);
  assert.equal(fake.manager.getCurrentLevel(fake.byName("Hitpoints")), 10);
  assert.equal(fake.manager.getExperience(fake.byName("Hitpoints")), 1000);
  assert.equal(fake.manager.getMaxLevel(fake.byName("Attack")), 1, "locked skills keep level one");
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
