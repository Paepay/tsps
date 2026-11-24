// Run after `yarn build`: node --test tests/crystal-weapon-revert.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
CachePipeline.initialize();

const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { ItemIdentifiers } = require("../dist/util/ItemIdentifiers");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");

const Plugin = require("../plugins/items/CrystalWeaponRevert.plugin");

Plugin.register({
  core: {
    Equipment,
    ItemIdentifiers,
    CacheDefinitions,
    BonusManager: { update() {} },
    Flag: { APPEARANCE: 1 },
    WeaponInterfaceManager: { assign() {} },
    EquipPacketListener: { unequip: () => false },
  },
  onItemAction() {},
  log() {},
});

function item(id, meta = {}) {
  return {
    id,
    meta: { ...meta },
    getId() { return this.id; },
    getMetaValue(key) { return this.meta[key]; },
    setMetaValue(key, next) {
      if (next === undefined) delete this.meta[key];
      else this.meta[key] = next;
    },
  };
}

function inventory(items = []) {
  return {
    items,
    deleted: [],
    addsCalls: [],
    adds(id, amount) { this.addsCalls.push([id, amount]); },
    deleteItem(value) { this.deleted.push(value); },
    getItems() { return this.items; },
    refreshItems() {},
  };
}

function player(inv) {
  return {
    messages: [],
    getInventory: () => inv,
    getEquipment: () => ({ refreshItems() {} }),
    getUpdateFlag: () => ({ flag() {} }),
    sendMessage(text) { this.messages.push(text); },
  };
}

const seed = ItemIdentifiers.CRYSTAL_WEAPON_SEED;
const cases = [
  ["Crystal bow", ItemIdentifiers.CRYSTAL_BOW, "crystal-bow:shots-in-stage", "crystal bow"],
  ["Crystal bow (inactive)", ItemIdentifiers.CRYSTAL_BOW_INACTIVE_, "crystal-bow:shots-in-stage", "crystal bow"],
  ["Crystal shield", ItemIdentifiers.CRYSTAL_SHIELD, null, "crystal shield"],
  ["Crystal shield (inactive)", ItemIdentifiers.CRYSTAL_SHIELD_INACTIVE_, null, "crystal shield"],
  ["Crystal halberd", ItemIdentifiers.CRYSTAL_HALBERD, "crystal-halberd", "crystal halberd"],
  ["Crystal halberd (inactive)", ItemIdentifiers.CRYSTAL_HALBERD_INACTIVE_, "crystal-halberd", "crystal halberd"],
];

for (const [name, id, metaKey, label] of cases) {
  test(`${name} reverts to one crystal weapon seed and forfeits its charges`, () => {
    assert.equal(CacheDefinitions.getItem(id).name, name);
    const weapon = item(id, metaKey ? { [metaKey]: 17 } : {});
    const inv = inventory([weapon]);
    const who = player(inv);
    Plugin._test.revert({ player: who, item: weapon, itemId: id, slot: 0, interfaceId: 3214 });
    assert.deepEqual(inv.deleted, [weapon]);
    assert.deepEqual(inv.addsCalls, [[seed, 1]]);
    if (metaKey) assert.equal(weapon.meta[metaKey], undefined);
    assert.deepEqual(who.messages, [`You revert the ${label} to a crystal weapon seed.`]);
  });
}

test("an item without the Revert option is left alone", () => {
  const inv = inventory([]);
  const who = player(inv);
  Plugin._test.revert({ player: who, item: item(ItemIdentifiers.DRAGON_LONGSWORD), itemId: ItemIdentifiers.DRAGON_LONGSWORD, slot: 0, interfaceId: 3214 });
  assert.deepEqual(inv.addsCalls, []);
  assert.deepEqual(who.messages, []);
});
