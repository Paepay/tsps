// Run after `yarn build`: node --test tests/item-alch-values.test.cjs
//
// Issue #212: alchemy values. data/definitions/item-alch.json comes from
// osrsreboxed-db (the cache-derived dump the item definitions load over the old
// item-gameplay export). Live high/low alchemy is 60%/40% of the item's store
// value, floored; an item the dump marks unalchable is 0/0 even when it has a
// store value. Check every imported row against the cache, so a bad import or a
// cache revision that moves a store value fails the test instead of the game.
const assert = require("node:assert/strict");
const { before, test } = require("node:test");
const path = require("node:path");

require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { ItemDefinition } = require("../dist/game/definition/ItemDefinition");
const ItemDefinitionLoader = require("../plugins/items/ItemDefinitionLoader.plugin");
const ALCH = require("../data/definitions/item-alch.json");

const IRON_LONGSWORD = 1293;
const IRON_LONGSWORD_NOTE = 1294;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  ItemDefinitionLoader._test.loadItemAlch();
});

test("the alch table is the current dump, not an empty or truncated file", () => {
  assert.ok(Object.keys(ALCH).length > 16_000, `only ${Object.keys(ALCH).length} entries`);
});

test("every alch row matches the cache's store value: high 60% and low 40%, floored", () => {
  let checked = 0;
  const mismatches = [];
  for (const [key, values] of Object.entries(ALCH)) {
    const id = Number(key);
    const definition = ItemDefinition.forId(id);
    if (!Number.isInteger(id) || definition === ItemDefinition.DEFAULT) continue;
    const high = Number(values?.highalch);
    const low = Number(values?.lowalch);
    const store = Number(definition.getValue());
    if (!Number.isFinite(high) || !Number.isFinite(low)) {
      if (Math.floor(store * 0.6) > 0) mismatches.push({ id, name: definition.getName(), reason: "missing" });
      continue;
    }
    checked += 1;
    if (high === 0) {
      if (low !== 0) mismatches.push({ id, name: definition.getName(), reason: "unalchable low", got: [high, low] });
      continue;
    }
    const wantHigh = Math.floor(store * 0.6);
    const wantLow = Math.floor(store * 0.4);
    if (high !== wantHigh || low !== wantLow) {
      mismatches.push({ id, name: definition.getName(), store, got: [high, low], want: [wantHigh, wantLow] });
    }
  }
  assert.ok(checked > 14_000, `only ${checked} rows had alchemy values`);
  assert.deepEqual(mismatches, []);
});

test("the iron longsword and its note alch for the cache's 140 store value", () => {
  const sword = ItemDefinition.forId(IRON_LONGSWORD);
  const note = ItemDefinition.forId(IRON_LONGSWORD_NOTE);
  assert.equal(sword.getValue(), 140);
  assert.equal(sword.getHighAlchValue(), 84);
  assert.equal(sword.getLowAlchValue(), 56);
  assert.equal(note.getHighAlchValue(), 84);
  assert.equal(note.getLowAlchValue(), 56);
});
