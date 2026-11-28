// Run after 'yarn build': node --test tests/ape-atoll-quests-off.test.cjs
// A Quests-off world auto-completes Monkey Madness II at login. That is exactly what the real
// Greegrees area reads, so the Wiki's MM2-gated Ape Atoll natives must stop hunting a human
// (issue 208). The Ape Atoll page makes every surface inhabitant tolerant after MM2, so monkey
// archers and scorpions calm too; monkey zombies and skeletal apes are the stated exceptions (#250).
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { NpcDefinitionLoader } = require("../dist/game/definition/loader/impl/NpcDefinitionLoader");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { NpcAggression } = require("../dist/game/entity/impl/npc/NpcAggression");
const { AreaManager } = require("../dist/game/model/areas/AreaManager");
const greegrees = require("../plugins/items/Greegrees.plugin");
const QuestAutoComplete = require("../plugins/quests/QuestAutoComplete.plugin.js");
const QuestRuntime = require("../plugins/quests/QuestRuntime");

const SPIDER = 5238;
const SCORPION = 5242;
const JUNGLE_SPIDER = 5243;
const SNAKE = 5244;
const GUARD = 5275;
const GUARD_2 = 5276;
const ARCHER = 5272;

let core, player;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  new NpcDefinitionLoader().load();
  core = PM.getCoreApi();
  greegrees.register(PM.createApi("ApeAtollQuestsOffGreegrees"));
  // The real world switch: Quests off, members. QuestAutoComplete completes every quest at login.
  const overridden = Object.create(core);
  Object.defineProperty(overridden, "PluginManager", {
    value: { getPluginSwitch: (name) => (name === "Quests" ? false : undefined) },
  });
  Object.defineProperty(overridden, "WorldDefinition", { value: { isMembersWorld: () => true } });
  const real = PM.createApi("ApeAtollQuestsOffAutoComplete");
  const api = new Proxy(real, {
    get(target, property) {
      if (property === "core") return overridden;
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  QuestAutoComplete.register(api);
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {} };
  player = new Player(new PlayerSession(channel));
  player.setIndex(9911);
  player.setUsername("apecub");
  player.setRegistered(true);
  player.setAttribute("bot-skip-persistence", true);
  player.setLocation(new core.Location(2734, 2793, 0));
  player.setNeedsPlacement(false);
  AreaManager.process(player);
  PM.emitPlayerLogin({ player, username: player.getUsername() });
  setLevel(90);
});

function setLevel(level) {
  for (const skill of core.Skill.values()) {
    player.getSkillManager().setCurrentLevel(skill, level);
    player.getSkillManager().setMaxLevel(skill, level);
  }
}

/** Runs the real aggression decision for one real NPC at npcTile against a human at playerTile. */
function hunts(t, npcId, npcTile, playerTile) {
  player.setLocation(new core.Location(...playerTile));
  AreaManager.process(player);
  const creature = core.NPC.create(npcId, new core.Location(...npcTile));
  creature.setSpawnPosition(new core.Location(...npcTile));
  creature.isRegistered = () => true;
  creature.setNeedsPlacement(false);
  creature.setHitpoints(500);
  t.after(() => core.World.unregisterNpcPosition(creature));
  NpcAggression.runAggression(player, [creature]);
  return creature.getCombat().getTarget() === player;
}

test("the Quests-off world completes Monkey Madness II at login", () => {
  const mm2 = QuestRuntime.getRegisteredQuests().find((quest) => quest.key === "monkey_madness_ii");
  assert.ok(mm2, "the definition is registered by QuestAutoComplete");
  assert.equal(mm2.getStage(player), 195);
  const request = { player, key: "monkey_madness_ii", complete: null };
  PM.emitCustomEvent("quest:is-complete", request);
  assert.equal(request.complete, true);
});

test("MM2-gated Ape Atoll natives are passive after the Quests-off auto-completion", (t) => {
  assert.equal(hunts(t, SPIDER, [2734, 2792, 0], [2734, 2793, 0]), false, "spider 5238");
  assert.equal(hunts(t, JUNGLE_SPIDER, [2736, 2793, 0], [2737, 2793, 0]), false, "jungle spider 5243");
  assert.equal(hunts(t, SNAKE, [2732, 2740, 0], [2732, 2741, 0]), false, "snake 5244");
  assert.equal(hunts(t, GUARD, [2788, 2778, 0], [2788, 2779, 0]), false, "monkey guard 5275");
  assert.equal(hunts(t, GUARD_2, [2803, 2785, 0], [2803, 2786, 0]), false, "monkey guard 5276");
});

test("monkey archers are passive after the Quests-off auto-completion (#250)", (t) => {
  assert.equal(hunts(t, ARCHER, [2768, 2768, 0], [2769, 2768, 0]), false, "5272");
  assert.equal(hunts(t, 5273, [2713, 2753, 0], [2714, 2753, 0]), false, "5273");
  assert.equal(hunts(t, 5274, [2752, 2754, 0], [2753, 2754, 0]), false, "5274");
});

test("scorpions are passive after the Quests-off auto-completion (#250)", (t) => {
  setLevel(50);
  try {
    assert.equal(hunts(t, SCORPION, [2762, 2749, 0], [2762, 2750, 0]), false);
  } finally {
    setLevel(90);
  }
});

test("monkey zombies and skeletal apes remain aggressive on a Quests-off world (#250 exceptions)", (t) => {
  assert.equal(hunts(t, 5281, [2694, 9115, 0], [2695, 9115, 0]), true, "monkey zombie 5281");
  assert.equal(hunts(t, 5237, [2704, 9105, 0], [2705, 9105, 0]), true, "skeleton 5237");
});
