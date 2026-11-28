// Run after `yarn build`: node --test tests/level-up-combat-mastery-ruby-bolt.test.cjs
//
// #246: "ruby proc does not count for 50 damage in 1 hit". The Level-Up mastery asks for one
// applied hitsplat of 50+ (Points.LeagueCombatMasteries hitResolved), and enchanted bolts change
// that same HitDamage as it is rolled (EnchantedBolts rollBoltEffect), so a Blood Forfeit proc is
// the bolt's own hitsplat, not a second queued hit. Real plugins, real definitions, a real
// PendingHit through CombatFactory.executeHit and the target's HitQueue; only the damage roll is
// scripted, because this fixture has no world to roll accuracy and strength in.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { NpcDefinitionLoader } = require("../dist/game/definition/loader/impl/NpcDefinitionLoader");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { NPC } = require("../dist/game/entity/impl/npc/NPC");
const { CombatType } = require("../dist/game/content/combat/CombatType");
const { PendingHit } = require("../dist/game/content/combat/hit/PendingHit");
const { HitDamage } = require("../dist/game/content/combat/hit/HitDamage");
const { HitMask } = require("../dist/game/content/combat/hit/HitMask");
const { CombatFactory } = require("../dist/game/content/combat/CombatFactory");
const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { Item } = require("../dist/game/model/Item");
const { WeaponInterfaces } = require("../dist/game/content/combat/WeaponInterfaces");
const { Ammunition, RangedWeapon } = require("../dist/game/content/combat/ranged/RangedData");

const POINTS = "league:mastery-points";
const CHALLENGE = "deal-50-in-one-hit";
let core;
let next = 9300;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  await new NpcDefinitionLoader().load();
  PM.emitServerStartup({});
  // The Level-Up template is activated by TemplateWorlds' authenticated contract in production;
  // here the profile answer is the only part the mastery gate needs.
  const hooks = PM.customEventHooks.get("level-up:mastery-profile") ?? [];
  PM.customEventHooks.set("level-up:mastery-profile", [...hooks, { handler: (query) => { query.active = true; } }]);
});

after(() => {
  PM.emitServerShutdown({});
  setImmediate(() => process.exit());
});

/** A real player with a rune crossbow and ruby bolts (e), on the Level-Up mastery profile. */
function archer(t) {
  const channel = {
    kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {},
  };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername("rubymastery" + player.getIndex());
  player.setRegistered(true);
  player.setLocation(new core.Location(3222, 3218, 0));
  player.needsPlacement = false;
  for (const skill of core.Skill.values()) {
    player.getSkillManager().setMaxLevels(skill, 99, false).setCurrentLevels(skill, 99, false);
  }
  player.setHitpoints(99);
  const equipment = new Equipment(player);
  equipment.set(Equipment.WEAPON_SLOT, new Item(core.ItemIdentifiers.RUNE_CROSSBOW));
  player.equipment = equipment;
  player.setWeapon(WeaponInterfaces.CROSSBOW);
  player.getCombat().setRangedWeapon(RangedWeapon.RUNE_CROSSBOW);
  player.getCombat().setAmmunition(Ammunition.ENCHANTED_RUBY_BOLT);
  t.after(() => {
    player.setRegistered(false);
    core.TaskManager.cancelTasks(player.getIndex());
  });
  return player;
}

function target(hitpoints) {
  const npc = NPC.create(core.NpcIdentifiers.HILL_GIANT, new core.Location(3223, 3218, 0));
  npc.setIndex(next++);
  npc.setRegistered(true);
  npc.setHitpoints(hitpoints);
  return npc;
}

/** One forced ruby bolt shot whose natural roll is `base`; the proc replaces it. */
function shoot(player, npc, base) {
  player.setAttribute("enchanted-bolts:force-proc", true);
  const getHitDamage = CombatFactory.getHitDamage;
  CombatFactory.getHitDamage = () => new HitDamage(base, HitMask.RED);
  try {
    // rollAccuracy: false means the shot lands, as a forced proc must be observed rather than rolled.
    return new PendingHit(player, npc, { type: () => CombatType.RANGED, accuracyDefenceType: () => undefined },
      { rollAccuracy: false, experience: false, handleAfterHitEffects: false });
  } finally {
    CombatFactory.getHitDamage = getHitDamage;
  }
}

function land(npc, hit) {
  CombatFactory.executeHit(hit);
  npc.getCombat().getHitQueue().process(core.World.getProcessCycle() + 5);
}

test("a ruby bolt (e) proc is one hitsplat, and 20% of 300 (60) completes Deal 50 damage with a single attack (#246)", (t) => {
  const player = archer(t);
  const npc = target(300);
  const hit = shoot(player, npc, 5);
  assert.equal(hit.getHits().length, 1, "Blood Forfeit replaces the bolt's hit, it does not queue another");
  assert.equal(hit.getHits()[0].getDamage(), 60, "20% of 300, capped at 100");
  land(npc, hit);
  assert.equal(npc.getHitpoints(), 240, "the proc damage is the hitsplat the target lost");
  assert.equal(player.getAttribute(POINTS)?.[CHALLENGE], 1, "one applied hit of 60 counts for the 50 task");
});

test("a proc below 50 still does not count: 20% of 200 is 40 (#246)", (t) => {
  const player = archer(t);
  const npc = target(200);
  const hit = shoot(player, npc, 5);
  assert.equal(hit.getHits()[0].getDamage(), 40);
  land(npc, hit);
  assert.equal(npc.getHitpoints(), 160);
  assert.equal(player.getAttribute(POINTS)?.[CHALLENGE], undefined, "the task asks for 50 in the hit, not the bolt's base damage");
});