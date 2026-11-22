/**
 * Trailblazer Reloaded's tier 3 passive (Wiki Trailblazer_Reloaded_League/Relics; also Level-Up,
 * which unlocks that catalog): grants the Crystal of Echoes (live's name for the Crystal of
 * memories). Teleport-back returns to where the last teleport began (`teleport:landed`), with a
 * cooldown of six minutes cut by one per 300 total levels (none at 1,800). Save-memory only says
 * the crystal keeps itself. Instances and `noRecall` places are skipped, except the God Wars
 * chambers: their real tile is remembered and a parked private copy is resumed. Holding the item is
 * the token for clicking it; the passive itself is the unlocked tier.
 */
const Common = require("./Common.LeagueRelics");

const RECALL_ATTRIBUTE = "league:last-recall";
const READY_AT_ATTRIBUTE = "league:crystal-of-memories-ready-at";
/** Save-memory's switch: false stops new teleports being remembered (issue #17). */
const SAVE_ATTRIBUTE = "league:crystal-of-memories-save";
const FROM_TIER = 3;

let effect;

function itemId() {
  return Common.core.ItemIdentifiers[effect.item];
}

/** Whether the world grants the Crystal of memories passive at a tier the character reached. */
function unlocked(player) {
  if (player?.isPlayer?.() !== true) return false;
  return Common.activePassiveValues(player, "crystalOfMemories").length > 0;
}

function inBox(location, box) {
  const x = location.getX();
  const y = location.getY();
  const z = location.getZ();
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY
    && (box.z === undefined || z === box.z)
    && (box.minZ === undefined || z >= box.minZ);
}

/**
 * Whether the character holds the crystal anywhere reclaim would look: inventory, worn, banked,
 * grave / Death's Office, or an item-retrieval NPC.
 */
function holds(player) {
  const id = itemId();
  if (!Number.isInteger(id)) return true;
  const containers = [player.getInventory(), player.getEquipment()];
  for (let tab = 0; tab < Common.core.Bank.TOTAL_BANK_TABS; tab++) containers.push(player.getBank(tab));
  const held = (itemIdValue, amount) => itemIdValue === id && amount > 0;
  if (containers.some((container) => container?.getItems?.().some((item) => item && held(item.getId(), item.getAmount())))) {
    return true;
  }
  const storage = { player, grave: null, office: [] };
  Common.api.emitCustomEvent("gravestones:state", storage);
  if ([...(storage.grave?.items ?? []), ...(storage.office ?? [])].some((entry) => entry && held(entry.id, entry.amount))) {
    return true;
  }
  const retrieval = { player, items: [] };
  Common.api.emitCustomEvent("item-retrieval:items", retrieval);
  return retrieval.items.some((entry) => entry && held(entry.itemId, entry.amount));
}

/**
 * Whether the crystal is actually on the character (carried or worn). A banked crystal does not
 * remember teleports: issue #17 was that it did.
 */
function carried(player) {
  const id = itemId();
  return Number.isInteger(id)
    && (player.getInventory().contains(id) || player.getEquipment().contains(id));
}

/** Save-memory's switch; absent means on, so existing characters keep saving. */
function saving(player) {
  return player.getAttribute(SAVE_ATTRIBUTE) !== false;
}

function grantCrystal(player) {
  if (!unlocked(player) || holds(player)) return false;
  const id = itemId();
  if (!Number.isInteger(id)) return false;
  const item = new (Common.core.Item)(id, 1);
  const name = Common.core.ItemDefinition.forId(id)?.getName?.() ?? "a crystal of memories";
  let key = "crystalGranted";
  if (player.getInventory().getAddableAmount(item) > 0) player.getInventory().add(item, true);
  else if (Common.bank(player, id, 1)) key = "crystalGrantedBanked";
  else {
    player.getInventory().forceAdd(player, item);
    key = "crystalGrantedFloor";
  }
  player.sendMessage(Common.message(key, { item: name }));
  return true;
}

/**
 * A God Wars private chamber is the one instance the crystal can remember. Its event carries the
 * private area, and the chamber maps its copied tile back to the real chamber tile so the memory
 * remains meaningful after the instance is parked or (safely) expires.
 */
function godWarsRecallTarget(player, from, fromArea) {
  if (!from) return null;
  const area = fromArea ?? player.getPrivateArea?.();
  if (area?.isGodWarsInstance !== true || area.isDestroyed?.() || !area.faction?.key
      || typeof area.sourceOf !== "function") return null;
  const source = area.sourceOf(from);
  if (!source || !inBox(source, area.faction.room)) return null;
  return {
    x: source.getX(), y: source.getY(), z: source.getZ(),
    godwars: { faction: area.faction.key },
  };
}

function rememberTeleport({ player, from, fromInstance, fromArea }) {
  if (!unlocked(player) || !saving(player) || !carried(player) || !from) return;
  const source = godWarsRecallTarget(player, from, fromArea);
  const startsInInstance = fromInstance || (fromArea ?? player.getPrivateArea?.()) != null;
  if (startsInInstance && !source) return;
  const memory = source ?? { x: from.getX(), y: from.getY(), z: from.getZ() };
  const rememberedAt = source
    ? new (Common.core.Location)(source.x, source.y, source.z)
    : from;
  if ((effect.noRecall ?? []).some((box) => inBox(rememberedAt, box))) return;
  player.setAttribute(RECALL_ATTRIBUTE, memory);
}

function recalled(player) {
  const saved = player.getAttribute(RECALL_ATTRIBUTE);
  return saved && Number.isInteger(saved.x) ? saved : null;
}

/** Minutes left on the cooldown: 6 minus one per 300 total levels, none from 1,800. */
function cooldownMinutes(player) {
  const total = player.getSkillManager?.().getTotalLevel?.() ?? 0;
  const cut = Math.floor(total / effect.cooldownCutPerTotalLevels);
  return Math.max(0, effect.cooldownMinutes - cut);
}

function cooldownRemainingMs(player, now = Date.now()) {
  const readyAt = Number(player.getAttribute(READY_AT_ATTRIBUTE) ?? 0);
  const remaining = Math.max(0, readyAt - now);
  // A character who passes a total-level threshold while the crystal recharges gets the shorter
  // cooldown their new total level earns, including none at 1,800.
  return Math.min(remaining, cooldownMinutes(player) * 60_000);
}

function teleport(player, location, onArrival) {
  const { TeleportHandler, TeleportType } = Common.core;
  if (!TeleportHandler.checkReqs(player, location, effect.wildernessLevel)) return false;
  TeleportHandler.confirm(player, location,
    () => TeleportHandler.teleport(player, location, TeleportType.NORMAL, false, onArrival), effect.wildernessLevel);
  return true;
}

function teleportBack(event) {
  if (!unlocked(event.player)) return false;
  const player = event.player;
  const remaining = cooldownRemainingMs(player);
  if (remaining > 0) {
    player.sendMessage(Common.message("crystalCooldown", { seconds: Math.ceil(remaining / 1000) }));
    return true;
  }
  const saved = recalled(player);
  if (!saved) {
    player.sendMessage(Common.message("recallNothing"));
    return true;
  }
  const location = new (Common.core.Location)(saved.x, saved.y, saved.z);
  const onArrival = saved.godwars?.faction
    ? () => Common.api.emitCustomEvent("godwars:chamber-recall", {
      player, faction: saved.godwars.faction, location, handled: false,
    })
    : undefined;
  if (teleport(player, location, onArrival)) {
    const minutes = cooldownMinutes(player);
    player.setAttribute(READY_AT_ATTRIBUTE, minutes > 0 ? Date.now() + minutes * 60_000 : 0);
  }
  return true;
}

function checkMemory(event) {
  if (!unlocked(event.player)) return false;
  event.player.sendMessage(recalled(event.player) ? Common.message("crystalMemory") : Common.message("recallNothing"));
  if (!saving(event.player)) event.player.sendMessage(Common.message("crystalPaused"));
  return true;
}

/** Save-memory pauses or resumes remembering new teleports (issue #17). */
function saveMemory(event) {
  if (!unlocked(event.player)) return false;
  const on = !saving(event.player);
  event.player.setAttribute(SAVE_ATTRIBUTE, on);
  event.player.sendMessage(Common.message(on ? "crystalSaveOn" : "crystalSaveOff"));
  return true;
}

function onRelicUnlocked({ player, tier }) {
  const atTier = Common.activePassiveValues(player, "crystalOfMemories")
    .some((passive) => (passive.grantTier ?? passive.originalTier) - 1 === Number(tier));
  if (atTier) grantCrystal(player);
}

function onLogin({ player }) {
  grantCrystal(player);
}

module.exports = function attach(api) {
  effect = Common.data.effects.crystalOfMemories;
  api.persistAttribute(RECALL_ATTRIBUTE, null);
  api.persistAttribute(READY_AT_ATTRIBUTE, 0);
  api.persistAttribute(SAVE_ATTRIBUTE, true);
  api.onCustomEvent("teleport:landed", rememberTeleport);
  api.onCustomEvent("league:relic-unlocked", onRelicUnlocked);
  api.onPlayerLogin(onLogin);
  api.onItemAction(effect.toolName, {
    "Teleport-back": teleportBack,
    "Check-memories": checkMemory,
    "Save-memory": saveMemory,
  });
};

module.exports.unlocked = unlocked;
module.exports.grantCrystal = grantCrystal;
module.exports.holds = holds;
module.exports.carried = carried;
module.exports.saving = saving;
module.exports.cooldownMinutes = cooldownMinutes;
module.exports.cooldownRemainingMs = cooldownRemainingMs;
module.exports.RECALL_ATTRIBUTE = RECALL_ATTRIBUTE;
module.exports.READY_AT_ATTRIBUTE = READY_AT_ATTRIBUTE;
module.exports.SAVE_ATTRIBUTE = SAVE_ATTRIBUTE;
module.exports.FROM_TIER = FROM_TIER;
