// Run after `yarn build`: node --test tests/culinaromancers-chest.test.cjs
//
// The Culinaromancer's Chest sits against the cellar's east wall. Its cache access edge has no
// standable tile, so clicks must route to the floor west of it. That route (and Bank / Buy-*)
// used to live only on Recipe for Disaster, so Quests-off worlds showed the chest but answered
// "I can't reach that!".
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Location } = require("../dist/game/model/Location");

const plugin = require("../plugins/objects/CulinaromancersChest.plugin");
const T = plugin._test;

let core, route, interact, prices;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  plugin.register(new Proxy({
    core,
    emitCustomEvent() {},
    onObjectRoute(handler) { route = handler; },
    onObjectInteraction(handler) { interact = handler; },
    onCustomEvent(name, handler) {
      prices = prices ?? {};
      prices[name] = handler;
    },
  }, { get: (target, key) => (key in target ? target[key] : () => {}) }));
});

test("the chest routes to the walkable floor west of its map tile", () => {
  assert.equal(typeof route, "function");
  const object = {
    getId: () => T.CHEST_PARENT,
    getLocation: () => new Location(3219, 9623, 0),
  };
  const event = { object, objectId: T.CHEST_PARENT, destination: null };
  route(event);
  assert.deepEqual(event.destination, { ...T.CHEST_SIDE });
});

test("other locs are left alone", () => {
  const event = {
    object: { getId: () => 1, getLocation: () => new Location(3219, 9623, 0) },
    objectId: 1,
    destination: null,
  };
  route(event);
  assert.equal(event.destination, null);
});

test("Bank opens through the standalone chest handler", () => {
  let opened = 0;
  const player = {
    getCurrentBankTab: () => 0,
    getBank: () => ({ open: () => { opened++; } }),
  };
  const event = {
    objectId: T.CHEST_PARENT,
    clickType: 1,
    definition: { getActions: () => ["Bank", null, "Collect", "Buy-food", "Buy-items"] },
    player,
    handled: false,
  };
  assert.equal(interact(event), true);
  assert.equal(event.handled, true);
  assert.equal(opened, 1);
});

test("Buy-items refuses before the banquet opening is complete", () => {
  const messages = [];
  const player = {
    getAttribute: () => 0,
    sendMessage: (text) => messages.push(text),
  };
  const event = {
    objectId: T.CHEST_PARENT,
    clickType: 5,
    definition: { getActions: () => ["Bank", null, "Collect", "Buy-food", "Buy-items"] },
    player,
    handled: false,
  };
  assert.equal(interact(event), true);
  assert.equal(event.handled, true);
  assert.match(messages.at(-1), /banquet/);
});
