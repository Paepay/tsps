// node --test tests/ursine-chainmace-special.test.cjs
// Bear Down: charged-only, 50% energy, doubled slash accuracy, 20 bleed over 6 seconds,
// 20 Agility drained and a 6-tick run block.
const assert = require("node:assert/strict");
const { test } = require("node:test");

function setup() {
  let registered = null;
  const log = { drains: [], animation: null, tasks: [], cancelled: [] };
  class MeleeCombatMethod {}
  class Task {
    constructor(interval, key) { this.interval = interval; this.key = key; this.stopped = false; }
    stop() { this.stopped = true; }
  }
  const core = {
    Animation: class { constructor(id) { this.id = id; } },
    HitDamage: class { constructor(amount, mask) { this.amount = amount; this.mask = mask; } setSource(source) { this.source = source; return this; } },
    HitMask: { RED: "red" },
    CombatSpecial: { drain: (character, amount) => log.drains.push(amount) },
    ItemIdentifiers: { URSINE_CHAINMACE: 27660, URSINE_CHAINMACE_2: 27661, URSINE_CHAINMACE_U_: 27657 },
    MeleeCombatMethod,
    Skill: { AGILITY: 16 },
    Task,
    TaskManager: {
      submit: (task) => log.tasks.push(task),
      cancelTasks: (key) => log.cancelled.push(key),
    },
  };
  require("../plugins/combat/specials/UrsineChainmace.SpecialAttack")({ core, registerCombatSpecial: (definition) => { registered = definition; } });

  const abilities = { current: 99, max: 99 };
  const messages = [];
  const attributes = new Map();
  const damage = [];
  const target = {
    running: true,
    runEnergy: 100,
    hits: 50,
    isPlayer: () => true,
    isNpc: () => false,
    isRegistered: () => true,
    getAsPlayer() { return this; },
    getHitpoints() { return this.hits; },
    getRunEnergy() { return this.runEnergy; },
    isRunning() { return this.running; },
    setRunning(running) { this.running = running; },
    getPacketSender: () => ({ sendRunStatus() { target.statusSent = (target.statusSent ?? 0) + 1; } }),
    getSkillManager: () => ({
      getCurrentLevel: () => abilities.current,
      setCurrentLevels: (skill, level) => { assert.equal(skill, 16); abilities.current = level; },
    }),
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getCombat: () => ({ getHitQueue: () => ({ addPendingDamage: (hits) => damage.push(...hits) }) }),
    sendMessage: (message) => messages.push(message),
  };
  const attacker = {
    isPlayer: () => true,
    isRegistered: () => true,
    performAnimation: (animation) => { log.animation = animation.id; },
  };
  const hit = (accurate = true, total = 20) => ({
    isAccurate: () => accurate,
    getTotalDamage: () => total,
    getAttacker: () => attacker,
    getTarget: () => target,
  });
  return { special: registered, method: registered.combatMethod, attacker, target, hit, log, attributes, damage, abilities, messages };
}

test("only the charged chainmaces offer Bear Down", () => {
  const { special, log } = setup();
  assert.deepEqual(special.itemIds, [27660, 27661]);
  assert.equal(special.drainAmount, 50);
  assert.equal(special.accuracyMultiplier, 2);
  assert.equal(special.traits.meleeDefenceBonusIndex, 1, "rolled against slash defence");
  assert.equal(log.drains.length, 0);
});

test("the swing drains 50% energy and plays the mace special animation", () => {
  const { method, attacker, target, log } = setup();
  method.start(attacker, target);
  assert.deepEqual(log.drains, [50]);
  assert.equal(log.animation, 1060);
});

test("a successful hit bleeds 20 over six seconds, drains 20 Agility and blocks running for 6 ticks", () => {
  const { method, attacker, target, hit, damage, abilities, messages, log } = setup();
  method.handleAfterHitEffects(hit());
  assert.equal(abilities.current, 79);
  assert.match(messages[0], /Agility level is drained by 20/);
  assert.equal(target.running, false);
  assert.equal(log.tasks.length, 1);

  const task = log.tasks[0];
  for (let tick = 1; tick <= 10; tick++) task.execute();
  assert.equal(damage.length, 5);
  assert.deepEqual(damage.map((entry) => entry.amount), [4, 4, 4, 4, 4]);
  assert.equal(target.running, true, "run is restored after 6 ticks");
  assert.equal(task.stopped, true);
  assert.equal(target.statusSent, 2, "off at the hit and on after 6 ticks");
});

test("a miss or a zero deals no bleed, no Agility drain and no run block", () => {
  for (const [accurate, total] of [[false, 20], [true, 0]]) {
    const { method, target, hit, damage, abilities, log } = setup();
    method.handleAfterHitEffects(hit(accurate, total));
    assert.equal(damage.length, 0);
    assert.equal(abilities.current, 99);
    assert.equal(target.running, true);
    assert.equal(log.tasks.length, 0);
  }
});

test("a new Bear Down replaces the active bleed on the same target", () => {
  const { method, target, hit, attributes, log } = setup();
  method.handleAfterHitEffects(hit());
  const firstKey = attributes.get("combat:ursine-bleed:task-key");
  method.handleAfterHitEffects(hit());
  assert.deepEqual(log.cancelled, [firstKey]);
  assert.equal(log.tasks.length, 2);
});
