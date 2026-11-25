// Run after `yarn build`: node --test tests/league-infernal-harpoon-fishing.test.cjs
// Issue #180: Infernal Gathering's equipped Trailblazer harpoon stands in for any fishing tool.
// Real league character, equipment, cache spot definitions, npc_option packets and the production
// Fishing task: a small net spot and a lure spot both fish, while a carried harpoon does not.
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
const { GameConstants } = require("../dist/game/GameConstants");

let core;
let Fishing;
let next = 1200;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  GameConstants.setWorldProfile("league");
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.emitServerStartup({});
  Fishing = require("../plugins/skills/Fishing.plugin");
});

after(() => PM.emitServerShutdown({}));

/** A real level-99 Trailblazer character with the Infernal Gathering relic. */
function character(t, { equipped }) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername("harpoon" + Math.random().toString(36).slice(2));
  player.setProfile("league");
  player.setRegistered(true);
  player.setAttribute("bot-skip-persistence", true);
  const connection = new ClientConnection(channel);
  connection.player = player;
  player.setAttribute("league:tutorial-stage", 14);
  player.setAttribute("league:type", 4);
  player.setAttribute("league:relics", { 4: 3 });
  player.setAttribute("league:areas", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // The standby stand-in is the tool, not the cook/burn/smelt effect; raw catches keep this evidence simple.
  player.setAttribute("league:infernal-gathering-mode", "off");
  player.getInventory().resetItems();
  const harpoon = new core.Item(core.ItemIdentifiers.TRAILBLAZER_HARPOON, 1);
  if (equipped) player.getEquipment().set(core.Equipment.WEAPON_SLOT, harpoon);
  else player.getInventory().add(harpoon, true);
  const skills = player.getSkillManager();
  skills.setMaxLevel(core.Skill.FISHING, 99);
  skills.setCurrentLevel(core.Skill.FISHING, 99);
  core.RegionManager.loadMapFiles(3104, 3424);
  player.setLocation(new core.Location(3104, 3424, 0));
  player.needsPlacement = false;
  player.getPacketSender().sendInterfaceRemoval();
  t.after(() => {
    PM.emitPlayerLogout({ player, username: player.getUsername() });
    player.setRegistered(false);
    core.TaskManager.cancelTasks(player.getIndex());
    core.TaskManager.cancelTasks(player);
  });
  return { player, connection };
}

function fishingSpot(t, npcId) {
  const spot = core.NPC.create(npcId, new core.Location(3105, 3424, 0));
  spot.setScriptedMovement(true);
  assert.equal(core.World.getNpcs().add(spot), true, "the cache's fishing spot joins World");
  spot.needsPlacement = false;
  t.after(() => { if (spot.isRegistered()) core.World.getNpcs().removes(spot); });
  return spot;
}

async function click(f, spot, action, ticks = 5) {
  const definition = spot.getCurrentDefinition(f.player);
  const option = definition.getActions().findIndex((name) => name === action) + 1;
  assert.ok(option > 0, `the cache exposes ${action}`);
  const event = { player: f.player, npc: spot, npcId: spot.getId(), definition, clickType: option, handled: false };
  assert.equal(PM.emitNpcInteraction(event), true, "the production Fishing interaction accepts the click");
  for (let i = 0; i < ticks; i++) {
    core.TaskManager.processWalkTo(f.player.getIndex());
    f.player.getMovementQueue().process();
    core.TaskManager.process();
  }
}

test("the equipped Trailblazer harpoon fishes a small-net spot without a net", async (t) => {
  const f = character(t, { equipped: true });
  assert.equal(f.player.getInventory().contains(core.ItemIdentifiers.SMALL_FISHING_NET), false);
  assert.deepEqual(Fishing.findTool(f.player, Fishing.TOOLS.NET).ids, [core.ItemIdentifiers.TRAILBLAZER_HARPOON]);
  const random = Math.random;
  Math.random = () => 0.02;
  try {
    await click(f, fishingSpot(t, core.NpcIdentifiers.FISHING_SPOT_21), "Small Net");
    const landed = f.player.getInventory().getAmount(core.ItemIdentifiers.RAW_ANCHOVIES)
      + f.player.getInventory().getAmount(core.ItemIdentifiers.RAW_SHRIMPS);
    assert.equal(landed, 1, "the harpoon lands one small-net fish (anchovy before shrimp at level 99)");
  } finally {
    Math.random = random;
  }
});

test("the equipped Trailblazer harpoon fishes a lure spot without a rod", async (t) => {
  const f = character(t, { equipped: true });
  f.player.getInventory().add(new core.Item(core.ItemIdentifiers.FEATHER, 5), true);
  assert.equal(f.player.getInventory().contains(core.ItemIdentifiers.FLY_FISHING_ROD), false);
  assert.deepEqual(Fishing.findTool(f.player, Fishing.TOOLS.FLY_FISHING_ROD).ids, [core.ItemIdentifiers.TRAILBLAZER_HARPOON]);
  const random = Math.random;
  Math.random = () => 0.02;
  try {
    await click(f, fishingSpot(t, core.NpcIdentifiers.ROD_FISHING_SPOT_10), "Lure");
    const landed = f.player.getInventory().getAmount(core.ItemIdentifiers.RAW_SALMON)
      + f.player.getInventory().getAmount(core.ItemIdentifiers.RAW_TROUT);
    assert.equal(landed, 1, "the harpoon lands one lure fish (salmon before trout at level 99)");
    assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.FEATHER), 4, "lure bait is still spent");
  } finally {
    Math.random = random;
  }
});

test("a carried, unwielded harpoon does not stand in for a net", async (t) => {
  const f = character(t, { equipped: false });
  assert.equal(f.player.getInventory().contains(core.ItemIdentifiers.TRAILBLAZER_HARPOON), true);
  assert.equal(Fishing.findTool(f.player, Fishing.TOOLS.NET), null, "Wiki: the stand-in is equipped only");
  const messages = [];
  const sendMessage = f.player.sendMessage.bind(f.player);
  f.player.sendMessage = (message) => { messages.push(String(message)); sendMessage(message); };
  await click(f, fishingSpot(t, core.NpcIdentifiers.FISHING_SPOT_21), "Small Net", 4);
  assert.equal(f.player.getInventory().getAmount(core.ItemIdentifiers.RAW_SHRIMPS), 0);
  assert.ok(messages.includes("You don't have the right tool to fish there."));
});
