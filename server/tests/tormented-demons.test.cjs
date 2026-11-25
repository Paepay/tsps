// Run after `yarn build`: node --test tests/tormented-demons.test.cjs
// Tormented Demons: the cache ids and room limits against the captures, and the shield, prayer
// and unshielded-attack rules against the Wiki (docs/tormented-demons.md).
const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const path = require("node:path");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { Gamevals, GamevalKind } = require("../dist/game/cache/Gamevals");
const { Location } = require("../dist/game/model/Location");
const { PluginManager } = require("../dist/plugins/PluginManager");

const Shared = require("../plugins/bosses/tormenteddemons/Shared.TormentedDemons");
const Shield = require("../plugins/bosses/tormenteddemons/Shield.TormentedDemons");
const Temple = require("../plugins/bosses/tormenteddemons/Temple.TormentedDemons");
const Combat = require("../plugins/bosses/tormenteddemons/Combat.TormentedDemons");
const CombatAchievements = require("../plugins/bosses/tormenteddemons/CombatAchievements.TormentedDemons");

const core = PluginManager.getCoreApi();
let gamevals = null;
const events = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  Shared.attachApi({ core, emitCustomEvent: (name, payload) => events.push({ name, payload }) });
  gamevals = new Gamevals();
});

test("the ids are the cache's tormented demon sequences, graphics and npcs", () => {
  const npc = gamevals.namesOf(GamevalKind.NPC);
  const seq = gamevals.namesOf(GamevalKind.SEQ);
  const spotanim = gamevals.namesOf(GamevalKind.SPOTANIM);
  const varbit = gamevals.namesOf(GamevalKind.VARBIT);
  assert.deepEqual(Shared.DEMON_IDS.map((id) => npc.get(id)), ["tormented_demon_1", "tormented_demon_2"]);
  assert.equal(seq.get(Shared.SEQ.EXPLOSION_FIRE), "luc2_undead_demon_explosion_fire");
  assert.equal(seq.get(Shared.SEQ.MELEE), "luc2_undead_demon_melee");
  assert.equal(seq.get(Shared.SEQ.RANGED), "luc2_undead_demon_spare_ribs");
  assert.equal(seq.get(Shared.SEQ.MAGIC), "luc2_undead_demon_firey_balls");
  assert.equal(seq.get(Shared.SEQ.SUMMON), "luc2_undead_demon_summon");
  assert.equal(spotanim.get(Shared.SPOT.SHIELD.id), "luc2_undead_demon_shield_spot");
  assert.equal(spotanim.get(Shared.SPOT.SHIELD_RESTORE.id), "luc2_undead_demon_shield_restore_spot");
  assert.equal(spotanim.get(Shared.SPOT.SHIELD_DROP.id), "luc2_undead_demon_explosion_fire_spot");
  assert.equal(spotanim.get(Shared.SPOT.DEFENCELESS.id), "luc2_undead_accuracy_debuff");
  assert.equal(spotanim.get(Shared.PROJECTILE.RANGED.id), "luc2_rib_bone_shard_projectile");
  assert.equal(spotanim.get(Shared.PROJECTILE.MAGIC.id), "luc2_undead_demon_fireball_proj");
  assert.equal(spotanim.get(Shared.PROJECTILE.BOMB.id), "luc2_undead_demon_fireball_large_proj");
  assert.equal(spotanim.get(Shared.BOMB_TILE.EXPLOSION.id), "luc2_undead_demon_fireball_large_impact");
  assert.equal(varbit.get(10960), "td_multiway_indicator");
  assert.equal(gamevals.namesOf(GamevalKind.VARP).get(4240), "wgs_tormented_demon_killcount");
});

test("each tile takes its room's demon limit, as the captured indicator shows", () => {
  const { zoneLimit } = Temple._test;
  const at = (x, y) => zoneLimit(new Location(x, y, 0));
  // Captured: 2 on arriving at the entrance, 3 down the west corridor, 1 into the plinth room.
  assert.equal(at(4061, 4466), 2);
  assert.equal(at(4060, 4417), 2);
  assert.equal(at(4059, 4410), 3);
  assert.equal(at(4094, 4399), 1);
  // Wiki rooms: the plinth room 1, the central chamber 2, the south-west rooms 3.
  assert.equal(at(4126, 4386), 1);
  assert.equal(at(4076, 4430), 2);
  assert.equal(at(4046, 4384), 3);
  assert.equal(at(4112, 4430), 2);
});

function fakePlayer({ weaponType = "UNARMED", bonusType = 0, weapon = -1, spell = null, castSpell = null } = {}) {
  const items = [];
  items[core.Equipment.WEAPON_SLOT] = { getId: () => weapon };
  return {
    isPlayer: () => true,
    getAsPlayer() { return this; },
    getWeapon: () => ({ getName: () => weaponType }),
    getFightType: () => ({ getBonusType: () => bonusType }),
    getEquipment: () => ({ getItems: () => items }),
    getCombat: () => ({ getSelectedSpell: () => spell, getCastSpell: () => castSpell }),
    attributes: new Map(),
    getAttribute(key) { return this.attributes.get(key); },
    setAttribute(key, value) { this.attributes.set(key, value); },
    configs: [],
    getPacketSender() { const configs = this.configs; return { sendConfig: (id, value) => configs.push([id, value]) }; },
  };
}

test("the unshielded attack's bonus: X^2 - 16 for crush, heavy ranged and spells", () => {
  const { unshieldedBonus } = Shield._test;
  const { CombatType } = core;
  // Wiki table: 7 ticks +33, 6 ticks +20, 5 ticks +9, 4 or faster +0.
  assert.equal(unshieldedBonus(fakePlayer({ weaponType: "TWO_HANDED_SWORD", bonusType: 2 }), CombatType.MELEE, 7), 33);
  assert.equal(unshieldedBonus(fakePlayer({ weaponType: "ELDER_MAUL", bonusType: 2 }), CombatType.MELEE, 6), 20);
  assert.equal(unshieldedBonus(fakePlayer({ weaponType: "CROSSBOW" }), CombatType.RANGED, 5), 9);
  assert.equal(unshieldedBonus(fakePlayer({ weaponType: "MACE", bonusType: 2 }), CombatType.MELEE, 4), 0);
  // Slash melee, light ranged and a powered staff's own spell get nothing.
  assert.equal(unshieldedBonus(fakePlayer({ weaponType: "TWO_HANDED_SWORD", bonusType: 1 }), CombatType.MELEE, 7), 0);
  assert.equal(unshieldedBonus(fakePlayer({ weaponType: "SHORTBOW" }), CombatType.RANGED, 6), 0);
  const trident = { name: "trident" };
  assert.equal(unshieldedBonus(fakePlayer({ weaponType: "POWERED_STAFF", spell: trident }), CombatType.MAGIC, 5), 0);
  assert.equal(unshieldedBonus(fakePlayer({ weaponType: "STAFF", spell: trident, castSpell: trident }), CombatType.MAGIC, 5), 9);
});

function fakeDemon(x, hitpoints = 10000) {
  const delays = [];
  const prayerActive = new Array(30).fill(false);
  return {
    hitpoints,
    delays,
    icon: null,
    isPlayer: () => false,
    isNpc: () => true,
    getAsNpc() { return this; },
    getId: () => 13599,
    getRealId: () => 13599,
    getSpawnPosition: () => new Location(x, 4400, 0),
    getLocation: () => new Location(x, 4400, 0),
    getHitpoints() { return this.hitpoints; },
    setHeadIcon(icon) { this.icon = icon; },
    getHeadIcon() { return this.icon; },
    getPrayerActive: () => prayerActive,
    setPrayerActive(id, active) { prayerActive[id] = active; return this; },
    models: undefined,
    setModelCustomisation(models) { this.models = models; },
    performGraphicInSlot() {},
    getCombat: () => ({ extendAttackDelay: (ticks) => delays.push(ticks) }),
  };
}

function fakeHit(attacker, combatType, damages, bypassProtectionPrayer = false) {
  const parts = damages.map((damage) => new core.HitDamage(damage, damage > 0 ? core.HitMask.RED : core.HitMask.BLUE));
  return {
    getAttacker: () => attacker,
    getCombatType: () => combatType,
    bypassesProtectionPrayer: () => bypassProtectionPrayer,
    getHits: () => parts,
    updateTotalDamage() {},
    total: () => parts.reduce((sum, part) => sum + part.getDamage(), 0),
  };
}

function land(npc, player, combatType, damages, entry, bypassProtectionPrayer = false) {
  const fight = Shared.fightOf(npc);
  fight.launches.set(player, [{ cycle: 0, ...entry }]);
  const hit = fakeHit(player, combatType, damages, bypassProtectionPrayer);
  Shield._test.onHitModify({ npc, hit });
  return hit.total();
}

test("the prayer stops its style, but lets a third of the unshielded bonus through", () => {
  const npc = fakeDemon(4100);
  const player = fakePlayer({ weaponType: "ELDER_MAUL", bonusType: 2 });
  Shared.setPrayer(npc, "melee");
  assert.equal(land(npc, player, core.CombatType.MELEE, [40], { shielded: true, bonus: 0 }), 0);
  // Wiki: a 7-tick weapon (+33) always hits 11 on prayer.
  assert.equal(land(npc, player, core.CombatType.MELEE, [0], { shielded: false, bonus: 33 }), 11);
});

test("a penetrating mastery hit keeps 60% of a prayed style through the fire shield", () => {
  const npc = fakeDemon(4105);
  Shared.setPrayer(npc, "melee");
  const { PrayerHandler } = core;
  assert.equal(PrayerHandler.isActivated(npc, PrayerHandler.PROTECT_FROM_MELEE), true);
  assert.equal(PrayerHandler.isActivated(npc, PrayerHandler.PROTECT_FROM_MISSILES), false);

  const plain = fakePlayer({ weaponType: "SCIMITAR", weapon: core.ItemIdentifiers.DRAGON_SCIMITAR });
  // The mastery already left 60 of 100: the shield cuts that to 48, while a normal hit is 0.
  assert.equal(land(npc, plain, core.CombatType.MELEE, [60], { shielded: true, bonus: 0 }, true), 48);
  assert.equal(land(npc, plain, core.CombatType.MELEE, [100], { shielded: true, bonus: 0 }), 0);
  // Demonbane ignores the shield, and the unshielded bonus still lands divided by three.
  const arclight = fakePlayer({ weaponType: "SWORD", weapon: core.ItemIdentifiers.ARCLIGHT });
  assert.equal(land(npc, arclight, core.CombatType.MELEE, [60], { shielded: true, bonus: 0 }, true), 60);
  assert.equal(land(npc, plain, core.CombatType.MELEE, [60], { shielded: true, bonus: 33 }, true), 59);
});

test("the shield cuts 20% unless the attack is demonbane or abyssal; the bonus adds on top", () => {
  const npc = fakeDemon(4101);
  Shared.setPrayer(npc, "magic");
  const plain = fakePlayer({ weaponType: "SCIMITAR", weapon: core.ItemIdentifiers.DRAGON_SCIMITAR });
  const arclight = fakePlayer({ weaponType: "SWORD", weapon: core.ItemIdentifiers.ARCLIGHT });
  const whip = fakePlayer({ weaponType: "WHIP", weapon: core.ItemIdentifiers.ABYSSAL_WHIP });
  assert.equal(land(npc, plain, core.CombatType.MELEE, [30], { shielded: true, bonus: 0 }), 24);
  assert.equal(land(npc, arclight, core.CombatType.MELEE, [30], { shielded: true, bonus: 0 }), 30);
  assert.equal(land(npc, whip, core.CombatType.MELEE, [30], { shielded: true, bonus: 0 }), 30);
  assert.equal(land(npc, plain, core.CombatType.MELEE, [30], { shielded: false, bonus: 20 }), 50);
});

test("a shielded hit on a 1 HP demon uses the pre-cap roll and finishes it", () => {
  const npc = fakeDemon(4106, 1);
  Shared.setPrayer(npc, "ranged");
  const player = fakePlayer({ weaponType: "SCIMITAR", weapon: core.ItemIdentifiers.DRAGON_SCIMITAR });
  const hit = fakeHit(player, core.CombatType.MELEE, [1]);
  hit.getHits()[0].setDamageBeforeCap(30);
  const fight = Shared.fightOf(npc);
  fight.launches.set(player, [{ cycle: 0, shielded: true, bonus: 0 }]);

  Shield._test.onHitModify({ npc, hit });

  assert.equal(hit.total(), 1, "the 1 HP cap is not what the shield cuts");
  assert.equal(hit.getHits()[0].getDamage(), 1);
});

test("PendingHit keeps the uncapped roll for the shield at impact", () => {
  const { PendingHit } = require("../dist/game/content/combat/hit/PendingHit");
  const { CombatFactory } = require("../dist/game/content/combat/CombatFactory");
  const { AccuracyFormulasDpsCalc } = require("../dist/game/content/combat/formula/AccuracyFormulasDpsCalc");
  const { Player } = require("../dist/game/entity/impl/player/Player");
  const { PlayerSession } = require("../dist/net/PlayerSession");
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setUsername("td-pre-cap");
  player.setRegistered(true);
  const npc = core.NPC.create(13599, new Location(4107, 4400, 0));
  npc.setHitpoints(1);
  Shared.setPrayer(npc, "ranged");

  const accuracy = AccuracyFormulasDpsCalc.rollAccuracy, damage = CombatFactory.getHitDamage;
  try {
    AccuracyFormulasDpsCalc.rollAccuracy = () => true;
    CombatFactory.getHitDamage = () => new core.HitDamage(30, core.HitMask.RED);
    const hit = new PendingHit(player, npc, { type: () => core.CombatType.MELEE, accuracyDefenceType: () => undefined },
      { experience: false, handleAfterHitEffects: false });
    assert.equal(hit.getTotalDamage(), 1, "the roll is capped to the target's 1 HP");
    assert.equal(hit.getHits()[0].getDamageBeforeCap(), 30, "the roll itself is kept");

    const fight = Shared.fightOf(npc);
    fight.launches.set(player, [{ cycle: 0, shielded: true, bonus: 0 }]);
    Shield._test.onHitModify({ npc, hit });
    assert.equal(hit.getTotalDamage(), 1, "a 20% cut of 30 still finishes a 1 HP demon");
  } finally {
    AccuracyFormulasDpsCalc.rollAccuracy = accuracy;
    CombatFactory.getHitDamage = damage;
    player.setRegistered(false);
  }
});

test("every 150 damage it prays against the style that last hit it, and stops attacking 6 ticks", () => {
  const npc = fakeDemon(4102);
  const player = fakePlayer({ weaponType: "SWORD", weapon: core.ItemIdentifiers.ARCLIGHT });
  Shared.setPrayer(npc, "ranged");
  land(npc, player, core.CombatType.MELEE, [100], { shielded: true, bonus: 0 });
  assert.equal(npc.icon, Shared.HEAD_ICON.ranged);
  land(npc, player, core.CombatType.MELEE, [60], { shielded: true, bonus: 0 });
  assert.equal(npc.icon, Shared.HEAD_ICON.melee);
  assert.equal(Shared.prayerOf(npc), "melee");
  assert.deepEqual(npc.delays, [Shared.PRAYER_SWAP_STALL]);
  assert.equal(Shared.fightOf(npc).damageSinceSwap, 0);
});

test("defenceless puts its flames out (the captured model) and they come back after", () => {
  const npc = fakeDemon(4103);
  const fight = Shared.fightOf(npc);
  Shared.setDefenceless(fight, true);
  assert.equal(fight.defenceless, true);
  assert.deepEqual(npc.models, [{ slot: 0, modelId: 55475 }]);
  Shared.setDefenceless(fight, false);
  assert.equal(fight.defenceless, false);
  assert.equal(npc.models, null);
});

function atTick(tick, run) {
  const original = core.World.processCycle;
  core.World.processCycle = tick;
  try { run(); } finally { core.World.processCycle = original; }
}

const completed = (player) => events
  .filter((event) => event.name === "combat-achievements:complete" && event.payload.player === player)
  .map((event) => event.payload.task);

test("kills: the count varp, a kill with the shield down, two and three kills in quick succession", () => {
  const { killed } = CombatAchievements._test;
  const player = fakePlayer();
  atTick(100, () => killed({ player, shieldDown: false }));
  assert.deepEqual(player.configs.at(-1), [4240, 1]);
  assert.deepEqual(completed(player), []);
  atTick(110, () => killed({ player, shieldDown: true }));
  assert.deepEqual(completed(player), ["Through Fire and Flames"]);
  // Two kills 3 ticks (1.8 seconds) apart, then a third 2 ticks later: 3 within 5 ticks.
  atTick(113, () => killed({ player, shieldDown: false }));
  assert.ok(completed(player).includes("Two Times the Torment"));
  assert.ok(!completed(player).includes("Three Times the Thrashing"));
  atTick(115, () => killed({ player, shieldDown: false }));
  assert.ok(completed(player).includes("Three Times the Thrashing"));
  assert.deepEqual(player.configs.at(-1), [4240, 4]);
});

test("Rapid Reload: crossbow hits on three different demons within 3 seconds", () => {
  const { hitLanded } = CombatAchievements._test;
  const bow = fakePlayer({ weaponType: "SHORTBOW" });
  const crossbow = fakePlayer({ weaponType: "CROSSBOW" });
  const demons = [fakeDemon(4110), fakeDemon(4111), fakeDemon(4112)];
  const hit = { isAccurate: () => true, getCombatType: () => core.CombatType.RANGED };
  demons.forEach((npc, i) => atTick(200 + i * 2, () => hitLanded({ attacker: bow, target: npc, hit })));
  assert.ok(!completed(bow).includes("Rapid Reload"));
  atTick(300, () => hitLanded({ attacker: crossbow, target: demons[0], hit }));
  atTick(303, () => hitLanded({ attacker: crossbow, target: demons[1], hit }));
  atTick(309, () => hitLanded({ attacker: crossbow, target: demons[2], hit }));
  assert.ok(!completed(crossbow).includes("Rapid Reload"), "the first hit is more than 3 seconds old");
  atTick(310, () => hitLanded({ attacker: crossbow, target: demons[1], hit }));
  atTick(311, () => hitLanded({ attacker: crossbow, target: demons[0], hit }));
  assert.ok(completed(crossbow).includes("Rapid Reload"));
});

test("its first ranged/magic attack does a quarter, until a 5+ tick attack hits it unshielded", () => {
  const hit = fakeHit(null, core.CombatType.RANGED, [24]);
  Combat._test.weaken(hit);
  // Captured: at most 6 on the first attack against later ones up to 24.
  assert.equal(hit.total(), 6);
  const npc = fakeDemon(4104);
  Shared.setPrayer(npc, "magic");
  const fast = fakePlayer({ weaponType: "SHORTBOW" });
  land(npc, fast, core.CombatType.RANGED, [10], { shielded: false, bonus: 0, speed: 3 });
  assert.equal(Shared.fightOf(npc).slowUnshieldedHit, false);
  const slow = fakePlayer({ weaponType: "CROSSBOW" });
  land(npc, slow, core.CombatType.RANGED, [10], { shielded: false, bonus: 20, speed: 6 });
  assert.equal(Shared.fightOf(npc).slowUnshieldedHit, true);
});
