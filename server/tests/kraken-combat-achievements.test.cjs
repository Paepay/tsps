// From server/: node --test tests/kraken-combat-achievements.test.cjs (after yarn build).
//
// The Kraken's "Unnecessary Optimisation" (cache task struct 3309): kill the boss after killing
// all four tentacles. The tentacles are separate NPCs, so the unit keys their kills by the boss
// NPC they belong to and finishes the task for every participant who killed all four.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, beforeEach, test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { PluginManager } = require("../dist/plugins/PluginManager");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const core = PluginManager.getCoreApi();

let Shared, Kraken, Data;
let npcs, events, deaths;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  Shared = require("../plugins/bosses/kraken/Shared.Kraken");
  Kraken = require("../plugins/bosses/kraken/CombatAchievements.Kraken");
  Data = require("../plugins/achievements/combatachievements/Data.CombatAchievements");
  Data({ core });
});

beforeEach(() => {
  npcs = [];
  events = [];
  deaths = [];
  Shared.bind({
    core: { ...core, World: { getNpcs: () => npcs } },
    emitCustomEvent: (name, payload) => events.push({ name, ...payload }),
    onNpcDeath: (handler) => deaths.push(handler),
  });
  Kraken.attach(Shared.api());
});

function fakeNpc(id, area = null) {
  return {
    area,
    isNpc: () => true,
    isRegistered: () => true,
    getId: () => id,
    getHitpoints: () => 100,
    getPrivateArea: () => area,
  };
}

const fakePlayer = (name) => ({ name, isPlayer: () => true });

function die(npc, killer = null, damagers = []) {
  for (const handler of deaths) handler({ npc, killer, damagers });
}

/** A boss up in `area`, with `count` tentacles beside it. */
function encounter(area = null, count = 4) {
  const boss = fakeNpc(Shared.ids().BOSS, area);
  const tentacles = Array.from({ length: count }, () => fakeNpc(Shared.ids().TENTACLE, area));
  npcs.push(boss, ...tentacles);
  return { boss, tentacles };
}

test("the cache's task is the one this unit finishes", () => {
  const task = Data.taskNamed(Kraken.TASK);
  assert.ok(task, "the cache has Unnecessary Optimisation");
  assert.equal(task.id, 169);
  assert.equal(task.tier, 3);
  assert.equal(task.type, Data.TYPE.MECHANICAL);
  assert.equal(task.description, "Kill the Kraken after killing all four tentacles.");
});

test("killing all four tentacles and then the boss finishes the task", () => {
  const player = fakePlayer("solo");
  const { boss, tentacles } = encounter();
  for (const tentacle of tentacles) die(tentacle, player);
  die(boss, player, [player]);
  assert.deepEqual(events, [{ name: "combat-achievements:complete", player, task: Kraken.TASK }]);
});

test("a boss kill with three tentacles killed does not finish it", () => {
  const player = fakePlayer("solo");
  const { boss, tentacles } = encounter(null, 3);
  for (const tentacle of tentacles) die(tentacle, player);
  die(boss, player, [player]);
  assert.deepEqual(events, []);
});

test("the same tentacle dying more than once counts once", () => {
  const player = fakePlayer("solo");
  const { boss, tentacles } = encounter();
  for (let i = 0; i < 4; i++) die(tentacles[0], player);
  die(boss, player, [player]);
  assert.deepEqual(events, []);
});

test("tentacles killed for a previous boss do not count for its respawn", () => {
  const player = fakePlayer("solo");
  const first = encounter();
  for (const tentacle of first.tentacles) die(tentacle, player);
  die(first.boss, player, [player]);
  events.length = 0;
  // The respawn is a new NPC with new tentacles.
  npcs = [];
  const second = encounter();
  die(second.boss, player, [player]);
  assert.deepEqual(events, []);
});

test("only a participant who killed all four tentacles himself is credited", () => {
  const killer = fakePlayer("killer");
  const helper = fakePlayer("helper");
  const { boss, tentacles } = encounter();
  for (const tentacle of tentacles) die(tentacle, helper);
  // The helper killed the tentacles but took no part in the boss kill.
  die(boss, killer, [killer]);
  assert.deepEqual(events, []);
  // The same fight, with the helper among the damagers, credits the helper only.
  events.length = 0;
  npcs = [];
  const second = encounter();
  for (const tentacle of second.tentacles) die(tentacle, helper);
  die(second.boss, killer, [killer, helper]);
  assert.deepEqual(events, [{ name: "combat-achievements:complete", player: helper, task: Kraken.TASK }]);
});

test("tentacles killed in another area, or with the boss down, do not count", () => {
  const player = fakePlayer("solo");
  const area = { isKrakenInstance: true };
  const open = encounter(null);
  const privateRoom = encounter(area);
  // The public boss's tentacles cannot count towards the private room's boss.
  for (const tentacle of open.tentacles) die(tentacle, player);
  die(privateRoom.boss, player, [player]);
  assert.deepEqual(events, []);
  // With the boss already gone, a stray tentacle death is ignored too.
  events.length = 0;
  npcs = npcs.filter((npc) => npc !== privateRoom.boss);
  die(privateRoom.tentacles[0], player);
  die(privateRoom.boss, player, [player]);
  assert.deepEqual(events, []);
});
