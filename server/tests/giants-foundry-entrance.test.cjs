// From server/: yarn build && node --test tests/giants-foundry-entrance.test.cjs
//
// The Giant's Foundry cave (44635) is a 5x2 loc, but map scenery is registered only at its
// origin tile (3359,3150). A click names the tile under the pointer, so clicking the east half
// of the cave did nothing (issue #153). The object lookup now resolves any covered tile.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { ObjectActionPacketListener } = require('../dist/net/packet/impl/ObjectActionPacketListener');
const { TaskManager } = require('../dist/game/task/TaskManager');
const { World } = require('../dist/game/World');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { Location } = require('../dist/game/model/Location');

const CAVE = 44635;
const CAVE_ORIGIN = [3359, 3150];
const LANDING = [3366, 11483];

let next = 9500;

before(async () => {
  process.env.DISABLE_PLAYER_BOTS = '1';
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  RegionManager.init();
  PluginManager.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  PluginManager.emitServerStartup({});
});

function playerAt(x, y, stage = 3) {
  const player = new Player(null, new Location(x, y, 0));
  player.setIndex(next++);
  player.setRegistered(true);
  player.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  player.setHitpoints(10);
  player.setAttribute('quest.sleeping_giants.stage', stage);
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

function click(player, x, y) {
  new ObjectActionPacketListener().executeAction(player, CAVE, x, y, 1);
  for (let tick = 0; tick < 14; tick++) step(player);
  return [player.getLocation().getX(), player.getLocation().getY()];
}

test('every tile of the cave footprint enters the foundry', () => {
  assert.deepEqual(click(playerAt(3359, 3152), ...CAVE_ORIGIN), LANDING);
  assert.deepEqual(click(playerAt(3360, 3152), 3362, 3150), LANDING);
  assert.deepEqual(click(playerAt(3361, 3152), 3363, 3151), LANDING);
});

test('a tile east of the footprint remains a plain walk and does not enter', () => {
  const player = playerAt(3363, 3152);
  assert.deepEqual(click(player, 3366, 3150), [3363, 3152]);
});

test('a click before the quest starts explains the cave instead of entering', () => {
  const player = playerAt(3359, 3152, 0);
  assert.deepEqual(click(player, 3362, 3150), [3359, 3152]);
});