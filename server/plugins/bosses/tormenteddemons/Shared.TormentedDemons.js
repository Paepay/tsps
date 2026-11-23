"use strict";

/**
 * Shared Tormented Demon ids, timings and per-demon state (docs/tormented-demons.md).
 *
 * Behaviour: https://oldschool.runescape.wiki/w/Tormented_Demon and its /Strategies page.
 * Ids from the cache (rev 241): tormented_demon_1/2 are 13599/13600 (13601/13602 are the
 * While Guthix Sleeps quest pair, fought in the quest's own instance); the luc2_undead_demon_*
 * sequences 11387-11395 and spotanims 2846-2858 and 3013.
 *
 * Animations, graphics, projectiles, sounds and their ticks are from rsprox captures
 * (https://rsprox.net/database, recordings 552, 1756, 3308 and 3312: Leagues V and Grid Master
 * worlds, so their damage is not used). Damage, the fire bomb's 60-tick period and the 30-tick
 * defenceless timer are the Wiki's; the captures agree with the timer (30 ticks after the
 * shield drops, in every fight they show).
 */

const fs = require("fs");
const path = require("path");

const DEMON_IDS = Object.freeze([13599, 13600]);

const STYLES = Object.freeze(["melee", "ranged", "magic"]);
/** Index in the headicons_prayer sprites (headicon group 440), as captured. */
const HEAD_ICON = Object.freeze({ melee: 0, ranged: 1, magic: 2 });

const SEQ = Object.freeze({
  EXPLOSION_FIRE: 11387,
  MAGIC: 11388,
  RANGED: 11389,
  MELEE: 11392,
  DEATH: 11394,
  SUMMON: 11395,
});

/** Spotanims, with the actor slot each plays in (captured). */
const SPOT = Object.freeze({
  SUMMON: { id: 2847, slot: 4 },
  SHIELD: { id: 2849, slot: 4 },
  SHIELD_RESTORE: { id: 2850, slot: 4 },
  MELEE: { id: 2851, slot: 2 },
  SHIELD_DROP: { id: 2852, slot: 4 },
  MAGIC_IMPACT: { id: 2854, slot: 2, height: 124 },
  RANGED_CAST: { id: 2858, slot: 2 },
  DEFENCELESS: { id: 3013, slot: 5 },
  BIND_CAST: { id: 177, slot: 2, height: 240 },
  BIND_IMPACT: { id: 179, slot: 0, height: 124 },
});

/**
 * Projectiles as captured: [id, start cycle, end cycle, angle, progress, start height, end height].
 * Ranged and magic land 118 cycles after launch at any distance, so their hit lands 4 ticks on.
 */
const PROJECTILE = Object.freeze({
  RANGED: { id: 2857, start: 60, end: 118, angle: 10, progress: 200, startHeight: 100, endHeight: 30 },
  MAGIC: { id: 2853, start: 30, end: 118, angle: 0, progress: 160, startHeight: 86, endHeight: 30 },
  BIND: { id: 178, start: 46, end: 76, angle: 16, progress: 64, startHeight: 45, endHeight: 0 },
  BOMB: { id: 2855, start: 45, end: 115, angle: 30, progress: 128, startHeight: 86, endHeight: 0 },
});
const HIT_DELAY = Object.freeze({ melee: 1, ranged: 4, magic: 4 });

/** Graphics on the bombed tiles: the shadow from cycle 30, the explosion as the bomb lands. */
const BOMB_TILE = Object.freeze({ SHADOW: { id: 1446, delay: 30 }, EXPLOSION: { id: 2856, delay: 115 } });

/** [id, delay in cycles], as captured. */
const SOUND = Object.freeze({
  MELEE: [[9219, 0]],
  RANGED_IMPACT: [[9253, 118]],
  MAGIC_IMPACT: [[9229, 118]],
  /** The shield dropping and the bind: the same four sounds. */
  SHIELD_DROP: [[9224, 0], [9210, 3], [9215, 36], [9259, 39]],
  BIND: [[9224, 30], [9210, 3], [9215, 36], [9259, 39], [7099, 0]],
  SINGLE_BOMB: [[9221, 33], [9335, 3], [9215, 36]],
});

const BIND_MESSAGE = "The demon's spell binds you!";

/** Wiki: an attack every 6 ticks, 31 max hit; the fire bomb every 10 attacks (~60 ticks). */
const ATTACK_SPEED = 6;
const ATTACKS_PER_BOMB = 10;
/** Wiki: the bombs land 2 ticks after the 2-tick bind ends (the projectile's 115 cycles). */
const BIND_TICKS = 2;
const BOMB_LAND_TICKS = 4;
/** Wiki: "40+ damage", 45 the special's max hit. */
const BOMB_DAMAGE = Object.freeze([40, 45]);
/** Wiki: a prayer swap every 150 damage, after which it doesn't attack for 6 ticks. */
const PRAYER_SWAP_DAMAGE = 150;
const PRAYER_SWAP_STALL = 6;
/** Wiki and captures: defenceless (100% accuracy) 30 ticks after the shield drops. */
const DEFENCELESS_TICKS = 30;
/** Wiki: the shield cuts non-demonbane, non-abyssal damage by 20%. */
const SHIELD_DAMAGE_PERCENT = 80;
/** Wiki: the attack made while the shield is down takes 4 ticks, one less per extra demon. */
const UNSHIELDED_ATTACK_SPEED = 4;
/**
 * Captured: its first ranged or magic attack of a fight hits at most a quarter of the later ones
 * when the player isn't praying against it (Wiki: ~75% less), unless a 5+ tick attack hit it
 * while its shield was down.
 */
const FIRST_ATTACK_DAMAGE_PERCENT = 25;
const SLOW_ATTACK_TICKS = 5;
/** Captured: a respawned demon summons itself and can't be attacked for 8 ticks. */
const SUMMON_TICKS = 8;
/**
 * Captured: defenceless, its flames go out - its one body model (53287 / 53285) becomes 55475 /
 * 55474 - and they come back when it ends and when it respawns.
 */
const DEFENCELESS_MODEL = Object.freeze({ 13599: 55475, 13600: 55474 });
/** The death that counts, for the kill-count varp and Combat Achievements (CombatAchievements.TormentedDemons.js). */
const KILLED_EVENT = "tormented-demons:killed";
/** Ranged and magic attack from this far (Wiki: it holds back rather than closing in). */
const RANGED_DISTANCE = 8;

let pluginApi = null;
let DATA = null;

function attachApi(api) {
  pluginApi = api;
}

function api() {
  return pluginApi;
}

function core() {
  return pluginApi.core;
}

function data() {
  DATA ??= JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "tormented-demons.json"), "utf8"));
  return DATA;
}

function isDemon(mobile) {
  if (!mobile?.isNpc?.()) return false;
  const npc = mobile.getAsNpc?.() ?? mobile;
  return DEMON_IDS.includes(npc.getId?.()) || DEMON_IDS.includes(npc.getRealId?.());
}

function tick() {
  return core().World.getProcessCycle();
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** A combat style key ("melee", "ranged", "magic") for a CombatType. */
function styleOf(combatType) {
  const { CombatType } = core();
  if (combatType === CombatType.MAGIC) return "magic";
  if (combatType === CombatType.RANGED) return "ranged";
  return "melee";
}

function combatTypeOf(style) {
  const { CombatType } = core();
  return style === "magic" ? CombatType.MAGIC : style === "ranged" ? CombatType.RANGED : CombatType.MELEE;
}

// ------------------------------------------------------------------ per-demon state

/**
 * Captured (528 fights): a fight opens with melee half the time and ranged or magic a quarter
 * each, whatever style the demon last used.
 */
function openingStyle() {
  return Math.random() < 0.5 ? "melee" : pick(["ranged", "magic"]);
}

/** One demon's fight. The prayer outlives it (Wiki: kept through respawns). */
class Fight {
  constructor(npc) {
    this.npc = npc;
    this.target = null;
    this.engagedAt = 0;
    this.style = openingStyle();
    /** "up", "dropping" (drops next tick), "down" (the next attack is unshielded), "spent" (restores next attack). */
    this.shield = "up";
    this.started = false;
    this.attacks = 0;
    this.damageSinceSwap = 0;
    this.defencelessAt = -1;
    this.defenceless = false;
    /** After a fire bomb, defenceless lasts until the next attack on it lands. */
    this.defencelessUntilHit = false;
    /** Player -> the attacks launched at it and not landed yet, oldest first. */
    this.launches = new Map();
    this.lostTargetAt = -1;
    /** A hit from a 5+ tick attack landed while the shield was down: its first attack is no longer weakened. */
    this.slowUnshieldedHit = false;
  }
}

const fights = new WeakMap();
/** Spawn tile -> the prayer its demon had, so a respawned demon keeps it. */
const prayers = new Map();

function fightOf(npc) {
  let fight = fights.get(npc);
  if (!fight) {
    fight = new Fight(npc);
    fights.set(npc, fight);
  }
  return fight;
}

function spawnKey(npc) {
  const at = npc.getSpawnPosition?.() ?? npc.getLocation();
  return `${at.getX()},${at.getY()},${at.getZ()}`;
}

function prayerOf(npc) {
  return prayers.get(spawnKey(npc)) ?? "melee";
}

function setPrayer(npc, style) {
  prayers.set(spawnKey(npc), style);
  const { PrayerHandler } = core();
  PrayerHandler.activatePrayerPrayerId(npc, PrayerHandler.getProtectingPrayer(combatTypeOf(style)));
  npc.setHeadIcon(HEAD_ICON[style]);
}

/** The demons in combat with a player, oldest fight first. */
function demonsFighting(player) {
  const area = player.getArea?.();
  const npcs = area?.getNpcs?.() ?? [];
  return npcs
    .filter((npc) => isDemon(npc) && npc.getHitpoints() > 0 && fights.get(npc)?.target === player)
    .sort((a, b) => fights.get(a).engagedAt - fights.get(b).engagedAt);
}

// ------------------------------------------------------------------ effects

function spotanim(mobile, spot, delay = 0) {
  const { Graphic } = core();
  const graphic = new Graphic(spot.id);
  graphic.height = spot.height ?? 0;
  graphic.delay = delay;
  mobile.performGraphicInSlot(spot.slot ?? 0, graphic);
}

function sounds(player, list) {
  const sender = player?.getPacketSender?.();
  if (!sender) return;
  for (const [id, delay] of list) sender.sendSoundEffect(id, 1, delay);
}

function projectile(source, target, shot) {
  const { Projectile } = core();
  Projectile.createProjectile(source, target, shot.id, shot.start, shot.end, shot.startHeight, shot.endHeight)
    .withAngle(shot.angle)
    .withProgress(shot.progress)
    .sendProjectile();
}

/** A projectile at a tile, from the demon's centre (captured: the bombs aren't locked on). */
function tileProjectile(npc, tile, shot) {
  const { Projectile } = core();
  new Projectile(Projectile.centreOf(npc), tile, null, shot.id, shot.start, shot.end, shot.startHeight, shot.endHeight, npc.getPrivateArea())
    .withSource(npc)
    .withAngle(shot.angle)
    .withProgress(shot.progress)
    .sendProjectile();
}

/** A graphic on a tile for the players who can see it. Fields set directly: Graphic's overloads read small heights as delays. */
function tileGraphic(npc, tile, id, delay) {
  const { Graphic } = core();
  const graphic = new Graphic(id);
  graphic.height = 0;
  graphic.delay = delay;
  for (const viewer of npc.getPlayersWithinDistance(15)) viewer.getPacketSender().sendGraphic(graphic, tile);
}

/** Defenceless or not: the debuff graphic and the flames out, or the flames back. */
function setDefenceless(fight, defenceless) {
  const npc = fight.npc;
  fight.defenceless = defenceless;
  if (defenceless) {
    fight.defencelessAt = -1;
    spotanim(npc, SPOT.DEFENCELESS);
    const model = DEFENCELESS_MODEL[npc.getId()];
    if (model) npc.setModelCustomisation?.([{ slot: 0, modelId: model }]);
  } else {
    fight.defencelessUntilHit = false;
    npc.setModelCustomisation?.(null);
  }
}

function damage(player, amount) {
  const { HitDamage, HitMask } = core();
  if (!player || player.getHitpoints() <= 0) return;
  player.getCombat().getHitQueue().addPendingDamage([new HitDamage(amount, amount > 0 ? HitMask.RED : HitMask.BLUE)]);
}

module.exports = {
  DEMON_IDS,
  STYLES,
  HEAD_ICON,
  SEQ,
  SPOT,
  PROJECTILE,
  HIT_DELAY,
  BOMB_TILE,
  SOUND,
  BIND_MESSAGE,
  ATTACK_SPEED,
  ATTACKS_PER_BOMB,
  BIND_TICKS,
  BOMB_LAND_TICKS,
  BOMB_DAMAGE,
  PRAYER_SWAP_DAMAGE,
  PRAYER_SWAP_STALL,
  DEFENCELESS_TICKS,
  SHIELD_DAMAGE_PERCENT,
  UNSHIELDED_ATTACK_SPEED,
  SUMMON_TICKS,
  RANGED_DISTANCE,
  FIRST_ATTACK_DAMAGE_PERCENT,
  SLOW_ATTACK_TICKS,
  DEFENCELESS_MODEL,
  KILLED_EVENT,
  attachApi,
  api,
  core,
  data,
  isDemon,
  tick,
  randomInt,
  pick,
  styleOf,
  combatTypeOf,
  fights,
  fightOf,
  spawnKey,
  prayerOf,
  setPrayer,
  demonsFighting,
  spotanim,
  sounds,
  projectile,
  tileProjectile,
  tileGraphic,
  setDefenceless,
  damage,
};
