// From server/: yarn build && node --test tests/swan-song-colony-gate.test.cjs
//
// The Piscatoris colony gate's own tile is walkable in this cache, so a plain click routed the
// player onto the gate, `reachesObject` then failed and Open never fired (issue #152).
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { ObjectDefinition } = require('../dist/game/definition/ObjectDefinition');
const { ObjectActionPacketListener } = require('../dist/net/packet/impl/ObjectActionPacketListener');
const { TaskManager } = require('../dist/game/task/TaskManager');
const { World } = require('../dist/game/World');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { GameObject } = require('../dist/game/entity/impl/object/GameObject');
const { Location } = require('../dist/game/model/Location');

const GATE_WEST_ID = 12723;
const GATE_EAST_ID = 12725;
const GATE_WEST_X = 2343;
const GATE_EAST_X = 2344;
const GATE_Y = 3662;
const INSIDE = [2345, 3663];
const OUTSIDE = [2343, 3661];

let next = 9400;

before(async () => {
  process.env.DISABLE_PLAYER_BOTS = '1';
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  RegionManager.init();
  PluginManager.loadFromDirectory(path.resolve(__dirname, '../plugins'));
});

function playerAt(x, y) {
  const player = new Player(null, new Location(x, y, 0));
  player.setIndex(next++);
  player.setRegistered(true);
  player.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  player.setHitpoints(10);
  return player;
}

function step(player) {
  World.processCycle++;
  TaskManager.process();
  const queue = player.getMovementQueue();
  queue.beginCycle?.();
  if (queue.hasPendingWork?.()) queue.process();
  TaskManager.processWalkTo(player.getIndex());
  player.setNeedsPlacement(false);
  player.setResetMovementQueue(false);
}

function click(player, id, x) {
  new ObjectActionPacketListener().executeAction(player, id, x, GATE_Y, 1);
  for (let tick = 0; tick < 12; tick++) step(player);
  return [player.getLocation().getX(), player.getLocation().getY()];
}

function gate(id, x) {
  return new GameObject(id, new Location(x, GATE_Y, 0), 0, 0, null);
}

test('the colony gate lets the player in from the outside and out from the inside', () => {
  assert.deepEqual(click(playerAt(...OUTSIDE), GATE_WEST_ID, GATE_WEST_X), INSIDE);
  assert.deepEqual(click(playerAt(2344, 3661), GATE_EAST_ID, GATE_EAST_X), INSIDE);
  assert.deepEqual(click(playerAt(...INSIDE), GATE_WEST_ID, GATE_WEST_X), OUTSIDE);
  assert.deepEqual(click(playerAt(2344, 3663), GATE_EAST_ID, GATE_EAST_X), OUTSIDE);
});

test('a click from a distance walks over and then opens the gate', () => {
  assert.deepEqual(click(playerAt(2340, 3664), GATE_WEST_ID, GATE_WEST_X), OUTSIDE);
  assert.deepEqual(click(playerAt(2340, 3658), GATE_WEST_ID, GATE_WEST_X), INSIDE);
});

test('the gate route stops beside the gate, not on its walkable tile', () => {
  const player = playerAt(...OUTSIDE);
  const object = gate(GATE_WEST_ID, GATE_WEST_X);
  const event = {
    player, object, objectId: GATE_WEST_ID, clickType: 1,
    definition: ObjectDefinition.forId(GATE_WEST_ID),
    sourceLocation: { x: OUTSIDE[0], y: OUTSIDE[1], z: 0 },
    destination: null,
  };
  PluginManager.emitObjectRoute(event);
  assert.deepEqual(event.destination, { x: GATE_WEST_X, y: 3661, z: 0 });

  const inside = playerAt(...INSIDE);
  const insideEvent = {
    player: inside, object: gate(GATE_EAST_ID, GATE_EAST_X), objectId: GATE_EAST_ID,
    clickType: 1, definition: ObjectDefinition.forId(GATE_EAST_ID),
    sourceLocation: { x: INSIDE[0], y: INSIDE[1], z: 0 },
    destination: null,
  };
  PluginManager.emitObjectRoute(insideEvent);
  assert.deepEqual(insideEvent.destination, { x: GATE_EAST_X, y: 3663, z: 0 });
});

test('a non-Open option on the gate does not move the player', () => {
  const player = playerAt(...OUTSIDE);
  const handled = PluginManager.emitObjectInteraction({
    player,
    object: gate(GATE_WEST_ID, GATE_WEST_X),
    objectId: GATE_WEST_ID,
    definition: ObjectDefinition.forId(GATE_WEST_ID),
    clickType: 2,
    location: { x: GATE_WEST_X, y: GATE_Y, z: 0 },
    handled: false,
  });
  assert.equal(handled, false);
  assert.deepEqual([player.getLocation().getX(), player.getLocation().getY()], OUTSIDE);
});