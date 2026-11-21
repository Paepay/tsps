const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { PluginManager } = require("../dist/plugins/PluginManager");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { Player } = require("../dist/game/entity/impl/player/Player");
const Hilt = require("../plugins/items/GhommalsHilt.plugin");

const WORN_INTERFACE = 1688;
let core = null;
let api = null;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  api = PluginManager.createApi("GhommalsHiltTest");
  Hilt.register(api);
});

function actor() {
  const player = new Player(null, new core.Location(3200, 3200, 0));
  player.setIndex(4000 + Math.floor(Math.random() * 1000));
  player.setUsername("ghommal-test");
  player.setRegistered(true);
  player.setNeedsPlacement(false);
  player.getSession = () => ({ sendClientPacket: () => true, write() {} });
  player.getHitpoints = () => 10;
  player.isDyingReturn = () => false;
  return player;
}

function stub(t, player) {
  const landed = [];
  const messages = [];
  t.mock.method(core.TeleportHandler, "checkReqs", () => true);
  t.mock.method(core.TeleportHandler, "confirm", (_player, _target, action) => action());
  t.mock.method(core.TeleportHandler, "teleport", (_player, target) => landed.push([target.getX(), target.getY()]));
  t.mock.method(player, "sendMessage", (message) => messages.push(message));
  return { landed, messages };
}

/** A worn hilt: the first worn option (click 2) at cache param 451. */
function click(player, itemId, option, clickType = 2) {
  const item = new core.Item(itemId, 1);
  const event = { player, interfaceId: WORN_INTERFACE, item, itemId, slot: 5, clickType, option, handled: false };
  PluginManager.emitItemAction(event);
  return event;
}

test("hilt 1 gives three Trollheim teleports a day", (t) => {
  const player = actor();
  const { landed, messages } = stub(t, player);
  for (let i = 0; i < 3; i++) {
    click(player, 25926, "Trollheim");
  }
  assert.deepEqual(landed, [[2918, 3744], [2918, 3744], [2918, 3744]]);
  click(player, 25926, "Trollheim");
  assert.equal(landed.length, 3, "the fourth is refused");
  assert.deepEqual(messages, [Hilt._test.NO_TELEPORTS_MESSAGE]);
});

test("a new day restores the allowance", (t) => {
  const player = actor();
  player.setAttribute("ghommals-hilt:daily", { day: "2000-01-01", counts: { trollheim: 3 } });
  const { landed } = stub(t, player);
  click(player, 25926, "Trollheim");
  assert.deepEqual(landed, [[2918, 3744]]);
});

test("hilt 3 has unlimited Trollheim teleports", (t) => {
  const player = actor();
  const { landed } = stub(t, player);
  for (let i = 0; i < 8; i++) click(player, 25930, "Trollheim");
  assert.equal(landed.length, 8);
});

test("Mor Ul Rek needs the fire cape unlock and then three daily uses on hilt 4", (t) => {
  const player = actor();
  const { landed, messages } = stub(t, player);
  click(player, 25932, "Mor Ul Rek");
  assert.deepEqual(landed, [], "no access, no teleport");
  assert.deepEqual(messages, [Hilt._test.NO_CAPE_MESSAGE]);

  player.setAttribute("mor-ul-rek:access", true);
  for (let i = 0; i < 3; i++) click(player, 25932, "Mor Ul Rek");
  assert.deepEqual(landed, [[2548, 5137], [2548, 5137], [2548, 5137]]);
  click(player, 25932, "Mor Ul Rek");
  assert.equal(landed.length, 3, "the fourth is refused");
});

test("hilts without the Mor Ul Rek option do nothing", (t) => {
  const player = actor();
  const { landed } = stub(t, player);
  player.setAttribute("mor-ul-rek:access", true);
  const event = click(player, 25926, "Mor Ul Rek");
  assert.equal(event.handled, false);
  assert.deepEqual(landed, []);
});
