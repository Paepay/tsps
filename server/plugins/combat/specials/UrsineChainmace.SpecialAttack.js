/**
 * Bear Down (https://oldschool.runescape.wiki/w/Ursine_chainmace): 50% special energy.
 * Usable only while the chainmace is charged (the uncharged ids are not registered).
 * Doubled accuracy rolled against the target's slash defence, then on a successful /
 * damaging hit: 20 damage over 6 seconds (five hits of 4), 20 Agility drained and
 * running prevented for 6 ticks (3.6 seconds).
 */
module.exports = function registerUrsineChainmaceSpecialAttack(api) {
  const { Animation, CombatSpecial, HitDamage, HitMask, ItemIdentifiers, MeleeCombatMethod, Skill, Task, TaskManager } = api.core;

  const ID = "ursine_chainmace";
  const DRAIN = 50;
  const ACCURACY_MULTIPLIER = 2;
  const SLASH_DEFENCE_BONUS_INDEX = 1;
  const BLEED_TOTAL_DAMAGE = 20;
  const BLEED_HITS = 5;
  const BLEED_DAMAGE = BLEED_TOTAL_DAMAGE / BLEED_HITS;
  const BLEED_INTERVAL_TICKS = 2;
  const RUN_BLOCK_TICKS = 6;
  const AGILITY_DRAIN = 20;
  const ANIMATION = new Animation(1060); // the mace special attack (the chainmaces share the mace model)
  const BLEED_TASK_KEY_ATTRIBUTE = "combat:ursine-bleed:task-key";

  function drainAgility(target) {
    if (!target.isPlayer()) return;
    const skills = target.getAsPlayer().getSkillManager();
    const current = skills.getCurrentLevel(Skill.AGILITY);
    const next = Math.max(0, current - AGILITY_DRAIN);
    if (next === current) return;
    skills.setCurrentLevels(Skill.AGILITY, next);
    target.getAsPlayer().sendMessage(`Your Agility level is drained by ${current - next}.`);
  }

  function applyBearDown(attacker, target) {
    const player = target.isPlayer() ? target.getAsPlayer() : null;
    // One Bear Down at a time, as with the other bleeds.
    const previous = player?.getAttribute?.(BLEED_TASK_KEY_ATTRIBUTE);
    if (previous) TaskManager.cancelTasks(previous);
    const key = {};
    player?.setAttribute?.(BLEED_TASK_KEY_ATTRIBUTE, key);

    const wasRunning = !!player?.isRunning?.();
    if (player) {
      player.setRunning(false);
      player.getPacketSender?.().sendRunStatus?.();
    }

    const clear = () => player?.setAttribute?.(BLEED_TASK_KEY_ATTRIBUTE, null);
    let elapsed = 0;
    let hits = 0;
    TaskManager.submit(new (class extends Task {
      constructor() {
        super(1, key);
      }

      execute() {
        elapsed++;
        if (!attacker.isRegistered() || !target.isRegistered() || target.getHitpoints() <= 0) {
          clear();
          this.stop();
          return;
        }
        if (elapsed === RUN_BLOCK_TICKS && player && wasRunning && player.getRunEnergy() > 0) {
          player.setRunning(true);
          player.getPacketSender?.().sendRunStatus?.();
        }
        if (elapsed % BLEED_INTERVAL_TICKS === 0 && hits < BLEED_HITS) {
          hits++;
          target.getCombat().getHitQueue().addPendingDamage([new HitDamage(BLEED_DAMAGE, HitMask.RED).setSource(attacker)]);
        }
        if (hits >= BLEED_HITS) {
          clear();
          this.stop();
        }
      }
    })());
  }

  class UrsineChainmaceCombatMethod extends MeleeCombatMethod {
    start(character, target) {
      CombatSpecial.drain(character, DRAIN);
      character.performAnimation(ANIMATION);
    }

    handleAfterHitEffects(hit) {
      if (!hit.isAccurate() || Math.floor(hit.getTotalDamage()) <= 0) return;
      const attacker = hit.getAttacker();
      const target = hit.getTarget();
      if (!attacker.isPlayer() || (!target.isPlayer() && !target.isNpc())) return;
      drainAgility(target);
      applyBearDown(attacker, target);
    }
  }

  api.registerCombatSpecial({
    id: ID,
    itemIds: [ItemIdentifiers.URSINE_CHAINMACE, ItemIdentifiers.URSINE_CHAINMACE_2],
    drainAmount: DRAIN,
    strengthMultiplier: 1,
    accuracyMultiplier: ACCURACY_MULTIPLIER,
    traits: {
      hitCount: 1,
      accuracyMultiplier: ACCURACY_MULTIPLIER,
      damageMultiplier: 1,
      meleeDefenceBonusIndex: SLASH_DEFENCE_BONUS_INDEX,
    },
    combatMethod: new UrsineChainmaceCombatMethod(),
  });
};
