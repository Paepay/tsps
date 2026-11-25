"use strict";

/**
 * A tormented demon's defences against the player (Wiki: Tormented Demon/Strategies):
 * - its protection prayer stops the style it protects against. Every 150 damage it takes it
 *   switches to the style it was last hit with, and doesn't attack for 6 ticks;
 * - its fire shield cuts damage by 20%, except from demonbane and abyssal weapons and demonbane
 *   spells. It drops a tick after the player's first attack and after every fire bomb, and
 *   stays down for one attack: that attack takes 4 ticks (one less for each other demon on the
 *   player) and, for crush melee, heavy ranged (crossbows, ballistae) and spells cast without a
 *   powered staff, deals X^2 - 16 more damage, X its usual attack speed. Against the demon's
 *   prayer that bonus still lands, divided by 3. The attack after it restores the shield;
 * - 30 ticks after the shield first drops it is defenceless (its flames go out): every attack on
 *   it lands, until the first one after its next fire bomb, when the 30 ticks start again.
 *
 * Captured: the shield graphic on every attack launched at it, the drop (sequence, graphic and
 * sounds) the tick after the first, the restore graphic on the attack after the unshielded one,
 * the defenceless graphic, and its first attack 8 ticks after the drop.
 */

const Shared = require("./Shared.TormentedDemons");
const { isDemonbaneAttack } = require("../../combat/effects/Demonbane.EquipmentEffects");
const { weaponName } = require("../../combat/effects/GearChecks.EquipmentEffects");

const { SEQ, SPOT, SOUND, PRAYER_SWAP_DAMAGE, PRAYER_SWAP_STALL, DEFENCELESS_TICKS, SHIELD_DAMAGE_PERCENT, UNSHIELDED_ATTACK_SPEED } = Shared;

const CRUSH = 2;
const HEAVY_RANGED = new Set(["CROSSBOW", "KARILS_CROSSBOW", "BALLISTA"]);
const POWERED_STAFF = "POWERED_STAFF";
/** Captured: the demon's first attack comes 8 ticks after its shield drops. */
const FIRST_ATTACK_TICKS = 8;

function weaponType(player) {
  return player.getWeapon?.()?.getName?.() ?? "";
}

/** A crossbow or ballista: the heavy ranged weapons. */
function heavyRanged(player) {
  return HEAVY_RANGED.has(weaponType(player));
}

/** Whether the unshielded attack's bonus applies to this player's attack of `combatType`. */
function bonusEligible(player, combatType) {
  const { CombatType } = Shared.core();
  if (combatType === CombatType.MELEE) return player.getFightType?.()?.getBonusType?.() === CRUSH;
  if (combatType === CombatType.RANGED) return heavyRanged(player);
  if (combatType === CombatType.MAGIC) {
    const combat = player.getCombat();
    // A powered staff's built-in spell is its autocast; a spell cast by hand still counts.
    if (weaponType(player) === POWERED_STAFF && !combat.getCastSpell()) return false;
    return combat.getSelectedSpell() != null;
  }
  return false;
}

/** The player's usual attack speed for their current attack. */
function usualSpeed(player, method) {
  const resolved = method ?? Shared.core().CombatFactory.getMethod(player);
  return resolved?.attackSpeed?.(player) ?? 4;
}

function unshieldedBonus(player, combatType, speed = usualSpeed(player)) {
  if (!bonusEligible(player, combatType)) return 0;
  return speed > 4 ? speed * speed - 16 : 0;
}

function pierces(player) {
  return isDemonbaneAttack(player) || weaponName(player).startsWith("abyssal");
}

/** The shield drops: on the tick after the first attack, and after every fire bomb. */
function dropShield(fight, player, withSounds = true) {
  const { Animation } = Shared.core();
  fight.shield = "down";
  if (withSounds) {
    fight.npc.performAnimation(new Animation(SEQ.EXPLOSION_FIRE));
    Shared.sounds(player, SOUND.SHIELD_DROP);
  }
  Shared.spotanim(fight.npc, SPOT.SHIELD_DROP);
}

function startFight(fight, player) {
  const { Task, TaskManager } = Shared.core();
  fight.started = true;
  fight.shield = "dropping";
  const npc = fight.npc;
  const task = new Task(1, false);
  task.execute = () => {
    task.stop();
    if (Shared.fights.get(npc) !== fight || npc.getHitpoints() <= 0 || fight.shield !== "dropping") return;
    dropShield(fight, player);
    fight.defencelessAt = Shared.tick() + DEFENCELESS_TICKS;
    npc.getCombat().setAttackDelay(Math.max(npc.getCombat().getAttackDelay(), FIRST_ATTACK_TICKS));
    if (!npc.getCombat().getTarget() && player.getHitpoints() > 0) npc.getCombat().attack(player);
  };
  TaskManager.submit(task);
}

/** An attack launched at the demon: once per attack, before its accuracy roll. */
function launch(fight, player, combatType) {
  const now = Shared.tick();
  const entry = { cycle: now, shielded: true, bonus: 0, speed: 0 };
  if (!fight.started) {
    Shared.spotanim(fight.npc, SPOT.SHIELD);
    startFight(fight, player);
  } else if (fight.shield === "down") {
    entry.shielded = false;
    entry.speed = usualSpeed(player);
    entry.bonus = unshieldedBonus(player, combatType, entry.speed);
    fight.shield = "spent";
    Shared.spotanim(fight.npc, SPOT.SHIELD);
  } else if (fight.shield === "spent") {
    fight.shield = "up";
    Shared.spotanim(fight.npc, SPOT.SHIELD_RESTORE);
  } else {
    Shared.spotanim(fight.npc, SPOT.SHIELD);
  }
  return entry;
}

/** Defenceless: every attack lands. The first after a fire bomb ends it and restarts the 30 ticks. */
function rollAccuracy(fight, roll) {
  if (!fight.defenceless) return;
  roll.forceAccurate = true;
  if (!fight.defencelessUntilHit) return;
  Shared.setDefenceless(fight, false);
  fight.defencelessAt = Shared.tick() + DEFENCELESS_TICKS;
}

function onHitRoll(roll) {
  const { attacker, target } = roll;
  if (!attacker?.isPlayer?.() || !Shared.isDemon(target)) return;
  const fight = Shared.fightOf(target);
  const player = attacker.getAsPlayer();
  const queue = fight.launches.get(player) ?? [];
  // Multi-hit attacks roll once a hit; only the first is the attack.
  if (queue.length === 0 || queue[queue.length - 1].cycle !== Shared.tick()) {
    require("./Combat.TormentedDemons").engage(fight, player);
    queue.push(launch(fight, player, roll.combatType));
    fight.launches.set(player, queue);
  }
  rollAccuracy(fight, roll);
}

/** The unshielded attack's speed: 4 ticks, one less per other demon on the player (Wiki). */
function onAttackTiming(event) {
  const { attacker, target, method } = event;
  if (!attacker?.isPlayer?.() || !Shared.isDemon(target)) return;
  const fight = Shared.fights.get(target);
  if (fight?.shield !== "down" || !method) return;
  const player = attacker.getAsPlayer();
  if (!bonusEligible(player, method.type()) || usualSpeed(player, method) <= UNSHIELDED_ATTACK_SPEED) return;
  const others = Math.max(0, Shared.demonsFighting(player).length - 1);
  event.keepDelay = true;
  event.minimumDelay = Math.max(1, UNSHIELDED_ATTACK_SPEED - others);
}

function setDamage(hit, amounts) {
  const { HitMask } = Shared.core();
  const hits = hit.getHits();
  hits.forEach((part, i) => {
    part.setDamage(amounts[i]);
    if (amounts[i] > 0 && part.getHitmask() === HitMask.BLUE) part.setHitmask(HitMask.RED);
  });
  hit.updateTotalDamage();
}

function swapPrayer(fight, style) {
  const npc = fight.npc;
  fight.damageSinceSwap = 0;
  Shared.setPrayer(npc, style);
  npc.getCombat().extendAttackDelay(PRAYER_SWAP_STALL);
}

/** A hit landing on the demon: prayer, shield and the unshielded bonus, then the prayer count. */
function onHitModify({ npc, hit }) {
  if (!Shared.isDemon(npc) || !hit) return;
  const fight = Shared.fightOf(npc);
  const attacker = hit.getAttacker?.();
  const player = attacker?.isPlayer?.() ? attacker.getAsPlayer() : null;
  const entry = (player && fight.launches.get(player)?.shift()) ?? { shielded: fight.shield !== "down", bonus: 0 };
  const style = Shared.styleOf(hit.getCombatType());
  const prayed = Shared.prayerOf(npc) === style;
  const bypassed = hit.bypassesProtectionPrayer?.() === true;
  // PendingHit caps the rolled damage to the target's HP before the hit lands. The shield must
  // cut the roll, not that cap: at 1 HP a shielded 30 otherwise became floor(1 * 0.8) = 0 and
  // the demon could not be finished without switching attack style.
  const parts = hit.getHits().map((part) => ({ damage: part.getDamage(), rolled: part.getDamageBeforeCap() }));
  let amounts;
  if (prayed) {
    const cut = entry.shielded && !(player && pierces(player));
    amounts = parts.map((part, i) => {
      const kept = bypassed ? (cut ? Math.floor((part.rolled * SHIELD_DAMAGE_PERCENT) / 100) : part.damage) : 0;
      return kept + (i === 0 ? Math.floor(entry.bonus / 3) : 0);
    });
  } else {
    const cut = entry.shielded && !(player && pierces(player));
    amounts = parts.map((part, i) => (cut ? Math.floor((part.rolled * SHIELD_DAMAGE_PERCENT) / 100) : part.damage)
      + (i === 0 ? entry.bonus : 0));
  }
  let remaining = typeof npc.getHitpoints === "function" ? Math.max(0, npc.getHitpoints()) : Infinity;
  amounts = amounts.map((amount) => {
    const applied = Math.min(Math.max(0, amount), remaining);
    remaining -= applied;
    return applied;
  });
  setDamage(hit, amounts);
  const total = amounts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return;
  if (!entry.shielded && entry.speed >= Shared.SLOW_ATTACK_TICKS) fight.slowUnshieldedHit = true;
  fight.damageSinceSwap += total;
  if (fight.damageSinceSwap >= PRAYER_SWAP_DAMAGE) swapPrayer(fight, style);
}

function attach(api) {
  api.onCombatHitRoll(onHitRoll);
  api.onAttackTiming(onAttackTiming);
  api.onNpcHitModify(onHitModify);
}

module.exports = { attach, dropShield, heavyRanged, _test: { bonusEligible, unshieldedBonus, launch, onHitModify, onAttackTiming } };
