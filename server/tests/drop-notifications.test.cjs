// Run after `yarn build`: node --test tests/drop-notifications.test.cjs
// #84: a brimstone key is added to the kill with npc-drops:place, not rolled with the NPC's own
// table, so the loot notifications must hear placed loot too. A drop already announced on
// npc-drops:roll (SeaCombat's full-pack fallback) must not be said twice.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Location } = require("../dist/game/model/Location");
const NpcDrops = require("../plugins/npcs/NpcDrops.plugin");
const Warnings = require("../plugins/interface/ValueWarnings.plugin");

const LOOT_NOTIFICATIONS = 5399;
const LOOT_VALUE = 5400;
const LOOT_UNTRADEABLES = 5402;
const KEY_LINE = "<col=ef1020>Untradeable drop: Brimstone key</col>";

let keyId;
let emit;
const placed = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  keyId = PluginManager.getCoreApi().CacheDefinitions.getObjId("konar_key");
  const listeners = new Map();
  emit = (name, payload) => { for (const handler of listeners.get(name) ?? []) handler(payload); };
  const api = {
    core: PluginManager.getCoreApi(),
    getItemOnGroundManager: () => ({ registerLocation: (_player, item) => placed.push(item.getId()) }),
    onCustomEvent: (name, handler) => listeners.set(name, [...(listeners.get(name) ?? []), handler]),
    emitCustomEvent: emit,
    onNpcDeath: () => {},
    registerCommand: () => {},
    log: () => {},
  };
  NpcDrops.register(api);
  Warnings.register(api);
});

function player() {
  const messages = [];
  const varbits = { [LOOT_NOTIFICATIONS]: 1, [LOOT_VALUE]: 0, [LOOT_UNTRADEABLES]: 1 };
  const sender = {
    getVarbit: (id) => varbits[id] ?? 0,
    sendClientScript: () => sender,
    sendTypedMessage: () => sender,
  };
  return { messages, getPacketSender: () => sender, sendMessage: (text) => messages.push(text) };
}

test("a placed brimstone key is named once as an untradeable drop", () => {
  const who = player();
  placed.length = 0;
  emit("npc-drops:place", {
    player: who,
    drops: [{ itemId: keyId, amount: 1 }],
    location: new Location(3200, 3200, 0),
  });
  assert.deepEqual(placed, [keyId], "the key still lands");
  assert.deepEqual(who.messages, [KEY_LINE]);
});

test("a drop announced on npc-drops:roll is not announced again when placed", async () => {
  const who = player();
  const drops = [{ itemId: keyId, amount: 1 }];
  emit("npc-drops:roll", { player: who, npc: {}, drops });
  emit("npc-drops:place", { player: who, drops, location: new Location(3200, 3200, 0), npcId: 123 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(who.messages, [KEY_LINE]);
});
