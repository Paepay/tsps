// Run after `yarn build`: node --test tests/demonic-gorillas.test.cjs
// Demonic and tortured gorillas (plugins/npcs/DemonicGorillas.plugin.js, docs/demonic-gorillas.md).
const assert = require("node:assert/strict");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { PluginManager } = require("../dist/plugins/PluginManager");

const Combat = require("../plugins/npcs/demonicgorillas/Combat.DemonicGorillas");
const Prayer = require("../plugins/npcs/demonicgorillas/Prayer.DemonicGorillas");
const Cavern = require("../plugins/npcs/demonicgorillas/Cavern.DemonicGorillas");
const State = require("../plugins/npcs/demonicgorillas/State.DemonicGorillas");

const core = PluginManager.getCoreApi();
const providers = [];
const customEvents = new Map();
const playerProcess = [];

before(() => {
  const api = {
    core,
    registerNpcCombatMethodProvider: (ids, ctor, options) => providers.push({ ids, ctor, options }),
    onPlayerDealtDamage: () => {},
    onNpcHitModify: () => {},
    registerArea: () => {},
    onPlayerProcess: (handler) => playerProcess.push(handler),
    emitCustomEvent: () => {},
    onCustomEvent: (name, handler) => {
      if (!customEvents.has(name)) customEvents.set(name, []);
      customEvents.get(name).push(handler);
    },
  };
  Combat(api);
  Prayer(api);
  Cavern(api);
});

/** A gorilla stand-in: its id (transformations included), shouts and animations. */
function gorilla(id, { target = null } = {}) {
  const npc = {
    id, shouts: [], anims: [], target,
    isNpc: () => true,
    getId: () => npc.id,
    getRealId: () => id,
    getHitpoints: () => 380,
    setNpcTransformationId: (next) => { npc.id = next; },
    performAnimation: (animation) => npc.anims.push(animation.getId()),
    forceChat: (text) => npc.shouts.push(text),
    getCombat: () => ({ getTarget: () => npc.target }),
  };
  return npc;
}

function hit(type, damage, { bypass = false } = {}) {
  const parts = [{ damage, setDamage(value) { this.damage = value; } }];
  return {
    getCombatType: () => type,
    getHits: () => parts,
    getTotalDamage: () => parts.reduce((sum, part) => sum + part.damage, 0),
    updateTotalDamage() {},
    bypassesProtectionPrayer: () => bypass,
  };
}

test("every demonic and level 141 tortured gorilla id gets a per-attack combat method", () => {
  assert.deepEqual(providers[0].ids, [7144, 7145, 7146, 7147, 7148, 7149, 7150, 7151]);
  assert.equal(providers[0].options.singleton, false);
});

test("projectiles land when the capture says: 46 cycles, then 5 a tile (rock) or 4 (spell)", () => {
  const { projectileEnd, hitDelay } = Combat;
  assert.equal(projectileEnd({ delay: 46, cyclesPerTile: 5 }, 1), 51);
  assert.equal(projectileEnd({ delay: 46, cyclesPerTile: 4 }, 1), 50);
  // The hit shows on the first tick (30 cycles) at or after the landing (#1862).
  assert.equal(hitDelay(51), 2);
  assert.equal(hitDelay(60), 2);
  assert.equal(hitDelay(61), 3);
  for (const spec of [{ delay: 46, cyclesPerTile: 5 }, { delay: 46, cyclesPerTile: 4 }]) {
    for (const tiles of [1, 4, 10]) {
      const end = projectileEnd(spec, tiles);
      assert.ok(hitDelay(end) * 30 >= end && (hitDelay(end) - 1) * 30 < end, `${spec.cyclesPerTile}/tile, ${tiles} tiles`);
    }
  }
});

test("a boulder takes a third of the hitpoints, rounded down, and never kills", () => {
  assert.equal(Combat.boulderDamage(120), 40);
  assert.equal(Combat.boulderDamage(99), 33);
  assert.equal(Combat.boulderDamage(1), 0);
});

/**
 * A boulder victim whose turn has just run. `location` is moved before the handler is called,
 * as the world does: the impact is drawn with the step that landed the player on (or took them
 * off) the tile.
 */
function boulderPlayer(location, hitpoints = 99) {
  const hits = [];
  return {
    hits,
    getPrivateArea: () => null,
    getHitpoints: () => hitpoints,
    getLocation: () => location,
    getCombat: () => ({ getHitQueue: () => ({ addPendingDamage: (parts) => hits.push(parts) }) }),
  };
}

function settle(player) {
  for (const handler of playerProcess) handler({ player });
}

test("a boulder misses a player who steps off its tile on the landing tick (#151)", () => {
  const tile = new core.Location(2100, 5660, 0);
  const player = boulderPlayer(new core.Location(2101, 5660, 0));
  Combat.armBoulder(tile, null);
  settle(player);
  assert.equal(player.hits.length, 0, "the rock is behind them when it lands");
});

test("a boulder hits a player still on its tile, and one who steps onto it", () => {
  const still = new core.Location(2102, 5660, 0);
  Combat.armBoulder(still, null);
  const standing = boulderPlayer(new core.Location(2102, 5660, 0), 99);
  settle(standing);
  assert.equal(standing.hits.length, 1);
  assert.equal(standing.hits[0][0].getDamage(), 33);

  const arriving = new core.Location(2103, 5660, 0);
  Combat.armBoulder(arriving, null);
  const stepOn = boulderPlayer(new core.Location(2103, 5660, 0), 120);
  settle(stepOn);
  assert.equal(stepOn.hits.length, 1);
  assert.equal(stepOn.hits[0][0].getDamage(), 40);
});

test("one boulder hits each player on its tile once", () => {
  const tile = new core.Location(2104, 5660, 0);
  Combat.armBoulder(tile, null);
  const first = boulderPlayer(new core.Location(2104, 5660, 0));
  const second = boulderPlayer(new core.Location(2104, 5660, 0));
  const elsewhere = boulderPlayer(new core.Location(2105, 5660, 0));
  settle(first);
  settle(second);
  settle(elsewhere);
  assert.equal(first.hits.length, 1);
  assert.equal(second.hits.length, 1);
  assert.equal(elsewhere.hits.length, 0);
});

test("the method's style and reach follow the gorilla's fight", () => {
  const npc = gorilla(7144);
  const method = new providers[0].ctor(npc);
  State.stateOf(npc).style = "melee";
  assert.equal(method.type(), core.CombatType.MELEE);
  assert.equal(method.attackDistance(), 1);
  State.stateOf(npc).style = "magic";
  assert.equal(method.type(), core.CombatType.MAGIC);
  assert.equal(method.attackDistance(), 7);
  assert.equal(method.attackSpeed(), 5);
});

test("three misses change a demonic gorilla's style, four a tortured one's, with a scream", () => {
  for (const [id, misses] of [[7144, 3], [7150, 4]]) {
    const npc = gorilla(id);
    const state = State.stateOf(npc);
    state.style = "ranged";
    for (let i = 1; i < misses; i++) State.countMiss(npc, state);
    assert.equal(state.style, "ranged");
    State.countMiss(npc, state, () => 0.99);
    assert.notEqual(state.style, "ranged");
    assert.equal(state.misses, 0);
    assert.deepEqual(npc.shouts, ["Rhaaaaaaa!"]);
  }
});

test("a style change never picks the same style", () => {
  for (const roll of [0, 0.5, 0.99]) {
    for (const from of ["melee", "ranged", "magic"]) assert.notEqual(State.randomStyle(() => roll, from), from);
  }
});

test("its prayer stops hits in its style unless Verac's set gets through", () => {
  const npc = gorilla(7145); // _1_ranged
  assert.equal(State.protecting(npc), "ranged");
  assert.equal(Prayer.blocks(npc, hit(core.CombatType.RANGED, 20)), true);
  assert.equal(Prayer.blocks(npc, hit(core.CombatType.MELEE, 20)), false);
  assert.equal(Prayer.blocks(gorilla(7144), hit(core.CombatType.MELEE, 20, { bypass: true })), false);
});

test("four damaging hits and 70 damage off-prayer switch it to the last hit's style", () => {
  const npc = gorilla(7148); // _2_ranged
  for (const damage of [30, 30, 0, 9]) Prayer.countOffPrayer(npc, hit(core.CombatType.MELEE, damage));
  assert.equal(npc.getId(), 7148, "a zero is not a damaging hit, and 69 is short");
  Prayer.countOffPrayer(npc, hit(core.CombatType.MAGIC, 1));
  assert.equal(npc.getId(), 7149, "the same colour, protecting against Magic");
  assert.deepEqual(npc.anims, [7228]);
  assert.equal(State.stateOf(npc).offPrayerHits, 0);
});

test("in Melee with a target it can't reach, it changes style after 10 ticks", () => {
  const npc = gorilla(7150, { target: {} });
  const state = State.stateOf(npc);
  state.style = "melee";
  for (let i = 0; i < 9; i++) Cavern.ageMelee(npc);
  assert.equal(state.style, "melee");
  Cavern.ageMelee(npc);
  assert.notEqual(state.style, "melee");
  npc.target = null;
  state.style = "melee";
  for (let i = 0; i < 20; i++) Cavern.ageMelee(npc);
  assert.equal(state.style, "melee", "no target, no count");
});
test("a demonic gorilla reports the style its id prays against to league masteries", () => {
  const answers = customEvents.get("combat:scripted-protection") ?? [];
  assert.ok(answers.length > 0, "the damage passives' query is answered");
  const cases = [[7144, "melee"], [7145, "ranged"], [7146, "magic"], [7147, "melee"], [7148, "ranged"], [7149, "magic"]];
  const typeOf = { melee: core.CombatType.MELEE, ranged: core.CombatType.RANGED, magic: core.CombatType.MAGIC };
  for (const [id, style] of cases) {
    const npc = gorilla(id);
    for (const [combatType, name] of Object.entries(typeOf)) {
      const query = { target: npc, combatType, protecting: false };
      for (const answer of answers) answer(query);
      assert.equal(query.protecting, style === name, `${id} ${name}`);
    }
  }
  const tortured = gorilla(7150);
  const query = { target: tortured, combatType: core.CombatType.MELEE, protecting: false };
  for (const answer of answers) answer(query);
  assert.equal(query.protecting, false, "tortured gorillas do not pray");
});
