"use strict";

/**
 * Skilling Global Events (Paepay/tsps#65).
 *
 * Endless Harvest banks gathered resources, Abundance doubles them (and the extra resource's
 * experience), Infernal Gathering processes what is gathered, Production Master batches
 * production, and Trickster guarantees eligible Thieving and Hunter success. Every effect is
 * gated by the player's own Enable Effects switch for that event instance.
 *
 * The Infernal Gathering handler is registered before the banking/duplication handler so a
 * processed yield is never also banked as a raw resource. With Abundance active, the processed
 * yield is doubled first; with Endless Harvest active, the processed output is banked.
 */

const Common = require("./Common.GlobalEvents");

const BURN_GRAPHIC = 86;
const BURN_GRAPHIC_HEIGHT = 150;

let api;
let core;
let endlessSkills;
let abundanceSkills;
let smeltBars;

function enabled(player, eventId) {
  return Common.effectsEnabled(player, eventId);
}

function skillSet(eventId, fallback) {
  const names = Common.definition(eventId)?.config?.skills ?? fallback;
  return new Set((names ?? []).map((name) => core.Skill[name]).filter(Boolean));
}

function bankHasRoom(player, itemId) {
  const container = player.getBank(core.Bank.getTabForItem(player, itemId));
  return container.getFreeSlots() > 0 || container.contains(itemId);
}

function bank(player, itemId, amount) {
  if (amount <= 0 || !bankHasRoom(player, itemId)) return false;
  player.getBank(core.Bank.getTabForItem(player, itemId)).add(new core.Item(itemId, amount), true);
  return true;
}

function abundanceMultiplier(player) {
  return enabled(player, "abundance")
    ? Number(Common.effectOf("abundance")?.xpMultiplier ?? Common.definition("abundance")?.config?.multiplier ?? 2)
    : 1;
}

/* --------------------------------------------------------- banking / doubling --- */

/**
 * The single `storage:gather` handler. Abundance's extra resources are placed first, then the
 * whole yield is banked when Endless Harvest is on; with only Abundance, the extra goes to the
 * inventory. The extra's experience is paid only for resources actually placed.
 */
function gather(request) {
  const { player, itemId, amount, skill, xp } = request;
  if (request.gatherProcessed || !player || !(amount > 0)) return;
  const endless = enabled(player, "endless-harvest") && endlessSkills.has(skill);
  const abundance = enabled(player, "abundance") && abundanceSkills.has(skill);
  if (!endless && !abundance) return;

  const left = Math.max(0, amount - (Number(request.stored) || 0));
  const extra = abundance ? amount * (abundanceMultiplier(player) - 1) : 0;
  let placedExtra = 0;

  if (endless && bank(player, itemId, left + extra)) {
    request.stored = amount;
    placedExtra = extra;
  } else if (extra > 0) {
    const inventory = player.getInventory();
    const room = inventory.getAddableAmount(new core.Item(itemId, left + extra));
    placedExtra = Math.max(0, Math.min(extra, room - left));
    if (placedExtra > 0) inventory.adds(itemId, placedExtra);
  }

  if (placedExtra > 0 && xp > 0) {
    player.getSkillManager().addExperiences(skill, (xp * placedExtra) / amount);
  }
}

/** `storage:room`: Endless Harvest's bank room (or Abundance's extra room) keeps gathering going. */
function room(request) {
  if (request.room || !request.player) return;
  const { player, itemId, skill } = request;
  if (enabled(player, "endless-harvest") && endlessSkills.has(skill) && bankHasRoom(player, itemId)) {
    request.room = true;
    return;
  }
  if (enabled(player, "abundance") && abundanceSkills.has(skill)
      && player.getInventory().getAddableAmount(new core.Item(itemId, 1)) > 0) {
    request.room = true;
  }
}

/* --------------------------------------------------------- Infernal Gathering --- */

function processing(player) {
  return enabled(player, "infernal-gathering");
}

/** The got yield in the shape the league relic uses: Abundance doubles it first. */
function yieldCount(player, amount, skill) {
  const multiplier = abundanceSkills.has(skill) ? abundanceMultiplier(player) : 1;
  return amount * multiplier;
}

function deliver(player, skill, itemId, count) {
  if (count <= 0) return true;
  if (enabled(player, "endless-harvest") && endlessSkills.has(skill) && bank(player, itemId, count)) return true;
  const item = new core.Item(itemId, count);
  if (player.getInventory().getAddableAmount(item) < count) return false;
  player.getInventory().adds(itemId, count);
  return true;
}

function burnLogs(request) {
  const { player, itemId, amount, skill, xp } = request;
  if (request.stored >= amount || skill !== core.Skill.WOODCUTTING || !processing(player)) return;
  const fire = { logId: itemId, xp: null };
  api.emitCustomEvent("firemaking:log-xp", fire);
  if (!(fire.xp > 0)) return;
  const count = yieldCount(player, amount, skill);
  player.getSkillManager().addExperiences(core.Skill.FIREMAKING, fire.xp * count);
  player.performGraphic(new core.Graphic(BURN_GRAPHIC, 0, BURN_GRAPHIC_HEIGHT));
  player.getPacketSender().sendSoundEffect(core.Sound.FIRE_SUCCESSFUL.getId(), 1, 0, 1);
  const extra = count - amount;
  if (extra > 0 && xp > 0) player.getSkillManager().addExperiences(skill, (xp * extra) / amount);
  request.stored = amount;
  request.gatherProcessed = true;
}

function smeltOre(request) {
  const { player, itemId, amount, skill, xp } = request;
  if (request.stored >= amount || skill !== core.Skill.MINING || !processing(player)) return;
  const bar = { oreId: itemId, outputId: smeltBars.get(itemId), allowSecondary: true, barId: null, xp: null };
  api.emitCustomEvent("smithing:bar-for-ore", bar);
  if (!bar.barId) return;
  const count = yieldCount(player, amount, skill);
  if (!deliver(player, skill, bar.barId, count)) return;
  if (bar.xp > 0) player.getSkillManager().addExperiences(core.Skill.SMITHING, bar.xp * count);
  const extra = count - amount;
  if (extra > 0 && xp > 0) player.getSkillManager().addExperiences(skill, (xp * extra) / amount);
  request.stored = amount;
  request.gatherProcessed = true;
}

function cookFish(request) {
  const { player, itemId, amount, skill, xp } = request;
  if (request.stored >= amount || skill !== core.Skill.FISHING || !processing(player)) return;
  const cooked = { rawId: itemId, cookedId: null, xp: null };
  api.emitCustomEvent("cooking:cooked", cooked);
  if (!cooked.cookedId) return;
  const count = yieldCount(player, amount, skill);
  if (!deliver(player, skill, cooked.cookedId, count)) return;
  if (cooked.xp > 0) player.getSkillManager().addExperiences(core.Skill.COOKING, cooked.xp * count);
  player.performGraphic(new core.Graphic(BURN_GRAPHIC, 0, BURN_GRAPHIC_HEIGHT));
  player.getPacketSender().sendSoundEffect(core.Sound.FIRE_SUCCESSFUL.getId(), 1, 0, 1);
  const extra = count - amount;
  if (extra > 0 && xp > 0) player.getSkillManager().addExperiences(skill, (xp * extra) / amount);
  request.stored = amount;
  request.gatherProcessed = true;
}

function infernalGather(request) {
  burnLogs(request);
  smeltOre(request);
  cookFish(request);
}

/** `storage:room`: a processed output's bank or inventory room also keeps the action going. */
function infernalRoom(request) {
  if (request.room || !processing(request.player)) return;
  const { player, itemId, skill } = request;
  const bankRoom = enabled(player, "endless-harvest") && endlessSkills.has(skill);
  const fits = (outputId) => (bankRoom && bankHasRoom(player, outputId))
    || player.getInventory().getAddableAmount(new core.Item(outputId, 1)) > 0;
  if (skill === core.Skill.WOODCUTTING) {
    const fire = { logId: itemId, xp: null };
    api.emitCustomEvent("firemaking:log-xp", fire);
    if (fire.xp > 0) request.room = true;
  } else if (skill === core.Skill.MINING) {
    const bar = { oreId: itemId, outputId: smeltBars.get(itemId), allowSecondary: true, barId: null, xp: null };
    api.emitCustomEvent("smithing:bar-for-ore", bar);
    if (bar.barId && fits(bar.barId)) request.room = true;
  } else if (skill === core.Skill.FISHING) {
    const cooked = { rawId: itemId, cookedId: null, xp: null };
    api.emitCustomEvent("cooking:cooked", cooked);
    if (cooked.cookedId && fits(cooked.cookedId)) request.room = true;
  }
}

/* --------------------------------------------------------- Production Master --- */

function actionsPerCycle(request) {
  if (!request.player || !enabled(request.player, "production-master")) return;
  const effect = Common.definition("production-master");
  const batch = Common.config().production?.batch ?? effect?.config?.batch ?? {};
  const skill = Object.keys(batch).find((name) => core.Skill[name] === request.skill);
  if (!skill || !batch[skill].includes(request.kind)) return;
  // Far above any real inventory; each loop still stops when its materials or space run out.
  request.actions = Math.max(request.actions ?? 1, Number.MAX_SAFE_INTEGER);
}

/* --------------------------------------------------------------- Trickster --- */

function alwaysSucceeds(request) {
  if (request.player && enabled(request.player, "trickster")) request.alwaysSucceeds = true;
}

function catchChance(request) {
  if (request.player && enabled(request.player, "trickster")) request.chance = 1;
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  endlessSkills = skillSet("endless-harvest", ["MINING", "WOODCUTTING", "FISHING"]);
  abundanceSkills = skillSet("abundance", ["MINING", "WOODCUTTING", "FISHING"]);
  smeltBars = new Map();
  // Registered first: a processed yield never reaches the banking / duplication handler.
  api.onCustomEvent("storage:gather", infernalGather);
  api.onCustomEvent("storage:gather", gather);
  api.onCustomEvent("storage:room", infernalRoom);
  api.onCustomEvent("storage:room", room);
  api.onCustomEvent("skills:actions-per-cycle", actionsPerCycle);
  // Pickpocketing and hunter catches already ask these; stalls and blackjacking now ask the
  // same success question so Trickster covers every eligible action, not just a subset.
  api.onCustomEvent("thieving:pickpocket-target", alwaysSucceeds);
  api.onCustomEvent("thieving:stall-success", alwaysSucceeds);
  api.onCustomEvent("thieving:blackjack-success", alwaysSucceeds);
  api.onCustomEvent("thieving:lock-success", alwaysSucceeds);
  api.onCustomEvent("thieving:search-success", alwaysSucceeds);
  api.onCustomEvent("hunter:catch-chance", catchChance);
}

module.exports = { attach, _test: { gather, room, infernalGather, actionsPerCycle, alwaysSucceeds, catchChance } };
