// Run after `yarn build`: node --test tests/guardian-thrall-targets.test.cjs
// The Guardian relic's target domain (Trailblazer Reloaded/Raging Echoes): it may only hit the
// NPC its owner is attacking, never a pickpocket interaction, and never a transformed corpse.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before, afterEach } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { NpcDefinitionLoader } = require("../dist/game/definition/loader/impl/NpcDefinitionLoader");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { PacketSender } = require("../dist/net/packet/PacketSender");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { Location } = require("../dist/game/model/Location");

const ARAXXOR = 13668;
const ARAXXOR_CORPSE = 13669;
const ARAXXOR_BOSS_TASK = 31;

let core;
let Guardian;
let Common;
let Data;
let State;
let Tasks;
let Slaughter;
let Expeditious;
let Morytania;
let api;
let spawned;
let league = 4;
const realRandom = Math.random;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  new NpcDefinitionLoader().load();
  core = PluginManager.getCoreApi();
  spawned = [];
  api = {
    core,
    persistAttribute() {},
    getPluginConfig(key, fallback) {
      if (key === "league:type") return league;
      if (key === "league:relic-league") return 0;
      return fallback;
    },
    log() {},
    emitCustomEvent(name, event) {
      // Common.leagueOf asks over events; the default owner is Trailblazer Reloaded.
      if (name === "league:profile") event.league = league;
    },
    onCustomEvent() {},
    onItemAction() {},
    onPlayerLogout() {},
    spawnNpc(definition) {
      const npc = guardianNpc(definition);
      spawned.push(npc);
      return npc;
    },
    removeNpc(npc) { npc.registered = false; },
  };

  Common = require("../plugins/modes/leaguerelics/Common.LeagueRelics");
  Common.init(api);
  Guardian = require("../plugins/modes/leaguerelics/Guardian.LeagueRelics");
  Guardian(api);

  Data = require("../plugins/skills/slayer/Data.Slayer");
  Data.init({ core });
  State = require("../plugins/skills/slayer/State.Slayer");
  State.init({ core, emitCustomEvent() {} });
  Tasks = require("../plugins/skills/slayer/Tasks.Slayer");
  Tasks.init({ core, emitCustomEvent() {} });
  Slaughter = require("../plugins/skills/slayer/SlaughterBracelet.Slayer");
  Slaughter.init({ core, emitCustomEvent() {} });
  Expeditious = require("../plugins/skills/slayer/ExpeditiousBracelet.Slayer");
  Expeditious.init({ core, emitCustomEvent() {} });
  Morytania = require("../plugins/skills/slayer/MorytaniaDiary.Slayer");
  Morytania.init({ core, emitCustomEvent() {} });
});

afterEach(() => {
  league = 4;
  Math.random = realRandom;
  for (const npc of spawned) if (npc.registered) npc.registered = false;
  spawned = [];
});

function guardianNpc(definition) {
  return {
    definition,
    registered: true,
    following: null,
    animations: [],
    interactions: [],
    isRegistered() { return this.registered; },
    setPet() {},
    setUntargetable() {},
    setFollowing(target) { this.following = target; },
    getFollowing() { return this.following; },
    setMobileInteraction(target) { this.interactions.push(target); },
    calculateDistance() { return 1; },
    getMovementQueue() { return { reset() {} }; },
    getAttackAnim() { return 1; },
    performAnimation(animation) { this.animations.push(animation.getId()); },
  };
}

/** A real PacketSender-backed player with the Slayer fields the task counter reads. */
function player({ target = null, interacting = null } = {}) {
  const attributes = new Map();
  const messages = [];
  const skills = [];
  const p = {
    isPlayer: () => true,
    isPlayerBot: () => false,
    isRegistered: () => true,
    isDyingReturn: () => false,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    sendMessage: (message) => messages.push(message),
    getSession: () => ({ sendClientPacket() {}, write() {} }),
    getInterfaceId: () => -1,
    setInterfaceId() {},
    getLocation: () => new Location(3200, 3200, 0),
    getCombat: () => ({ getTarget: () => target }),
    getInteractingMobile: () => interacting,
    getEquipment: () => ({ getItems: () => [] }),
    getInventory: () => ({ getFreeSlots: () => 28, contains: () => false, adds() {}, deleteNumber() {} }),
    getSkillManager: () => ({
      getMaxLevel: () => 99,
      getCurrentLevel: () => 99,
      addExperiences: (skill, amount) => skills.push([skill, amount]),
    }),
  };
  const sender = new PacketSender(p);
  p.getPacketSender = () => sender;
  return { player: p, sender, messages, skills };
}

function summon(t, owner) {
  t.mock.method(core.TaskManager, "submit", () => ({}));
  const npc = Guardian.summon(owner);
  assert.ok(npc, "the guardian is summoned");
  return Guardian.stateOf(owner);
}

function giveAraxxorBossTask(sender, count = 2) {
  sender.sendConfig(CacheDefinitions.getVarpId("slayer_target"), Data.BOSS_TASK_ID);
  sender.sendConfig(CacheDefinitions.getVarpId("slayer_count"), count);
  sender.sendConfig(CacheDefinitions.getVarpId("slayer_count_original"), count);
  sender.sendVarbit(CacheDefinitions.getVarbitId("slayer_target_bossid"), ARAXXOR_BOSS_TASK);
  sender.sendVarbit(CacheDefinitions.getVarbitId("slayer_master"), 5);
}

const slayerCount = (sender) => sender.getVarp(CacheDefinitions.getVarpId("slayer_count"));

function corpseTarget() {
  const definition = core.NpcDefinition.forId(ARAXXOR_CORPSE);
  const queued = [];
  const target = {
    hp: 1,
    isNpc: () => true,
    isRegistered: () => true,
    isUntargetable: () => false,
    isNeedsPlacement: () => false,
    isDyingFunction: () => false,
    getId: () => ARAXXOR_CORPSE,
    getName: () => definition.getName(),
    getHitpoints: () => target.hp,
    getCurrentDefinition: () => definition,
    getDefinition: () => definition,
    getLocation: () => new Location(3200, 3200, 0),
    getCombat: () => ({
      getHitQueue: () => ({ added: queued, addPendingDamage: (hits) => queued.push(...hits) }),
      addDamage(_player, damage) { target.hp = Math.max(0, target.hp - damage); },
    }),
  };
  return { target, queued };
}

test("Guardian never fights a pickpocket/skilling interaction when the owner has no combat target", (t) => {
  const pickpocket = {
    isNpc: () => true,
    isRegistered: () => true,
    getHitpoints: () => 99,
    getCurrentDefinition: () => ({ isAttackable: () => true }),
    getCombat() { throw new Error("the guardian must not touch an interacted NPC"); },
  };
  const owner = player({ target: null, interacting: pickpocket }).player;
  const state = summon(t, owner);

  for (let tick = 0; tick < 6; tick++) assert.equal(Guardian.tick(owner, state), true);

  assert.equal(Guardian.targetOf(owner), null, "an interaction is not a combat target");
  assert.equal(state.npc.animations.length, 0, "it never swings");
  assert.equal(state.npc.interactions.length, 0, "it never faces/interacts with the skiller");
  assert.equal(state.npc.getFollowing(), owner, "it follows its owner instead");
  Guardian.dismiss(owner, true);
});

test("Guardian refuses Araxxor's harvestable corpse, so it cannot remove task KC a second time", (t) => {
  const { target: corpse, queued } = corpseTarget();
  const { player: owner, sender } = player({ target: corpse });
  t.mock.method(core.CombatFactory, "validTarget", () => {
    throw new Error("a non-attackable transformed NPC is rejected before engine targeting");
  });
  const state = summon(t, owner);

  // Control: if the corpse did die, the Slayer kill handler would count it as Araxxor again.
  giveAraxxorBossTask(sender, 2);
  Tasks.npcKilled({ killer: owner, npc: corpse, npcId: ARAXXOR_CORPSE });
  assert.equal(slayerCount(sender), 1, "a corpse death is a second task kill");
  sender.sendConfig(CacheDefinitions.getVarpId("slayer_count"), 2);

  for (let tick = 0; tick < 12; tick++) Guardian.tick(owner, state);

  assert.equal(Guardian.targetOf(owner), null);
  assert.equal(state.npc.animations.length, 0, "the guardian never swings at the corpse");
  assert.equal(queued.length, 0, "no hit is queued on the corpse");
  assert.equal(corpse.hp, 1, "the corpse keeps the HP that makes Harvest/Destroy clickable");
  assert.equal(slayerCount(sender), 2, "Guardian did not run the extra death/task-KC path");
  Guardian.dismiss(owner, true);
});

test("Guardian still attacks a live attackable combat target, in its weakest defence style", (t) => {
  const queued = [];
  const live = {
    isNpc: () => true,
    isRegistered: () => true,
    isUntargetable: () => false,
    isNeedsPlacement: () => false,
    isDyingFunction: () => false,
    getId: () => ARAXXOR,
    getHitpoints: () => 500,
    getCurrentDefinition: () => core.NpcDefinition.forId(ARAXXOR),
    getDefinition: () => core.NpcDefinition.forId(ARAXXOR),
    getCombat: () => ({
      getHitQueue: () => ({ addPendingDamage: (hits) => queued.push(...hits) }),
      addDamage() {},
    }),
  };
  const { player: owner } = player({ target: live });
  t.mock.method(core.CombatFactory, "validTarget", () => true);
  t.mock.method(core.CombatFactory, "canAttackPermission", () => core.CanAttackResponse.CAN_ATTACK);
  t.mock.method(core.AccuracyFormulasDpsCalc, "defenseMeleeRoll", () => 5000);
  t.mock.method(core.AccuracyFormulasDpsCalc, "defenseRangedRoll", () => 500);
  t.mock.method(core.AccuracyFormulasDpsCalc, "defenseMagicRoll", () => 9000);
  t.mock.method(Math, "random", () => 0);
  const state = summon(t, owner);

  assert.equal(Guardian.targetOf(owner), live);
  assert.equal(Guardian.weakestStyle(live), "ranged", "the lowest defence roll decides the style");
  for (let tick = 0; tick < 5; tick++) Guardian.tick(owner, state);

  assert.equal(state.style, "ranged");
  assert.equal(queued.length, 1, "the fifth Trailblazer Reloaded tick lands one attack");
  assert.equal(queued[0].getDamage(), 6, "Wiki damage roll 6-15");
  assert.equal(queued[0].getHitmask(), core.HitMask.RED);
  Guardian.dismiss(owner, true);
});

test("a Raging Echoes guardian keeps its own 4-tick cadence and 5-13 damage", (t) => {
  league = 5;
  const queued = [];
  const live = {
    isNpc: () => true,
    isRegistered: () => true,
    isUntargetable: () => false,
    isNeedsPlacement: () => false,
    isDyingFunction: () => false,
    getId: () => ARAXXOR,
    getHitpoints: () => 500,
    getCurrentDefinition: () => core.NpcDefinition.forId(ARAXXOR),
    getDefinition: () => core.NpcDefinition.forId(ARAXXOR),
    getCombat: () => ({
      getHitQueue: () => ({ addPendingDamage: (hits) => queued.push(...hits) }),
      addDamage() {},
    }),
  };
  const { player: owner } = player({ target: live });
  t.mock.method(core.CombatFactory, "validTarget", () => true);
  t.mock.method(core.CombatFactory, "canAttackPermission", () => core.CanAttackResponse.CAN_ATTACK);
  t.mock.method(core.AccuracyFormulasDpsCalc, "defenseMeleeRoll", () => 5000);
  t.mock.method(core.AccuracyFormulasDpsCalc, "defenseRangedRoll", () => 500);
  t.mock.method(core.AccuracyFormulasDpsCalc, "defenseMagicRoll", () => 9000);
  t.mock.method(Math, "random", () => 0);
  const state = summon(t, owner);

  assert.equal(state.interval, 4);
  for (let tick = 0; tick < 4; tick++) Guardian.tick(owner, state);

  assert.equal(queued.length, 1, "the fourth Raging Echoes tick lands one attack");
  assert.equal(queued[0].getDamage(), 5, "Wiki damage roll 5-13");
  Guardian.dismiss(owner, true);
});

test("Guardian rejects a dying NPC even when its current definition is still attackable", (t) => {
  const dying = {
    isNpc: () => true,
    isRegistered: () => true,
    isUntargetable: () => false,
    isNeedsPlacement: () => false,
    isDyingFunction: () => true,
    getHitpoints: () => 10,
    getCurrentDefinition: () => core.NpcDefinition.forId(ARAXXOR),
    getDefinition: () => core.NpcDefinition.forId(ARAXXOR),
    getCombat: () => {
      throw new Error("a dying NPC is rejected before its combat is touched");
    },
  };
  const { player: owner } = player({ target: dying });
  assert.equal(Guardian.targetOf(owner), null);
});
