// The elemental shields in the Slayer Equipment shop on league and Level-Up worlds (issue #69).
// The generated shops.json row is unchanged; the plugin stocks the shields at runtime.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { GameConstants } = require("../dist/game/GameConstants");
const { applyWorldConfigOverlay } = require("../dist/game/definition/WorldDefinition");
const { ShopDefinitionLoader } = require("../dist/game/definition/loader/impl/ShopDefinitionLoader");

const SHOP_ID = 1324; // Slayer Equipment (shop)
const ELEMENTAL_SHIELD = 2890;
const MIND_SHIELD = 9731;
let ShopManager;

function loadShops() {
  assert.equal(new ShopDefinitionLoader().load(), true, "the server's shops load");
  ({ ShopManager } = require("../dist/game/model/container/shop/ShopManager"));
  ShopManager.initialize();
}

function world(template) {
  const applied = applyWorldConfigOverlay({ pluginConfig: { "template:id": template } });
  assert.equal(applied.applied, true, applied.error);
  PM.refreshPluginConfig();
}

const shop = () => ShopManager.shopsById.get(SHOP_ID);

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  GameConstants.setWorldProfile("default");
  world("paescape");
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  PM.getCoreApi().RegionManager.init();
  loadShops();
  PM.emitServerStartup({ timestamp: Date.now() });
});
after(() => PM.emitServerShutdown({}));

test("a plain world keeps the generated Slayer Equipment stock", () => {
  assert.ok(shop(), "the shop is registered");
  assert.equal(shop().stock.get(ELEMENTAL_SHIELD) ?? 0, 0);
  assert.equal(shop().stock.get(MIND_SHIELD) ?? 0, 0);
});

test("a Level-Up world stocks both elemental shields", async () => {
  world("level_up");
  PM.emitCustomEvent("paescape:world-config", {});
  await Promise.resolve();
  assert.equal(shop().stock.get(ELEMENTAL_SHIELD), 50);
  assert.equal(shop().stock.get(MIND_SHIELD), 50);
  assert.deepEqual(
    shop().order.slice(-2),
    [ELEMENTAL_SHIELD, MIND_SHIELD],
    "both are shown in the shop"
  );
});

test("stocking twice does not duplicate or reset the stock", async () => {
  PM.emitCustomEvent("paescape:world-config", {});
  await Promise.resolve();
  assert.equal(shop().stock.get(ELEMENTAL_SHIELD), 50);
  assert.equal(shop().stock.get(MIND_SHIELD), 50);
  assert.equal(shop().order.filter((id) => id === ELEMENTAL_SHIELD).length, 1);
  assert.equal(shop().order.filter((id) => id === MIND_SHIELD).length, 1);
});

test("a league world config also stocks both shields", async () => {
  const applied = applyWorldConfigOverlay({ pluginConfig: { "league:type": 5 } });
  assert.equal(applied.applied, true, applied.error);
  PM.refreshPluginConfig();
  loadShops();
  PM.emitCustomEvent("paescape:world-config", {});
  await Promise.resolve();
  assert.equal(shop().stock.get(ELEMENTAL_SHIELD), 50);
  assert.equal(shop().stock.get(MIND_SHIELD), 50);
});

test("a reload and a plain world keep the generated stock", async () => {
  world("paescape");
  loadShops();
  PM.emitCustomEvent("paescape:world-config", {});
  await Promise.resolve();
  assert.equal(shop().stock.get(ELEMENTAL_SHIELD) ?? 0, 0);
  assert.equal(shop().stock.get(MIND_SHIELD) ?? 0, 0);
});
