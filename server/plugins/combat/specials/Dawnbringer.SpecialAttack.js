/**
 * Dawnbringer (https://oldschool.runescape.wiki/w/Dawnbringer, issue #167).
 *
 * Its ordinary attack is a powered staff's built-in spell: 7 tiles (9 on Longrange), speed 4,
 * always successful, no base experience, max hit floor((floor(Magic / 3) - 2) / 2), at least 2.
 * Before this file registered a combat method resolver, CombatFactory found no spell and no
 * ranged weapon, so it fell back to melee and the player ran up to Verzik. The special, Pulsate,
 * is gated to Verzik's shield phase by Entry.TheatreOfBlood.js and rolls a guaranteed 75-150.
 *
 * Cache gameval: DAWNBRINGER_CASTING 1543, _PROJECTILE 1544, _IMPACT 1545 and the special's
 * 1546 / 1547 / 1548.
 */
module.exports = function registerDawnbringerSpecialAttack(api) {
  const {
    Animation,
    CombatMethod,
    CombatSpecial,
    CombatType,
    Graphic,
    GraphicHeight,
    ItemIdentifiers,
    MagicCombatMethod,
    PendingHit,
    Projectile,
    Skill,
  } = api.core;

  const DRAIN = 35;
  const SPECIAL_VFX = new Graphic(1546);
  const IMPACT_GRAPHIC = new Graphic(1548);
  const MAXIMUM_DAMAGE = 150;
  const MINIMUM_DAMAGE_MULTIPLIER = 75 / MAXIMUM_DAMAGE;

  const ATTACK_RANGE = 7;
  const LONGRANGE_EXTRA = 2;
  const ATTACK_SPEED = 4;
  const LEVEL_REQUIRED = 75;
  const CAST_ANIMATION = 1167; // cache gameval human_castwave_staff
  const CAST_GRAPHIC = 1543; // DAWNBRINGER_CASTING
  const PROJECTILE_GRAPHIC = 1544; // DAWNBRINGER_PROJECTILE
  const SPELL_IMPACT_GRAPHIC = 1545; // DAWNBRINGER_IMPACT
  const CAST_SOUND = 3009;
  const IMPACT_SOUND = 3008;

  const spells = new WeakMap();

  function wielding(player) {
    return player?.getEquipment?.()?.get?.(api.core.Equipment.WEAPON_SLOT)?.getId?.() === ItemIdentifiers.DAWNBRINGER;
  }

  /** Wiki Maximum hit: floor((floor(Magic / 3) - 2) / 2), at least 2; gear bonuses apply after. */
  function maximumHit(player) {
    const magic = player.getSkillManager().getCurrentLevel(Skill.MAGIC);
    return Math.max(2, Math.floor((Math.floor(magic / 3) - 2) / 2));
  }

  function spellFor(player) {
    let spell = spells.get(player);
    if (spell) return spell;
    spell = new api.core.CombatNormalSpell({
      spellId: () => ItemIdentifiers.DAWNBRINGER,
      maximumHit: () => maximumHit(player),
      castAnimation: () => new Animation(CAST_ANIMATION),
      startGraphic: () => new Graphic(CAST_GRAPHIC, GraphicHeight.HIGH),
      castProjectile: (cast, castOn) => Projectile.createProjectile(cast, castOn, PROJECTILE_GRAPHIC, 0, 20, 43, 31),
      endGraphic: () => new Graphic(SPELL_IMPACT_GRAPHIC),
      castSound: () => CAST_SOUND,
      impactSound: () => IMPACT_SOUND,
      baseExperience: () => 0,
      levelRequired: () => LEVEL_REQUIRED,
    });
    spells.set(player, spell);
    return spell;
  }

  class DawnbringerSpellCombatMethod extends MagicCombatMethod {
    canAttack(character) {
      const player = character.getAsPlayer();
      if (!wielding(player)) return false;
      // The built-in spell is the only one the staff casts, whatever is selected or autocast.
      player.getCombat().setCastSpell(spellFor(player));
      return true;
    }

    canPursue(character) {
      return wielding(character.getAsPlayer());
    }

    hits(character, target) {
      const spell = spellFor(character.getAsPlayer());
      const delay = MagicCombatMethod.hitDelay(character, target, spell);
      // Wiki: the Dawnbringer ignores accuracy rolls and always lands a successful hit.
      return [new PendingHit(character, target, this, { delay, ordinary: true, rollAccuracy: false }).setSpell(spell)];
    }

    attackSpeed() {
      return ATTACK_SPEED;
    }

    attackDistance(character) {
      const longrange = character.getFightType?.()?.getStyle?.() === api.core.FightStyle.DEFENSIVE;
      return ATTACK_RANGE + (longrange ? LONGRANGE_EXTRA : 0);
    }

    /** Keeps attacking: the staff casts on its own, unlike a single manual spell click. */
    finished(character) {
      const combat = character.getCombat();
      combat.setPreviousCast(spellFor(character.getAsPlayer()));
      combat.setCastSpell(null);
    }
  }

  const spellMethod = new DawnbringerSpellCombatMethod();

  api.registerCombatMethodResolver({
    resolve(attacker) {
      if (!attacker?.isPlayer?.()) return null;
      const player = attacker.getAsPlayer();
      if (!wielding(player)) return null;
      // An armed Pulsate owns its swing; CombatFactory then uses the registered special's method.
      if (player.isSpecialActivated?.() === true && player.getCombatSpecial?.()?.getId?.() === "dawnbringer") return null;
      return spellMethod;
    },
  });

  class DawnbringerCombatMethod extends CombatMethod {
    hits(character, target) {
      return [new PendingHit(character, target, this)];
    }

    type() {
      return CombatType.MAGIC;
    }

    attackDistance() {
      return ATTACK_RANGE;
    }

    attackSpeed() {
      return ATTACK_SPEED;
    }

    canAttack(character, target) {
      const request = { specialId: "dawnbringer", attacker: character, target, allow: false };
      api.emitCustomEvent("combat-special:can-use", request);
      return request.allow === true;
    }

    start(character, target) {
      CombatSpecial.drain(character, DRAIN);
      character.performGraphic(SPECIAL_VFX);
    }

    handleAfterHitEffects(hit) {
      if (hit.isAccurate()) {
        hit.getTarget().performGraphic(IMPACT_GRAPHIC);
      }
    }
  }

  api.registerCombatSpecial({
    id: "dawnbringer",
    itemIds: [ItemIdentifiers.DAWNBRINGER],
    drainAmount: DRAIN,
    strengthMultiplier: 1,
    accuracyMultiplier: 1,
    traits: {
      hitCount: 1,
      guaranteedHit: true,
      rollAttackType: "magic",
      damageType: "magic",
      maxHitOverride: MAXIMUM_DAMAGE,
      minimumDamageMultiplier: MINIMUM_DAMAGE_MULTIPLIER,
      maximumDamageMultiplier: 1,
    },
    combatMethod: new DawnbringerCombatMethod(),
  });
};
