// From server/: node --test tests/dawnbringer.test.cjs (after yarn build and yarn ensure-cache).
//
// Issue #167: the Dawnbringer had no ordinary combat method, so the combat factory fell back to
// melee and ran the player up to Verzik; its special also kept the bare CombatMethod's one-tile
// reach. This loads the plugins the way the server does and drives the real resolvers.
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const core = PluginManager.getCoreApi();
const I = core.ItemIdentifiers;
const { CombatSpecial } = core;
const { CombatType } = require('../dist/game/content/combat/CombatType');
const { FightStyle } = require('../dist/game/content/combat/FightStyle');

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  PluginManager.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  PluginManager.emitServerStartup({});
});
after(() => PluginManager.emitServerShutdown({}));

function fakePlayer({ weapon = I.DAWNBRINGER, style = FightStyle.ACCURATE, magic = 99, specialArmed = false } = {}) {
  const combat = {
    castSpell: null,
    setCastSpell(spell) { combat.castSpell = spell; },
    getSelectedSpell() { return combat.castSpell; },
    getCastSpell() { return combat.castSpell; },
    getAutocastSpell() { return null; },
    getPreviousCast() { return null; },
    getTarget() { return null; },
    getRangedWeapon() { return null; },
    reset() {},
    setPreviousCast() {},
  };
  const player = {
    isPlayer: () => true,
    getAsPlayer: () => player,
    getUsername: () => "Dawn",
    getPacketSender: () => new Proxy({ getVarp: () => 0 }, { get: (target, key) => target[key] ?? (() => {}) }),
    getEquipment: () => ({
      get: (slot) => (slot === core.Equipment.WEAPON_SLOT ? { getId: () => weapon } : null),
      getItems: () => [],
    }),
    getWeapon: () => null,
    getCombat: () => combat,
    getCombatSpecial: () => (specialArmed ? CombatSpecial.getById('dawnbringer') : null),
    isSpecialActivated: () => specialArmed,
    getFightType: () => ({ getStyle: () => style }),
    getSkillManager: () => ({ getCurrentLevel: (skill) => (skill === core.Skill.MAGIC ? magic : 1) }),
  };
  return player;
}

function resolvedFor(player) {
  for (const resolver of PluginManager.getCombatMethodResolvers()) {
    const method = resolver.resolve(player);
    if (method) return method;
  }
  return null;
}

test('the worn Dawnbringer resolves to its own magic spell instead of falling back to melee', () => {
  const method = resolvedFor(fakePlayer());
  assert.ok(method, 'a resolver answered for the Dawnbringer');
  assert.equal(method.type(), CombatType.MAGIC);
  assert.equal(method.attackDistance(fakePlayer()), 7, 'the Wiki range is 7 tiles');
  assert.equal(method.attackDistance(fakePlayer({ style: FightStyle.DEFENSIVE })), 9, 'Longrange adds two tiles');
  assert.equal(method.attackSpeed(), 4);
  assert.equal(resolvedFor(fakePlayer({ weapon: I.TRIDENT_OF_THE_SEAS })), null, 'another weapon is untouched');
  assert.equal(resolvedFor(fakePlayer({ weapon: -1 })), null, 'an empty weapon slot is untouched');
});

test('an armed Pulsate steps the ordinary resolver aside so the special owns the swing', () => {
  assert.equal(resolvedFor(fakePlayer({ specialArmed: true })), null);
});

test('the ordinary spell always lands and rolls the Wiki maximum hit', () => {
  const player = fakePlayer();
  const method = resolvedFor(player);
  assert.equal(method.canAttack(player), true);
  const spell = player.getCombat().getSelectedSpell();
  assert.ok(spell, 'the built-in spell is selected for the max-hit roll');
  assert.equal(spell.maximumHit(), 15, 'floor((floor(99 / 3) - 2) / 2)');
  assert.equal(fakePlayer({ magic: 1 }).getSkillManager().getCurrentLevel(core.Skill.MAGIC), 1);
  assert.equal(resolvedFor(fakePlayer({ magic: 0 })).canAttack(fakePlayer({ magic: 0 })), true);
});

test('Pulsate is a magic special with the staff range and speed', () => {
  const special = CombatSpecial.getById('dawnbringer');
  assert.ok(special, 'the special is registered');
  assert.equal(CombatSpecial.getForWeaponId(I.DAWNBRINGER), special);
  const method = special.getCombatMethod();
  assert.equal(method.type(), CombatType.MAGIC);
  assert.equal(method.attackDistance(), 7, 'it no longer walks into melee to fire');
  assert.equal(method.attackSpeed(), 4);
});
