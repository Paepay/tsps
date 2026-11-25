"use strict";

// Run after `yarn build`: node --test tests/red-chinchompa-hunting-ground.test.cjs
// The red chinchompa hunting ground's cave entrance and exit (issue #185).
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { ObjectDefinition } = require("../dist/game/definition/ObjectDefinition");
const Progress = require("../plugins/achievements/diaries/Progress.AchievementDiaries");
const { BY_KEY } = require("../plugins/achievements/diaries/Data.AchievementDiaries");
const Red = require("../plugins/skills/hunter/RedChinchompa.Hunter");
const DIALOGUES = require("../data/definitions/npc-dialogues.json");
const SPAWNS_FILE = require("../data/definitions/npc-spawns.json");

let core;
let diary;
const spawns = SPAWNS_FILE.spawns ?? SPAWNS_FILE;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(2496, 2880, false);
  core.RegionManager.loadMapFiles(2496, 9280, false);
  diary = BY_KEY.get("western");
});

function attach() {
  const hooks = { objects: new Map(), conditions: [], events: [] };
  const api = {
    core,
    emitCustomEvent(name, payload) {
      hooks.events.push({ name, payload });
      if (name === "diary:is-complete") {
        payload.complete = Progress.isTierComplete(payload.player, BY_KEY.get(payload.diary), payload.tier);
      }
    },
    onObjectInteraction(name, handlers) { hooks.objects.set(name, handlers); },
    onNpcDialogueCondition(handler) { hooks.conditions.push(handler); },
  };
  Red.attach(api);
  return hooks;
}

function fakePlayer() {
  return {
    attributes: {},
    moves: [],
    getAttribute(name) { return this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = value; },
    moveTo(location) { this.moves.push([location.getX(), location.getY(), location.getZ()]); },
  };
}

function completeHardDiary(player) {
  player.setAttribute(Progress.TASKS_ATTRIBUTE, {
    western: diary.tiers.hard.tasks.map((task) => task.key),
  });
  assert.equal(Progress.isTierComplete(player, diary, "hard"), true);
}

const tile = (x, y, z = 0) => new core.Location(x, y, z);
const blocked = (x, y) => core.RegionManager.blocked(tile(x, y), null);

test("entrance 19039 and exit 19037 are the cache caves with Enter and Exit", () => {
  for (const [id, option] of [[Red.ENTRANCE, "Enter"], [Red.EXIT, "Exit"]]) {
    const definition = ObjectDefinition.forId(id);
    assert.equal(definition.getName(), "Cave", `loc ${id}`);
    assert.ok(definition.getInteractions().filter(Boolean).some((action) => action.toLowerCase() === option.toLowerCase()),
      `loc ${id} offers ${option}: ${definition.getInteractions()}`);
  }
  const guard = spawns.find((spawn) => spawn.id === Red.GUARD);
  assert.ok(guard, "Hunting expert 5529 is spawned beside the entrance");
  assert.equal(guard.x, 2527);
  assert.equal(guard.y, 2893);
});

test("both caves are solid and their landings are walkable tiles beside them", () => {
  assert.equal(blocked(2525, 2893), true, "surface cave footprint");
  assert.equal(blocked(2526, 2894), true, "surface cave footprint");
  assert.equal(blocked(Red.LANDING_OUTSIDE[0], Red.LANDING_OUTSIDE[1]), false, "outside landing");
  assert.equal(blocked(2533, 9293), true, "interior exit footprint");
  assert.equal(blocked(2534, 9294), true, "interior exit footprint");
  assert.equal(blocked(Red.LANDING_INSIDE[0], Red.LANDING_INSIDE[1]), false, "inside landing");
  assert.equal(Red.LANDING_INSIDE[2], 0);
  assert.equal(Red.LANDING_OUTSIDE[2], 0);
});

test("entering without the hard Western Provinces Diary is refused by the Hunting expert", () => {
  const hooks = attach();
  const player = fakePlayer();
  assert.equal(hooks.objects.get("Cave").Enter({ player, objectId: Red.ENTRANCE }), true);
  assert.deepEqual(player.moves, []);
  const start = hooks.events.find((event) => event.name === "npc-dialogue:start");
  assert.ok(start, "the guard's refusal plays");
  assert.equal(start.payload.npcId, Red.GUARD);
  assert.equal(start.payload.variant, Red.REFUSAL_VARIANT);
  assert.equal(start.payload.exact, true);
  assert.equal(Red.condition({ player, npcId: Red.GUARD, text: Red.DIARY_COMPLETE }), false);
  assert.equal(Red.condition({ player, npcId: Red.GUARD, text: Red.DIARY_INCOMPLETE }), true);
});

test("a completed hard diary enters at the tile beside the interior exit", () => {
  const hooks = attach();
  const player = fakePlayer();
  completeHardDiary(player);
  assert.equal(Red.condition({ player, npcId: Red.GUARD, text: Red.DIARY_COMPLETE }), true);
  assert.equal(Red.condition({ player, npcId: Red.GUARD, text: Red.DIARY_INCOMPLETE }), false);
  assert.equal(hooks.objects.get("Cave").Enter({ player, objectId: Red.ENTRANCE }), true);
  assert.deepEqual(player.moves, [[2532, 9294, 0]]);
  assert.equal(hooks.events.some((event) => event.name === "npc-dialogue:start"), false);
});

test("the interior exit returns outside beside the Feldip cave and other caves are untouched", () => {
  const hooks = attach();
  const player = fakePlayer();
  assert.equal(hooks.objects.get("Cave").Exit({ player, objectId: Red.EXIT }), true);
  assert.deepEqual(player.moves, [[2527, 2894, 0]]);
  player.moves.length = 0;
  assert.equal(hooks.objects.get("Cave").Enter({ player, objectId: 19037 }), false);
  assert.equal(hooks.objects.get("Cave").Exit({ player, objectId: Red.ENTRANCE }), false);
  assert.equal(hooks.objects.get("Cave").Enter({ player, objectId: 12345 }), false);
  assert.deepEqual(player.moves, []);
  assert.equal(Red.condition({ player, npcId: 1504, text: Red.DIARY_COMPLETE }), null);
  assert.equal(Red.condition({ player, npcId: Red.GUARD, text: "Something else?" }), null);
});

test("the generated transcript has the refusal variant and both diary conditions", () => {
  const page = DIALOGUES["Hunting expert (Red chinchompa hunting ground)"];
  assert.ok(page, "the guard's transcript page exists");
  assert.ok(Array.isArray(page.variants[Red.REFUSAL_VARIANT]));
  const conditions = page.variants["standard-dialogue"]
    .filter((step) => step.type === "condition")
    .map((step) => step.text);
  assert.deepEqual(conditions, [Red.DIARY_COMPLETE, Red.DIARY_INCOMPLETE]);
});
