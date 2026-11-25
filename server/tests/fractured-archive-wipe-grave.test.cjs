// Run after `yarn build`: node --test tests/fractured-archive-wipe-grave.test.cjs
// A wipe takes the last member's area out from under them (remove() disposes the raid), and the
// death that follows must not read that destroyed instance as a private area: its grave belongs
// at the lobby's return tile, not at the Lumbridge respawn point.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");

require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");

let core;
let Raid;
let Parties;
let Shared;
let next = 9000;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  Raid = require("../plugins/minigames/tfa/RaidState.FracturedArchive");
  Parties = require("../plugins/minigames/tfa/Parties.FracturedArchive");
  Shared = require("../plugins/minigames/tfa/Shared.FracturedArchive");
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(4096, 5568);
  PM.emitServerStartup({});
});

after(() => PM.emitServerShutdown({}));

function actor(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername("tfawipe" + next);
  player.setRegistered(true);
  player.setLocation(new core.Location(4125, 5597, 0));
  player.needsPlacement = false;
  const connection = new ClientConnection(channel);
  connection.player = player;
  t.after(() => {
    PM.emitPlayerLogout({ player, username: player.getUsername() });
    player.setRegistered(false);
    core.TaskManager.cancelTasks(player.getIndex());
  });
  return player;
}

function tick(times) {
  for (let i = 0; i < times; i++) core.TaskManager.process();
}

test("a Fractured Archive wipe leaves the grave at the lobby return, not Lumbridge", (t) => {
  const leader = actor(t);
  const party = Parties.create(leader);
  const raid = Raid.begin(leader);
  assert.ok(raid, "the leader opens a raid");
  raid.area.enter(leader);
  assert.equal(leader.getArea(), raid.area, "the private area is on the player");
  raid.member(leader).fighting = true;
  for (const id of [995, 385, 379, 373]) leader.getInventory().adds(id, 100);

  raid.fail();
  tick(4);

  assert.equal(raid.over, true);
  assert.equal(leader.getPrivateArea(), null, "the disposed raid's area is not left on the player");
  const held = leader.getAttribute("gravestones:grave");
  assert.ok(held, "the wiped player's items went to a grave");
  assert.deepEqual(
    [held.deathCoord.x, held.deathCoord.y, held.deathCoord.z],
    [Shared.TILE.WIPE_RETURN.x, Shared.TILE.WIPE_RETURN.y, Shared.TILE.WIPE_RETURN.z],
    "the grave stands where the wipe put the player, not at the Lumbridge respawn point",
  );
  assert.equal(party.raid, null);
});
