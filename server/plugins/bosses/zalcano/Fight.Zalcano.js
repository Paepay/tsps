/**
 * One Zalcano (Wiki: Zalcano, /Strategies, Rock_Formation, Golem_(Zalcano), Demonic_Symbol):
 * - armoured, she can only be hurt by imbued tephra: her 300 armour is the NPC's hitpoints while
 *   she stands; golems walk to her from the walls and give her armour back;
 * - at 0 armour she falls and players mine her 1,000 hitpoints; after 12-16 seconds she rises,
 *   pushing back whoever is next to her, the armour is whole again and every bit of tephra in the
 *   prison crumbles;
 * - standing, she drops boulders on the players, scrawls demonic symbols (orange hurts more the
 *   longer it is stood in, blue makes tephra hit harder), sends golems, blasts the glowing rock
 *   (which moves to another corner) and pelts everyone with pebbles;
 * - each player's damage to the armour and to her hitpoints is kept for the rewards. `hp` is
 *   her real armour or hitpoints: tephra and mining take from it as they land, so damage from
 *   anything else (a thrall, poison) is put back each tick, and she can't fall or die from it.
 * `world` is the prison's: spawnNpc(id, tile), removeNpc(npc), placeObject(id, tile) and
 * removeObject(object) - Prison.Zalcano.js gives the real ones.
 */
const Common = require("./Common.Zalcano");

const ARMOURED = "armoured";
const DOWN = "down";
const DEAD = "dead";

class Fight {
  constructor(world, players, random = Math.random) {
    this.world = world;
    this.players = players;
    this.random = random;
    this.tickCount = 0;
    this.phase = ARMOURED;
    this.npc = null;
    this.hp = 0;
    this.seen = false;
    this.health = Common.data.zalcano.hitpoints;
    this.contributions = new Map();
    this.golems = [];
    this.boulders = [];
    this.symbols = [];
    this.blasts = [];
    this.shatters = [];
    this.rocks = [];
    this.glowing = -1;
    this.nextAttack = 0;
    this.nextRockMove = 0;
    this.downUntil = 0;
    this.stopped = false;
  }

  // --- Setup

  start() {
    const { ids, data } = Common;
    this.npc = this.world.spawnNpc(ids.npcs.armoured, data.prison.zalcano);
    this.npc.__zalFight = this;
    this.setHp(data.zalcano.shield);
    this.glowing = this.weightedRock();
    this.setRocks();
    this.nextAttack = this.tickCount + this.attackDelay();
    this.nextRockMove = this.tickCount + data.attacks.rockMoveTicks;
  }

  weightedRock() {
    const weights = Common.data.prison.firstRockWeights;
    let roll = this.random() * weights.reduce((sum, w) => sum + w, 0);
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }

  /** The four corners: the glowing one, the others ordinary (or all depleted without her). */
  setRocks(depleted = false) {
    const { ids, data } = Common;
    for (const rock of this.rocks) if (rock) this.world.removeObject(rock);
    this.rocks = data.prison.rocks.map((tile, index) => {
      const id = depleted ? ids.locs.rockDepleted : index === this.glowing ? ids.locs.rockGlowing : ids.locs.rock;
      return this.world.placeObject(id, tile);
    });
  }

  setHp(value) {
    this.hp = value;
    this.npc.setHitpoints(value);
  }

  attackDelay() {
    const [min, max] = Common.data.attacks.every;
    return min + Math.floor(this.random() * (max - min + 1));
  }

  // --- Contributions

  contribution(player) {
    let entry = this.contributions.get(player);
    if (!entry) {
      entry = { shield: 0, health: 0 };
      this.contributions.set(player, entry);
    }
    return entry;
  }

  /**
   * A tephra or mining hit landing: what it can take from her (all the hits landing on one
   * tick share what she has left), credited to the player. Returns the damage it does.
   */
  land(player, amount) {
    const landed = Math.max(0, Math.min(amount, this.hp));
    this.hp -= landed;
    if (player && landed > 0) {
      if (this.phase === ARMOURED) this.contribution(player).shield += landed;
      else if (this.phase === DOWN) this.contribution(player).health += landed;
    }
    return landed;
  }

  // --- Phases

  /** Her armour is gone: she falls, mineable for a while. */
  fall() {
    if (this.phase !== ARMOURED) return;
    const { ids, data } = Common;
    this.phase = DOWN;
    this.npc.setNpcTransformationId(ids.npcs.weakened);
    this.setHp(this.health);
    this.npc.performAnimation(new Common.core.Animation(ids.seqs.fallDown));
    this.clearHazards();
    const [min, max] = data.zalcano.downTicks;
    this.downUntil = this.tickCount + min + Math.floor(this.random() * (max - min + 1));
    for (const player of this.players()) player.sendMessage(Common.message("fallen"));
  }

  /** Down long enough: she stands, armour whole, pushing back whoever is beside her. */
  rise() {
    if (this.phase !== DOWN) return;
    const { ids, data } = Common;
    this.health = this.hp;
    this.phase = ARMOURED;
    this.npc.setNpcTransformationId(ids.npcs.armoured);
    this.setHp(data.zalcano.shield);
    this.npc.performAnimation(new Common.core.Animation(ids.seqs.standUp));
    for (const player of this.players()) player.sendMessage(Common.message("stands"));
    this.shockwaveAt = this.tickCount + data.zalcano.shockwave.delay;
    this.nextAttack = this.tickCount + this.attackDelay();
  }

  /** Recorded: the shockwave a few ticks after she stands, destroying tephra and pushing back those beside her. */
  shockwave() {
    const { ids, data } = Common;
    this.shockwaveAt = null;
    const { shockwave } = data.zalcano;
    for (const player of this.players()) {
      const destroyed = [ids.items.tephra, ids.items.refined, ids.items.imbued].reduce((sum, id) => sum + Common.removeAll(player, id), 0)
        + removeWieldedImbued(player);
      if (destroyed > 0) player.sendMessage(Common.message("rises"));
      if (Common.distanceToNpc(player.getLocation(), this.npc) > 1) continue;
      Common.hurtPlayer(player, shockwave.damage);
      this.pushAway(player, shockwave.push);
      bind(player, shockwave.stunTicks);
    }
  }

  pushAway(player, tiles) {
    const centre = this.npc.getLocation().transform(2, 2);
    const at = player.getLocation();
    const dx = Math.sign(at.getX() - centre.getX());
    const dy = Math.sign(at.getY() - centre.getY());
    let to = at;
    for (let i = 0; i < tiles; i++) {
      const next = to.transform(dx, dy);
      if (!Common.onFloor(next)) break;
      to = next;
    }
    if (to !== at) player.moveTo(to);
  }

  /** Her hitpoints are gone. The rocks go dark; Rewards.Zalcano.js shares out the kill. */
  died() {
    if (this.phase === DEAD) return;
    this.phase = DEAD;
    this.health = 0;
    this.clearHazards();
    this.glowing = -1;
    this.setRocks(true);
  }

  clearHazards() {
    for (const golem of this.golems) this.world.removeNpc(golem.npc);
    for (const symbol of this.symbols) this.world.removeObject(symbol.object);
    this.golems = [];
    this.symbols = [];
    for (const shatter of this.shatters) this.placeRock(shatter.index, Common.ids.locs.rock);
    this.boulders = [];
    this.blasts = [];
    this.shatters = [];
  }

  // --- A tick

  /** Down to nothing (dying, or about to fall): nothing more happens until that plays out. */
  finished() {
    return this.hp <= 0 || this.npc.isDyingFunction?.() === true;
  }

  tick() {
    if (this.stopped || !this.npc) return;
    this.tickCount += 1;
    if (this.npc.isRegistered?.() === true) this.seen = true;
    // She is immune to poison and venom (Wiki), and only tephra and mining hurt her.
    if ((this.npc.getPoisonDamage?.() ?? 0) > 0) this.npc.setPoisonDamage(0);
    this.npc.setVenomed?.(false);
    if (this.finished()) return;
    if (this.npc.getHitpoints() !== this.hp) this.npc.setHitpoints(this.hp);
    const players = this.players();
    if (this.shockwaveAt != null && this.tickCount >= this.shockwaveAt) this.shockwave();
    if (this.phase === ARMOURED) {
      // Her spin and the rock's shatter are one attack: never let a same-tick melee/ranged
      // animation overwrite the spin. The skipped attack stays due for the next tick.
      const blastDue = this.tickCount >= this.nextRockMove;
      if (blastDue) this.blastRock();
      else if (this.tickCount >= this.nextAttack) {
        this.attack(players);
        this.nextAttack = this.tickCount + this.attackDelay();
      }
      this.tickGolems();
    } else if (this.phase === DOWN) {
      this.tickUnder(players);
      if (this.tickCount >= this.downUntil) this.rise();
    }
    this.tickBoulders(players);
    this.tickBlasts(players);
    this.tickShatters();
    this.tickSymbols(players);
  }

  attack(players) {
    const roll = Math.floor(this.random() * 4);
    if (roll === 0) this.dropBoulders(players);
    else if (roll === 1) this.drawSymbols();
    else if (roll === 2) this.sendGolem();
    else this.barrage(players);
  }

  // --- Boulders: one on every player, a few more about the room

  dropBoulders(players) {
    const { ids, data } = Common;
    const { boulders } = data.attacks;
    this.npc.performAnimation(new Common.core.Animation(ids.seqs.rockFall));
    const lands = this.tickCount + boulders.warnTicks;
    const tiles = players.map((player) => player.getLocation());
    for (let i = 0; i < boulders.extra; i++) tiles.push(this.randomFloorTile());
    for (const tile of tiles) {
      Common.tileGraphic(players, tile, ids.spotanims.rockFall);
      this.boulders.push({ tile, lands });
    }
  }

  tickBoulders(players) {
    const max = Common.data.attacks.boulders.max;
    for (const boulder of this.boulders.filter((b) => b.lands <= this.tickCount)) {
      for (const player of players) {
        if (Common.chebyshev(player.getLocation(), boulder.tile) === 0) Common.hurtPlayer(player, Common.randomInt(Math.floor(max * 0.75), max));
      }
    }
    this.boulders = this.boulders.filter((b) => b.lands > this.tickCount);
  }

  randomFloorTile() {
    const [minX, maxX, minY, maxY] = Common.data.prison.floor;
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = minX + Math.floor(this.random() * (maxX - minX + 1));
      const y = minY + Math.floor(this.random() * (maxY - minY + 1));
      const tile = new Common.core.Location(x, y, 0);
      if (!this.npc || Common.distanceToNpc(tile, this.npc) > 0) return tile;
    }
    return new Common.core.Location(minX, minY, 0);
  }

  // --- The glowing rock: she blasts it, and another corner starts to glow

  blastRock() {
    const { ids, data } = Common;
    this.nextRockMove = this.tickCount + data.attacks.rockMoveTicks;
    if (this.glowing < 0) return;
    const { rockBlast } = data.attacks;
    const index = this.glowing;
    const tile = Common.toLocation(data.prison.rocks[index]);
    const centre = tile.transform(1, 1);
    // The recorded magic attack: she spins, then the fire projectile crosses to the rock and
    // lands with the blast. The glow stays on this corner until the projectile lands.
    this.npc.performAnimation(new Common.core.Animation(ids.seqs.rockAttack));
    // Her spin is three ticks long; no melee/ranged animation may cut it off before the fire lands.
    this.nextAttack = Math.max(this.nextAttack, this.tickCount + rockBlast.flightTicks);
    Common.tileProjectile(this.players(), Common.core.Projectile.centreOf(this.npc), centre, ids.spotanims.fireAttack, {
      speed: rockBlast.flightTicks * 30,
      startHeight: rockBlast.projectileStartHeight,
      endHeight: rockBlast.projectileEndHeight,
      angle: rockBlast.projectileAngle,
    });
    this.blasts.push({ index, tile, lands: this.tickCount + rockBlast.flightTicks });
  }

  /** The fire lands on the 3x3 rock: it shatters, another corner starts glowing, and anyone beside it is hit. */
  tickBlasts(players) {
    const { max, shatterTicks } = Common.data.attacks.rockBlast;
    for (const blast of this.blasts.filter((b) => b.lands <= this.tickCount)) {
      const centre = blast.tile.transform(1, 1);
      Common.tileGraphic(players, centre, Common.ids.spotanims.fireAttack);
      // The glowing corner stops glowing at impact: it shatters as the depleted formation while
      // the next corner lights up, then settles as an ordinary rock after shatterTicks.
      const shattered = this.placeRock(blast.index, Common.ids.locs.rockDepleted);
      shattered?.performAnimation?.(new Common.core.Animation(Common.ids.seqs.rockShatter));
      for (const player of players) {
        if (Common.chebyshev(player.getLocation(), centre) <= 2) Common.hurtPlayer(player, Common.randomInt(Math.floor(max * 0.75), max));
      }
      this.shatters.push({ index: blast.index, at: this.tickCount + shatterTicks });
      this.moveGlow(blast.index);
    }
    this.blasts = this.blasts.filter((b) => b.lands > this.tickCount);
  }

  /** Another corner starts glowing the moment the rock is hit. */
  moveGlow(blasted) {
    const { ids, data } = Common;
    const others = data.prison.rocks.map((_, i) => i).filter((i) => i !== blasted);
    this.glowing = others[Math.floor(this.random() * others.length)];
    this.placeRock(this.glowing, ids.locs.rockGlowing);
  }

  /** Replace one corner, leaving the other three alone. */
  placeRock(index, id) {
    const { data } = Common;
    if (this.rocks[index]) this.world.removeObject(this.rocks[index]);
    return (this.rocks[index] = this.world.placeObject(id, data.prison.rocks[index]));
  }

  /** The shattered rock finishes its animation and becomes the ordinary formation. */
  tickShatters() {
    for (const shatter of this.shatters.filter((s) => s.at <= this.tickCount)) this.placeRock(shatter.index, Common.ids.locs.rock);
    this.shatters = this.shatters.filter((s) => s.at > this.tickCount);
  }

  // --- Demonic symbols

  drawSymbols() {
    const { ids, data } = Common;
    const { symbols } = data.attacks;
    this.npc.performAnimation(new Common.core.Animation(ids.seqs.pentagram));
    for (const symbol of this.symbols) this.world.removeObject(symbol.object);
    this.symbols = [];
    const count = Common.randomInt(symbols.count[0], symbols.count[1]);
    const blue = Math.min(count, Common.randomInt(symbols.blue[0], symbols.blue[1]));
    const until = this.tickCount + symbols.ticks;
    const [minX, maxX, minY, maxY] = data.prison.floor;
    for (let attempt = 0; this.symbols.length < count && attempt < 60; attempt++) {
      const x = minX + Math.floor(this.random() * (maxX - minX - 1));
      const y = minY + Math.floor(this.random() * (maxY - minY - 1));
      const tile = new Common.core.Location(x, y, 0);
      if (this.symbols.some((s) => Math.abs(s.tile.getX() - x) < 3 && Math.abs(s.tile.getY() - y) < 3)) continue;
      // Never over a rock: the symbol would take its place.
      if (data.prison.rocks.some(([rx, ry]) => Math.abs(rx - x) < 3 && Math.abs(ry - y) < 3)) continue;
      if ([0, 2].some((dx) => [0, 2].some((dy) => Common.distanceToNpc(tile.transform(dx, dy), this.npc) === 0))) continue;
      const empower = this.symbols.length < blue;
      const object = this.world.placeObject(empower ? ids.locs.symbolEmpower : ids.locs.symbolDamage, [x, y]);
      this.symbols.push({ tile, empower, spawnedAt: this.tickCount, until, object, standing: new Map() });
    }
  }

  /** The symbol (3x3 from its corner) under a tile. */
  symbolAt(location) {
    return this.symbols.find((s) => {
      const dx = location.getX() - s.tile.getX();
      const dy = location.getY() - s.tile.getY();
      return dx >= 0 && dx < 3 && dy >= 0 && dy < 3;
    }) ?? null;
  }

  /** Tephra thrown from a blue symbol hits harder. */
  empowered(player) {
    return this.symbolAt(player.getLocation())?.empower === true;
  }

  tickSymbols(players) {
    const { symbols } = Common.data.attacks;
    for (const symbol of this.symbols.filter((s) => s.until <= this.tickCount)) this.world.removeObject(symbol.object);
    this.symbols = this.symbols.filter((s) => s.until > this.tickCount);
    for (const symbol of this.symbols) {
      if (symbol.empower) {
        this.tickEmpower(symbol, players);
        continue;
      }
      for (const player of players) {
        const on = this.symbolAt(player.getLocation()) === symbol;
        if (!on) { symbol.standing.delete(player); continue; }
        const active = this.tickCount - symbol.spawnedAt >= symbols.graceTicks;
        const ticks = active ? (symbol.standing.get(player) ?? 0) + 1 : 0;
        symbol.standing.set(player, ticks);
        player.setRunEnergy?.(Math.max(0, (player.getRunEnergy?.() ?? 0) - symbols.runDrain));
        if (active) {
          Common.hurtPlayer(player, Math.min(symbols.max, ticks * symbols.step));
          Common.spam(player, Common.message("burning"));
          player.forceChat?.(Common.message("agh"));
          player.performGraphic?.(new Common.core.Graphic(Common.ids.spotanims.burning));
        }
      }
    }
  }

  /** A blue symbol (recorded): its line and spotanim on stepping on, then every `empowerPulse` ticks. */
  tickEmpower(symbol, players) {
    const { empowerPulse } = Common.data.attacks.symbols;
    for (const player of players) {
      if (this.symbolAt(player.getLocation()) !== symbol) { symbol.standing.delete(player); continue; }
      const since = symbol.standing.get(player);
      if (since !== undefined && this.tickCount - since < empowerPulse) continue;
      symbol.standing.set(player, this.tickCount);
      player.performGraphic?.(new Common.core.Graphic(Common.ids.spotanims.empower));
      Common.spam(player, Common.message("empowered"));
    }
  }

  // --- Golems

  sendGolem() {
    const { ids, data } = Common;
    this.npc.performAnimation(new Common.core.Animation(ids.seqs.golemAttack));
    const tile = data.prison.golemSpawns[Math.floor(this.random() * data.prison.golemSpawns.length)];
    const npc = this.world.spawnNpc(ids.npcs.golem, tile);
    npc.__zalFight = this;
    npc.setScriptedMovement?.(true);
    Common.tileGraphic(this.players(), Common.toLocation(tile), ids.spotanims.golemSpawn);
    this.golems.push({ npc, damage: new Map() });
  }

  /** Each golem walks to her; one that reaches her gives her armour back and is gone. */
  tickGolems() {
    const { data } = Common;
    const walkEvery = data.attacks.golem.walkEvery;
    for (const golem of [...this.golems]) {
      const npc = golem.npc;
      if (npc.getHitpoints() <= 0 || npc.isRegistered?.() === false) continue;
      if (Common.distanceToNpc(npc.getLocation(), this.npc) <= 1) {
        const max = data.zalcano.shield;
        const heal = Math.round(data.zalcano.golemHeal * npc.getHitpoints() / (npc.getMaxHitpoints?.() ?? 14));
        this.setHp(Math.min(max, this.hp + heal));
        this.removeGolem(npc);
        continue;
      }
      if (this.tickCount % walkEvery !== 0) continue;
      const target = this.npc.getLocation().transform(2, 2);
      const at = npc.getLocation();
      npc.getMovementQueue().walkStep(Math.sign(target.getX() - at.getX()), Math.sign(target.getY() - at.getY()));
    }
  }

  golemOf(npc) {
    return this.golems.find((g) => g.npc === npc) ?? null;
  }

  recordGolem(npc, player, amount) {
    const golem = this.golemOf(npc);
    if (!golem || !player || amount <= 0) return;
    golem.damage.set(player, (golem.damage.get(player) ?? 0) + amount);
  }

  /** Whoever did a dead golem the most damage gets its tephra. */
  golemKiller(npc) {
    const golem = this.golemOf(npc);
    if (!golem) return null;
    let best = null;
    for (const [player, amount] of golem.damage) if (!best || amount > best[1]) best = [player, amount];
    return best?.[0] ?? null;
  }

  removeGolem(npc) {
    this.golems = this.golems.filter((g) => g.npc !== npc);
    this.world.removeNpc(npc);
  }

  // --- Pebbles and the floor under her

  barrage(players) {
    const { barrage } = Common.data.attacks;
    this.npc.performAnimation(new Common.core.Animation(Common.ids.seqs.barrage));
    for (const player of players) Common.hurtPlayer(player, Common.randomInt(barrage.min, barrage.max));
  }

  tickUnder(players) {
    const [min, max] = Common.data.zalcano.underDamage;
    for (const player of players) {
      if (Common.distanceToNpc(player.getLocation(), this.npc) === 0) Common.hurtPlayer(player, Common.randomInt(min, max));
    }
  }

  stop() {
    this.stopped = true;
    this.clearHazards();
    for (const rock of this.rocks) if (rock) this.world.removeObject(rock);
    this.rocks = [];
    if (this.npc) {
      this.npc.__zalFight = null;
      this.world.removeNpc(this.npc);
    }
  }
}

function removeWieldedImbued(player) {
  const { Equipment, Item } = Common.core;
  const equipment = player.getEquipment?.();
  const weapon = equipment?.get?.(Equipment.WEAPON_SLOT);
  if (weapon?.getId?.() !== Common.ids.items.imbued) return 0;
  const amount = weapon.getAmount();
  equipment.set(Equipment.WEAPON_SLOT, new Item(-1));
  equipment.refreshItems?.();
  return amount;
}

/** A stun: the player can't move for `ticks` (a longer one already running keeps its own end). */
function bind(player, ticks) {
  const queue = player.getMovementQueue?.();
  if (!queue) return;
  const until = Common.core.World.getProcessCycle() + ticks;
  queue.reset?.();
  queue.setBlockMovement?.(true);
  if ((player.__zalBound?.until ?? -1) >= until) return;
  const bound = { until };
  player.__zalBound = bound;
  Common.later(ticks, () => {
    if (player.__zalBound !== bound) return;
    player.__zalBound = null;
    queue.setBlockMovement?.(false);
  });
}

module.exports = { Fight, bind, ARMOURED, DOWN, DEAD };
