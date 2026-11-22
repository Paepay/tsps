/**
 * Guardian (Trailblazer Reloaded and Raging Echoes tier 7): the Guardian horn summons a guardian
 * thrall for 30 minutes. It follows its owner, attacks the NPC the owner is fighting (4 ticks in
 * Raging Echoes, 5 in Trailblazer Reloaded) for 5-13 damage, and can be dismissed. Toggle-modes
 * switches between attacking and following only; Change-outfit cycles the cache's four guardian
 * appearances. The horn's inventory options and the thrall ids are the cache's.
 */
const Common = require("./Common.LeagueRelics");

const HORN_NAME = "Guardian horn";
const DURATION_TICKS = 3000;
/** 12589 is the ordinary guardian; 14803-14805 are its rare outfits. */
const OUTFITS = [12589, 14803, 14804, 14805];
const ATTACK_TICKS = { 4: 5, 5: 4 };
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
  const state = { npc, ticks: Math.max(1, remainingTicks), active: true, attackClock: 0 };
  guardians.set(player, state);
  player.sendMessage("Your guardian answers the horn.");
  const interval = ATTACK_TICKS[leagueType(player)] ?? 5;
  core.TaskManager.submit(new class extends core.Task {
    constructor() { super(1); }
    execute() {
      if (!state.active || guardians.get(player) !== state || player.isRegistered?.() !== true) {
        if (guardians.get(player) === state) {
          guardians.delete(player);
          remove(npc);
        }
        this.stop();
        return;
      }
      if (--state.ticks <= 0) {
        guardians.delete(player);
        state.active = false;
        remove(npc);
        player.sendMessage("Your guardian returns to the shadows.");
        this.stop();
        return;
      }
      if (!npc.isRegistered?.()) return;
      const target = player.getCombat?.()?.getTarget?.() ?? player.getInteractingMobile?.() ?? null;
      if (attacking(player) && target?.isNpc?.() && target.isRegistered?.() && target.getHitpoints?.() > 0) {
        if (npc.calculateDistance(target) > 1) {
          if (npc.getFollowing?.() !== target) npc.setFollowing?.(target);
          return;
        }
        npc.setFollowing?.(null);
        npc.getMovementQueue?.().reset?.();
        npc.setMobileInteraction?.(target);
        if (++state.attackClock % interval !== 0) return;
        npc.performAnimation?.(new core.Animation(npc.getAttackAnim?.() ?? -1));
        const damage = core.Misc.randomInclusive(5, 13);
        const hit = new core.HitDamage(damage, core.HitMask.RED).setSource(player).setOrigin("thrall")
          .onApplied((applied) => target.getCombat().addDamage(player, applied));
        target.getCombat().getHitQueue().addPendingDamage([hit]);
        return;
      }
      if (npc.getFollowing?.() !== player) npc.setFollowing?.(player);
    }
  });
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
module.exports.DURATION_TICKS = DURATION_TICKS;
module.exports.OUTFITS = OUTFITS;
module.exports.MODE_ATTRIBUTE = MODE_ATTRIBUTE;
module.exports.OUTFIT_ATTRIBUTE = OUTFIT_ATTRIBUTE;