// Run after `yarn build`: node --test tests/level-up-passives.test.cjs
//
// The relic tier's minigame-points passive on a Level-Up character. The real path is
// TemplateWorlds' `level-up:relic-profile` -> LeagueRelics.leagueOf -> Passives.leagueOf ->
// Unlock.answerHighestTier, so this wires the production plugins instead of stubbing
// `league:highest-tier` (which hid whether Level-Up's non-league profile reached the gate).
const assert = require("node:assert/strict");
const path = require("path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { GameConstants } = require("../dist/game/GameConstants");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");

const Rules = require("../plugins/modes/levelup/Rules.LevelUpWorld");
const League = require("../plugins/modes/league/Common.LeagueMode");
const Relics = require("../plugins/modes/leaguerelics/Common.LeagueRelics");
const Passives = require("../plugins/modes/league/Passives.LeagueMode");
const BoostedDrops = require("../plugins/modes/league/BoostedDrops.LeagueMode");
const TemplateWorlds = require("../plugins/modes/TemplateWorlds.plugin");
const Shared = require("../plugins/minigames/mixology/Shared.Mixology");
const Orders = require("../plugins/minigames/mixology/Orders.Mixology");
const leagues = require("../plugins/modes/data/leagues.json").leagues;

let core;
let api;
let runDrain;
const handlers = {};

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

function emit(name, payload) {
  for (const handler of handlers[name] ?? []) handler(payload);
  return payload;
}

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  GameConstants.setWorldProfile("main");
  const config = {
    "league:relics": true,
    "league:relic-league": 4,
    "template:id": "level_up",
    "template:contract": validContract(),
  };
  const base = {
    core,
    persistAttribute() {},
    getPluginConfig: (key, fallback) => (key in config ? config[key] : fallback),
    setWorldProfile: (profile) => GameConstants.setWorldProfile(profile),
    setExperienceRate() {},
    log() {},
    spawnNpc: () => null,
    removeNpc() {},
    onServerStartup() {},
    registerCommand() {},
    registerRunEnergyDrainModifier: (modifier) => { runDrain = modifier; },
    onCustomEvent: (name, handler) => { (handlers[name] ??= []).push(handler); },
    emitCustomEvent: emit,
  };
  api = new Proxy(base, { get: (target, key) => (key in target ? target[key] : () => {}) });
  require("../plugins/modes/Base.LeagueMode").register(api); // league profile + Passives
  require("../plugins/modes/Relics.LeagueMode").register(api); // real league:highest-tier
  TemplateWorlds.register(api); // real level-up:relic-profile
});

/** A Level-Up character: a main profile with `count` relic tiers chosen. */
function levelUpPlayer(count) {
  const picks = {};
  for (let tier = 0; tier < count; tier++) picks[tier] = 1;
  const attributes = new Map([["league:relics", picks]]);
  return {
    getProfile: () => "main",
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    isPlayer: () => true,
  };
}

function award(player, minigame, points = 10) {
  return emit("minigame:points", { player, minigame, points });
}

test("the real Level-Up relic profile answers the highest tier without a league save", () => {
  const player = levelUpPlayer(5);
  assert.equal(Relics.leagueOf(player), 4, "TemplateWorlds' level-up:relic-profile supplies the relic league");
  assert.equal(Relics.highestTier(player), 4);
  assert.equal(League.highestTier(player), 4, "Unlock answers league:highest-tier for a Level-Up player too");
});

test("Mastering Mixology's minigame points are 5x at five Level-Up relic tiers", () => {
  assert.equal(award(levelUpPlayer(5), "mastering-mixology").points, 50);
});

test("every minigame the passive lists is multiplied at five tiers; the others are not", () => {
  const player = levelUpPlayer(5);
  for (const minigame of leagues["4"].passives.minigamePoints.minigames) {
    assert.equal(award(player, minigame).points, 50, minigame);
  }
  for (const minigame of ["wintertodt", "tempoross", "forestry", "last-man-standing", "motherlode-mine"]) {
    assert.equal(award(player, minigame).points, 10, minigame);
  }
  assert.equal(award(player, "mastering-mixology", 0).points, 0, "nothing to multiply");
});

test("the Level-Up passive gate honors the Trailblazer tier map", () => {
  // leagues.json league 4's first minigame boost is tier 2 (3x), then tier 5 (5x) and 7 (8x),
  // so 0-1 picks stay at 1x while tiers 2-4 already pay 3x.
  const points = (tiers) => award(levelUpPlayer(tiers), "mastering-mixology").points;
  assert.equal(points(0), 10, "no relic");
  assert.equal(points(1), 10, "below the first boost (tier 2)");
  assert.equal(points(2), 30, "tier 2: 3x");
  assert.equal(points(3), 30, "tier 3 keeps 3x");
  assert.equal(points(4), 30, "tier 4 keeps 3x");
  assert.equal(points(5), 50, "tier 5: 5x");
  assert.equal(points(7), 80, "tier 7: 8x");
});

test("a Level-Up tier also grants its run-energy and drop passives through the real chain", () => {
  const player = levelUpPlayer(1);
  assert.ok(Passives.passive(player, "runEnergy"), "tier 1's run-energy passive is active");
  assert.equal(runDrain(player, 200), 0, "a running step drains no energy");
  assert.equal(BoostedDrops.rule(player, "Abyssal demon")?.multiplier, 2, "tier 1 boosts eligible drops");
  assert.equal(BoostedDrops.rule(player, "Scurrius")?.pattern.test("Scurrius' spine"), true, "Level-Up's Scurrius spine is eligible too");
});

/** A real player at the Mixology conveyor with the registered Fulfil-order handler. */
function conveyorHandIn(t) {
  const previousApi = Shared.api();
  const hooks = new Map();
  const channel = {
    kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true,
    send: () => true, close() {}, onData() {}, onError() {}, onClose() {},
  };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(1802);
  player.setUsername("levelupmixology");
  player.setProfile("main");
  player.setLocation(new core.Location(Shared.LOC.CONVEYOR.x, Shared.LOC.CONVEYOR.y - 1, Shared.LAB.z));
  t.after(() => {
    core.TaskManager.cancelTasks(player.getIndex());
    player.setRegistered(false);
    if (previousApi) Shared.bind(previousApi);
  });

  const previousOnObjectInteraction = api.onObjectInteraction;
  api.onObjectInteraction = (name, actions) => hooks.set(name, actions);
  api.onCustomEvent = (name, handler) => { (handlers[name] ??= []).push(handler); };
  t.after(() => { api.onObjectInteraction = previousOnObjectInteraction; });

  Shared.bind(api);
  Orders(api);
  player.setAttribute("league:relics", { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1 });
  Shared.set(player, Shared.VARBIT.MET_SUPERVISOR, 1);
  Shared.set(player, Shared.VARBIT.ORDER_TYPE[0], 1);
  Shared.set(player, Shared.VARBIT.ORDER_MODIFIER[0], Shared.MODIFIER.AGITATOR);
  const potion = Shared.potion(1);
  player.getInventory().add(new core.Item(potion.finished, 1, { [Shared.META.MODIFIER]: Shared.MODIFIER.AGITATOR }), false);
  hooks.get(Shared.OBJECT.CONVEYOR)["Fulfil-order"]({ player });
  return player;
}

test("the real Mixology hand-in writes five times the resin through the Level-Up passive", (t) => {
  const player = conveyorHandIn(t);
  const base = Orders.rewardOf({ entry: Shared.potion(1), ordered: true, digweed: false }).resin;
  assert.ok(Object.values(base).some((amount) => amount > 0), "the hand-in has real resin to multiply");
  for (const reagent of Shared.REAGENTS) {
    assert.equal(Shared.resin(player, reagent), base[reagent] * 5, reagent);
  }
});
