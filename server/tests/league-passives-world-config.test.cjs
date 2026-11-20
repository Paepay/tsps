// Run from server/ after `yarn build`: node --test tests/league-passives-world-config.test.cjs
// Issue #53's passive requirement: a world assigns individual passive grants to tiers, with no
// fixed count, and the server applies them automatically at the tier reached. This pins the
// complete split catalog, atomic validation, cross-league activation, independent Slayer grants,
// non-stacking maxima, the Relics toggle, restart behavior and both website-facing endpoints.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

process.env.DISABLE_PLAYER_BOTS = "1";
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { GameConstants } = require("../dist/game/GameConstants");
const { Skill } = require("../dist/game/model/Skill");
const { Location } = require("../dist/game/model/Location");
const FarmingModel = require("../plugins/skills/farming/Model.Farming");

let core;
let Common;
let Catalog;
let Passives;
let BoostedDrops;
let LeagueCommon;
let Crystal;
let PassivesCatalog;
let TrailRuntime;
let BeginnerRuntime;
let Tiers;
let FreeMovement;
let worldConfig = { "league:type": 4 };
const hooks = {};
const custom = {};
const modifiers = {};
const endpoints = new Map();
const logs = [];
const persisted = new Set();

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  require("../plugins/items/ItemDefinitionLoader.plugin").register({
    log() {}, onPlayerLogin() {}, registerContentEndpoint() {},
  });
  GameConstants.setWorldProfile("league");
  const lists = {};
  const on = (name) => (handler) => {
    (lists[name] ??= []).push(handler);
    hooks[name] = (event) => {
      let result;
      for (const attached of lists[name]) {
        const answer = attached(event);
        if (answer !== undefined) result = answer;
      }
      return result;
    };
  };
  const api = new Proxy({
    core,
    persistAttribute: (key) => persisted.add(key),
    getPluginConfig: (key, fallback) => (Object.prototype.hasOwnProperty.call(worldConfig, key) ? worldConfig[key] : fallback),
    setWorldProfile: (profile) => GameConstants.setWorldProfile(profile),
    getSkillManager: () => require("../dist/game/content/skill/SkillManager").SkillManager,
    registerCommand: (name, handler) => (hooks[`command:${name}`] = handler),
    registerContentEndpoint: (name, handler) => endpoints.set(name, handler),
    registerRunEnergyDrainModifier: (modifier) => (modifiers.runEnergyDrain = modifier),
    onInterfaceActionButton: (ids, handler) => {
      for (const id of [].concat(ids)) on(`button:${id}`)(handler);
    },
    onCustomEvent: (name, handler) => (custom[name] = (custom[name] ?? []).concat(handler)),
    emitCustomEvent: (name, payload) => {
      for (const handler of custom[name] ?? []) handler(payload);
    },
    log: (message) => logs.push(message),
  }, { get: (target, key) => (key in target ? target[key] : on(String(key))) });
  require("../plugins/modes/Base.LeagueMode").register(api);
  require("../plugins/modes/Points.LeagueMode").register(api);
  require("../plugins/modes/Relics.LeagueMode").register(api);
  Common = require("../plugins/modes/leaguerelics/Common.LeagueRelics");
  Catalog = require("../plugins/modes/leaguerelics/Catalog.LeagueRelics");
  Passives = require("../plugins/modes/league/Passives.LeagueMode");
  BoostedDrops = require("../plugins/modes/league/BoostedDrops.LeagueMode");
  LeagueCommon = require("../plugins/modes/league/Common.LeagueMode");
  Crystal = require("../plugins/modes/leaguerelics/CrystalOfMemories.LeagueRelics");
  PassivesCatalog = require("../plugins/modes/leaguerelics/PassivesCatalog.LeagueRelics");
  FreeMovement = require("../plugins/world/FreeMovement.plugin");
  Tiers = require("../plugins/treasuretrails/trails/Tiers.TreasureTrails");
  TrailRuntime = require("../plugins/treasuretrails/trails/Runtime.TreasureTrails");
  BeginnerRuntime = require("../plugins/treasuretrails/beginner/Runtime.BeginnerTreasureTrails");
  require("../plugins/treasuretrails/TreasureTrails.plugin").register(api);
  require("../plugins/treasuretrails/BeginnerTreasureTrails.plugin").register(api);
  // TemplateWorlds answers this for PaeScape/Level-Up characters, which have no
  // seasonal league profile but still use the relic catalog.
  custom["level-up:relic-profile"] = [((query) => {
    if (query?.player?.getProfile?.() === "main") query.league = 4;
  })];
});

function configure(settings = {}) {
  worldConfig = { "league:type": 4, ...settings };
  Common.reloadWorldCatalog();
  return Common.passivesWorldState();
}

/** A logged-in real player with relics chosen through `tier` (1-based; 0 none). */
function character(name, tier = 0, leagueType = 4) {
  const player = new Player(null);
  player.setUsername(name);
  player.setProfile("league");
  player.setAttribute("league:type", leagueType);
  player.setLocation(new Location(3200, 3200, 0));
  const sender = new Proxy({}, { get: () => () => sender });
  player.getPacketSender = () => sender;
  player.sendMessage = () => {};
  const picks = {};
  for (let index = 0; index < tier; index++) picks[index] = 1;
  player.setAttribute("league:relics", picks);
  hooks.onPlayerLogin({ player, username: name, isNewAccount: false, profile: "league" });
  return player;
}

function ask(name, payload) {
  for (const handler of custom[name] ?? []) handler(payload);
  return payload;
}

const slayerReward = (player) => ask("slayer:task-reward", { player, master: 7, freeTasks: 4, multiplier: 1 });
const superior = (player) => ask("slayer:superior-spawn", { player, npc: null, unlocked: false, chance: 200 });
const minigame = (player, minigameId = "pest-control", amount = 10) => ask("minigame:points", {
  player, minigame: minigameId, points: amount,
}).points;
const gain = (player, skill = Skill.ATTACK) => {
  const event = { player, skill, experience: 10, allow: null, multiplier: 1 };
  hooks.onCanGainExperience(event);
  return event.multiplier;
};

test("the catalog inventories every source bullet as individual stable grants", () => {
  const entries = Common.passiveCatalog();
  const counts = entries.reduce((all, entry) => ({ ...all, [entry.sourceLeague]: (all[entry.sourceLeague] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { 4: 17, 5: 17, 6: 17 });
  assert.equal(entries.length, 51);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.ok(entries.every((entry) => /^league-[4-6]:t[1-8]:[a-z0-9-]+$/.test(entry.id)));
  assert.ok(entries.every((entry) => entry.name && entry.description && entry.sourceText));
  assert.ok(entries.every((entry) => entry.implementation.location));

  const ids = new Set(entries.map((entry) => entry.id));
  for (const id of [
    "league-4:t1:drop-rate-x2", "league-4:t1:run-energy", "league-4:t1:scroll-boxes",
    "league-4:t4:slayer-bigger-and-badder", "league-4:t4:slayer-superior-1-in-50",
    "league-4:t4:slayer-points-x5", "league-4:t4:slayer-no-task-streak",
    "league-5:t3:combat-xp-x2", "league-6:t3:combat-xp-x1-5", "league-4:t3:crystal-of-memories",
  ]) assert.ok(ids.has(id), id);

  const unsupported = entries.filter((entry) => !entry.compatible);
  assert.deepEqual(unsupported, [], "every source passive now has an implementation");

  const payload = endpoints.get("league-passives")();
  assert.equal(payload.passives.length, 51);
  assert.equal(payload.limits.choicesPerTier, null);
  assert.deepEqual(payload.world, Common.passivesWorldState());
  const relics = endpoints.get("relic-catalog")();
  assert.equal(relics.schemaVersion, 2);
  assert.equal(relics.passives.length, 51);

  const audit = require("../docs/league-passives-audit.json");
  assert.deepEqual(audit.passives.map((entry) => entry.id), entries.map((entry) => entry.id));
  assert.deepEqual(audit.counts, counts);
  assert.ok(audit.tiers.every((league) => league.tiers.every((tier) =>
    tier.passives.length > 0 || tier.sourceText === "There are no passive unlocks for this tier.")));
});

test("an unrecognized future bullet stays visible as incompatible instead of disappearing", () => {
  const built = PassivesCatalog.buildCatalog({
    4: { tiers: [{ passive: "- A future passive whose wording is not known yet." }] },
    5: null,
    6: null,
  });
  assert.equal(built.entries.length, 1);
  assert.equal(built.entries[0].compatible, false);
  assert.match(built.entries[0].incompatibleReason, /could not classify/);
});

test("every catalog grant can be configured alone, and every incompatible one is refused", () => {
  const entries = Common.passiveCatalog();
  assert.equal(entries.length, 51);
  for (const entry of entries) {
    configure({ "league:passive-tiers": [[entry.id]] });
    if (entry.compatible) {
      const state = Common.passivesWorldState();
      assert.equal(state.status, "custom", entry.id);
      assert.deepEqual(state.tiers, [[entry.id]], entry.id);
      const player = character(`only-${entry.id.replace(/[^a-z0-9]+/gi, "-")}`, 1);
      assert.deepEqual(Common.activePassives(player).map((passive) => passive.id), [entry.id], entry.id);
    } else {
      const state = Common.passivesWorldState();
      assert.equal(state.status, "invalid", entry.id);
      assert.match(state.error, /incompatible/, entry.id);
    }
  }
});

test("passive rows accept any count, mix sources freely and reject bad configurations whole", () => {
  let state = configure({ "league:passive-tiers": [
    ["league-4:t1:run-energy", "league-4:t1:scroll-boxes", "league-5:t3:combat-xp-x2",
      "league-5:t4:drop-rate-x5", "league-5:t1:minigame-points-x4", "league-4:t3:crystal-of-memories"],
    [],
    ["league-5:t3:slayer-bigger-and-badder"],
  ] });
  assert.equal(state.status, "custom");
  assert.deepEqual(state.tiers[0].length, 6);
  assert.deepEqual(state.tiers[1], []);

  state = configure({ "league:passive-tiers": [["league-4:t1:run-energy", "league-4:t1:run-energy"]] });
  assert.equal(state.status, "invalid");
  assert.match(state.error, /more than once/);
  assert.ok(Passives.passive(character("invalid-keeps-default", 1), "runEnergy"), "the league default stays");

  state = configure({ "league:passive-tiers": [["league-5:t1:clue-step-progress"]] });
  assert.equal(state.status, "custom", "clue-step progress is implemented");

  state = configure({ "league:passive-tiers": [["league-4:t1:not-a-passive"]] });
  assert.equal(state.status, "invalid");
  assert.match(state.error, /not in league 4/);

  state = configure({
    "league:relic-tiers": [["4:endless-harvest", "4:production-prodigy"], ["4:trickster", "4:fairys-flight"]],
    "league:passive-tiers": [[], [], []],
  });
  assert.equal(state.status, "invalid");
  assert.match(state.error, /must have 1-2 tiers/);
});

test("configured passives activate automatically at their assigned tier, across source leagues", () => {
  configure({ "league:passive-tiers": [
    ["league-4:t1:run-energy", "league-5:t3:combat-xp-x2", "league-5:t4:drop-rate-x5", "league-5:t1:minigame-points-x4"],
    ["league-4:t2:xp-multiplier-8x", "league-5:t3:slayer-points-x5", "league-5:t3:slayer-bigger-and-badder", "league-5:t3:slayer-superior-1-in-50",
      "league-5:t3:slayer-no-task-streak"],
    ["league-4:t3:crystal-of-memories"],
    ["league-4:t7:xp-multiplier-16x"],
  ] });
  const none = character("auto-none", 0);
  const one = character("auto-one", 1);
  const two = character("auto-two", 2);
  const three = character("auto-three", 3);
  const four = character("auto-four", 4);

  assert.equal(modifiers.runEnergyDrain(none, 1), 1);
  assert.equal(modifiers.runEnergyDrain(one, 1), 0);
  assert.equal(BoostedDrops.rule(one, "Abyssal demon")?.multiplier, 5);
  assert.equal(minigame(one), 40);
  assert.equal(gain(one), 5 * 2, "the tier-1 combat grant applies without a relic being that source");
  assert.equal(gain(two), 8 * 2, "tier 2's configured XP grant is automatic");
  assert.equal(gain(four), 16 * 2, "tier 4's stronger XP grant replaces, not stacks with, x8");

  assert.deepEqual([slayerReward(one).freeTasks, slayerReward(one).multiplier], [4, 1]);
  assert.deepEqual([slayerReward(two).freeTasks, slayerReward(two).multiplier], [0, 5]);
  assert.deepEqual([superior(two).unlocked, superior(two).chance], [true, 50]);

  assert.equal(Crystal.unlocked(two), false);
  assert.equal(Crystal.unlocked(three), true, "the Crystal is assigned independently of its source tier");
  assert.deepEqual(Common.passiveTierEntries(4, 0).map((entry) => entry.grantTier), [1, 1, 1, 1]);
  assert.match(Common.passiveTierText(4, 0), /Run energy is never drained/);
  assert.equal(Common.passiveTierText(4, 4), "There are no passive unlocks for this tier.");
});

test("the farming tick grant applies at its tier and changes only that character's growth rate", () => {
  configure({ "league:passive-tiers": [["league-5:t1:farming-ticks-every-minute"]] });
  const unreached = character("farming-unreached", 0, 4);
  const boosted = character("farming-boosted", 1);
  const rate = (player) => ask("farming:growth-rate", { player, rate: 1, tickMinutes: 5 }).rate;
  assert.equal(rate(unreached), 1);
  assert.equal(rate(boosted), 5);

  const start = Date.UTC(2026, 0, 1);
  const farm = { offset: 0, patches: {}, tools: {} };
  FarmingModel.applyGrowthRate(farm, start, rate(boosted));
  const next = FarmingModel.nextGrowth(start, 5, farm.offset, FarmingModel.growthRateOf(farm));
  assert.equal(next - start, FarmingModel.MINUTE, "a five-minute crop cycle lands on the next one-minute tick");
});

test("Raging Echoes' and Demonic Pacts' default farming passives stay within their own leagues", () => {
  const rate = (player) => ask("farming:growth-rate", { player, rate: 1, tickMinutes: 5 }).rate;
  for (const type of [5, 6]) {
    configure({ "league:type": type });
    const own = character(`default-farming-${type}`, 1, type);
    const other = character(`default-farming-${type}-reloaded`, 1, 4);
    assert.equal(rate(own), 5, `league ${type}'s tier-1 farming grant`);
    assert.equal(rate(other), 1, `league ${type}'s grant does not reach a Trailblazer Reloaded character`);
  }
  configure({});
  assert.equal(rate(character("default-farming-reloaded", 1, 4)), 1);
});

function freshClue(player, tierName, slot = 0) {
  const tier = Tiers.byName.get(tierName);
  const itemId = TrailRuntime.data(tier).rollable[0].itemId;
  player.getInventory().setItem(slot, new core.Item(itemId, 1));
  return TrailRuntime.stateOf(player, slot, () => 0);
}

test("clue-step progress carries between clues of one tier and clears when a casket is received", () => {
  configure({});
  assert.ok(persisted.has("league:clue-progress"), "the character's tier progress is a saved attribute");
  const echoes = character("clue-progress-echoes", 1, 5);
  ask("treasure-trails:clue-progress", { player: echoes, tier: "hard", event: "step", completed: 2, saved: 0 });
  assert.equal(freshClue(echoes, "hard").state.completed, 2, "a replacement hard clue keeps its two steps");
  assert.equal(freshClue(echoes, "easy").state.completed, 0, "another tier starts from its own saved count");

  ask("treasure-trails:clue-progress", { player: echoes, tier: "hard", event: "casket", completed: 0, saved: 0 });
  assert.equal(freshClue(echoes, "hard").state.completed, 0, "receiving a casket clears the tier");

  const reloaded = character("clue-progress-reloaded", 1, 4);
  ask("treasure-trails:clue-progress", { player: reloaded, tier: "hard", event: "step", completed: 2, saved: 0 });
  assert.equal(freshClue(reloaded, "hard").state.completed, 0, "Trailblazer Reloaded has no clue-step grant");

  configure({ "league:passive-tiers": [["league-5:t1:clue-step-progress"]] });
  const configured = character("clue-progress-configured", 1, 4);
  ask("treasure-trails:clue-progress", { player: configured, tier: "hard", event: "step", completed: 1, saved: 0 });
  assert.equal(freshClue(configured, "hard").state.completed, 1, "a world-configured grant carries progress");
});

test("beginner clues use the same clue-step progress and clear it on their casket", () => {
  configure({});
  const random = Math.random;
  Math.random = () => 0.9; // beginner length 3
  try {
    const echoes = character("beginner-progress-echoes", 1, 6);
    ask("treasure-trails:clue-progress", { player: echoes, tier: "beginner", event: "step", completed: 2, saved: 0 });
    const item = new core.Item(BeginnerRuntime.data().scroll, 1);
    assert.equal(BeginnerRuntime.stateOf(item, echoes).completed, 2);

    ask("treasure-trails:clue-progress", { player: echoes, tier: "beginner", event: "casket", completed: 0, saved: 0 });
    const reset = new core.Item(BeginnerRuntime.data().scroll, 1);
    assert.equal(BeginnerRuntime.stateOf(reset, echoes).completed, 0);
  } finally {
    Math.random = random;
  }
});

test("Slayer bundle members are independently selectable", () => {
  configure({ "league:passive-tiers": [["league-5:t3:slayer-superior-1-in-50"]] });
  let player = character("only-superior", 1);
  assert.deepEqual([superior(player).unlocked, superior(player).chance], [false, 50]);
  assert.deepEqual([slayerReward(player).freeTasks, slayerReward(player).multiplier], [4, 1]);

  configure({ "league:passive-tiers": [["league-5:t3:slayer-points-x5"]] });
  player = character("only-points", 1);
  assert.deepEqual([slayerReward(player).freeTasks, slayerReward(player).multiplier], [4, 5]);
  assert.deepEqual([superior(player).unlocked, superior(player).chance], [false, 200]);

  configure({ "league:passive-tiers": [["league-5:t3:slayer-bigger-and-badder"]] });
  player = character("only-bigger", 1);
  assert.deepEqual([superior(player).unlocked, superior(player).chance], [true, 200]);
  assert.deepEqual([slayerReward(player).freeTasks, slayerReward(player).multiplier], [4, 1]);

  configure({ "league:passive-tiers": [["league-5:t3:slayer-no-task-streak"]] });
  player = character("only-streak", 1);
  assert.deepEqual([slayerReward(player).freeTasks, slayerReward(player).multiplier], [0, 1]);
});

test("same-effect grants from different leagues use the strongest value, never a product", () => {
  configure({ "league:passive-tiers": [
    ["league-4:t1:drop-rate-x2", "league-5:t4:drop-rate-x5", "league-5:t1:minigame-points-x4", "league-5:t4:minigame-points-x8"],
    ["league-5:t2:xp-multiplier-8x"],
    [],
    [],
    [],
    [],
    [],
    ["league-4:t7:xp-multiplier-16x"],
  ] });
  const one = character("max-one", 1);
  const three = character("max-three", 3);
  const eight = character("max-eight", 8);
  assert.equal(BoostedDrops.rule(one, "Abyssal demon")?.multiplier, 5);
  assert.equal(minigame(one), 80);
  assert.equal(gain(one), 5);
  assert.equal(gain(three), 8, "x8 at the configured tier, not x8 times a default");
  assert.equal(gain(eight), 16, "the later x16 grant replaces x8 rather than multiplying it");
});

test("the Relics toggle disables configured passives, and a restart keeps the saved rows", () => {
  const rows = [["league-4:t1:run-energy", "league-5:t1:minigame-points-x4"]];
  configure({ "league:passive-tiers": rows });
  let player = character("saved-passives", 1);
  assert.equal(modifiers.runEnergyDrain(player, 1), 0);
  Common.reloadWorldCatalog();
  assert.equal(modifiers.runEnergyDrain(player, 1), 0, "a restart reloads the same saved rows");

  configure({ "league:relics": false, "league:passive-tiers": rows });
  player = character("disabled-passives", 1);
  assert.equal(modifiers.runEnergyDrain(player, 1), 1);
  assert.equal(minigame(player), 10);
  assert.deepEqual(Common.activePassives(player), []);
  assert.deepEqual(Common.passivesWorldState().tiers, rows, "the rows remain saved while disabled");
});

test("free movement applies the configured run-energy drain modifier", () => {
  configure({ "league:passive-tiers": [["league-4:t1:run-energy"]] });
  let player = character("free-move-passive", 1);
  assert.equal(FreeMovement.runEnergyDrain({ ...core,
    applyRunEnergyDrainModifiers: (who, amount) => modifiers.runEnergyDrain(who, amount),
  }, player, 1), 0);

  player = character("free-move-without-passive", 0);
  assert.equal(FreeMovement.runEnergyDrain({ ...core,
    applyRunEnergyDrainModifiers: (who, amount) => modifiers.runEnergyDrain(who, amount),
  }, player, 1), 1);
});

test("a PaeScape-style non-seasonal world activates configured relics and passives without a league profile", () => {
  worldConfig = {
    "league:relic-league": 4,
    "league:relic-tiers": [["league-4:endless-harvest", "league-4:production-prodigy"]],
    "league:passive-tiers": [["league-4:t1:run-energy", "league-5:t1:minigame-points-x4"]],
  };
  Common.reloadWorldCatalog();
  assert.equal(Common.worldCatalogState().status, "custom");
  assert.equal(Common.passivesWorldState().status, "custom");

  const player = new Player(null);
  player.setUsername("paescape-main");
  player.setProfile("main");
  player.setLocation(new Location(3200, 3200, 0));
  player.setAttribute("league:relics", { 0: 1 });
  const sender = new Proxy({}, { get: () => () => sender });
  player.getPacketSender = () => sender;
  player.sendMessage = () => {};

  assert.equal(Common.leagueOf(player), 4, "level-up:relic-profile supplies the catalog league");
  assert.deepEqual(
    Common.activePassives(player).map((passive) => passive.id),
    ["league-4:t1:run-energy", "league-5:t1:minigame-points-x4"],
  );
  assert.equal(modifiers.runEnergyDrain(player, 1), 0);
  assert.equal(minigame(player), 40, "the automatic tier passive applies to a main-profile character");
});
