// Run from server/ after `yarn build`: node --test tests/paescape-world-config-plumbing.test.cjs
//
// Issue #45: every website setting must reach the server. This pins the translation
// table (plugin switches, pluginConfig, template rules), the atomic apply rule (a
// refused overlay must not change XP or the reported revision) and the owner player cap.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, beforeEach } = require("node:test");

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-plumbing-"));
process.env.PAESCAPE_WORLD_PLATFORM_CONFIG = path.join(WORK_DIR, "world.platform.json");
process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { toWorldOverlay } = require("../plugins/paescape/PlatformWorldConfig.js");
const PaeScape = require("../plugins/paescape/PaeScape.plugin");

function blob(settings, extra = {}) {
  return { version: 2, mode: "online", template: "osrs", settings, shops: [], mapOverrides: [], ...extra };
}

function fakeApi({ applied = true } = {}) {
  const calls = { xp: [], events: [], refresh: 0 };
  const api = {
    setExperienceRate: (value) => calls.xp.push(value),
    emitCustomEvent: (name, payload) => calls.events.push([name, payload]),
    registerLoginExtension() {},
    registerCommand() {},
    onServerStartup() {},
    onPlayerLogout() {},
    onPlayerDisconnect() {},
    onCustomEvent() {},
    onServerShutdown() {},
    core: {
      PlayerRights: { NONE: 0 },
      WorldDefinition: { applyWorldConfigOverlay: () => (applied ? { applied: true } : { applied: false, error: "invalid overlay" }) },
      PluginManager: { refreshPluginConfig: () => { calls.refresh += 1; } },
      World: { getNetworkPlayerCount: () => 0, getPlayers: () => ({ capacityReturn: () => 2048 }) },
    },
  };
  return { api, calls };
}

beforeEach(() => {
  PaeScape._test.reset();
  try { fs.unlinkSync(process.env.PAESCAPE_WORLD_PLATFORM_CONFIG); } catch {}
});

test("every website plugin toggle becomes the runtime plugin switch", () => {
  const settings = {
    tutorialIsland: true, voiceChat: true, presets: true, setSkillLevel: true, ironmanAccounts: true,
    quests: true, achievementDiaries: true, combatAchievements: true, collectionLog: true, pets: true,
    gravestones: true, duelStaking: true, grandExchange: true, customShops: true, osrsNpcs: true,
    playerBots: true, randomEvents: true, shootingStars: true, customAccountTab: true,
    f2pWorld: true, crossFloorVisibility: true, crossFloorCombat: true,
  };
  const { overlay } = toWorldOverlay(blob(settings));
  assert.deepEqual(overlay.plugins, {
    TutorialIsland: true, VoiceChat: true, PvpMode: true, SetSkillLevel: true, Ironman: true,
    Quests: true, AchievementDiaries: true, CombatAchievements: true, CollectionLog: true, Pets: true,
    Gravestones: true, DuelStaking: true, GrandExchange: true, CustomShops: true, NpcSpawns: true,
    PlayerBots: true, RandomEvents: true, ShootingStars: true, CustomCharacterSummary: true,
    FreeToPlay: true, CrossFloor: true,
  });
});

test("every website pluginConfig option becomes the runtime flat key", () => {
  const settings = {
    tutorialIsland: true, tutorialSkippable: false, levelUpInterruptions: false,
    equipmentRequirements: false, bossDropRate: 4, crossFloorVisibility: true, crossFloorCombat: true,
    commandPermissions: { teleport: "MODERATOR" },
  };
  const { overlay } = toWorldOverlay(blob(settings));
  assert.equal(overlay.pluginConfig["TutorialIsland:allowSkip"], false);
  assert.equal(overlay.pluginConfig["SkillLevelUp:interruptActions"], false);
  assert.equal(overlay.pluginConfig["quests:equipment-requirements"], false);
  assert.equal(overlay.pluginConfig["NpcDrops:bossRareMultiplier"], 4);
  assert.equal(overlay.pluginConfig["CrossFloor:visibility"], true);
  assert.equal(overlay.pluginConfig["CrossFloor:combat"], true);
  assert.deepEqual(overlay.pluginConfig["commands:permissions"], { teleport: "MODERATOR" });
});

test("the tutorial skip value is omitted while Tutorial Island is off", () => {
  const { overlay } = toWorldOverlay(blob({ tutorialIsland: false, tutorialSkippable: true }));
  assert.equal(overlay?.pluginConfig?.["TutorialIsland:allowSkip"], undefined);
});

test("template rules with a runtime consumer compile to it", () => {
  const hardcore = toWorldOverlay({
    version: 2, mode: "online", template: "hardcore",
    templateContract: { schemaVersion: 1, ruleset: "hardcore", hardcore: true, leagueRelics: false, leagueSeason: null, pvp: null, levelUp: null },
    settings: { xpRate: 1 },
  });
  assert.equal(hardcore.overlay.pluginConfig["HardcoreWorld:enabled"], true);
  assert.equal(hardcore.overlay.pluginConfig["template:id"], "hardcore");

  const demonic = toWorldOverlay({
    version: 2, mode: "online", template: "demonic_pacts",
    templateContract: { schemaVersion: 1, ruleset: "demonic_pacts", hardcore: false, leagueRelics: true, leagueSeason: 6, pvp: null, levelUp: null },
    settings: { xpRate: 5 },
  });
  assert.equal(demonic.overlay.pluginConfig["league:type"], 6);
  assert.equal(demonic.overlay.pluginConfig["template:id"], "demonic_pacts");
});

test("the world name and owner player cap travel with the platform config", () => {
  const result = toWorldOverlay({ ...blob({ xpRate: 2, maxPlayers: 12 }), name: "Test Realm" });
  assert.equal(result.overlay.name, "Test Realm");
  assert.equal(result.maxPlayers, 12);
  assert.equal(result.overlay.experienceMultiplier, 2);
});

test("an invalid player cap is reported and does not become a cap", () => {
  const result = toWorldOverlay(blob({ maxPlayers: 100000 }));
  assert.equal(result.maxPlayers, undefined);
  assert.ok(result.notes.some((note) => /max player/i.test(note)));
});

test("a refused overlay changes neither XP nor the applied revision", () => {
  const { api, calls } = fakeApi({ applied: false });
  PaeScape.register(api);
  const before = PaeScape._test.state();
  PaeScape._test.applyWorldConfig(blob({ xpRate: 999, spawn: { x: -1, y: -1 }, maxPlayers: 50 }), 9, 50);
  assert.deepEqual(PaeScape._test.state(), before, "state is unchanged");
  assert.deepEqual(calls.xp, [], "XP was not applied before validation");
  assert.equal(calls.events.length, 0, "no config event was emitted");
});

test("an accepted overlay applies XP, the cap and a restart snapshot together", () => {
  const { api, calls } = fakeApi({ applied: true });
  PaeScape.register(api);
  PaeScape._test.applyWorldConfig(blob({ xpRate: 25, maxPlayers: 7 }), 4, 7);
  const state = PaeScape._test.state();
  assert.equal(state.worldConfigRevision, 4);
  assert.equal(state.configuredMaxPlayers, 7);
  assert.deepEqual(calls.xp, [25]);
  assert.equal(calls.refresh, 1);
  assert.ok(calls.events.some(([name]) => name === "paescape:world-config"));
  const snapshot = JSON.parse(fs.readFileSync(process.env.PAESCAPE_WORLD_PLATFORM_CONFIG, "utf8"));
  assert.equal(snapshot.experienceMultiplier, 25);
  assert.equal(snapshot.plugins.FreeToPlay, undefined, "F2P was not selected");
});

test("the owner cap reports and refuses a full world", () => {
  const { api } = fakeApi();
  PaeScape.register(api);
  PaeScape._test.setConfiguredMaxPlayers(3);
  assert.equal(PaeScape._test.maxPlayers(), 3);
  api.core.World.getNetworkPlayerCount = () => 3;
  assert.equal(PaeScape._test.worldIsFull(), true);
  api.core.World.getNetworkPlayerCount = () => 2;
  assert.equal(PaeScape._test.worldIsFull(), false);
});