// Run after `yarn build`: node --test tests/death-on-the-isle-fountain.test.cjs
//
// #86: the south-western Aldarin fountain is a placed multiloc (54740) that becomes the searchable
// 54739 only once Death on the Isle's fancy chest is opened (varbit 11232 = 1). The packet listener
// resolves the placed loc per player and routes to it, so these are the real plugin, Player, cache
// definitions and ObjectActionPacketListener, not the mock quest harness.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ObjectActionPacketListener } = require("../dist/net/packet/impl/ObjectActionPacketListener");
const { ObjectDefinition } = require("../dist/game/definition/ObjectDefinition");
const QuestRuntime = require("../plugins/quests/QuestRuntime");

const FOUNTAIN_PLACED = 54740;
const FOUNTAIN_PLAIN = 54738;
const FOUNTAIN_SEARCH = 54739;
const FANCY_CHEST = 54736;
const ICON = 29897;
const CHEST_KEY = 29923;
const VARBIT_ATES_PIECE_HUNT = 11232;
const FOUNTAIN_TILE = [1436, 2920];
const CHEST_TILE = [1436, 9312];
const STREET_TILE = [1445, 2932];
let core;
let index = 8800;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  core.RegionManager.init();
  for (const [x, y] of [FOUNTAIN_TILE, CHEST_TILE, STREET_TILE, [1435, 9312], [1447, 2938], [1447, 9333]]) {
    core.RegionManager.loadMapFiles(x, y);
  }
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

function player(t, name) {
  const channel = {
    kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {},
  };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(index++);
  p.setUsername(name);
  p.setRegistered(true);
  p.needsPlacement = false;
  QuestRuntime.getRegisteredQuests().find((entry) => entry.key === "death_on_the_isle").setStage(p, 50);
  t.after(() => {
    PM.emitPlayerLogout({ player: p, username: p.getUsername() });
    p.setRegistered(false);
  });
  return p;
}

function place(p, [x, y]) {
  p.setLocation(new core.Location(x, y, 0));
  p.needsPlacement = false;
}

function run(p, times) {
  for (let tick = 0; tick < times; tick++) {
    core.TaskManager.process();
    p.process();
  }
}

function click(p, id, [x, y], clickType = 1) {
  new ObjectActionPacketListener().executeAction(p, id, x, y, clickType);
}

test("the placed fountain resolves to Search only once the fancy chest is opened", (t) => {
  const p = player(t, "atesfountaingate1");
  place(p, STREET_TILE);
  assert.equal(ObjectDefinition.forPlayer(FOUNTAIN_PLACED, p)?.id, FOUNTAIN_PLAIN,
    "before the chest the fountain has no Search option");

  p.setAttribute("quest.death_on_the_isle.chest.opened", true);
  p.getPacketSender().sendVarbit(VARBIT_ATES_PIECE_HUNT, 1);
  const searchable = ObjectDefinition.forPlayer(FOUNTAIN_PLACED, p);
  assert.equal(searchable?.id, FOUNTAIN_SEARCH, "the chest's varbit swaps in the searchable fountain");
  assert.ok(searchable?.getInteractions?.().includes("Search"));
});

test("a quest-complete player routes to the south-western fountain and gets the Aldarin icon", (t) => {
  const p = player(t, "atesfountain1");
  p.setAttribute("quest.death_on_the_isle.chest.opened", true);
  p.getPacketSender().sendVarbit(VARBIT_ATES_PIECE_HUNT, 1);
  place(p, STREET_TILE);
  click(p, FOUNTAIN_PLACED, FOUNTAIN_TILE);

  let iconAt = -1;
  for (let tick = 0; tick < 120; tick++) {
    core.TaskManager.process();
    p.process();
    if (p.getInventory().getAmount(ICON) > 0) { iconAt = tick; break; }
  }
  assert.ok(iconAt >= 0, "the click walked to the fountain and searched it");
  assert.equal(p.getInventory().getAmount(ICON), 1);
  assert.equal(p.getPacketSender().getVarbit(VARBIT_ATES_PIECE_HUNT), 2);
  assert.equal(p.getAttribute("quest.death_on_the_isle.icon.found"), true);
});

test("the fountain yields no icon before the fancy chest is opened", (t) => {
  const p = player(t, "atesfountain2");
  place(p, STREET_TILE);
  click(p, FOUNTAIN_PLACED, FOUNTAIN_TILE);
  run(p, 40);
  assert.equal(p.getInventory().getAmount(ICON), 0);
  assert.equal(p.getPacketSender().getVarbit(VARBIT_ATES_PIECE_HUNT), 0);
});

test("the fancy chest needs the pickpocket key and opening it makes the fountain searchable", (t) => {
  const noKey = player(t, "ateschest1");
  place(noKey, [1435, 9312]);
  click(noKey, FANCY_CHEST, CHEST_TILE);
  run(noKey, 4);
  assert.equal(noKey.getAttribute("quest.death_on_the_isle.chest.opened"), undefined, "no key, no open");
  assert.equal(noKey.getPacketSender().getVarbit(VARBIT_ATES_PIECE_HUNT), 0);

  const withKey = player(t, "ateschest2");
  place(withKey, [1435, 9312]);
  withKey.getInventory().adds(CHEST_KEY, 1);
  click(withKey, FANCY_CHEST, CHEST_TILE);
  run(withKey, 4);
  assert.equal(withKey.getAttribute("quest.death_on_the_isle.chest.opened"), true);
  assert.equal(withKey.getInventory().getAmount(CHEST_KEY), 0, "opening consumes the key");
  assert.equal(withKey.getPacketSender().getVarbit(VARBIT_ATES_PIECE_HUNT), 1);
});
