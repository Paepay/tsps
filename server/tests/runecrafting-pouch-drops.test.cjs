// Run after `yarn build`: node --test tests/runecrafting-pouch-drops.test.cjs
// Abyssal creatures roll each essence pouch as its own row, so a kill could drop a giant pouch
// before a small one and repeat tiers. Wiki (Small/Medium/Giant pouch): a pouch drops only while
// the player does not own it, and the lower tiers are earned first.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");

require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { PluginManager } = require("../dist/plugins/PluginManager");
const Pouches = require("../plugins/skills/runecrafting/Pouches.Runecrafting");

let filter;
const id = (name) => CacheDefinitions.getObjId(name);
const SMALL = () => id("rcu_pouch_small");
const MEDIUM = () => id("rcu_pouch_medium");
const LARGE = () => id("rcu_pouch_large");
const GIANT = () => id("rcu_pouch_giant");
const DEGRADED_GIANT = () => id("rcu_pouch_giant_degrade");

const container = (ids = []) => ({ getAmount: (item) => (ids.includes(item) ? 1 : 0) });
const player = ({ inventory = [], banks = [] } = {}) => ({
  getInventory: () => container(inventory),
  getBanks: () => banks.map((tab) => container(tab)),
});
const drop = (itemId) => ({ itemId, amount: 1 });
const rolled = (...ids) => ids.map(drop);

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  Pouches.attach(PluginManager.createApi("PouchDropTest"));
  filter = Pouches._test.filterPouchDrops;
});

test("without a pouch the kill may only drop the small pouch", () => {
  const drops = rolled(GIANT(), SMALL(), LARGE(), MEDIUM(), SMALL());
  filter({ player: player(), drops });
  assert.deepEqual(drops, [drop(SMALL())]);
});

test("owning the small pouch moves eligibility to the medium pouch", () => {
  const drops = rolled(GIANT(), SMALL(), MEDIUM(), MEDIUM());
  filter({ player: player({ inventory: [SMALL()] }), drops });
  assert.deepEqual(drops, [drop(MEDIUM())]);
});

test("a degraded or banked pouch counts as owned and is not replaced", () => {
  const inBank = player({ inventory: [SMALL(), MEDIUM(), LARGE()], banks: [[DEGRADED_GIANT()]] });
  const drops = rolled(GIANT(), LARGE());
  filter({ player: inBank, drops });
  assert.deepEqual(drops, []);

  const degradedMedium = player({ inventory: [SMALL(), id("rcu_pouch_medium_degrade")] });
  const next = rolled(MEDIUM(), LARGE());
  filter({ player: degradedMedium, drops: next });
  assert.deepEqual(next, [drop(LARGE())]);
});

test("a lower tier in the bank still blocks higher tiers from dropping", () => {
  const drops = rolled(GIANT(), LARGE(), MEDIUM());
  filter({ player: player({ banks: [[], [SMALL()]] }), drops });
  assert.deepEqual(drops, [drop(MEDIUM())]);
});

test("a fully owned set drops no pouch, and other loot is untouched", () => {
  const drops = [
    { itemId: id("blankrune_high"), amount: 12 },
    drop(SMALL()),
    drop(GIANT()),
    { itemId: id("coins"), amount: 500 },
  ];
  filter({ player: player({ inventory: [SMALL(), MEDIUM(), LARGE(), GIANT()] }), drops });
  assert.deepEqual(drops, [
    { itemId: id("blankrune_high"), amount: 12 },
    { itemId: id("coins"), amount: 500 },
  ]);
});

test("a malformed event is left alone", () => {
  assert.doesNotThrow(() => filter({ player: null, drops: rolled(SMALL()) }));
  assert.doesNotThrow(() => filter({ player: player(), drops: null }));
});
