const assert = require("node:assert/strict");
const { test } = require("node:test");
const Retired = require("../plugins/items/RetiredGlobalEventItems.plugin");

function item(id, meta = null) {
  return {
    id,
    meta: meta ? { ...meta } : null,
    getId: () => id,
    getMetaValue(key) { return this.meta?.[key]; },
    setMetaValue(key, value) {
      if (value === undefined) delete this.meta[key];
      else this.meta[key] = value;
      return this;
    },
  };
}

function container(values = []) {
  const items = [...values];
  return {
    items,
    refreshed: 0,
    getItems: () => items,
    deleteItem: (_value, slot) => items.splice(slot, 1),
    refreshItems() { this.refreshed++; return this; },
  };
}

function player(containers) {
  const [inventory, equipment, ...banks] = containers;
  const messages = [];
  return {
    messages,
    getInventory: () => inventory,
    getEquipment: () => equipment,
    getBanks: () => banks,
    sendMessage: (text) => messages.push(text),
  };
}

test("retired event copies and arsenal loans are deleted", () => {
  const retired = item(50006, { "global-event": { kind: "bankers-note" } });
  const loan = item(22325, { "global-event": { kind: "arsenal" } });
  const inventory = container([retired]);
  const equipment = container([loan]);
  const p = player([inventory, equipment]);

  assert.deepEqual(Retired.cleanup(p), { removed: 2, restored: 0 });
  assert.equal(inventory.getItems().length, 0);
  assert.equal(equipment.getItems().length, 0);
  assert.equal(inventory.refreshed, 1);
  assert.equal(equipment.refreshed, 1);
  assert.deepEqual(p.messages, ["Your temporary global-event items have been removed."]);
});

test("a real league relic with stale event metadata is kept as the plain item", () => {
  const note = item(28767, { "global-event": { kind: "bankers-note" } });
  const greaves = item(50001, { "global-event": { kind: "sages-greaves" } });
  const bank = container([note, greaves]);
  const p = player([container(), container(), bank]);

  assert.deepEqual(Retired.cleanup(p), { removed: 0, restored: 2 });
  assert.equal(bank.getItems().length, 2);
  assert.equal(note.getMetaValue(Retired.BINDING_META), undefined);
  assert.equal(greaves.getMetaValue(Retired.BINDING_META), undefined);
  assert.deepEqual(p.messages, []);
});

test("ordinary item metadata is never touched", () => {
  const charged = item(12926, { "triton-charges": 10 });
  const inventory = container([charged]);
  const p = player([inventory, container()]);

  assert.deepEqual(Retired.cleanup(p), { removed: 0, restored: 0 });
  assert.equal(charged.getMetaValue("triton-charges"), 10);
});
