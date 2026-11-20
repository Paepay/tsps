// node --test tests/barlak-bones.test.cjs
// Barlak buys every long and curved bone from the inventory and the bank:
// long 1,000 gp / 4,500 Construction XP, curved 2,000 gp / 6,750 XP, level 30 and a house for the XP.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const LONG = 10976;
const CURVED = 10977;
const COINS = 995;
const CONSTRUCTION = 22;

function container(entries) {
  const items = new Map(entries);
  return {
    items,
    getAmount: (id) => items.get(id) ?? 0,
    deleteNumber: (id, amount) => items.set(id, (items.get(id) ?? 0) - amount),
    addItem: (item) => items.set(item.getId(), (items.get(item.getId()) ?? 0) + item.getAmount()),
    getAddableAmount: (item) => item.getId() === COINS ? item.getAmount() : 0,
    refreshItems() {},
  };
}

function setup({ inventory: inventoryEntries = [], bank = [], level = 30, owns = true } = {}) {
  let registration = null;
  const inventory = container(inventoryEntries);
  const tabs = [container(bank), container([]), container([])];
  let experience = 0;
  const messages = [];
  const player = {
    getInventory: () => inventory,
    getBanks: () => tabs,
    getBank: (index) => tabs[index],
    getCurrentBankTab: () => 0,
    getSkillManager: () => ({
      getCurrentLevel: (skill) => skill === CONSTRUCTION ? level : 1,
      addExperiences: (skill, amount) => { assert.equal(skill, CONSTRUCTION); experience += amount; },
    }),
    sendMessage: (message) => messages.push(message),
  };
  const api = {
    core: {
      ItemIdentifiers: { LONG_BONE: LONG, LONG_BONE_2: 18419, CURVED_BONE: CURVED, CURVED_BONE_2: 18420, COINS },
      Bank: { BANK_SEARCH_TAB_INDEX: 9, isOpen: () => false },
      Skill: { CONSTRUCTION },
      Item: class { constructor(id, amount) { this.id = id; this.amount = amount; } getId() { return this.id; } getAmount() { return this.amount; } },
    },
    emitCustomEvent: (name, request) => { if (name === "construction:owns-house") request.owns = owns; },
    onNpcDialogueVariant: (handler) => { registration = { ...registration, variant: handler }; },
    onCustomEvent: (name, handler) => { registration = { ...registration, [name]: handler }; },
  };
  require("../plugins/npcs/Barlak.plugin").register(api);
  return { plugin: require("../plugins/npcs/Barlak.plugin"), api, player, inventory, tabs, messages, registration,
    experience: () => experience };
}

test("the offer counts bones in the inventory and every bank tab", () => {
  const { plugin, player, registration } = setup({ inventory: [[LONG, 1]], bank: [[LONG, 2], [CURVED, 1]] });
  assert.deepEqual(plugin._test.boneCounts(player).map((bone) => bone.amount), [3, 1]);
  assert.equal(plugin._test.totalCoins(plugin._test.boneCounts(player)), 5000);
  assert.equal(registration.variant({ player, npcId: 2344 }), plugin._test.BONE_VARIANT);
  assert.equal(registration.variant({ player, npcId: 1 }), null);
});

test("the dialogue offer fills [X] with the whole payout", () => {
  const { registration, player } = setup({ inventory: [[LONG, 1]], bank: [[CURVED, 2]] });
  const line = { npcId: 2344, player, text: "I'll give you [X] gp for the bones you're carrying and for any you have in your bank." };
  registration["npc-dialogue:line"](line);
  assert.match(line.text, /5,000 gp/);
  assert.equal(line.text.includes("[X]"), false);
});

test("the lecture takes every bone from the inventory and bank and pays coins and experience", () => {
  const { plugin, player, inventory, tabs, messages, registration, experience } = setup({
    inventory: [[LONG, 1], [CURVED, 1]], bank: [[LONG, 2], [CURVED, 1]],
  });
  registration["npc-dialogue:action"]({ npcId: 2344, stepId: plugin._test.LECTURE_STEP_ID, player });
  assert.equal(inventory.getAmount(LONG), 0);
  assert.equal(inventory.getAmount(CURVED), 0);
  assert.equal(tabs[0].getAmount(LONG), 0);
  assert.equal(tabs[0].getAmount(CURVED), 0);
  assert.equal(inventory.getAmount(COINS), 7000, "3 long bones at 1,000 and 2 curved at 2,000");
  assert.equal(experience(), 3 * 4500 + 2 * 6750);
  assert.match(messages.at(-1), /7,000 coins/);
});

test("without level 30 or a house Barlak still buys the bones but teaches nothing", () => {
  for (const options of [{ level: 29, owns: true }, { level: 99, owns: false }]) {
    const { plugin, player, registration, experience } = setup({ inventory: [[LONG, 1]], ...options });
    registration["npc-dialogue:action"]({ npcId: 2344, stepId: plugin._test.LECTURE_STEP_ID, player });
    assert.equal(experience(), 0);
    assert.equal(player.getInventory().getAmount(COINS), 1000);
  }
});

test("a full inventory refuses before taking any bones", () => {
  const { plugin, player, inventory, registration, experience, messages } = setup({ inventory: [[LONG, 1]] });
  inventory.getAddableAmount = () => 0;
  registration["npc-dialogue:action"]({ npcId: 2344, stepId: plugin._test.LECTURE_STEP_ID, player });
  assert.equal(inventory.getAmount(LONG), 1);
  assert.equal(experience(), 0);
  assert.match(messages.at(-1) ?? "", /free inventory slot/);
});
