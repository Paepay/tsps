/**
 * Guardian (Trailblazer Reloaded and Raging Echoes tier 7): the Guardian horn summons a guardian
 * thrall for 30 minutes. It follows its owner, attacks only the NPC the owner is fighting in the
 * target's weakest defence style (5 ticks and 6-15 damage in Trailblazer Reloaded, 4 ticks and
 * 5-13 in Raging Echoes), and can be dismissed. Toggle-modes switches between attacking and
 * following only; Change-outfit cycles the cache's four guardian appearances. The horn's
 * inventory options and the thrall ids are the cache's.
 *
 * The owner's combat target is the only target domain: an interaction such as pickpocketing is not
 * an attack, so it never authorises the guardian. Before every attack the NPC must still be a
 * live, registered, attackable target that the owner may attack now. That excludes skilling NPCs
 * and NPC remains/corpses, including Araxxor's harvestable corpse (id 13669), without naming any
 * one encounter here. The guardian never acquires a target of its own.
 */
const Common = require("./Common.LeagueRelics");

const HORN_NAME = "Guardian horn";
const DURATION_TICKS = 3000;
/** 12589 is the ordinary guardian; 14803-14805 are its rare outfits. */
const OUTFITS = [12589, 14803, 14804, 14805];
const ATTACK_TICKS = { 4: 5, 5: 4 };
/** Wiki: accuracy roll 45,000; 6-15 damage in Trailblazer Reloaded, 5-13 in Raging Echoes. */
const ACCURACY_ROLL = 45000;
const DAMAGE_ROLLS = { 4: [6, 15], 5: [5, 13] };
const MIN_DAMAGE = DAMAGE_ROLLS[4][0];
const MAX_DAMAGE = DAMAGE_ROLLS[4][1];
const MODE_ATTRIBUTE = "league:guardian-mode";
const OUTFIT_ATTRIBUTE = "league:guardian-outfit";

/** One live guardian per owner: its NPC, remaining ticks, attack clock and outfit. */
const guardians = new WeakMap();

let api;
let core;

function itemId() {
  return core.ItemIdentifiers.GUARDIAN_HORN;
}

function leagueType(player) {
  return Common.leagueOf(player);
}

function supports(player) {
  return ATTACK_TICKS[leagueType(player)] !== undefined;
}

function attacking(player) {
  return player.getAttribute(MODE_ATTRIBUTE) !== "passive";
}

function outfitIndex(player) {
  const raw = Number(player.getAttribute(OUTFIT_ATTRIBUTE));
  return Number.isInteger(raw) && raw >= 0 && raw < OUTFITS.length ? raw : 0;
}

/**
 * Only the NPC the owner is actually attacking. The interacting entity is deliberately not a
 * fallback: pickpocketing sets it without starting combat. A target can remain in Combat while
 * its NPC changes into a corpse, so also ask the current definition whether it is attackable and
 * pass the live target through the same engine permission checks as an ordinary attack.
 */
function targetOf(player) {
  if (player?.isRegistered?.() !== true || player.isDyingReturn?.() === true) return null;
  const target = player.getCombat?.()?.getTarget?.() ?? null;
  if (!target?.isNpc?.() || target.isRegistered?.() !== true || target.isUntargetable?.() === true
    || target.isNeedsPlacement?.() === true || target.isDyingFunction?.() === true
    || (target.getHitpoints?.() ?? 0) <= 0) return null;
  // The transformed form's own answer catches harvestable remains and other non-combat NPCs.
  const definition = target.getCurrentDefinition?.() ?? target.getDefinition?.();
  if (definition?.isAttackable?.() === false) return null;
  const combat = core.CombatFactory;
  if (combat?.validTarget && !combat.validTarget(player, target)) return null;
  if (combat?.canAttackPermission
    && combat.canAttackPermission(player, target) !== core.CanAttackResponse.CAN_ATTACK) return null;
  return target;
}

/** The target's lowest defence roll: melee is its weakest of stab, slash and crush. */
function weakestStyle(target) {
  const { AccuracyFormulasDpsCalc: formulas, BonusManager } = core;
  const rolls = {
    melee: Math.min(...[BonusManager.ATTACK_STAB, BonusManager.ATTACK_SLASH, BonusManager.ATTACK_CRUSH]
      .map((type) => formulas.defenseMeleeRoll(target, type))),
    ranged: formulas.defenseRangedRoll(target, "standard"),
    magic: formulas.defenseMagicRoll(target),
  };
  return Object.entries(rolls).sort(([, a], [, b]) => a - b)[0][0];
}

function defenceRoll(target, style) {
  const { AccuracyFormulasDpsCalc: formulas, BonusManager } = core;
  if (style === "ranged") return formulas.defenseRangedRoll(target, "standard");
  if (style === "magic") return formulas.defenseMagicRoll(target);
  return Math.min(...[BonusManager.ATTACK_STAB, BonusManager.ATTACK_SLASH, BonusManager.ATTACK_CRUSH]
    .map((type) => formulas.defenseMeleeRoll(target, type)));
}

/** OSRS's hit chance for an attack roll against a defence roll. */
function hitChance(attack, defence) {
  return attack > defence ? 1 - (defence + 2) / (2 * (attack + 1)) : attack / (2 * (defence + 1));
}

/** An adjacent free tile; the player's own tile when every neighbour is blocked. */
function summonTile(player) {
  const at = player.getLocation();
  const region = api.getRegionManager?.();
  if (!region) return at.clone();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const tile = new core.Location(at.getX() + dx, at.getY() + dy, at.getZ());
    if (!region.blocked(tile, player.getPrivateArea?.())
      && region.canMovestart(at, tile, 1, 1, player.getPrivateArea?.())) return tile;
  }
  return at.clone();
}

function remove(npc) {
  if (!npc) return;
  npc.setFollowing?.(null);
  npc.setMobileInteraction?.(null);
  api.removeNpc(npc);
}

/** One attack in the target's weakest defence style. */
function attack(player, state, target) {
  const npc = state.npc;
  const style = weakestStyle(target);
  state.style = style;
  npc.performAnimation?.(new core.Animation(npc.getAttackAnim?.(target) ?? -1));
  const accurate = Math.random() < hitChance(ACCURACY_ROLL, defenceRoll(target, style));
  const [minDamage, maxDamage] = state.damage;
  const damage = accurate ? core.Misc.randomInclusive(minDamage, maxDamage) : 0;
  const hit = new core.HitDamage(damage, accurate ? core.HitMask.RED : core.HitMask.BLUE)
    .setSource(player).setOrigin("thrall")
    .onApplied((applied) => target.getCombat().addDamage(player, applied));
  target.getCombat().getHitQueue().addPendingDamage([hit]);
}

/** The guardian's tick. Returns false once it has been dismissed or has run out. */
function tick(player, state) {
  if (!state.active || guardians.get(player) !== state || player.isRegistered?.() !== true) {
    if (guardians.get(player) === state) {
      guardians.delete(player);
      remove(state.npc);
    }
    return false;
  }
  if (--state.ticks <= 0) {
    guardians.delete(player);
    state.active = false;
    remove(state.npc);
    player.sendMessage("Your guardian returns to the shadows.");
    return false;
  }
  const npc = state.npc;
  if (!npc.isRegistered?.()) return true;
  const target = attacking(player) ? targetOf(player) : null;
  if (!target) {
    if (npc.getFollowing?.() !== player) npc.setFollowing?.(player);
    return true;
  }
  if (npc.calculateDistance(target) > 1) {
    if (npc.getFollowing?.() !== target) npc.setFollowing?.(target);
    return true;
  }
  npc.setFollowing?.(null);
  npc.getMovementQueue?.().reset?.();
  npc.setMobileInteraction?.(target);
  if (++state.attackClock % state.interval !== 0) return true;
  attack(player, state, target);
  return true;
}

function schedule(player, state) {
  core.TaskManager.submit(new class extends core.Task {
    constructor() { super(1); }
    execute() {
      this.stop();
      if (tick(player, state)) schedule(player, state);
    }
  });
}

function dismiss(player, quiet = false) {
  const state = guardians.get(player);
  if (!state) {
    if (!quiet) player.sendMessage("You do not have a guardian to dismiss.");
    return false;
  }
  guardians.delete(player);
  state.active = false;
  remove(state.npc);
  if (!quiet) player.sendMessage("Your guardian returns to the shadows.");
  return true;
}

function summon(player, remainingTicks = DURATION_TICKS) {
  if (player?.isPlayer?.() !== true) return null;
  dismiss(player, true);
  const id = OUTFITS[outfitIndex(player)];
  const tile = summonTile(player);
  const npc = api.spawnNpc({ id, x: tile.getX(), y: tile.getY(), z: tile.getZ(), owner: player, ownerOnly: true, wanderRadius: 0 });
  if (!npc) {
    player.sendMessage("Your guardian cannot answer here.");
    return null;
  }
  npc.setPet?.(true);
  npc.setUntargetable?.(true);
  npc.setFollowing?.(player);
  npc.__skipDefaultRespawn = true;
  const type = leagueType(player);
  const state = {
    npc, ticks: Math.max(1, remainingTicks), active: true, attackClock: 0, style: "melee",
    interval: ATTACK_TICKS[type] ?? 5, damage: DAMAGE_ROLLS[type] ?? DAMAGE_ROLLS[4],
  };
  guardians.set(player, state);
  player.sendMessage("Your guardian answers the horn.");
  schedule(player, state);
  return npc;
}

function onSummon(event) {
  if (!supports(event.player)) return false;
  if (guardians.has(event.player)) {
    event.player.sendMessage("Your guardian is already here.");
    return true;
  }
  summon(event.player);
  return true;
}

function onDismiss(event) {
  if (!supports(event.player)) return false;
  dismiss(event.player);
  return true;
}

function onToggleModes(event) {
  if (!supports(event.player)) return false;
  const passive = attacking(event.player);
  event.player.setAttribute(MODE_ATTRIBUTE, passive ? "passive" : "aggressive");
  event.player.sendMessage(passive ? "Your guardian will follow you and hold its attacks." : "Your guardian will attack what you attack.");
  return true;
}

function onChangeOutfit(event) {
  if (!supports(event.player)) return false;
  const next = (outfitIndex(event.player) + 1) % OUTFITS.length;
  event.player.setAttribute(OUTFIT_ATTRIBUTE, next);
  const state = guardians.get(event.player);
  const remaining = state?.ticks ?? DURATION_TICKS;
  if (state) summon(event.player, remaining);
  event.player.sendMessage("Your guardian changes its appearance.");
  return true;
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  api.persistAttribute(MODE_ATTRIBUTE, "aggressive");
  api.persistAttribute(OUTFIT_ATTRIBUTE, 0);
  api.onItemAction(HORN_NAME, {
    Summon: onSummon,
    Dismiss: onDismiss,
    "Toggle-modes": onToggleModes,
    "Change-outfit": onChangeOutfit,
  });
  api.onPlayerLogout?.(({ player }) => dismiss(player, true));
};

module.exports.summon = summon;
module.exports.dismiss = dismiss;
module.exports.attacking = attacking;
module.exports.leagueType = leagueType;
module.exports.stateOf = (player) => guardians.get(player) ?? null;
module.exports.tick = tick;
module.exports.targetOf = targetOf;
module.exports.weakestStyle = weakestStyle;
module.exports.hitChance = hitChance;
module.exports.DURATION_TICKS = DURATION_TICKS;
module.exports.OUTFITS = OUTFITS;
module.exports.MODE_ATTRIBUTE = MODE_ATTRIBUTE;
module.exports.OUTFIT_ATTRIBUTE = OUTFIT_ATTRIBUTE;
module.exports.ACCURACY_ROLL = ACCURACY_ROLL;
module.exports.DAMAGE_ROLLS = DAMAGE_ROLLS;
module.exports.MIN_DAMAGE = MIN_DAMAGE;
module.exports.MAX_DAMAGE = MAX_DAMAGE;
