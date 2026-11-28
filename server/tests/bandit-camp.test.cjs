// Run after `yarn build`: node --test tests/bandit-camp.test.cjs
//
// Desert Bandit Camp (#229). Wiki (Bandit Camp (Kharidian Desert)): the camp is multi-combat.
// Wiki (Bandit (Bandit Camp)): "aggressive = Only when wearing an item associated with Saradomin
// or Zamorak", with either god's equipment causing the attack. The cache's bandits (690-695) are
// definition-passive, so the area has to supply the rule. The 695 spawns at x 3272-3302 are
// outside the camp and must stay outside its multi-combat bounds.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { NpcAggression } = require("../dist/game/entity/impl/npc/NpcAggression");

const plugin = require("../plugins/areas/BanditCamp.plugin");
const SPAWNS = require("../data/definitions/npc-spawns.json");

const BANDITS = [690, 691, 692, 693, 694, 695];
const SARADOMIN_FULL_HELM = 2665;
const ZAMORAK_FULL_HELM = 2657;
const MONKS_ROBE_TOP = 544;
const RUNE_PLATEBODY = 1127;
const MUGGER = 1;

let core, area, CAMP_ROWS;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  CAMP_ROWS = plugin._test.CAMP_ROWS;
  plugin.register(new Proxy({ core, registerArea(registered) { area = registered; } },
    { get: (target, key) => (key in target ? target[key] : () => {}) }));
});

const inside = (x, y, z = 0) => area.getBoundaries().some((b) => b.inside(new core.Location(x, y, z)));
const wearing = (...ids) => ({ getEquipment: () => ({ getItems: () => ids.map((id) => ({ getId: () => id })) }) });
const bandit = (id = 690) => ({ getId: () => id });

/** A real Player standing in the camp, so the engine's own aggression pass can run. */
function campPlayer(helm) {
  const player = new Player(null);
  player.setUsername("bandit-camp");
  const sender = new Proxy({ getVarbit: () => 0, getVarp: () => 0 }, { get: (object, key) => object[key] ?? (() => sender) });
  player.getPacketSender = () => sender;
  player.getSession = () => ({ sendClientPacket: () => true, processPackets: () => {} });
  player.setLocation(new core.Location(3171, 2979, 0));
  player.setArea(area);
  player.setRegistered(true);
  player.setNeedsPlacement(false);
  player.autoRetaliateReturn = () => false;
  for (const skill of core.Skill.values()) {
    player.getSkillManager().setCurrentLevel(skill, 99);
    player.getSkillManager().setMaxLevel(skill, 99);
  }
  if (helm) player.getEquipment().setItem(core.Equipment.HEAD_SLOT, new core.Item(helm, 1));
  return player;
}

function campHunter() {
  const npc = core.NPC.create(690, new core.Location(3171, 2981, 0));
  npc.setSpawnPosition(new core.Location(3171, 2981, 0));
  npc.isRegistered = () => true;
  npc.setNeedsPlacement(false);
  npc.setHitpoints(500);
  return npc;
}

test("the camp is multi-combat and every in-camp bandit spawn is inside it", () => {
  assert.equal(area.isMulti(), true);
  const campSpawns = SPAWNS.filter((spawn) => BANDITS.includes(spawn.id) && spawn.x <= 3199);
  assert.equal(campSpawns.length, 30);
  for (const spawn of campSpawns) {
    assert.ok(inside(spawn.x, spawn.y), `bandit ${spawn.id} at ${spawn.x},${spawn.y} is in the camp`);
  }
});

test("the five far-east 695 spawns are outside the camp", () => {
  const farEast = SPAWNS.filter((spawn) => spawn.id === 695 && spawn.x > 3199);
  assert.equal(farEast.length, 5);
  for (const spawn of farEast) {
    assert.equal(inside(spawn.x, spawn.y), false, `far-east bandit at ${spawn.x},${spawn.y} is not in the camp`);
  }
});

test("the bounds follow the Wiki polygon, including its notched corners", () => {
  for (const [x, y] of [[3174, 2952], [3163, 2957], [3149, 2958], [3137, 3005], [3171, 2979], [3198, 2974]]) {
    assert.ok(inside(x, y), `${x},${y} is multi-combat`);
  }
  for (const [x, y] of [[3172, 2953], [3137, 2978], [3199, 2974], [3171, 3006]]) {
    assert.equal(inside(x, y), false, `${x},${y} is outside the camp`);
  }
  assert.equal(CAMP_ROWS.length, 44, "the polygon decomposition stays current");
});

test("a Saradomin or Zamorak item makes every bandit aggressive", () => {
  for (const item of [SARADOMIN_FULL_HELM, ZAMORAK_FULL_HELM, MONKS_ROBE_TOP]) {
    for (const id of BANDITS) {
      assert.equal(area.npcAggression(wearing(item), bandit(id)), true, `${id} attacks for item ${item}`);
    }
  }
  assert.equal(area.npcAggression(wearing(SARADOMIN_FULL_HELM, ZAMORAK_FULL_HELM), bandit(695)), true,
    "wearing both god types still counts as a god affiliation");
});

test("without god equipment the bandits stay passive", () => {
  for (const player of [wearing(), wearing(RUNE_PLATEBODY)]) {
    for (const id of BANDITS) assert.equal(area.npcAggression(player, bandit(id)), false, `${id} stays passive`);
  }
  assert.equal(area.npcAggression(wearing(SARADOMIN_FULL_HELM), bandit(MUGGER)), null,
    "another NPC's aggression is not this area's decision");
});

test("the engine's aggression pass attacks a god-item wearer but not a plain player", () => {
  const godPlayer = campPlayer(SARADOMIN_FULL_HELM);
  const godNpc = campHunter();
  NpcAggression.runAggression(godPlayer, [godNpc]);
  assert.equal(godNpc.getCombat().getTarget(), godPlayer, "a god item makes the bandit engage");

  const plainPlayer = campPlayer(null);
  const plainNpc = campHunter();
  NpcAggression.runAggression(plainPlayer, [plainNpc]);
  assert.equal(plainNpc.getCombat().getTarget(), null, "without god equipment the bandit stays passive");
});
