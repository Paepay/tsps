// Run after `yarn build`: node --test tests/fractured-archive-supplies.test.cjs
//
// Issue #178: the Quartermaster's Alliance Supplies. The real Omnishop, the cache's shop rows and
// real widget packets: the normal row order (the free note is row 0, the first item row 1), a
// purchase in Supply Credits, a refusal without them, and the failure row that adds Leftovers.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
process.env.DISABLE_PLAYER_BOTS = "1";
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");

const SHOP = "tfa_midraid_supplies_shop";
const SHOP_FAILURE = "tfa_midraid_supplies_shop_failure";
const CREDITS = "fractured-archive:supply-credits";
/** The cache's stock order: the note is 0, the brew 1 in the normal shop and 2 in the failure one. */
const NOTE = 0;
const BREW = 6685;
const RESTORE = 3024;
const PRAYER4 = 2434;
const MANTA = 391;
const HALIBUT = 32336;
const KRILL = 32312;
const PRAYER2 = 141;
const RANGING2 = 171;
const COMBAT2 = 12699;
const LOG = 34729;
const LEFTOVERS = 34730;

let core;
let Raid;
let next = 9100;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(4127, 5530);
  PM.emitServerStartup({});
  Raid = require("../plugins/minigames/tfa/RaidState.FracturedArchive");
});
after(() => PM.emitServerShutdown({}));

function stockIndex(itemId, shop = SHOP) {
  const row = core.CacheDefinitions.getDbRow(core.CacheDefinitions.getDbRowId(shop));
  const ids = row.column(core.CacheDefinitions.getDbColumn(row.tableId, "omnishop_shop_stock")).map(Number);
  for (let index = 0; index < ids.length; index++) {
    const entry = core.CacheDefinitions.getDbRow(ids[index]);
    const obj = entry.column(core.CacheDefinitions.getDbColumn(entry.tableId, "omnishop_stock_obj")).map(Number);
    if (obj[0] === itemId) return index;
  }
  return -1;
}

function harness(t, { credits = 0, deathCount = 0 } = {}) {
  const raid = { id: 8000 + next, deathCount, rooms: new Map() };
  return { ...session(t, raid, { credits }), raid };
}

/** Another party member in the same raid, with their own packets and shop. */
function partyMember(t, raid, { credits = 0 } = {}) {
  return session(t, raid, { credits });
}

function session(t, raid, { credits = 0 } = {}) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername("supplies" + player.getIndex());
  player.setRegistered(true);
  player.setAttribute("bot-skip-persistence", true);
  player.setLocation(new core.Location(4127, 5530, 0));
  player.needsPlacement = false;
  const messages = [];
  const sendMessage = player.sendMessage.bind(player);
  player.sendMessage = (message) => { messages.push(String(message)); return sendMessage(message); };
  const connection = new ClientConnection(channel);
  connection.player = player;
  if (!Raid.raids.has(raid.id)) {
    raid.rooms ??= new Map();
    Raid.raids.set(raid.id, raid);
  }
  raid.players ??= [];
  if (!raid.players.includes(player)) raid.players.push(player);
  player.setAttribute(Raid.ATTR_RAID, raid);
  if (credits > 0) player.setAttribute(CREDITS, credits);
  const npc = core.NPC.create(core.NpcIdentifiers.QUARTERMASTER_2, new core.Location(4127, 5530, 0));
  function resupply() {
    return PM.emitNpcInteraction({
      player,
      npc,
      definition: npc.getCurrentDefinition(player),
      npcId: npc.getId(),
      option: "Resupply",
      clickType: 1,
      handled: false,
    });
  }
  const inventories = [];
  const sender = player.getPacketSender();
  const sendInventory = sender.sendInventory.bind(sender);
  sender.sendInventory = (inventoryId, capacity, items, ownerGroupId) => {
    inventories.push({ inventoryId, capacity, items });
    return sendInventory(inventoryId, capacity, items, ownerGroupId);
  };
  async function click(entry, op = 2) {
    const uid = core.CacheDefinitions.getComponentId("omnishop_main:list");
    await connection.dispatch([{
      type: "widget_action", widgetId: uid, groupId: uid >>> 16, childId: uid & 65535, slot: entry * 12, buttonNum: op,
    }]);
    connection.processTurnPackets();
  }
  function lastStock() {
    const inventoryId = core.CacheDefinitions.getInventoryId("tfa_midraid_supplies_shop");
    const packet = [...inventories].reverse().find((entry) => entry.inventoryId === inventoryId);
    return packet ? {
      packet,
      amount: (itemId) => packet.items.find((item) => item?.id === itemId)?.amount,
    } : null;
  }
  t.after(() => {
    raid.players = raid.players.filter((other) => other !== player);
    Raid.raids.delete(raid.id);
    player.setAttribute(Raid.ATTR_RAID, null);
    PM.emitPlayerLogout({ player, username: player.getUsername() });
    player.setRegistered(false);
    core.TaskManager.cancelTasks(player.getIndex());
  });
  return { player, messages, resupply, click, inventories, lastStock, amount: (id) => player.getInventory().getAmount(id) };
}

test("the normal shop's note is view-only and the brew below it buys for 3 credits", async (t) => {
  const f = harness(t, { credits: 30 });
  assert.equal(f.resupply(), true);
  assert.equal(f.player.getInterfaceId(), core.CacheDefinitions.getInterfaceId("omnishop_main"));
  assert.equal(f.player.getAttribute("omnishop:shop"), core.CacheDefinitions.getDbRowId(SHOP));
  const row = stockIndex(BREW);
  assert.equal(row, 1, "the note is row 0 in the normal shop");

  await f.click(NOTE);
  assert.equal(f.player.getAttribute(CREDITS), 30, "the note costs nothing and gives nothing");

  await f.click(row);
  assert.equal(f.player.getAttribute(CREDITS), 27);
  assert.equal(f.amount(BREW), 1);
});

test("the shop sends the Wiki's starting stock, shared by the raid and lowered as it buys", async (t) => {
  const f = harness(t, { credits: 30 });
  assert.equal(f.resupply(), true);
  const start = f.lastStock();
  assert.ok(start, "the resupply sends the omnishop shop inventory 1030");
  for (const [itemId, count] of [
    [BREW, 6], [RESTORE, 4], [PRAYER4, 4], [MANTA, 10], [HALIBUT, 5],
    [KRILL, 10], [PRAYER2, 1], [RANGING2, 1], [COMBAT2, 1], [LOG, 1],
  ]) {
    assert.equal(start.amount(itemId), count, `item ${itemId} starts at ${count}`);
  }

  await f.click(stockIndex(BREW));
  assert.equal(f.raid.supplies.get(BREW), 5);
  assert.equal(f.lastStock().amount(BREW), 5, "the buyer's shop shows the lower stock");

  const partner = partyMember(t, f.raid, { credits: 30 });
  assert.equal(partner.resupply(), true);
  assert.equal(partner.lastStock().amount(BREW), 5, "a party member sees the same stock");
  await partner.click(stockIndex(BREW));
  assert.equal(f.lastStock().amount(BREW), 4, "the first member's open shop follows the partner's buy");
  assert.equal(partner.amount(BREW), 1);
});

test("a sold-out row refuses the next unit and costs nothing", async (t) => {
  const f = harness(t, { credits: 30 });
  assert.equal(f.resupply(), true);
  for (let unit = 0; unit < 6; unit++) await f.click(stockIndex(BREW));
  assert.equal(f.amount(BREW), 6);
  assert.equal(f.player.getAttribute(CREDITS), 12);
  await f.click(stockIndex(BREW));
  assert.equal(f.amount(BREW), 6);
  assert.equal(f.player.getAttribute(CREDITS), 12);
  assert.ok(f.messages.includes("There is none of that item left in stock."), f.messages.join(" | "));
});

test("without credits the shop refuses and takes nothing", async (t) => {
  const f = harness(t, { credits: 0 });
  assert.equal(f.resupply(), true);
  await f.click(stockIndex(BREW));
  assert.equal(Number(f.player.getAttribute(CREDITS)) || 0, 0);
  assert.equal(f.amount(BREW), 0);
  assert.ok(f.messages.includes("You don't have enough Supply Credits."), f.messages.join(" | "));
});

test("after a death the failure shop adds free Leftovers", async (t) => {
  const f = harness(t, { credits: 30, deathCount: 1 });
  assert.equal(f.resupply(), true);
  assert.equal(f.player.getAttribute("omnishop:shop"), core.CacheDefinitions.getDbRowId(SHOP_FAILURE));
  const row = stockIndex(LEFTOVERS, SHOP_FAILURE);
  assert.ok(row > 0);
  await f.click(row);
  assert.equal(f.amount(LEFTOVERS), 1);
  assert.equal(f.player.getAttribute(CREDITS), 30, "Leftovers are free");
});
