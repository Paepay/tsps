// Run from server/ after `yarn build`: node --test tests/league-relics-world-config.test.cjs
// Issue #53: a world saves 1-8 tiers of 2 or 3 canonical relics from any relic league. This pins
// the pure catalog validation, the website-facing catalog, the platform settings translation, and
// the live game: the exact structs/enums the client draws, cross-league selection, source-league
// effects, Reloaded's extra pick, persistence after reconnect, and the Reloads toggle.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { GameConstants } = require("../dist/game/GameConstants");
const { PlayerStatus } = require("../dist/game/model/PlayerStatus");
const { toWorldOverlay } = require("../plugins/paescape/PlatformWorldConfig.js");
const WorldCatalog = require("../plugins/modes/leaguerelics/WorldCatalog.LeagueRelics");

const RELICS = 655;
const SIDE_PANEL = 656;
const uid = (group, child) => (group << 16) | child;

const MIXED = [
  ["4:endless-harvest", "6:evil-eye"],
  ["5:power-miner", "4:production-prodigy", "6:flow-state"],
  ["6:flask-of-fervour", "4:fairys-flight"],
  ["5:reloaded", "6:barbarian-gathering", "4:archers-embrace"],
  ["6:grimoire", "5:lumberjack"],
  ["6:executioner", "4:equilibrium", "5:friendly-forager"],
  ["6:soul-harvest", "4:trickster"],
  ["6:minion", "5:last-stand", "4:guardian"],
];
const PASSIVES = [
  ["league-4:t1:run-energy", "league-5:t1:minigame-points-x4"],
  ["league-5:t3:combat-xp-x2"],
  ["league-4:t3:crystal-of-memories"],
];

let core;
let Common;
let Catalog;
let Unlock;
let worldConfig = { "league:type": 4 };
const hooks = {};
const custom = {};
const endpoints = new Map();
const logs = [];
let api;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  require("../plugins/items/ItemDefinitionLoader.plugin").register({
    log() {}, onPlayerLogin() {}, registerContentEndpoint() {},
  });
  GameConstants.setWorldProfile("league");
  const lists = {};
  const listen = (name) => (handler) => {
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
  api = new Proxy({
    core,
    persistAttribute() {},
    getPluginConfig: (key, fallback) => (Object.prototype.hasOwnProperty.call(worldConfig, key) ? worldConfig[key] : fallback),
    setWorldProfile: (profile) => GameConstants.setWorldProfile(profile),
    getSkillManager: () => require("../dist/game/content/skill/SkillManager").SkillManager,
    log: (message) => logs.push(message),
    registerCommand: (name, handler) => (hooks["command:" + name] = handler),
    registerContentEndpoint: (name, handler) => endpoints.set(name, handler),
    onNpcInteraction: (nameOrHandler, actions) => {
      if (typeof nameOrHandler === "function") return listen("onNpcInteraction")(nameOrHandler);
      for (const [action, handler] of Object.entries(actions ?? {})) listen("npc:" + nameOrHandler + ":" + action)(handler);
    },
    onInterfaceActionButton: (ids, handler) => {
      for (const id of [].concat(ids)) listen("button:" + id)(handler);
    },
    onCustomEvent: (name, handler) => (custom[name] = (custom[name] ?? []).concat(handler)),
    emitCustomEvent: (name, payload) => {
      for (const handler of custom[name] ?? []) handler(payload);
    },
  }, { get: (target, key) => (key in target ? target[key] : listen(String(key))) });
  require("../plugins/modes/Base.LeagueMode").register(api);
  require("../plugins/modes/Points.LeagueMode").register(api);
  require("../plugins/modes/Relics.LeagueMode").register(api);
  Common = require("../plugins/modes/leaguerelics/Common.LeagueRelics");
  Catalog = require("../plugins/modes/leaguerelics/Catalog.LeagueRelics");
  Unlock = require("../plugins/modes/leaguerelics/Unlock.LeagueRelics");
});

/** Point the world at a relic configuration and re-read it, as a restart would. */
function configure(settings = {}) {
  worldConfig = { "league:type": 4, ...settings };
  Common.reloadWorldCatalog();
  return Common.worldCatalogState();
}

/** A real player whose packets are recorded; logged in as a new character of `profile`. */
function character(name, profile = "league", { login = true } = {}) {
  const player = new Player(null);
  player.setUsername(name);
  player.setProfile(profile);
  const sent = { messages: [], varbits: new Map(), scripts: [], subs: [], flags: [], sounds: [], content: [], removals: 0 };
  const sender = new Proxy({}, {
    get: (target, key) => {
      switch (key) {
        case "sendVarbit": return (id, value) => (sent.varbits.set(id, value), sender);
        case "sendInterfaceScript": return (id, args) => (sent.scripts.push([id, args]), sender);
        case "sendSubInterface": return (targetId, group) => (sent.subs.push([targetId, group]), sender);
        case "sendInterface": return (group) => (player.setInterfaceId(group), sent.subs.push(["main", group]), sender);
        case "sendInterfaceFlagsRange": return (...args) => (sent.flags.push(args), sender);
        case "sendSound": return (...args) => (sent.sounds.push(args), sender);
        case "sendContentData": return (source, datasets) => (sent.content.push(datasets), sender);
        case "sendInterfaceRemoval": return () => (sent.removals++, sender);
        default: return () => sender;
      }
    },
  });
  player.getPacketSender = () => sender;
  player.sendMessage = (text) => sent.messages.push(text);
  if (login) hooks.onPlayerLogin({ player, username: name, isNewAccount: true, profile });
  return Object.assign(player, { sent });
}

function givePoints(player, points) {
  hooks["command:leaguetask"]({ player, parts: ["leaguetask", "task-" + points + "-" + Math.random(), String(points)] });
}

function dataset(player, key) {
  return player.sent.content.at(-1).find((entry) => entry.key === key).rows;
}

function openBank(player) {
  player.setStatus(PlayerStatus.BANKING);
  player.setInterfaceId(core.Bank.MAIN_INTERFACE_ID);
}

/** The toggles component's script trigger for a cache toggle row (zigzag varint row id). */
function toggle(player, rowName) {
  let value = core.CacheDefinitions.getDbRowId(rowName) << 1;
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  hooks["button:" + uid(RELICS, 38)]({ player, scriptTrigger: true, argsData: Int8Array.from(bytes) });
}

test("a mixed 8-tier catalog from every source reaches the client with its own descriptions and icons", () => {
  const state = configure({ "league:relic-tiers": MIXED });
  assert.equal(state.status, "custom");
  assert.equal(state.custom, true);
  assert.equal(Common.isCustomCatalog(4), true);

  const player = character("mixed-catalog");
  const structs = new Map(dataset(player, "structOverrides").map((row) => [row.structId, row.params]));
  const enums = dataset(player, "enumOverrides");
  assert.equal(structs.get(4699)[870], 204000, "the Trailblazer Reloaded league struct names our tier enum");

  const tiers = enums.find((row) => row.enumId === 204000);
  assert.equal(tiers.entries.length, 8);
  const costs = tiers.entries.map(([, id]) => structs.get(id)[877]);
  assert.deepEqual(costs, [0, 500, 1200, 2000, 4000, 7500, 15000, 24000], "tier costs stay the base league's");

  const names = (tierIndex) => {
    const tier = tiers.entries[tierIndex][1];
    const relics = enums.find((row) => row.enumId === structs.get(tier)[878]);
    return relics.entries.map(([, id]) => structs.get(id)[879]);
  };
  assert.deepEqual(names(0), ["Endless Harvest", "Evil Eye"]);
  assert.deepEqual(names(1), ["Power Miner", "Production Prodigy", "Flow State"]);
  assert.deepEqual(names(2), ["Flask of Fervour", "Fairy's Flight"]);
  assert.deepEqual(names(7), ["Minion", "Last Stand", "Guardian"]);

  const byName = (name) => [...structs].find(([, params]) => params[879] === name)[1];
  const icon = (name, param) => byName(name)[param];
  assert.equal(icon("Endless Harvest", 881), core.CacheDefinitions.getSpriteId("league_4_relics,0"));
  assert.equal(icon("Power Miner", 881), core.CacheDefinitions.getSpriteId("league_5_relics,0"));
  assert.equal(icon("Evil Eye", 881), core.CacheDefinitions.getStructParams(6439).get(881));
  assert.equal(byName("Fairy's Flight")[880], MIXED[2][1] === "4:fairys-flight"
    ? require("../plugins/modes/data/league-relics.json").leagues[4].tiers[1].relics[0].description : null);
});

test("cross-league picks save, activate their source-league effect and survive reconnect", () => {
  configure({ "league:relic-tiers": MIXED });
  const player = character("cross-picks");
  const effects = Common.data.effects;

  assert.equal(Unlock.unlock(player, 0, 1), true, "Trailblazer Reloaded's Endless Harvest in a mixed tier");
  assert.deepEqual(player.getAttribute("league:relics"), { 0: 1 });
  assert.equal(Common.effectActive(player, effects.endlessHarvest), true);
  assert.equal(Common.effectSource(player, effects.endlessHarvest), 4);

  givePoints(player, 20000);
  assert.equal(Unlock.unlock(player, 1, 1), true, "Raging Echoes' Power Miner in another tier");
  assert.equal(Common.effectActive(player, effects.powerMiner), true);
  assert.equal(Common.effectSource(player, effects.powerMiner), 5);

  assert.equal(Unlock.unlock(player, 2, 1), false, "a Demonic Pacts item relic still needs a bank");
  assert.match(player.sent.messages.at(-1), /bank.*item/i);
  openBank(player);
  assert.equal(Unlock.unlock(player, 2, 1, { bankOpen: true }), true);
  assert.deepEqual(player.getAttribute("league:relics"), { 0: 1, 1: 1, 2: 1 });
  assert.equal(Common.effectActive(player, effects.flaskOfFervour), true);
  assert.equal(Common.effectSource(player, effects.flaskOfFervour), 6);
  assert.match(player.sent.messages.join("\n"), /unlocked a new Relic/i, "Demonic Pacts' own unlock line");

  // A reconnect and a restart both rebuild the same catalog and the same picks.
  configure({ "league:relic-tiers": MIXED });
  const again = character("cross-picks", "league", { login: false });
  again.setAttribute("league:type", 4);
  again.setAttribute("league:relics", { 0: 1, 1: 1, 2: 1 });
  hooks.onPlayerLogin({ player: again, username: "cross-picks", isNewAccount: false, profile: "league" });
  assert.equal(again.sent.varbits.get(10049), 1);
  assert.equal(again.sent.varbits.get(10050), 1);
  assert.equal(again.sent.varbits.get(10051), 1);
  assert.equal(Common.effectActive(again, effects.endlessHarvest), true);
  const has = { player: again, relic: "flask-of-fervour", sourceLeague: 6 };
  Common.api.emitCustomEvent("league:has-relic", has);
  assert.equal(has.active, true);
  assert.equal(Common.hasRelic(again, "flask-of-fervour", 4), false, "the source is part of the identity");
});

test("a Demonic Pacts relic keeps its own toggle mechanics in another base league", () => {
  configure({ "league:relic-tiers": [["6:endless-harvest", "4:trickster"]] });
  const dp = character("dp-elsewhere", "league", { login: false });
  dp.setAttribute("league:type", 4);
  dp.setAttribute("league:relics", { 0: 1 });
  const gather = (player) => {
    const request = { player, itemId: core.ItemIdentifiers.IRON_ORE, amount: 1, stored: 0, skill: core.Skill.MINING, xp: 35 };
    Common.api.emitCustomEvent("storage:gather", request);
    return request;
  };
  assert.equal(gather(dp).stored, 1, "the Demonic Pacts default toggle banks");
  toggle(dp, "league_relic_endless_harvest_toggle_bank");
  const unbanked = gather(dp);
  assert.equal(unbanked.stored, 0, "toggled off, the skill keeps the ore");
  assert.equal(dp.getInventory().getAmount(core.ItemIdentifiers.IRON_ORE), 1);
  const endless = { player: dp, handled: false };
  Common.api.emitCustomEvent("mining:deplete-rock", endless);
  assert.equal(endless.handled, true, "Demonic Pacts' rocks stay up");

  // The same key from Trailblazer Reloaded has no toggle: clearing the varp must not change it.
  configure({ "league:relic-tiers": [["4:endless-harvest", "6:evil-eye"]] });
  const tb = character("tb-elsewhere", "league", { login: false });
  tb.setAttribute("league:type", 4);
  tb.setAttribute("league:relics", { 0: 1 });
  assert.equal(gather(tb).stored, 1);
  toggle(tb, "league_relic_endless_harvest_toggle_bank");
  assert.equal(gather(tb).stored, 1, "Trailblazer Reloaded's relic always banks");
  const deplete = { player: tb, handled: false };
  Common.api.emitCustomEvent("mining:deplete-rock", deplete);
  assert.equal(deplete.handled, false, "and its rocks still deplete");
});

test("Executioner's reach follows the relic's source league, not the world's", () => {
  configure({ "league:relic-tiers": MIXED });
  const dp = character("dp-executioner", "league", { login: false });
  dp.setAttribute("league:type", 4);
  dp.setAttribute("league:relics", { 5: 1 });
  const reach = (player) => {
    const event = { attacker: player, target: {}, combatType: core.CombatType.RANGED, manualCast: false, distance: 5 };
    hooks.onCombatAttackDistance(event);
    return event.distance;
  };
  for (const player of [dp]) player.getEquipment().set(core.Equipment.WEAPON_SLOT, new core.Item(core.ItemIdentifiers.SAGES_AXE, 1));
  assert.equal(reach(dp), 6, "Demonic Pacts' axe adds its six-tile reach");

  configure({ "league:relic-tiers": [["4:executioner", "4:trickster"]] });
  const tb = character("tb-executioner", "league", { login: false });
  tb.setAttribute("league:type", 4);
  tb.setAttribute("league:relics", { 0: 1 });
  tb.getEquipment().set(core.Equipment.WEAPON_SLOT, new core.Item(core.ItemIdentifiers.SAGES_AXE, 1));
  assert.equal(reach(tb), 5, "Trailblazer Reloaded's axe keeps the shared five-tile reach");
});

test("same key from two sources is two relics; a repeated canonical id is refused", () => {
  const both = [
    ["4:endless-harvest", "6:endless-harvest"],
    ["5:power-miner", "4:trickster"],
  ];
  assert.equal(configure({ "league:relic-tiers": both }).status, "custom");
  const player = character("same-key", "league", { login: false });
  const picks = { 0: 1, 1: 2 };
  player.setAttribute("league:type", 4);
  player.setAttribute("league:relics", picks);
  const effect = Common.data.effects.endlessHarvest;
  assert.deepEqual(Common.effectSources(player, effect), [4], "only tier 1's source is held");
  player.setAttribute("league:relics", { 0: 2 });
  assert.deepEqual(Common.effectSources(player, effect), [6], "Demonic Pacts' variant is distinct");
  assert.equal(Common.effectSource(player, effect), 6, "the world's base league does not silently stand in");

  const state = configure({ "league:relic-tiers": [["4:endless-harvest", "4:endless-harvest"]] });
  assert.equal(state.status, "invalid");
  assert.match(state.error, /more than once/i);
  assert.equal(Common.isCustomCatalog(4), false, "an invalid catalog never partially applies");
  const fallback = character("invalid-fallback");
  const structs = new Map(dataset(fallback, "structOverrides").map((row) => [row.structId, row.params]));
  const tiers = dataset(fallback, "enumOverrides").find((row) => row.enumId === 204000);
  assert.equal(tiers.entries.length, 8, "the league's own catalog is still playable");
  assert.equal(structs.get(204100)[879], "Endless Harvest");
});

test("a Demonic Pacts world can host the same mixed catalog over its cache-native league", () => {
  const state = configure({
    "league:type": 6,
    "league:relic-tiers": [["4:endless-harvest", "5:power-miner"], ["6:flow-state", "4:trickster"]],
  });
  assert.equal(state.status, "custom");
  assert.equal(Common.isCustomCatalog(6), true);
  const player = character("dp-base");
  const structs = new Map(dataset(player, "structOverrides").map((row) => [row.structId, row.params]));
  const enums = dataset(player, "enumOverrides");
  assert.equal(structs.get(6436)[870], 206000, "Demonic Pacts' cache league struct points at our virtual tiers");
  assert.equal(structs.get(206100)[879], "Endless Harvest");
  assert.equal(structs.get(206100)[881], core.CacheDefinitions.getSpriteId("league_4_relics,0"));
  assert.equal(structs.get(206103)[881], core.CacheDefinitions.getStructParams(6453).get(881), "Flow State keeps its cache icon");
  const tiers = enums.find((row) => row.enumId === 206000);
  const base = Common.sourceCatalog(6).tiers;
  assert.equal(tiers.entries.length, 2);
  assert.equal(structs.get(tiers.entries[0][1])[877], base[0].cost, "Demonic Pacts' own tier costs stay");
  assert.deepEqual([Common.structIds(6, 0, 1).relicStruct, Common.structIds(6, 0, 1).passiveStruct], [206100, 206020]);
  givePoints(player, 100000);
  assert.equal(Unlock.unlock(player, 0, 1), true, "a Trailblazer Reloaded relic works with Demonic Pacts as the base");
  assert.equal(Common.effectSource(player, Common.data.effects.endlessHarvest), 4);
});

test("Reloaded's extra pick comes from the configured tiers below it", () => {
  configure({ "league:relic-tiers": MIXED });
  const player = character("mixed-reloaded", "league", { login: false });
  player.setAttribute("league:type", 4);
  player.setAttribute("league:relics", { 3: 1 });
  player.setAttribute("league:relics-extra", { tier: 0, slot: 1 });
  const extra = Common.reloadedPick(player, 4);
  assert.equal(extra?.key, "endless-harvest");
  assert.equal(Common.reloadedTier(player, 4), 3);
  assert.deepEqual(Common.reloadedTiers(Common.data.effects.reloaded, 4, 3), [0, 1, 2]);
  assert.equal(Common.effectActive(player, Common.data.effects.endlessHarvest), true, "the extra pick counts");
  player.setAttribute("league:relics-extra", { tier: 3, slot: 1 });
  assert.equal(Common.reloadedPick(player, 4), null, "its own tier is not below itself");
});

test("the Relics toggle turns the interface, effects and passives off but keeps the saved catalog", () => {
  const state = configure({ "league:relics": false, "league:relic-tiers": MIXED });
  assert.equal(state.relicsEnabled, false);
  assert.equal(state.status, "disabled");
  assert.deepEqual(state.configuredTiers, MIXED, "the website's selections are still reported");
  const player = character("relics-off");
  assert.equal(hooks["button:" + uid(SIDE_PANEL, 44)]({ player }), false);
  assert.equal(Unlock.unlock(player, 0, 1), false);
  assert.equal(Common.effectActive(player, Common.data.effects.endlessHarvest), false);
  assert.equal(Common.highestTier(player), -1);
  const relics = { player };
  Common.api.emitCustomEvent("league:relics", relics);
  assert.equal(relics.enabled, false);
  assert.deepEqual(relics.chosen, {});
  hooks["command:relic"]({ player, parts: ["relic", "1", "1"] });
  assert.match(player.sent.messages.at(-1), /Relics are disabled/i);
});

test("the public catalog lists every source relic with stable ids and icon information", () => {
  configure();
  const catalog = Catalog.relicCatalog();
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.canonicalIdFormat, "<leagueType>:<relicKey>");
  assert.deepEqual(catalog.limits, { minTiers: 1, maxTiers: 8, minChoicesPerTier: 2, maxChoicesPerTier: 3 });
  assert.deepEqual(catalog.leagues.map((league) => league.type), [4, 5, 6]);
  assert.equal(catalog.relics.filter((relic) => relic.sourceLeague === 4).length, 22);
  assert.equal(catalog.relics.filter((relic) => relic.sourceLeague === 5).length, 24);
  assert.equal(catalog.relics.filter((relic) => relic.sourceLeague === 6).length, 23);
  assert.equal(new Set(catalog.relics.map((relic) => relic.id)).size, catalog.relics.length, "canonical ids are unique");
  assert.ok(catalog.relics.every((relic) => relic.compatible && relic.incompatibleReason === null));
  assert.ok(catalog.relics.every((relic) => /^\d+:[a-z0-9-]+$/.test(relic.id)));
  const tb = catalog.relics.find((relic) => relic.id === "4:endless-harvest");
  assert.equal(tb.icon.sprite, "league_4_relics");
  assert.equal(tb.icon.index, 0);
  assert.ok(Number.isInteger(tb.icon.params[881]));
  const dp = catalog.relics.find((relic) => relic.id === "6:evil-eye");
  assert.equal(dp.icon.sprite, null);
  assert.equal(dp.icon.index, null);
  assert.ok(Number.isInteger(dp.icon.params[881]), "cache-native relics expose their struct's sprite params");
  assert.equal(catalog.world.status, "default");
  assert.equal(catalog.world.custom, false);
});

test("the world config accepts every validated editor shape and forwards explicit settings", () => {
  const blob = (settings, extra = {}) => ({ version: 2, mode: "online", template: "osrs", settings, shops: [], mapOverrides: [], ...extra });
  const direct = toWorldOverlay(blob({ leagueRelics: false, relicTiers: MIXED, passiveTiers: PASSIVES }));
  assert.equal(direct.overlay.pluginConfig["league:relics"], false);
  assert.equal(direct.overlay.pluginConfig["league:relic-league"], undefined, "a non-relic world stays league-free");
  assert.deepEqual(direct.overlay.pluginConfig["league:relic-tiers"], MIXED);
  assert.deepEqual(direct.overlay.pluginConfig["league:passive-tiers"], PASSIVES);

  const object = toWorldOverlay(blob({ leagueRelics: { enabled: true, tiers: MIXED, passives: PASSIVES } }));
  assert.equal(object.overlay.pluginConfig["league:relics"], true);
  assert.deepEqual(object.overlay.pluginConfig["league:relic-tiers"], MIXED);
  assert.deepEqual(object.overlay.pluginConfig["league:passive-tiers"], PASSIVES);

  const aliases = toWorldOverlay(blob({
    relics: false, leagueRelicTiers: JSON.stringify(MIXED), leaguePassives: JSON.stringify(PASSIVES),
  }));
  assert.equal(aliases.overlay.pluginConfig["league:relics"], false);
  assert.equal(aliases.overlay.pluginConfig["league:relic-tiers"], JSON.stringify(MIXED));
  assert.equal(aliases.overlay.pluginConfig["league:passive-tiers"], JSON.stringify(PASSIVES));

  const template = toWorldOverlay({
    version: 2, mode: "online", template: "trailblazer_reloaded",
    templateContract: {
      schemaVersion: 1, ruleset: "trailblazer_reloaded",
      leagueRelics: { enabled: true, tiers: MIXED, passives: PASSIVES }, leagueSeason: 4,
    },
    settings: {},
  });
  assert.equal(template.overlay.pluginConfig["league:relics"], true);
  assert.deepEqual(template.overlay.pluginConfig["league:relic-tiers"], MIXED);
  assert.deepEqual(template.overlay.pluginConfig["league:passive-tiers"], PASSIVES);

  const explicit = toWorldOverlay({
    version: 2, mode: "online", template: "trailblazer_reloaded",
    templateContract: { schemaVersion: 1, ruleset: "trailblazer_reloaded", leagueRelics: false, leagueSeason: 4 },
    settings: { leagueRelics: true },
  });
  assert.equal(explicit.overlay.pluginConfig["league:relics"], true, "the website setting wins over the template default");

  const invalid = toWorldOverlay(blob({ leagueRelics: "yes", relicTiers: 7, passiveTiers: 7 }));
  assert.ok(invalid.notes.some((note) => /leagueRelics/i.test(note)));
  assert.ok(invalid.notes.some((note) => /relicTiers/i.test(note)));
  assert.ok(invalid.notes.some((note) => /passiveTiers/i.test(note)));
  assert.equal(invalid.overlay.pluginConfig["league:relics"], undefined);

  const editorRelics = {
    version: 1,
    tierCount: 2,
    tiers: [
      { tier: 1, slots: 2, relics: ["league-4:endless-harvest", "league-5:power-miner"] },
      { tier: 2, slots: 2, relics: ["league-6:flow-state", "league-4:fairys-flight"] },
    ],
  };
  const editorPassives = {
    version: 1,
    tierCount: 2,
    tiers: [
      { tier: 1, passives: ["league-4:t1:run-energy"] },
      { tier: 2, passives: ["league-5:t3:combat-xp-x2", "league-4:t4:slayer-points-x5"] },
    ],
  };
  const nonSeasonal = toWorldOverlay({
    version: 2,
    mode: "online",
    template: "paescape",
    templateContract: { schemaVersion: 1, ruleset: "paescape", leagueSeason: null, leagueRelics: true },
    settings: { relicConfig: editorRelics, passiveConfig: editorPassives },
  });
  assert.equal(nonSeasonal.overlay.pluginConfig["league:type"], undefined, "a PaeScape world is not a seasonal league");
  assert.equal(nonSeasonal.overlay.pluginConfig["league:relic-league"], 4);
  assert.equal(nonSeasonal.overlay.pluginConfig["league:relics"], true);
  assert.deepEqual(nonSeasonal.overlay.pluginConfig["league:relic-tiers"], [
    ["4:endless-harvest", "5:power-miner"],
    ["6:flow-state", "4:fairys-flight"],
  ]);
  assert.deepEqual(nonSeasonal.overlay.pluginConfig["league:passive-tiers"], [
    ["league-4:t1:run-energy"],
    ["league-5:t3:combat-xp-x2", "league-4:t4:slayer-points-x5"],
  ]);

  const delivered = toWorldOverlay({
    version: 2,
    mode: "online",
    template: "paescape",
    templateContract: { schemaVersion: 1, ruleset: "paescape", leagueSeason: null, leagueRelics: true },
    settings: {},
    relics: { enabled: true, config: editorRelics },
    passives: { enabled: true, config: editorPassives },
  });
  assert.deepEqual(delivered.overlay.pluginConfig["league:relic-tiers"], nonSeasonal.overlay.pluginConfig["league:relic-tiers"]);
  assert.deepEqual(delivered.overlay.pluginConfig["league:passive-tiers"], nonSeasonal.overlay.pluginConfig["league:passive-tiers"]);

  // A shared tier row may carry both kinds. Each reader must take only its own field.
  const combined = {
    version: 1,
    tierCount: 2,
    tiers: editorRelics.tiers.map((row, index) => ({ ...row, passives: editorPassives.tiers[index].passives })),
  };
  const combinedRows = toWorldOverlay(blob({ relicConfig: combined, passiveConfig: combined }));
  assert.deepEqual(combinedRows.overlay.pluginConfig["league:relic-tiers"], [
    ["4:endless-harvest", "5:power-miner"],
    ["6:flow-state", "4:fairys-flight"],
  ]);
  assert.deepEqual(combinedRows.overlay.pluginConfig["league:passive-tiers"], [
    ["league-4:t1:run-energy"],
    ["league-5:t3:combat-xp-x2", "league-4:t4:slayer-points-x5"],
  ]);
  const rowObjects = toWorldOverlay(blob({ passiveConfig: editorPassives.tiers }));
  assert.deepEqual(rowObjects.overlay.pluginConfig["league:passive-tiers"], [
    ["league-4:t1:run-energy"],
    ["league-5:t3:combat-xp-x2", "league-4:t4:slayer-points-x5"],
  ]);
});

test("catalog validation rejects bad shapes, missing definitions, duplicates and too many tiers", () => {
  const relic = (key, extra = {}) => ({ key, name: key, description: "", grants: [], icon: 0, ...extra });
  const catalogs = {
    4: { tiers: [
      { cost: 0, passive: "", relics: [relic("one"), relic("two")] },
      { cost: 500, passive: "", relics: [relic("three"), relic("four")] },
    ] },
    5: { tiers: [{ cost: 0, passive: "", relics: [relic("other")] }] },
    6: null,
  };
  const baseTiers = catalogs[4].tiers;
  const build = (raw) => WorldCatalog.buildWorldCatalog({ raw, baseLeague: 4, baseTiers, catalogs });

  assert.equal(build([["4:one", "4:two"]]).status, "custom");
  assert.deepEqual(build([["league-4:one", "league-4:two"]]).canonicalTiers, [["4:one", "4:two"]], "website ids are accepted and canonicalised");
  assert.match(build([["4:one", "4:one"]]).error, /more than once/);
  assert.match(build([["4:one"]]).error, /2 or 3/);
  assert.match(build([["4:one", "4:two", "4:three", "4:other"]]).error, /2 or 3/);
  assert.match(build([["4:one", "4:nope"]]).error, /not in league 4/);
  assert.match(build([["7:one", "4:two"]]).error, /unsupported source/);
  assert.match(build([["one", "4:two"]]).error, /canonical relic id/);
  assert.match(build([["4:one", "4:two"], ["4:three", "4:other"], ["4:one", "4:two"]]).error, /has only 2 tiers/);
  assert.match(build("not json").error, /not valid JSON/);
  assert.equal(build([["4:one", "4:two"], ["4:three", "4:four"]]).status, "custom", "the saved tier count is the enabled count");
  assert.equal(build(undefined).status, "default", "no saved value means the league's own catalog");

  const broken = {
    4: { tiers: [{ cost: 0, passive: "", relics: [
      { key: "no-icon", name: "No icon", description: "", grants: [] },
      { key: "no-name", description: "", grants: [], icon: 0 },
    ] }] },
    5: null,
    6: null,
  };
  const badCatalog = (raw) => WorldCatalog.buildWorldCatalog({ raw, baseLeague: 4, baseTiers: broken[4].tiers, catalogs: broken });
  assert.match(badCatalog([["4:no-icon", "4:no-name"]]).error, /icon|name|incompatible/);
});
