// Run after `yarn build`: node --test tests/elemental-workshop-i-bookcase.test.cjs
//
// Issue #67: the Seers' Village smithy south-west of the bank holds two bookcases, the quest's
// 26113 and the plain 25927 a few tiles away. Searching either gives the battered book; the same
// plain bookcase elsewhere in the village does not. Real object_option packets through
// ClientConnection and the loaded Elemental Workshop I plugin.
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

const QUEST_BOOKCASE = 26113; // BOOKCASE_99, the smithy's own
const PLAIN_BOOKCASE = 25927;  // BOOKCASE_97, also in the smithy
const PLAIN_ELSEWHERE = [2735, 3505]; // the same id in another Seers' Village building
const MAP_AT = [2711, 3482];

let core;
let next = 9970;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(MAP_AT[0], MAP_AT[1]);
  core.RegionManager.loadMapFiles(PLAIN_ELSEWHERE[0], PLAIN_ELSEWHERE[1]);
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

function actor(t, at) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername("ewbook" + player.getIndex());
  player.setRegistered(true);
  player.setAttribute("bot-skip-persistence", true);
  player.setLocation(new core.Location(at[0], at[1], 0));
  player.needsPlacement = false;
  const connection = new ClientConnection(channel);
  connection.player = player;
  player.getSession().setPlayer(player);
  player.getSession().setTurnPacketProcessor(() => connection.processTurnPackets());
  const messages = [];
  const send = player.sendMessage.bind(player);
  player.sendMessage = (message, ...rest) => { messages.push(String(message)); return send(message, ...rest); };
  core.World.getPlayers().add(player);
  t.after(() => {
    PM.emitPlayerLogout({ player, username: player.getUsername() });
    if (core.World.getPlayers().contains?.(player)) core.World.getPlayers().remove(player);
    player.setRegistered(false);
    core.TaskManager.cancelTasks(player);
    core.TaskManager.cancelTasks(player.getIndex());
  });
  return {
    player,
    messages,
    books: () => player.getInventory().getAmount(core.ItemIdentifiers.BATTERED_BOOK),
    search: async (id, x, y) => {
      await connection.dispatch([{ type: "object_option", id, x, y, clickType: 1 }]);
      for (let i = 0; i < 4; i++) {
        core.World.process();
        connection.processTurnPackets();
      }
    },
  };
}

test("the quest bookcase still gives the battered book", async (t) => {
  const f = actor(t, [2715, 3481]);
  await f.search(QUEST_BOOKCASE, 2716, 3481);
  assert.equal(f.books(), 1);
});

test("the plain bookcase in the same smithy gives the battered book", async (t) => {
  const f = actor(t, [2711, 3481]);
  await f.search(PLAIN_BOOKCASE, 2711, 3482);
  assert.equal(f.books(), 1, "the player collected the book from the smithy's other bookcase");
  await f.search(PLAIN_BOOKCASE, 2711, 3482);
  assert.equal(f.books(), 1, "searching again does not duplicate it");
});

test("the same bookcase id elsewhere in the village does not give the quest book", async (t) => {
  const f = actor(t, [PLAIN_ELSEWHERE[0], PLAIN_ELSEWHERE[1] - 1]);
  await f.search(PLAIN_BOOKCASE, PLAIN_ELSEWHERE[0], PLAIN_ELSEWHERE[1]);
  assert.equal(f.books(), 0);
});
