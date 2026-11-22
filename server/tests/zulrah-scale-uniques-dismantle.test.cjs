// Run after `yarn build`: node --test tests/zulrah-scale-uniques-dismantle.test.cjs
// Wiki: Serpentine visage, Magic fang and Tanzanite fang each prompt "Dismantle <item>"
// and give 20,000 Zulrah's scales on Yes. The real server plugins, a real Player and
// inventory, and the native inventory-action packet are used throughout.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");

const LUMBRIDGE = [3222, 3218];
const ITEMS = [
  ["SERPENTINE_VISAGE", "Serpentine visage"],
  ["MAGIC_FANG", "Magic fang"],
  ["TANZANITE_FANG", "Tanzanite fang"],
];

let core;
let I;
let next = 9860;
let dismantled = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  I = core.ItemIdentifiers;
  PM.emitServerStartup({});
  PM.createApi("ZulrahScaleUniquesTest").onCustomEvent("zulrah:unique-dismantled",
    (event) => dismantled.push(event.itemId));
});
after(() => PM.emitServerShutdown({}));

function actor(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername("zulrahuniques" + player.getIndex());
  player.setRegistered(true);
  player.setAttribute("bot-skip-persistence", true);
  player.setLocation(new core.Location(...LUMBRIDGE, 0));
  player.needsPlacement = false;
  const messages = [];
  t.mock.method(player.getPacketSender(), "sendMessage", (message) => {
    messages.push(message);
    return player.getPacketSender();
  });
  const connection = new ClientConnection(channel);
  connection.player = player;
  t.after(() => { player.setRegistered(false); core.TaskManager.cancelTasks(player); });
  dismantled = [];
  return { player, connection, inventory: player.getInventory(), messages };
}

async function send(frame, packet) {
  await frame.connection.dispatch([packet]);
  frame.connection.processTurnPackets();
}

function dismantle(frame, slot, itemId) {
  return send(frame, {
    type: "inventory_action", slot, itemId,
    widgetId: core.Inventory.INTERFACE_ID, option: "Dismantle",
  });
}

function pending(player) {
  return core.MultiChatboxPrompt.getPending(player);
}

function answer(player, option) {
  return core.MultiChatboxPrompt.handleInterfaceActionClick({
    player, buttonId: core.MultiChatboxPrompt.OPTIONS_WIDGET_ID, groupId: 219,
    slot: option, action: option,
  });
}

test("each item has the cache Dismantle option and prompts before consuming anything", async (t) => {
  for (const [key, name] of ITEMS) {
    const f = actor(t);
    const itemId = I[key];
    assert.ok(core.CacheDefinitions.getItem(itemId).inventoryActions.includes("Dismantle"),
      `${name} has a cache Dismantle option`);
    f.inventory.setItem(3, new core.Item(itemId, 1));
    await dismantle(f, 3, itemId);
    assert.deepEqual(pending(f.player), { title: `Dismantle ${name}`, options: ["Yes.", "No."] });
    assert.equal(f.inventory.getAmount(itemId), 1, `${name} is still there before Yes`);
    assert.equal(f.inventory.getAmount(I.ZULRAHS_SCALES), 0);
    assert.deepEqual(dismantled, []);
  }
});

test("No closes the prompt and keeps every item", async (t) => {
  for (const [key] of ITEMS) {
    const f = actor(t);
    const itemId = I[key];
    f.inventory.setItem(0, new core.Item(itemId, 1));
    await dismantle(f, 0, itemId);
    assert.equal(answer(f.player, 2), true);
    assert.equal(f.inventory.getAmount(itemId), 1);
    assert.equal(f.inventory.getAmount(I.ZULRAHS_SCALES), 0);
    assert.deepEqual(dismantled, []);
  }
});

test("Yes consumes each item for 20,000 scales and emits the league deed event", async (t) => {
  for (const [key] of ITEMS) {
    const f = actor(t);
    const itemId = I[key];
    f.inventory.setItem(3, new core.Item(itemId, 1));
    await dismantle(f, 3, itemId);
    assert.equal(answer(f.player, 1), true);
    assert.equal(f.inventory.getAmount(itemId), 0);
    assert.equal(f.inventory.getAmount(I.ZULRAHS_SCALES), 20000);
    assert.deepEqual(dismantled, [itemId]);
  }
});

test("the scales merge into an existing unrestricted stack", async (t) => {
  const f = actor(t);
  f.inventory.setItem(0, new core.Item(I.ZULRAHS_SCALES, 500));
  f.inventory.setItem(1, new core.Item(I.MAGIC_FANG, 1));
  await dismantle(f, 1, I.MAGIC_FANG);
  answer(f.player, 1);
  assert.equal(f.inventory.getAmount(I.ZULRAHS_SCALES), 20500);
  assert.equal(f.inventory.getItems()[1]?.getId() ?? -1, -1, "the fang's slot is freed");
});

test("a full inventory still dismantles because the item's own slot holds the scales", async (t) => {
  const f = actor(t);
  f.inventory.setItem(0, new core.Item(I.SERPENTINE_VISAGE, 1));
  for (let slot = 1; slot < f.inventory.capacity(); slot++) {
    f.inventory.setItem(slot, new core.Item(I.BONES, 1));
  }
  assert.equal(f.inventory.getFreeSlots(), 0);
  await dismantle(f, 0, I.SERPENTINE_VISAGE);
  answer(f.player, 1);
  assert.equal(f.inventory.getAmount(I.SERPENTINE_VISAGE), 0);
  assert.equal(f.inventory.getAmount(I.ZULRAHS_SCALES), 20000);
});

test("preset copies cannot be turned into free scales", async (t) => {
  const f = actor(t);
  const item = new core.Item(I.TANZANITE_FANG, 1);
  item.setMetaValue(core.Item.PRESET_META, true);
  item.setMetaValue(core.Item.UNTRADEABLE_META, true);
  f.inventory.setItem(0, item);
  await dismantle(f, 0, I.TANZANITE_FANG);
  assert.equal(pending(f.player), null);
  assert.equal(f.inventory.getItems()[0], item);
  assert.equal(f.inventory.getAmount(I.ZULRAHS_SCALES), 0);
  assert.deepEqual(f.messages, ["Preset items cannot be used for this."]);
  assert.deepEqual(dismantled, []);
});

test("a stale Yes after the item moved pays nothing", async (t) => {
  const f = actor(t);
  f.inventory.setItem(0, new core.Item(I.SERPENTINE_VISAGE, 1));
  await dismantle(f, 0, I.SERPENTINE_VISAGE);
  f.inventory.deleteAtSlot(0, 1);
  answer(f.player, 1);
  assert.equal(f.inventory.getAmount(I.ZULRAHS_SCALES), 0);
  assert.deepEqual(dismantled, []);
});
