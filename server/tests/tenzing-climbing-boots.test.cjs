// Run after `yarn build`: node --test tests/tenzing-climbing-boots.test.cjs
//
// Issue #176: Tenzing's climbing-boot purchase. The real NPC Talk-to is used (npc_option and
// native dialogue packets), so the quests' variant selection runs too: Troll Stronghold's page
// while that quest is active, and Tenzing's own page once it is done. The price is 12 coins
// (Wiki: Transcript:Tenzing, revid 15359849). A hand-out that cannot fit must not announce that
// the boots were given.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { after, before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");
const { MultiChatboxPrompt } = require("../dist/game/model/menu/MultiChatboxPrompt");
const QuestRuntime = require("../plugins/quests/QuestRuntime");

const BOOTS_GIVEN = "Tenzing has given you some Climbing boots.";

let core;
let tenzing;
let next = 9820;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(2822, 3556);
  PM.emitServerStartup({});
  tenzing = [...core.World.getNpcs()].find((npc) => npc && npc.getId() === core.NpcIdentifiers.TENZING)
    ?? PM.spawnNpc({ id: core.NpcIdentifiers.TENZING, x: 2820, y: 3556, z: 0, wanderRadius: 0 });
});
after(() => PM.emitServerShutdown({}));

const quest = (key) => QuestRuntime.getRegisteredQuests().filter((entry) => entry.key === key).at(-1);

function harness(t, { coins = 12, trollStrongholdStage = 10, fillInventory = false } = {}) {
  const npc = tenzing;
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername(`tenzing${player.getIndex()}`);
  player.setRegistered(true);
  player.setAttribute("bot-skip-persistence", true);
  const at = npc.getLocation();
  player.setLocation(new core.Location(at.getX(), at.getY() + 1, 0));
  player.needsPlacement = false;
  quest("death_plateau").setStage(player, quest("death_plateau").completionValue);
  if (trollStrongholdStage !== null) quest("troll_stronghold").setStage(player, trollStrongholdStage);
  if (fillInventory) player.getInventory().adds(core.ItemIdentifiers.SHARK, 27);
  if (coins > 0) player.getInventory().adds(core.ItemIdentifiers.COINS, coins);
  const messages = [];
  const sendMessage = player.sendMessage.bind(player);
  player.sendMessage = (message) => { messages.push(String(message)); sendMessage(message); };
  const connection = new ClientConnection(channel);
  connection.player = player;
  const tick = () => {
    core.TaskManager.processWalkTo(player.getIndex());
    player.getMovementQueue().process();
    core.TaskManager.process();
    connection.processTurnPackets();
  };
  const send = async (packet) => { await connection.dispatch([packet]); for (let i = 0; i < 3; i++) tick(); };
  async function menu() {
    for (let i = 0; i < 40; i++) {
      const current = player.getDialogueManager().getCurrent();
      if (typeof current?.getOptions === "function") return current.getOptions();
      const pending = MultiChatboxPrompt.getPending(player);
      if (pending) return pending.options;
      if (!player.getDialogueManager().isActive()) return null;
      const group = player.getPacketSender().getChatboxGroupId();
      await send({ type: "dialogue_continue", widgetId: (group << 16) | ({ 229: 4, 193: 0, 11: 4 }[group] ?? 5), childIndex: group === 193 ? 0 : -1 });
    }
    return null;
  }
  async function choose(option) {
    const options = await menu();
    assert.ok(options?.includes(option), `${option} in ${JSON.stringify(options)}`);
    await send({ type: "dialogue_continue", widgetId: (219 << 16) | 1, childIndex: options.indexOf(option) + 1 });
  }
  async function talk() {
    const option = npc.getCurrentDefinition(player).getActions().findIndex((action) => action === "Talk-to") + 1;
    assert.ok(option > 0, "Tenzing has a Talk-to option");
    await send({ type: "npc_option", index: npc.getIndex(), clickType: option });
  }
  async function buy() {
    await choose("Can I buy some Climbing boots?");
    await choose("OK, sounds good.");
    await menu();
  }
  t.after(() => {
    PM.emitPlayerLogout({ player, username: player.getUsername() });
    player.setRegistered(false);
    core.TaskManager.cancelTasks(player);
    core.TaskManager.cancelTasks(player.getIndex());
  });
  return { npc, player, messages, send, menu, choose, talk, buy };
}

test("Tenzing sells climbing boots during Troll Stronghold", async (t) => {
  const f = harness(t);
  await f.talk();
  await f.buy();
  assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.COINS), 0);
  assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.CLIMBING_BOOTS), 1);
  assert.ok(f.messages.includes(BOOTS_GIVEN));
});

test("Tenzing still sells climbing boots after Troll Stronghold, from his own page", async (t) => {
  const f = harness(t, { trollStrongholdStage: null });
  await f.talk();
  await f.buy();
  assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.COINS), 0);
  assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.CLIMBING_BOOTS), 1);
});

test("with no space for the boots Tenzing takes nothing and does not claim to have given them", async (t) => {
  const f = harness(t, { coins: 13, fillInventory: true });
  assert.equal(f.player.getInventory().isFull(), true, "the inventory starts full");
  await f.talk();
  await f.buy();
  assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.COINS), 13);
  assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.CLIMBING_BOOTS), 0);
  assert.ok(f.messages.includes("Not enough space in your inventory."));
  assert.equal(f.messages.includes(BOOTS_GIVEN), false, "the success line is not played when nothing is handed over");
});

test("without 12 coins Tenzing sells no boots", async (t) => {
  const f = harness(t, { coins: 11 });
  await f.talk();
  await f.buy();
  assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.COINS), 11);
  assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.CLIMBING_BOOTS), 0);
});
