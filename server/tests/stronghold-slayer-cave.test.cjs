// Run after `yarn build`: node --test tests/stronghold-slayer-cave.test.cjs
// The Stronghold Slayer Cave (Nieve's cave): only the five post-split monsters, task-only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const Cave = require('../plugins/areas/StrongholdSlayerCave.plugin');
const SPAWNS = require('../data/definitions/npc-spawns.json');

const T = Cave._test;
const COUNTS = { Ankou: 8, 'Fire giant': 12, Hellhound: 13, Bloodveld: 12, 'Aberrant spectre': 13 };
let core;
let area;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  core = PluginManager.getCoreApi();
  const api = {
    core,
    emitCustomEvent: (name, payload) => {
      if (name === 'slayer:on-task') payload.onTask = payload.player.onTask === true;
    },
    registerArea: (registered) => { area = registered; },
  };
  Cave.register(api);
});

function fakePlayer({ onTask = false, retaliating = false, target = null } = {}) {
  const player = {
    onTask,
    target,
    messages: [],
    isPlayer: () => true,
    isNpc: () => false,
    getAsPlayer: () => player,
    sendMessage: (text) => player.messages.push(text),
    getCombat: () => ({ isAutoRetaliating: () => retaliating, getTarget: () => player.target ?? null }),
  };
  return player;
}

function fakeNpc(id, name) {
  return { id, isPlayer: () => false, isNpc: () => true, getId: () => id, getDefinition: () => ({ getName: () => name }) };
}

const inside = (x, y, z = 0) => area.getBoundaries().some((b) => b.inside(new core.Location(x, y, z)));

test('the area covers the cave and exactly its five Wiki monster families', () => {
  const spawns = SPAWNS.spawns ?? SPAWNS;
  const found = {};
  for (const spawn of spawns) {
    if (!T.MONSTER_NAMES.has(spawn.name)) continue;
    if (spawn.x < T.CAVE[0] || spawn.x > T.CAVE[1] || spawn.y < T.CAVE[2] || spawn.y > T.CAVE[3]) continue;
    found[spawn.name] = (found[spawn.name] ?? 0) + 1;
    assert.ok(inside(spawn.x, spawn.y, spawn.level), `${spawn.name} at ${spawn.x},${spawn.y}`);
  }
  assert.deepEqual(found, COUNTS);
  assert.equal(inside(2387, 9800), false, 'west of the cave');
  assert.equal(inside(2409, 9817, 1), false, 'plane 0 only');
});

test('an explicit attack without a task is refused with the cave message', () => {
  for (const id of [2517, 2518, 2519, 2081, 2082, 2083, 105, 486, 487, 6, 7]) {
    const name = core.NpcDefinition.forId(id)?.getName?.() ?? '';
    const npc = fakeNpc(id, name);
    const player = fakePlayer({ target: npc });
    assert.equal(area.canAttack(player, npc), false, `npc ${id} ${name}`);
    assert.deepEqual(player.messages, [T.REFUSAL]);
  }
});

test('the same monsters are left alone while they are the player task', () => {
  for (const [id, name] of [[2517, 'Ankou'], [2081, 'Fire giant'], [105, 'Hellhound'], [486, 'Bloodveld'], [6, 'Aberrant spectre']]) {
    const npc = fakeNpc(id, name);
    const player = fakePlayer({ onTask: true, target: npc });
    assert.equal(area.canAttack(player, npc), null);
    assert.deepEqual(player.messages, []);
  }
});

test('auto-retaliation and permission probes are refused silently', () => {
  const npc = fakeNpc(105, 'Hellhound');
  for (const player of [fakePlayer({ retaliating: true, target: npc }), fakePlayer(), fakePlayer({ target: fakeNpc(486, 'Bloodveld') })]) {
    assert.equal(area.canAttack(player, npc), false);
    assert.deepEqual(player.messages, []);
  }
});

test('other cave NPCs, monsters attacking players and other planes are not this area business', () => {
  assert.equal(area.canAttack(fakePlayer(), fakeNpc(1043, 'Brimstail')), null);
  assert.equal(area.canAttack(fakeNpc(105, 'Hellhound'), fakePlayer()), null);
  assert.equal(inside(2434, 9817, 1), false);
});
