// Run after `yarn build`: node --test tests/custom-item-bank-placeholder.test.cjs
// Custom items have no cache row of their own. With a base item that has a bank placeholder,
// the custom item must inherit it so withdrawing the last of a stack leaves one behind.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

require("../dist/Server").Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { ItemDefinition } = require("../dist/game/definition/ItemDefinition");
const { Bank } = require("../dist/game/model/container/impl/Bank");
const { Item } = require("../dist/game/model/Item");

const BASE = 4587;
const CUSTOM = 59110;

test("a custom item inherits its base item's bank placeholder", async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  const base = CacheDefinitions.getItem(BASE);
  assert.ok(base.placeholder >= 0, "the base item has a cache placeholder");
  assert.equal(base.placeholderTemplate, -1);

  // The shipped custom-items rows spell out placeholder: -1, overriding the base clone.
  CacheDefinitions.registerCustomItems([{ id: CUSTOM, baseItemId: BASE, objType: { name: "Placeholder test item", placeholder: -1 } }]);
  const custom = CacheDefinitions.getItem(CUSTOM);
  assert.equal(custom.placeholder, base.placeholder, "the custom cache row carries the placeholder id");
  assert.equal(custom.placeholderTemplate, -1);
  assert.equal(CacheDefinitions.getCustomItems()[0].objType.placeholder, base.placeholder,
    "the login content data tells the client the same id");

  const definition = ItemDefinition.registerCustom(CUSTOM, BASE, {});
  assert.equal(definition.getPlaceholderId(), base.placeholder);
  assert.equal(Bank.placeholderBankId(CUSTOM), CUSTOM, "the bank keeps the custom id at amount 0");
  assert.equal(Bank.displayItemId(new Item(CUSTOM, 0)), base.placeholder,
    "and the client is shown the base family's faded placeholder");
});

test("an explicit placeholder, or a base without one, is never overwritten", async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  CacheDefinitions.registerCustomItems([
    { id: 59111, baseItemId: BASE, objType: { name: "Explicit placeholder", placeholder: 14760 } },
    { id: 59112, baseItemId: 995, objType: { name: "Coins copy" } },
  ]);
  assert.equal(CacheDefinitions.getItem(59111).placeholder, 14760);
  assert.equal(CacheDefinitions.getItem(59112).placeholder, CacheDefinitions.getItem(995).placeholder);
});
