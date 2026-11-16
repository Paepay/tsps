// Run after `yarn build`: node --test tests/warriors-guild-cyclops-teleported-in.test.cjs
// A player put in a cyclops room without its door (an admin's teleport) was never added to the room, so no tokens
// drained and no defender dropped. They are now in the room from the first tick it sees them there. Real engine:
// every plugin loaded, a real Player and Inventory, the real player-process hook; only the network is stubbed.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");

let core;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

const ROOM = "warriors-guild:room";

function guildPlayer(t, index, location) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(index); p.setUsername("cyclops" + index); p.setRegistered(true); p.setAttribute("bot-skip-persistence", true);
  // The guild is in Asgarnia: a Level-Up character has to have it unlocked or the area barrier
  // sends the player home the moment they are teleported in.
  p.setAttribute("level-up:regions", ["misthalin", "asgarnia"]);
  p.setAttribute("level-up:claimed-region-milestones", [1]);
  p.messages = [];
  p.sendMessage = (message) => p.messages.push(message);
  p.getInventory().resetItems();
  p.setLocation(location);
  t.after(() => { PM.emitPlayerLogout?.({ player: p }); core.TaskManager.cancelTasks(p); p.setRegistered(false); });
  return p;
}

function process(p, ticks) {
  for (let i = 0; i < ticks; i++) PM.emitPlayerProcess({ player: p });
}

const token = () => core.ItemIdentifiers.WARRIOR_GUILD_TOKEN;

test("a player teleported into Kamfreena's room pays 10 tokens a minute like one who came through the door", (t) => {
  const p = guildPlayer(t, 9040, new core.Location(2860, 3545, 2));
  p.getInventory().adds(token(), 25);
  process(p, 1);
  assert.equal(p.getAttribute(ROOM)?.room, "top", "in the room from the first tick");
  assert.equal(p.getInventory().getAmount(token()), 25, "no entry fee: they never used the door");
  process(p, 99);
  assert.equal(p.getInventory().getAmount(token()), 15, "a minute in, 10 tokens go");
  assert.ok(p.messages.includes("10 of your tokens crumble away."));
});

test("a player teleported into Lorelai's basement pays too, and leaving the room ends it", (t) => {
  const p = guildPlayer(t, 9041, new core.Location(2920, 9960, 0));
  p.getInventory().adds(token(), 40);
  process(p, 100);
  assert.equal(p.getAttribute(ROOM)?.room, "basement");
  assert.equal(p.getInventory().getAmount(token()), 30);
  p.setLocation(new core.Location(2907, 9968, 0)); // Lorelai's lobby
  process(p, 1);
  assert.deepEqual(p.getAttribute(ROOM), {}, "out of the room");
  process(p, 100);
  assert.equal(p.getInventory().getAmount(token()), 30, "nothing more is taken outside");
});

function rollDrops(p, npcId) {
  const random = Math.random;
  Math.random = () => 0; // Guild.random(1, n) is 1: a defender drops
  try {
    const drops = [];
    PM.emitCustomEvent("npc-drops:roll", {
      player: p, npc: { getLocation: () => p.getLocation() }, npcId, drops,
    });
    return drops.map((drop) => drop.itemId);
  } finally {
    Math.random = random;
  }
}

test("a player teleported straight into a cyclops room still gets its defender drop", (t) => {
  const top = guildPlayer(t, 9042, new core.Location(2860, 3545, 2));
  assert.deepEqual(rollDrops(top, core.NpcIdentifiers.CYCLOPS_10), [core.ItemIdentifiers.BRONZE_DEFENDER],
    "the top floor's first defender, without walking through Kamfreena's door");
  assert.equal(top.getAttribute(ROOM)?.room, "top", "the room registers the teleported player");

  const basement = guildPlayer(t, 9043, new core.Location(2920, 9960, 0));
  assert.deepEqual(rollDrops(basement, core.NpcIdentifiers.CYCLOPS_2), [core.ItemIdentifiers.DRAGON_DEFENDER],
    "the basement's dragon defender");
  assert.equal(basement.getAttribute(ROOM)?.room, "basement");
});
