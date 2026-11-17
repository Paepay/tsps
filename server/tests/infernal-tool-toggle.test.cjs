// Run after `yarn build`: node --test tests/infernal-tool-toggle.test.cjs
// Wiki (14 October 2026): Infernal tools Toggle turns off auto-burn / smelt / cook. Ornamented
// copies keep Toggle under Options; plain ones expose it directly.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const InfernalAxe = require("../plugins/skills/woodcutting/InfernalAxe.Woodcutting");
const InfernalPickaxe = require("../plugins/skills/mining/InfernalPickaxe.Mining");
const InfernalHarpoon = require("../plugins/skills/fishing/InfernalHarpoon.Fishing");
const InfernalToolEffect = require("../plugins/skills/InfernalToolEffect");

let core;
const actions = new Map();
const attributes = new Map();
const messages = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  const api = {
    core,
    persistAttribute() {},
    emitCustomEvent: (_name, request) => {
      if (request && "xp" in request) request.xp = 100;
    },
    onItemAction: (name, handlers) => actions.set(name, handlers),
    onItemOnItem() {},
  };
  InfernalAxe.attach(api);
  InfernalPickaxe.attach(api);
  InfernalHarpoon.attach(api);
});

function player() {
  messages.length = 0;
  attributes.clear();
  const axe = {
    id: core.ItemIdentifiers.INFERNAL_AXE,
    meta: {},
    getId() { return this.id; },
    getMetaValue(key) { return this.meta[key]; },
    setMetaValue(key, value) { this.meta[key] = value; },
  };
  return {
    axe,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    sendMessage: (text) => messages.push(text),
    getEquipment: () => ({ getItems: () => Object.assign(new Array(14).fill(null), { [core.Equipment.WEAPON_SLOT]: axe }) }),
    getInventory: () => ({ getItems: () => [], refreshItems() {} }),
    getSkillManager: () => ({ addExperiences() {} }),
    performGraphic() {},
    getPacketSender: () => ({ sendSoundEffect() {} }),
  };
}

test("Infernal axe Toggle turns burn off and on again", () => {
  const p = player();
  const random = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(InfernalAxe.tryBurnLog(p, p.axe.id, 1511), true, "burn is on by default");
    assert.equal(actions.get("Infernal axe").Toggle({ player: p }), true);
    assert.match(messages.at(-1), /leave the logs/);
    assert.equal(InfernalAxe.tryBurnLog(p, p.axe.id, 1511), false, "Toggle off skips the burn");
    actions.get("Infernal axe").Toggle({ player: p });
    assert.match(messages.at(-1), /burn the logs/);
    assert.equal(InfernalAxe.tryBurnLog(p, p.axe.id, 1511), true);
  } finally {
    Math.random = random;
  }
});

test("ornamented Infernal axe (or) Toggle is under Options", () => {
  const p = player();
  const handlers = actions.get("Infernal axe (or)");
  assert.equal(handlers.Options({ player: p, subOption: "Change-Style" }), false, "Change-Style is left alone");
  assert.equal(handlers.Options({ player: p, subOption: "Toggle" }), true);
  assert.equal(InfernalToolEffect.enabled(p, "axe"), false);
});

test("Infernal pickaxe and harpoon register Toggle and default to on", () => {
  assert.ok(actions.get("Infernal pickaxe").Toggle);
  assert.ok(actions.get("Infernal harpoon").Toggle);
  assert.ok(actions.get("Infernal pickaxe (or)").Options);
  assert.ok(actions.get("Infernal harpoon (or)").Options);
  const p = player();
  assert.equal(InfernalToolEffect.enabled(p, "pickaxe"), true);
  assert.equal(InfernalToolEffect.enabled(p, "harpoon"), true);
});
