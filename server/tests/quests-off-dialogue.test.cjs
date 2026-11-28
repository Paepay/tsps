// Run after `yarn build`: node --test tests/quests-off-dialogue.test.cjs
// The Quests-off shims driven through the REAL dialogue engine: Eblis's post-quest ancient
// staff, Sir Prysin's Darklight repurchase, Malignius's magic secateurs and the WGS light
// creature's Attract.
// The hook-level checks live in quest-auto-complete.test.cjs; these prove the real
// variants, conditions and actions reach the hand-outs.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, afterEach, test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { NpcDefinitionLoader } = require("../dist/game/definition/loader/impl/NpcDefinitionLoader");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");
const { Location } = require("../dist/game/model/Location");
const { MultiChatboxPrompt } = require("../dist/game/model/menu/MultiChatboxPrompt");
const QuestAutoComplete = require("../plugins/quests/QuestAutoComplete.plugin.js");

let core, index = 9850;
const cleanups = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  new NpcDefinitionLoader().load();
  core = PM.getCoreApi();
  require("../plugins/npcs/NpcDialogues.plugin").register(PM.createApi("QuestsOffDialogue"));
  // Quests off, members world: the same switch QuestAutoComplete reads on a level-up world.
  const overridden = Object.create(core);
  Object.defineProperty(overridden, "PluginManager", { value: { getPluginSwitch: (name) => name === "Quests" ? false : undefined } });
  Object.defineProperty(overridden, "WorldDefinition", { value: { isMembersWorld: () => true } });
  const real = PM.createApi("QuestsOffAutoComplete");
  const api = new Proxy(real, {
    get(target, property) {
      if (property === "core") return overridden;
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  QuestAutoComplete.register(api);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

/** A real player with a real inventory beside a real NPC; chatbox text and messages recorded separately. */
function actor(npcId, items = [], at = [3300, 3300, 0]) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel), new Location(...at));
  p.setIndex(index++);
  p.setRegistered(true);
  p.setUsername("questsoff" + index);
  p.setAttribute("bot-skip-persistence", true);
  for (const [id, amount] of items) p.getInventory().adds(id, amount);
  // QuestAutoComplete completes every quest at login, as the real world does.
  PM.emitPlayerLogin({ player: p, username: p.getUsername() });
  const connection = new ClientConnection(channel);
  connection.player = p;
  const npc = core.NPC.create(npcId, new Location(at[0] + 1, at[1], at[2]));
  const lines = [], messages = [];
  const sender = p.getPacketSender();
  const wrap = (name, record) => {
    const original = sender[name].bind(sender);
    sender[name] = (...args) => { record(...args); return original(...args); };
  };
  wrap("sendString", (text) => lines.push(String(text)));
  wrap("sendMessage", (text) => messages.push(String(text)));
  wrap("sendTypedMessage", (type, text) => messages.push(String(text)));
  cleanups.push(() => { p.closeInterruptibleInterfaces(); p.setRegistered(false); core.TaskManager.cancelTasks(p); });
  const send = async (packet) => { await connection.dispatch([packet]); connection.processTurnPackets(); };
  const tick = (count = 1) => { for (let i = 0; i < count; i++) core.World.process(); };
  async function useItemOnItem(itemId, withItemId) {
    const inventory = p.getInventory();
    const slot = inventory.getSlotForItemId(itemId);
    const withSlot = inventory.getSlotForItemId(withItemId);
    assert.ok(slot >= 0 && withSlot >= 0, "both items are in the inventory");
    await send({ type: "inventory_use_on", itemId, slot, target: { kind: "inventory", slot: withSlot } });
  }
  async function readItem(itemId) {
    const inventory = p.getInventory();
    const slot = inventory.getSlotForItemId(itemId);
    const actions = core.CacheDefinitions.getItem(itemId)?.inventoryActions ?? [];
    const index = actions.findIndex((action) => String(action).toLowerCase() === "read");
    assert.ok(slot >= 0 && index >= 0, "the notes are held with a Read option");
    await send({ type: "inventory_action", widgetId: 3214, slot, itemId, option: "Read", optionIndex: index + 1 });
  }
  const next = () => send({ type: "dialogue_continue", widgetId: (sender.getChatboxGroupId() << 16) | 5, childIndex: -1 });
  async function choose(text) {
    for (let page = 0; page < 12; page++) {
      for (let n = 0; !MultiChatboxPrompt.getPending(p) && n < 80; n++) {
        assert.ok(p.getDialogueManager().getCurrent(), `dialogue ended before "${text}"; lines: ${JSON.stringify(lines)}`);
        await next();
      }
      const prompt = MultiChatboxPrompt.getPending(p);
      assert.ok(prompt, `no option menu reached for "${text}"; lines: ${JSON.stringify(lines)}`);
      if (prompt.options.includes(text)) {
        await send({ type: "dialogue_continue", widgetId: MultiChatboxPrompt.OPTIONS_WIDGET_ID,
          childIndex: prompt.options.indexOf(text) + 1 });
        return;
      }
      const more = prompt.options.indexOf("More...");
      assert.ok(more >= 0, `choice "${text}" offered: ${JSON.stringify(prompt.options)}`);
      await send({ type: "dialogue_continue", widgetId: MultiChatboxPrompt.OPTIONS_WIDGET_ID, childIndex: more + 1 });
    }
    assert.fail(`choice "${text}" never appeared; lines: ${JSON.stringify(lines)}`);
  }
  async function playToEnd(limit = 140) {
    for (let n = 0; n < limit && p.getDialogueManager().getCurrent(); n++) {
      if (MultiChatboxPrompt.getPending(p)) break;
      await next();
    }
  }
  // NPCOptionPacketListener passes the resolved cache variant, so a multinpc spawn such as the
  // gnomeball-house Zooknock 7194 reaches content hooks as ZOOKNOCK_4 (7171).
  const talkTo = () => PM.emitNpcInteraction({ player: p, npc, npcId: npc.getContentId(p), action: "Talk-to", clickType: 1, handled: false });
  return { p, npc, npcId, lines, messages, choose, playToEnd, talkTo, tick, useItemOnItem, readItem,
    count: (id) => p.getInventory().getAmount(id) };
}

/** The auto-completed quests hand out their items at login, so make room for the purchase. */
function freeSlot(player) {
  const item = player.getInventory().getItems().find((held) => held.getId() !== -1 && held.getId() !== core.ItemIdentifiers.COINS);
  if (item) player.getInventory().deleteNumber(item.getId(), item.getAmount());
}

test("Quests off: Eblis's post-quest offer buys the ancient staff through the real transcript", async () => {
  const { ItemIdentifiers: I } = core;
  const a = actor(core.NpcIdentifiers.EBLIS, [[I.COINS, 80_000]]);
  // Desert Treasure's auto-reward already handed one over at login.
  a.p.getInventory().deleteNumber(I.ANCIENT_STAFF, a.count(I.ANCIENT_STAFF));
  freeSlot(a.p);
  const coins = a.count(I.COINS);
  a.talkTo();
  await a.choose("Yes please");
  await a.playToEnd();
  assert.equal(a.count(I.COINS), coins - 80_000, "the 80,000-coin price is taken");
  assert.equal(a.count(I.ANCIENT_STAFF), 1, "the ancient staff is handed over");
  assert.ok(a.messages.some((text) => text === "Eblis hands you an ancient staff."));
});

test("Quests off: Sir Prysin's reissued sword is Darklight and costs 500 coins", async () => {
  const { ItemIdentifiers: I } = core;
  const a = actor(core.NpcIdentifiers.SIR_PRYSIN, [[I.COINS, 500]]);
  // The auto-rewarded Demon Slayer sword is what a repurchase replaces; lose it first.
  for (const sword of [I.SILVERLIGHT, I.SILVERLIGHT_2, I.DARKLIGHT]) {
    const held = a.count(sword);
    if (held) a.p.getInventory().deleteNumber(sword, held);
  }
  freeSlot(a.p);
  const coins = a.count(I.COINS);
  a.talkTo();
  await a.choose("Yes, although I'm afraid I've lost Silverlight.");
  await a.choose("Is there any chance of me borrowing it again?");
  await a.choose("Ok, I'll pay.");
  await a.playToEnd();
  assert.equal(a.count(I.COINS), coins - 500, "the price is taken");
  assert.equal(a.count(I.DARKLIGHT), 1, "Shadow of the Storm's Darklight replaces Silverlight");
  assert.equal(a.count(I.SILVERLIGHT), 0, "the old sword is not handed out instead");
});

test("Quests off: Malignius sells magic secateurs for 40,000 coins through the real transcript", async () => {
  const { ItemIdentifiers: I } = core;
  const a = actor(core.NpcIdentifiers.MALIGNIUS_MORTIFER, [[I.COINS, 40_000]]);
  const coins = a.count(I.COINS);
  a.talkTo();
  await a.choose("About those enchanted secateurs again...");
  await a.choose("Can I get another set of enchanted secateurs?");
  await a.choose("Ok, great.");
  await a.playToEnd();
  assert.equal(a.count(I.COINS), coins - 40_000, "the 40,000-coin price is taken");
  assert.equal(a.count(I.MAGIC_SECATEURS), 1, "the magic secateurs are handed over");
});

test("Quests off: Attract on a light creature opens the crossing into the chasm", async () => {
  const a = actor(core.NpcIdentifiers.LIGHT_CREATURE_4, [[core.ItemIdentifiers.SAPPHIRE_LANTERN_3, 1]], [3229, 9527, 2]);
  a.talkTo();
  await a.choose("Travel into the chasm.");
  await a.playToEnd();
  assert.deepEqual([a.p.getLocation().getX(), a.p.getLocation().getY(), a.p.getLocation().getZ()], [4064, 4600, 0],
    "the chasm crossing moves the player to the bottom of the chasm");
});

test("Quests off: WGS completion resolves Duradel's spawn to Kuradal", () => {
  // Burthorpe's slayer master spawn is a multinpc keyed on the WGS fellowship varp.
  const a = actor(13654, [], [2869, 2982, 1]);
  assert.equal(a.p.getPacketSender().getVarbit(10782), 2, "the fellowship visibility varp is sent at login");
  assert.equal(a.npc.getContentId(a.p), core.NpcIdentifiers.KURADAL, "the post-quest master is Kuradal");
  assert.equal(a.npc.getCurrentDefinition(a.p).getName(), "Kuradal");
});

test("Quests off: Kuradal's post-quest notes hand-out and reading unlock synapse crafting", async () => {
  const { ItemIdentifiers: I, Skill } = core;
  const a = actor(core.NpcIdentifiers.KURADAL);
  a.talkTo();
  await a.choose("About Duradel...");
  await a.playToEnd();
  assert.equal(a.count(I.DURADELS_NOTES), 1, "Kuradal hands out the notes after the auto-completed quest");

  await a.readItem(I.DURADELS_NOTES);
  assert.equal(a.count(I.DURADELS_NOTES), 0, "reading consumes the notes");
  assert.equal(a.p.getAttribute("while-guthix-sleeps:duradel-notes-read"), 1, "the read attribute is saved");

  a.p.getSkillManager().setMaxLevel(Skill.FLETCHING, 74).setCurrentLevel(Skill.FLETCHING, 74);
  a.p.getInventory().adds(I.TORMENTED_SYNAPSE, 1);
  a.p.getInventory().adds(I.MAGIC_LONGBOW_U_, 1);
  await a.useItemOnItem(I.TORMENTED_SYNAPSE, I.MAGIC_LONGBOW_U_);
  a.tick(6);
  assert.equal(a.count(I.SCORCHING_BOW), 1, "the shared reward crafting still runs with Quests off");
  assert.equal(a.count(I.TORMENTED_SYNAPSE), 0, "the synapse is consumed");
});

test("Quests off: Zooknock's post-quest choice hands a zombie greegree", async () => {
  const { ItemIdentifiers: I } = core;
  // npc-spawns.json's house above the gnomeball field is multinpc 7194; on an MM2-complete
  // world it transforms to ZOOKNOCK_4 (7171), which is what the reclaim hooks read.
  const a = actor(7194);
  assert.equal(a.npc.getContentId(a.p), core.NpcIdentifiers.ZOOKNOCK_4, "the spawn resolves to the post-quest Zooknock");
  a.talkTo();
  await a.choose("Monkey talisman.");
  await a.choose("Next.");
  await a.choose("Small zombie.");
  await a.playToEnd();
  assert.equal(a.count(I.ZOMBIE_MONKEY_GREEGREE), 1, "the reclaim condition resolves instead of taking the already-owned branch");
  assert.ok(!a.lines.some((line) => /already have one of those/i.test(line)), "Zooknock does not refuse the missing greegree");
});

test("Quests off: a Zooknock bank placeholder does not count as owning the greegree", async () => {
  const { ItemIdentifiers: I } = core;
  const a = actor(7194);
  a.p.getBank(0).add(new core.Item(I.ZOMBIE_MONKEY_GREEGREE, 0), false);
  assert.equal(a.p.getBank(0).getAmount(I.ZOMBIE_MONKEY_GREEGREE), 0, "stored as a placeholder");
  assert.equal(a.p.getBank(0).contains(I.ZOMBIE_MONKEY_GREEGREE), true, "the placeholder is still present");
  a.talkTo();
  await a.choose("Monkey talisman.");
  await a.choose("Next.");
  await a.choose("Small zombie.");
  await a.playToEnd();
  assert.equal(a.count(I.ZOMBIE_MONKEY_GREEGREE), 1, "the placeholder does not block the replacement");
});
