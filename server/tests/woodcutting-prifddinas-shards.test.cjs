// Run after `yarn build`: node --test tests/woodcutting-prifddinas-shards.test.cjs
// Wiki (Crystal shard): chopping trees in Prifddinas gives a 1/40 shard roll per log received;
// Gwenith does not count. These tests drive the real Woodcutting success producer.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ClientConnection } = require('../dist/net/NetworkBuilder');

let core, next = 12650;
const bots = process.env.DISABLE_PLAYER_BOTS;

before(async () => {
  process.env.DISABLE_PLAYER_BOTS = '1';
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  core = PM.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(3235, 6125);
  core.RegionManager.loadMapFiles(2260, 3400);
  core.RegionManager.loadMapFiles(3199, 6100);
  PM.emitServerStartup({});
});

after(() => {
  PM.emitServerShutdown({});
  if (bots === undefined) delete process.env.DISABLE_PLAYER_BOTS;
  else process.env.DISABLE_PLAYER_BOTS = bots;
});

function chopper(t, [x, y], shardHit) {
  const channel = { kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername('prifshard' + next);
  player.setRegistered(true);
  player.setLocation(new core.Location(x, y, 0));
  player.needsPlacement = false;
  const connection = new ClientConnection(channel);
  connection.player = player;
  t.after(() => {
    player.setRegistered(false);
    core.TaskManager.cancelTasks(player.getIndex());
  });

  const skills = player.getSkillManager();
  skills.setMaxLevel(core.Skill.WOODCUTTING, 99);
  skills.setCurrentLevel(core.Skill.WOODCUTTING, 99);
  player.getInventory().add(new core.Item(core.ItemIdentifiers.DRAGON_AXE), true);
  t.mock.method(core.WorldDefinition, 'isMembersWorld', () => true);
  t.mock.method(Math, 'random', () => {
    const stack = new Error().stack;
    if (stack.includes('rollLog')) return 0;
    if (stack.includes('rollShard')) return shardHit ? 0 : 0.99;
    return 0.99;
  });
  return { player, connection };
}

async function chop(t, fixture, at) {
  const tree = new core.GameObject(core.ObjectIdentifiers.TREE, new core.Location(at[0], at[1], 0), 10, 0, null);
  core.ObjectManager.register(tree, true);
  t.after(() => core.ObjectManager.deregister(tree, true));
  await fixture.connection.dispatch([{ type: 'object_option', id: tree.getId(), x: at[0], y: at[1], action: 'Chop down' }]);
  fixture.connection.processTurnPackets();
  for (let i = 0; i < 12; i++) {
    core.TaskManager.processWalkTo(fixture.player.getIndex());
    fixture.player.getMovementQueue().process();
    core.TaskManager.process();
  }
}

test('a successful Prifddinas chop rolls and receives a crystal shard', async (t) => {
  const fixture = chopper(t, [3237, 6124], true);
  await chop(t, fixture, [3238, 6124]);
  assert.equal(fixture.player.getInventory().getAmount(core.ItemIdentifiers.CRYSTAL_SHARD), 1);
  assert.equal(fixture.player.getInventory().getAmount(core.ItemIdentifiers.LOGS), 1);
});

test('each received log rolls separately', async (t) => {
  const fixture = chopper(t, [3237, 6124], true);
  fixture.player.getEquipment().setItem(core.Equipment.HEAD_SLOT, new core.Item(core.ItemIdentifiers.KANDARIN_HEADGEAR_1, 1));
  await chop(t, fixture, [3238, 6124]);
  assert.equal(fixture.player.getInventory().getAmount(core.ItemIdentifiers.LOGS), 2);
  assert.equal(fixture.player.getInventory().getAmount(core.ItemIdentifiers.CRYSTAL_SHARD), 2);
});

test('a shard with no backpack room is dropped on the floor', async (t) => {
  const fixture = chopper(t, [3237, 6124], true);
  while (fixture.player.getInventory().getFreeSlots() > 1) {
    fixture.player.getInventory().add(new core.Item(core.ItemIdentifiers.RAKE, 1), false);
  }
  await chop(t, fixture, [3238, 6124]);
  assert.equal(fixture.player.getInventory().getAmount(core.ItemIdentifiers.CRYSTAL_SHARD), 0);
  const ground = core.World.getItems().filter((item) =>
    item.getItem().getId() === core.ItemIdentifiers.CRYSTAL_SHARD
    && item.getOwner() === fixture.player.getUsername());
  assert.equal(ground.reduce((total, item) => total + item.getItem().getAmount(), 0), 1);
  t.after(() => ground.forEach((item) => core.ItemOnGroundManager.deregister(item)));
});

test('Gwenith never gives the Prifddinas woodcutting shard', async (t) => {
  const fixture = chopper(t, [2255, 3398], true);
  await chop(t, fixture, [2256, 3398]);
  assert.equal(fixture.player.getInventory().getAmount(core.ItemIdentifiers.CRYSTAL_SHARD), 0);
  assert.equal(fixture.player.getInventory().getAmount(core.ItemIdentifiers.LOGS), 1);
});

test('trees just outside Prifddinas never give the shard', async (t) => {
  const fixture = chopper(t, [3193, 6099], true);
  await chop(t, fixture, [3194, 6099]);
  assert.equal(fixture.player.getInventory().getAmount(core.ItemIdentifiers.CRYSTAL_SHARD), 0);
  assert.equal(fixture.player.getInventory().getAmount(core.ItemIdentifiers.LOGS), 1);
});

test('the Prifddinas rectangle includes its corners and excludes Gwenith and the surrounding tiles', () => {
  const shards = require('../plugins/skills/woodcutting/PrifddinasShards.Woodcutting');
  const at = (x, y, z = 0) => ({ getX: () => x, getY: () => y, getZ: () => z });
  for (const [x, y] of [[3200, 6016], [3327, 6016], [3200, 6143], [3327, 6143]]) {
    assert.equal(shards.isInPrifddinas(at(x, y)), true, `${x},${y} is in Prifddinas`);
  }
  for (const [x, y] of [[3199, 6100], [3328, 6100], [3230, 6015], [3230, 6144], [2260, 3400]]) {
    assert.equal(shards.isInPrifddinas(at(x, y)), false, `${x},${y} is outside Prifddinas`);
  }
  assert.equal(shards.isInPrifddinas(at(3230, 6100, 1)), false, 'the surface rectangle does not spill onto upper floors');
});

test("the rectangle is the generated map's Prifddinas music area", () => {
  const shards = require('../plugins/skills/woodcutting/PrifddinasShards.Woodcutting');
  const music = require('../data/definitions/music-areas.json');
  const area = music.areas.findIndex(({ names }) => names.includes('Architects of Prifddinas'));
  assert.ok(area >= 0);

  const tiles = [];
  for (const [region, runs] of Object.entries(music.tiles[0])) {
    const regionNumber = Number(region);
    let index = 0;
    for (const run of runs.split(',')) {
      const [value, count] = run.split('*');
      const length = count === undefined ? 1 : Number(count);
      if (Number(value) === area) {
        for (let offset = 0; offset < length; offset++) {
          const tile = index + offset;
          tiles.push([
            ((regionNumber >> 8) << 6) + (tile & 63),
            ((regionNumber & 255) << 6) + (tile >> 6),
          ]);
        }
      }
      index += length;
    }
  }

  const xs = tiles.map(([x]) => x);
  const ys = tiles.map(([, y]) => y);
  assert.deepEqual({
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys), z: 0,
  }, shards.PRIFDDINAS);
  assert.equal(tiles.length, 128 * 128, 'the whole city map square pair is the area');
  assert.equal(tiles.some(([x, y]) => x === 2260 && y === 3400), false, 'Gwenith is not part of it');
});
