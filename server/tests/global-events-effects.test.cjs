// Run after `yarn build`: node --test tests/global-events-effects.test.cjs
// Paepay/tsps#65: combat events only ever touch NPC targets; Onslaught is +50% damage;
// Bloodthirst is the Blood Fury roll for every style; Accelerate, Prodigy and Rags to Riches.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before, afterEach } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { Location } = require("../dist/game/model/Location");

const Common = require("../plugins/events/global/Common.GlobalEvents");
const Combat = require("../plugins/events/global/Combat.GlobalEvents");
const Utility = require("../plugins/events/global/Utility.GlobalEvents");

let core;
let store;
const realRandom = Math.random;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "global-events-")), "state.json");
  Common.testing.setStoreFile(store);
  Common.testing.reset();
  const custom = new Map();
  const api = new Proxy({
    core,
    onCombatHitRoll: (handler) => custom.set("hit-roll", handler),
    onCombatHitDamage: (handler) => custom.set("hit-damage", handler),
    onCustomEvent: (name, handler) => custom.set(name, handler),
    registerRestingLevelModifier: (handler) => custom.set("resting", handler),
    onPlayerProcess: (handler) => custom.set("process", handler),
    onCanGainExperience: (handler) => custom.set("xp", handler),
    emitCustomEvent: (name, event) => (custom.get(name)?.(event) ?? event),
  }, { get: (target, key) => (key in target ? target[key] : () => {}) });
  Combat.attach(api);
  Utility.attach(api);
  globalThis.hooks = custom;
});

afterEach(() => {
  Math.random = realRandom;
});

function activate(eventId, minutes = 30) {
  const startedAt = Date.now();
  return Common.activate(eventId, { startedAt, endsAt: startedAt + minutes * 60_000 });
}

function fighter(name = "fighter") {
  const p = {
    hp: 50,
    healed: 0,
    disabled: [],
    getUsername: () => name,
    getAsPlayer() { return p; },
    isPlayer: () => true,
    getAttribute(key) { return key === Common.OPT_OUT_ATTRIBUTE ? p.disabled : undefined; },
    setAttribute(key, value) { if (key === Common.OPT_OUT_ATTRIBUTE) p.disabled = value; },
    heal(amount) { p.healed += amount; },
  };
  return p;
}

const npc = { isNpc: () => true, isPlayer: () => false, performGraphic() { npc.graphic = true; } };
const otherPlayer = { isNpc: () => false, isPlayer: () => true };

function hitRoll(target, combatType = core.CombatType.MELEE) {
  const roll = { attacker: fighter(), target, combatType, forceAccurate: false, bypassProtectionPrayer: false };
  globalThis.hooks.get("hit-roll")(roll);
  return roll;
}

test("Berserker/Deadeye/Mystique force an accurate NPC hit of their own style only", () => {
  Common.testing.reset();
  activate("berserker");
  const melee = hitRoll(npc, core.CombatType.MELEE);
  assert.deepEqual([melee.forceAccurate, melee.bypassProtectionPrayer], [true, true]);
  assert.equal(hitRoll(npc, core.CombatType.RANGED).forceAccurate, false, "another style is not Berserker");
  assert.equal(hitRoll(otherPlayer, core.CombatType.MELEE).forceAccurate, false, "PvP is untouched");

  Common.testing.reset();
  activate("deadeye");
  assert.equal(hitRoll(npc, core.CombatType.RANGED).forceAccurate, true);
  assert.equal(hitRoll(npc, core.CombatType.MELEE).forceAccurate, false);

  Common.testing.reset();
  activate("mystique");
  assert.equal(hitRoll(npc, core.CombatType.MAGIC).forceAccurate, true);
  assert.equal(hitRoll(npc, core.CombatType.MAGIC).bypassProtectionPrayer, true);
});

test("a player's opt-out turns the accuracy event off without ending the world event", () => {
  Common.testing.reset();
  activate("berserker");
  const p = fighter();
  Common.setEffectsEnabled(p, "berserker", false);
  const roll = { attacker: p, target: npc, combatType: core.CombatType.MELEE, forceAccurate: false, bypassProtectionPrayer: false };
  globalThis.hooks.get("hit-roll")(roll);
  assert.equal(roll.forceAccurate, false);
  assert.ok(Common.active("combat"), "the event still runs for everyone else");
});

test("Onslaught raises a landed NPC hit by 50% and never touches PvP", () => {
  Common.testing.reset();
  activate("onslaught");
  const damage = { value: 20, getDamage() { return damage.value; }, setDamage(value) { damage.value = value; } };
  globalThis.hooks.get("hit-damage")({ attacker: fighter(), target: npc, damage });
  assert.equal(damage.value, 30);

  const pvp = { value: 20, getDamage() { return pvp.value; }, setDamage(value) { pvp.value = value; } };
  globalThis.hooks.get("hit-damage")({ attacker: fighter(), target: otherPlayer, damage: pvp });
  assert.equal(pvp.value, 20, "a player target is untouched");

  const opted = fighter();
  Common.setEffectsEnabled(opted, "onslaught", false);
  const off = { value: 20, getDamage() { return off.value; }, setDamage(value) { off.value = value; } };
  globalThis.hooks.get("hit-damage")({ attacker: opted, target: npc, damage: off });
  assert.equal(off.value, 20);
});

test("Bloodthirst is the Blood Fury 1-in-5 roll, heals 30% and only works on NPCs", () => {
  Common.testing.reset();
  activate("bloodthirst");
  Math.random = () => 0; // Misc.getRandom(4) === 0
  const owner = fighter();
  let applied;
  const hit = { getHits: () => [{ getDamage: () => 20, onApplied(callback) { applied = callback; } }] };
  globalThis.hooks.get("combat:hit-queued")({ player: owner, target: npc, hit });
  assert.equal(npc.graphic, true, "the proc graphic is shown with the swing");
  applied(20);
  assert.equal(owner.healed, 6, "30% of the damage actually taken");

  owner.healed = 0;
  npc.graphic = false;
  Math.random = () => 0.9; // 4 -> no proc
  globalThis.hooks.get("combat:hit-queued")({ player: owner, target: npc, hit });
  assert.equal(npc.graphic, false);
  assert.equal(owner.healed, 0);

  Math.random = () => 0;
  globalThis.hooks.get("combat:hit-queued")({ player: owner, target: otherPlayer, hit });
  assert.equal(owner.healed, 0, "PvP is untouched");
});

test("Accelerate doubles each XP gain once, and can be switched off per player", () => {
  Common.testing.reset();
  activate("accelerate");
  const first = { player: fighter(), multiplier: 1 };
  globalThis.hooks.get("xp")(first);
  assert.equal(first.multiplier, 2);
  const second = { player: first.player, multiplier: 1 };
  globalThis.hooks.get("xp")(second);
  assert.equal(second.multiplier, 2, "each gain is multiplied once, not recursively");
  const p = fighter();
  Common.setEffectsEnabled(p, "accelerate", false);
  const off = { player: p, multiplier: 1 };
  globalThis.hooks.get("xp")(off);
  assert.equal(off.multiplier, 1);
});

test("Rags to Riches boosts unique NPC tables and the three raid unique rolls, and nothing else", () => {
  Common.testing.reset();
  activate("rags-to-riches");
  const p = fighter();
  const unique = { player: p, rules: [] };
  globalThis.hooks.get("npc-drops:unique-chance")(unique);
  assert.deepEqual(unique.rules.map((rule) => rule.multiplier), [1.1]);
  for (const source of ["Chambers of Xeric", "Theatre of Blood", "Tombs of Amascut"]) {
    const raid = { player: p, source, rules: [] };
    globalThis.hooks.get("drops:chance")(raid);
    assert.equal(raid.rules.length, 1, source);
  }
  const ordinary = { player: p, source: "Barrows", rules: [] };
  globalThis.hooks.get("drops:chance")(ordinary);
  assert.equal(ordinary.rules.length, 0, "a non-unique source is not boosted");
  Common.setEffectsEnabled(p, "rags-to-riches", false);
  const off = { player: p, rules: [] };
  globalThis.hooks.get("npc-drops:unique-chance")(off);
  assert.equal(off.rules.length, 0);
});

test("Prodigy rests every skill at +12, leaves Hitpoints and Prayer alone, and never boosts in PvP", () => {
  Common.testing.reset();
  activate("prodigy");
  const p = new Player(null);
  p.setUsername("prodigy");
  p.setLocation(new Location(3200, 3200, 0));
  p.setRegistered(true);
  const sender = new Proxy({}, { get: () => () => sender });
  p.getPacketSender = () => sender;
  const resting = globalThis.hooks.get("resting");
  assert.equal(resting(p, core.Skill.ATTACK, 60), 72);
  assert.equal(resting(p, core.Skill.HITPOINTS, 60), 60);
  assert.equal(resting(p, core.Skill.PRAYER, 60), 60);

  const skills = p.getSkillManager();
  skills.setCurrentLevel(core.Skill.ATTACK, 1, true);
  const prayer = skills.getCurrentLevel(core.Skill.PRAYER);
  const hitpoints = skills.getCurrentLevel(core.Skill.HITPOINTS);
  globalThis.hooks.get("process")({ player: p });
  assert.equal(skills.getCurrentLevel(core.Skill.ATTACK), skills.getMaxLevel(core.Skill.ATTACK) + 12);
  assert.equal(skills.getCurrentLevel(core.Skill.PRAYER), prayer, "Prayer is not restored");
  assert.equal(skills.getCurrentLevel(core.Skill.HITPOINTS), hitpoints, "Hitpoints are not restored");
  const boosted = skills.getCurrentLevel(core.Skill.ATTACK);
  skills.setCurrentLevel(core.Skill.ATTACK, boosted + 5, true);
  globalThis.hooks.get("process")({ player: p });
  assert.equal(skills.getCurrentLevel(core.Skill.ATTACK), boosted + 5, "a higher boost is preserved");

  const inPvp = new Player(null);
  inPvp.setUsername("pvp-prodigy");
  inPvp.setLocation(new Location(3200, 3200, 0));
  inPvp.setRegistered(true);
  inPvp.getPacketSender = () => sender;
  inPvp.getCombat = () => ({ getTarget: () => otherPlayer });
  const before = inPvp.getSkillManager().getCurrentLevel(core.Skill.ATTACK);
  globalThis.hooks.get("process")({ player: inPvp });
  assert.equal(inPvp.getSkillManager().getCurrentLevel(core.Skill.ATTACK), before, "no boost while fighting a player");
  assert.equal(resting(inPvp, core.Skill.ATTACK, 60), 60);
});
