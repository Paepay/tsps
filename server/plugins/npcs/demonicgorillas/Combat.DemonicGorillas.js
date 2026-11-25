"use strict";

/**
 * How the cavern's demonic and tortured gorillas attack (Wiki, rsprox captures):
 *
 * - One style at a time, every 5 ticks: a punch, a thrown rock (Ranged) or a green spell (Magic).
 *   After three missed hits in that style (tortured: four) it screams "Rhaaaaaaa!" and changes
 *   to one of the other two. A miss is a hit that does no damage, prayed against or not.
 * - In Ranged or Magic a demonic gorilla sometimes beats its chest instead: a boulder falls on
 *   the target's tile 5 ticks later and takes a third of the hitpoints of anyone still on it.
 *   It is not one of the missed hits.
 * - In Melee, if it can't reach its target for a while, it changes style (the Area counts it).
 */
const {
  DEMONIC_IDS, TORTURED_IDS, KINDS, ATTACK_SPEED, RANGED_DISTANCE, SEQ, RANGED, MAGIC, MELEE_SOUND, BOULDER,
} = require("./Data.DemonicGorillas");
const State = require("./State.DemonicGorillas");

let core = null;

/** Cycles until a projectile lands, from the capture: the launch delay plus a step per tile. */
function projectileEnd(spec, distance) {
  return spec.delay + spec.cyclesPerTile * Math.max(1, distance);
}

/** The tick the hit lands on, with the projectile: rounded up, as rounding down hit before it landed. */
function hitDelay(end) {
  return core.Projectile.ticksToLand(end);
}

/** A third of the hitpoints, rounded down: a boulder alone never kills. */
function boulderDamage(hitpoints) {
  return Math.floor(Math.max(0, hitpoints) / 3);
}

function later(ticks, action) {
  const { Task, TaskManager } = core;
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(ticks, false);
    }
    execute() {
      this.stop();
      action();
    }
  })());
}

function sendProjectile(source, target, lockon, spec, end, area) {
  const { Projectile } = core;
  // The wire carries heights x4; the capture logs them as the client sees them.
  new Projectile(source, target, lockon, spec.projectile, spec.delay, end, Math.round(spec.startHeight / 4), Math.round(spec.endHeight / 4), area)
    .withAngle(spec.angle)
    .withProgress(spec.progress)
    .sendProjectile();
}

function sound(target, id, delay = 0) {
  if (target.isPlayer()) target.getAsPlayer().getPacketSender().sendSound(id, 1, delay);
}

/**
 * Landed boulders waiting for this cycle's movement, so the hit uses the tile the player is
 * drawn on rather than the one they occupied before stepping. A task runs before the player
 * turn; the impact graphic and the step reach the client in the same update.
 */
const landings = [];

function armBoulder(tile, area) {
  landings.push({ tile: tile.clone(), area, cycle: core.World.getProcessCycle() });
}

/** Hits everyone still on a boulder's tile once movement has been applied (#151). */
function settleBoulder(player) {
  const { HitDamage, HitMask } = core;
  const cycle = core.World.getProcessCycle();
  for (let index = landings.length - 1; index >= 0; index--) {
    const landing = landings[index];
    // One player turn late means the landing tick is over: nobody can still be under it.
    if (landing.cycle < cycle) {
      landings.splice(index, 1);
      continue;
    }
    if (landing.cycle !== cycle || player.getPrivateArea() !== landing.area) continue;
    if (!player.getLocation().equals(landing.tile) || player.getHitpoints() <= 0) continue;
    const damage = boulderDamage(player.getHitpoints());
    player.getCombat().getHitQueue().addPendingDamage([new HitDamage(damage, damage > 0 ? HitMask.RED : HitMask.BLUE)]);
  }
}

function throwBoulder(npc, target) {
  const { Graphic, HitDamage, HitMask, Sounds } = core;
  const tile = target.getLocation().clone();
  const area = npc.getPrivateArea();
  // Capture: it falls from a tile beside the target's, east or west.
  const from = tile.transform(Math.random() < 0.5 ? -1 : 1, 0);
  sendProjectile(from, tile, null, BOULDER, BOULDER.end, area);
  later(BOULDER.landTicks, () => {
    if (target.isPlayer()) target.getAsPlayer().getPacketSender().sendGlobalGraphic(new Graphic(BOULDER.impact, 0, BOULDER.impactHeight), tile);
    Sounds.playAreaSound({ soundId: BOULDER.sound, x: tile.getX(), y: tile.getY(), level: tile.getZ(), radius: BOULDER.soundRadius });
    // Wiki: anyone's boulder hits anyone still on the tile. Settled after this cycle's movement.
    armBoulder(tile, area);
  });
}

function createGorillaCombat() {
  const { CombatMethod, CombatType, PendingHit, Animation, Graphic } = core;
  const TYPES = { melee: CombatType.MELEE, ranged: CombatType.RANGED, magic: CombatType.MAGIC };

  return class GorillaCombat extends CombatMethod {
    /** Built for each attack, for the gorilla making it. */
    constructor(npc) {
      super();
      this.npc = npc;
      this.boulder = false;
    }

    style() {
      return this.npc ? State.stateOf(this.npc).style : "melee";
    }

    type() {
      return TYPES[this.style()];
    }

    attackSpeed() {
      return ATTACK_SPEED;
    }

    attackDistance() {
      return this.style() === "melee" ? 1 : RANGED_DISTANCE;
    }

    start(npc, target) {
      const state = State.stateOf(npc);
      state.unreachable = 0;
      this.boulder = state.style !== "melee" && KINDS[state.kind].boulders && Math.random() < BOULDER.chance;
      if (this.boulder) {
        npc.performAnimation(new Animation(SEQ.smashChest));
        throwBoulder(npc, target);
        return;
      }
      if (state.style === "melee") {
        npc.performAnimation(new Animation(SEQ.punch));
        sound(target, MELEE_SOUND);
        return;
      }
      const spec = state.style === "magic" ? MAGIC : RANGED;
      const end = projectileEnd(spec, npc.calculateDistance(target));
      this.end = end;
      npc.performAnimation(new Animation(state.style === "magic" ? SEQ.magic : SEQ.range));
      const { Projectile } = core;
      sendProjectile(Projectile.centreOf(npc), Projectile.centreOf(target), target, spec, end, npc.getPrivateArea());
      // Capture: the splat and impact sound go out with the attack, timed to the landing.
      if (state.style === "magic") {
        target.performGraphic(new Graphic(MAGIC.impact, end, MAGIC.impactHeight));
        sound(target, MAGIC.castSound);
        sound(target, MAGIC.impactSound, end);
      } else {
        target.performGraphic(Graphic.delayed(RANGED.impact, end));
        sound(target, RANGED.impactSound, end);
      }
    }

    hits(npc, target) {
      if (this.boulder) return [];
      const delay = this.style() === "melee" ? 0 : hitDelay(this.end ?? projectileEnd(RANGED, npc.calculateDistance(target)));
      return [new PendingHit(npc, target, this, delay)];
    }

    /** A hit in its current style that did nothing counts towards changing style. */
    handleAfterHitEffects(hit) {
      const npc = hit.getAttacker();
      const state = State.stateOf(npc);
      if (hit.getCombatType() !== TYPES[state.style] || hit.getTotalDamage() > 0) return;
      State.countMiss(npc, state);
    }
  };
}

module.exports = function attachCombat(api) {
  core = api.core;
  api.registerNpcCombatMethodProvider([...DEMONIC_IDS, ...TORTURED_IDS], createGorillaCombat(), { singleton: false });
  api.onPlayerProcess(({ player }) => settleBoulder(player));
};

Object.assign(module.exports, { projectileEnd, hitDelay, boulderDamage, armBoulder, settleBoulder });
