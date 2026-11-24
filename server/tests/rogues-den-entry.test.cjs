// From server/: yarn build && node --test tests/rogues-den-entry.test.cjs
//
// Entering the maze used to land the player on 3056,4992, the cache's solid wall tile just
// north of the first room. Every obstacle click then started a route from a blocked tile, so
// the first contortion bars (and the rest of the course) could not be reached. This drives the
// production entry action and the real cache collision/pathfinder.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const ROOT = path.resolve(__dirname, '..');
const ENTRY_TILE = [3056, 4993, 1];
const FIRST_OBSTACLE_APPROACH = [3050, 4997];

let core;
let Player;
let Location;
let Common;
let Lobby;
let Run;

before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(ROOT);
  const { RegionManager } = require('../dist/game/collision/RegionManager');
  RegionManager.init();

  ({ Player } = require('../dist/game/entity/impl/player/Player'));
  ({ Location } = require('../dist/game/model/Location'));
  const { PluginManager } = require('../dist/plugins/PluginManager');
  core = PluginManager.getCoreApi();
  require('../plugins/minigames/RoguesDen.plugin').register(
    PluginManager.createApi('RoguesDenEntryRegression'),
  );

  Common = require('../plugins/minigames/roguesden/Common.RoguesDen');
  Lobby = require('../plugins/minigames/roguesden/Lobby.RoguesDen');
  Run = require('../plugins/minigames/roguesden/Run.RoguesDen');
});

function account() {
  const player = new Player(null);
  player.setIndex(1);
  player.setRegistered(true);
  const sender = new Proxy({}, {
    get: (target, key) => (key === 'sendMessage' ? () => {} : () => sender),
  });
  player.getPacketSender = () => sender;
  player.moveTo(new Location(3061, 4985, 1));
  player.setNeedsPlacement(false);
  player.getSkillManager().setMaxLevels(core.Skill.THIEVING, 50, false);
  player.getSkillManager().setMaxLevels(core.Skill.AGILITY, 50, false);
  player.getSkillManager().setCurrentLevel(core.Skill.THIEVING, 50);
  player.getSkillManager().setCurrentLevel(core.Skill.AGILITY, 50);
  return player;
}

test('the maze entry lands on a walkable tile with a route to the first obstacle', () => {
  const player = account();
  Lobby.startEntry(player);

  const at = player.getLocation();
  assert.deepEqual([at.getX(), at.getY(), at.getZ()], ENTRY_TILE,
    'the doorway puts the player on the maze floor, not the solid wall at y=4992');
  assert.equal(Common.walkable(at.getX(), at.getY(), at.getZ()), true,
    'the entry tile must not be inside a wall');
  const { RegionManager } = require('../dist/game/collision/RegionManager');
  assert.equal(RegionManager.getRegion(3056, 4992).getClip(3056, 4992, 1) & 0x20, 0x20,
    'the old tile sits in the wall row the doorway must not land on');

  const route = new core.RsmodRouteFinding().findRoute({
    level: 1,
    srcX: at.getX(), srcY: at.getY(), srcSize: 1,
    destX: FIRST_OBSTACLE_APPROACH[0], destY: FIRST_OBSTACLE_APPROACH[1],
    privateArea: null, moveNear: false,
  });
  assert.equal(route.success, true, 'the first contortion bars are reachable from the entry');
});

test('a pendulum carries the player past it instead of ejecting them (issue #164)', () => {
  const player = account();
  Lobby.startEntry(player);
  // A tile that only carries a wall's direction bit is walkable; the pendulum post is not.
  assert.equal(Common.walkable(2958, 5025, 1), true);
  assert.equal(Common.walkable(2954, 5025, 1), false);

  player.moveTo(new Location(2955, 5026, 1));
  Run.tick(player);
  // Diagonal into the pendulum's base tile: the first tile past it is its own post.
  player.moveTo(new Location(2956, 5025, 1));
  Run.tick(player);
  assert.equal(Run.runOf(player)?.ended ?? false, false, 'the carry does not eject the player');
  assert.equal(Common.level(player, 'AGILITY'), 47, '3 Agility is drained for the pendulum');
  const at = player.getLocation();
  assert.notDeepEqual([at.getX(), at.getY()], [2956, 5025], 'the player is carried off the pendulum');
  assert.equal(Common.walkable(at.getX(), at.getY(), at.getZ()), true, 'onto a real maze tile');
});
