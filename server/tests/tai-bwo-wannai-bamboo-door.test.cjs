// Run after `yarn build`: node --test tests/tai-bwo-wannai-bamboo-door.test.cjs
//
// Tiadeche's hut in Tai Bwo Wannai has its bamboo door at 2782,3057, facing east. The player
// outside at 2783,3057 could trade with Tiadeche through the wall but the closed door did nothing.
// Real engine: the map's bamboo loc, every plugin, a real Player and ObjectActionPacketListener.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ObjectActionPacketListener } = require("../dist/net/packet/impl/ObjectActionPacketListener");

const DOOR_ID = 779;
const DOOR_AT = [2782, 3057];
const OUTSIDE = [2783, 3057];
const INSIDE = [2782, 3057];

let core;
let next = 4600;
const players = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PluginManager.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PluginManager.getCoreApi();
  core.ObjectDefinition.init();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(2781, 3057);
  PluginManager.emitServerStartup({});
});

function actor(t, start = OUTSIDE) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername("bambooDoor" + player.getIndex());
  player.setRegistered(true);
  player.setLocation(new core.Location(...start, 0));
  player.needsPlacement = false;
  players.push(player);
  t.after(() => { player.setRegistered(false); core.TaskManager.cancelTasks(player.getIndex()); });
  return player;
}

function tick(count = 1) {
  for (let i = 0; i < count; i++) {
    for (const player of players) {
      player.getMovementQueue().process();
      core.TaskManager.processWalkTo(player.getIndex());
    }
    core.TaskManager.process();
  }
}

function until(condition, limit = 20) {
  for (let i = 0; i < limit && !condition(); i++) tick();
  return condition();
}

const at = (player) => [player.getLocation().getX(), player.getLocation().getY()];
const doorClosed = () => core.MapObjects.get(DOOR_ID, new core.Location(...DOOR_AT, 0), null) != null;
const click = (player) => new ObjectActionPacketListener().executeAction(player, DOOR_ID, ...DOOR_AT, 1);

test("Tiadeche's bamboo door lets a player walk up from outside and enter the hut", (t) => {
  tick(12);
  assert.ok(doorClosed(), "the hut starts with its closed bamboo door");
  const player = actor(t, [2784, 3057]);
  click(player);
  assert.ok(until(() => at(player).join() === INSIDE.join()), `the player reaches Tiadeche, at ${at(player)}`);
  assert.ok(until(doorClosed), "the door is closed again behind the player");
});

test("the bamboo door opens when clicked from directly outside", (t) => {
  tick(12);
  const player = actor(t);
  click(player);
  assert.ok(until(() => at(player).join() === INSIDE.join()), `the player steps inside, at ${at(player)}`);
  assert.ok(until(doorClosed), "the door shuts behind them");
});
