// Run after `yarn build`: node --test tests/league-combat-prayer-penetration.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const core = PluginManager.getCoreApi();

function attachPassives() {
  const handlers = new Map();
  const on = (name, handler) => {
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push(handler);
  };
  const api = {
    core,
    onCustomEvent: on,
    registerRangedAmmoHandler() {},
    registerMeleeAttackAccuracyModifier() {},
    registerRangedAttackAccuracyModifier() {},
    registerMagicAttackAccuracyModifier() {},
    registerIncomingDamageModifier() {},
    onCombatHitRoll: (handler) => on('hit-roll', handler),
    onCombatHitDamage: (handler) => on('hit-damage', handler),
    emitCustomEvent: (name, payload) => {
      if (name === 'level-up:mastery-profile' && payload) payload.active = true;
      if (name === 'combat:scripted-protection' && payload) {
        const style = payload.combatType === core.CombatType.MELEE ? 'melee'
          : payload.combatType === core.CombatType.RANGED ? 'ranged'
            : payload.combatType === core.CombatType.MAGIC ? 'magic' : null;
        payload.protecting = style !== null && payload.target?.__scriptedPrayer === style;
      }
    },
  };
  const Common = require('../plugins/modes/leaguemasteries/Common.LeagueCombatMasteries');
  Common.init(api);
  require('../plugins/modes/leaguemasteries/Passives.LeagueCombatMasteries')(api);
  return handlers;
}

const player = {
  isPlayer: () => true,
  getAttribute: (key) => (key === 'league:masteries' ? { melee: 6, ranged: 0, magic: 0 } : undefined),
};

test('prayer penetration recognises the Hunllef scripted protection prayer', () => {
  const handlers = attachPassives();
  const target = { isPlayer: () => false, isNpc: () => true, __gauntletHunllef: { protecting: 'ranged' } };
  const roll = { attacker: player, target, combatType: core.CombatType.RANGED, bypassProtectionPrayer: false };
  for (const handler of handlers.get('hit-roll') ?? []) handler(roll);
  assert.equal(roll.bypassProtectionPrayer, true, 'the ranged hit bypasses Protect from Missiles');

  const damage = {
    value: 100,
    getDamage() { return this.value; },
    setDamage(value) { this.value = value; },
  };
  for (const handler of handlers.get('hit-damage') ?? []) {
    handler({ attacker: player, target, combatType: core.CombatType.RANGED, damage });
  }
  assert.equal(damage.value, 60, '60% penetration leaves 60 damage on an NPC prayer block');
});

test('the Hunllef does not count as praying against another style', () => {
  const handlers = attachPassives();
  const target = {
    isPlayer: () => false,
    isNpc: () => true,
    getPrayerActive: () => [],
    __gauntletHunllef: { protecting: 'ranged' },
  };
  const roll = { attacker: player, target, combatType: core.CombatType.MAGIC, bypassProtectionPrayer: false };
  for (const handler of handlers.get('hit-roll') ?? []) handler(roll);
  assert.equal(roll.bypassProtectionPrayer, false);
});
test('prayer penetration recognises a protection prayer another plugin reports by script', () => {
  const handlers = attachPassives();
  const target = { isPlayer: () => false, isNpc: () => true, getPrayerActive: () => [], __scriptedPrayer: 'melee' };
  const roll = { attacker: player, target, combatType: core.CombatType.MELEE, bypassProtectionPrayer: false };
  for (const handler of handlers.get('hit-roll') ?? []) handler(roll);
  assert.equal(roll.bypassProtectionPrayer, true, 'the reported melee prayer is bypassed');

  const miss = { attacker: player, target, combatType: core.CombatType.MAGIC, bypassProtectionPrayer: false };
  for (const handler of handlers.get('hit-roll') ?? []) handler(miss);
  assert.equal(miss.bypassProtectionPrayer, false, 'a magic hit sees no melee prayer');
});
