/**
 * Infernal Gathering (https://oldschool.runescape.wiki/w/Infernal_Gathering), Trailblazer Reloaded's
 * tier 5 relic: the Trailblazer axe, pickaxe and harpoon (custom items: the cache reused their ids
 * for the Echo tools). They act as crystal tools with no requirement. Toggle turns the burn / smelt
 * / cook effect on or off for all three. With the effect on, chopped logs burn for Firemaking XP,
 * mined ore smelts into bars for Smithing XP (coal waived, as Power Miner's), and caught fish cook
 * for Cooking XP; with Endless Harvest the doubled yield is processed the same way (Wiki). The axe
 * and pickaxe work one tick faster, the harpoon two. Equipped, the harpoon stands in for any fishing
 * tool (bait still needed).
 */
const Common = require("./Common.LeagueRelics");

const MODE_ATTRIBUTE = "league:infernal-gathering-mode";
const BURN_GRAPHIC = 86;
const BURN_GRAPHIC_HEIGHT = 150;

let api;
let core;
let effect;
let smeltBars;

function active(player) {
  return Common.effectActive(player, effect);
}

function mode(player) {
  const current = player.getAttribute(MODE_ATTRIBUTE);
  return effect.modes.includes(current) ? current : effect.modes[0];
}

function processing(player) {
  return active(player) && mode(player) === "on";
}

/** Whether the player carries or wears the named Trailblazer tool. */
function holdsTool(player, name) {
  const id = core.ItemIdentifiers[name];
  return Number.isInteger(id)
    && (player.getInventory().contains(id) || player.getEquipment().contains(id));
}

function wieldsHarpoon(player) {
  const id = core.ItemIdentifiers.TRAILBLAZER_HARPOON;
  return player.getEquipment().contains(id);
}

/** Endless Harvest's doubled yield is processed here when burn/smelt/cook is on (Wiki). */
function yieldCount(player, amount) {
  const endless = Common.data.effects.endlessHarvest;
  if (endless && Common.effectActive(player, endless)) return amount * (endless.multiplier ?? 2);
  return amount;
}

function deliver(player, itemId, count) {
  if (count <= 0) return true;
  const endless = Common.data.effects.endlessHarvest;
  if (endless && Common.effectActive(player, endless) && Common.bank(player, itemId, count)) return true;
  const item = new core.Item(itemId, count);
  if (player.getInventory().getAddableAmount(item) < count) return false;
  player.getInventory().adds(itemId, count);
  return true;
}

function burnLogs(request) {
  const { player, itemId, amount } = request;
  if (request.stored >= amount || request.skill !== core.Skill.WOODCUTTING || !processing(player)
    || !holdsTool(player, "TRAILBLAZER_AXE")) return;
  const fire = { logId: itemId, xp: null };
  api.emitCustomEvent("firemaking:log-xp", fire);
  if (!(fire.xp > 0)) return;
  const count = yieldCount(player, amount);
  const outfit = { player, multiplier: 1 };
  api.emitCustomEvent("firemaking:xp-multiplier", outfit);
  player.getSkillManager().addExperiences(core.Skill.FIREMAKING, fire.xp * count * outfit.multiplier);
  player.performGraphic(new core.Graphic(BURN_GRAPHIC, 0, BURN_GRAPHIC_HEIGHT));
  player.getPacketSender().sendSoundEffect(core.Sound.FIRE_SUCCESSFUL.getId(), 1, 0, 1);
  request.stored = amount;
  request.gatherProcessed = true;
}

function smeltOre(request) {
  const { player, itemId, amount, xp } = request;
  if (request.stored >= amount || request.skill !== core.Skill.MINING || !processing(player)
    || !holdsTool(player, "TRAILBLAZER_PICKAXE")) return;
  if (!smeltBars.has(itemId)) return;
  const bar = { oreId: itemId, outputId: smeltBars.get(itemId), barId: null, xp: null };
  api.emitCustomEvent("smithing:bar-for-ore", bar);
  if (!bar.barId) return;
  const count = yieldCount(player, amount);
  if (!deliver(player, bar.barId, count)) return;
  if (bar.xp > 0) player.getSkillManager().addExperiences(core.Skill.SMITHING, bar.xp * count);
  const extra = count - amount;
  if (extra > 0 && xp > 0) player.getSkillManager().addExperiences(core.Skill.MINING, (xp * extra) / amount);
  request.stored = amount;
  request.gatherProcessed = true;
}

function cookFish(request) {
  const { player, itemId, amount, xp } = request;
  if (request.stored >= amount || request.skill !== core.Skill.FISHING || !processing(player)
    || !holdsTool(player, "TRAILBLAZER_HARPOON")) return;
  const cooked = { rawId: itemId, cookedId: null, xp: null };
  api.emitCustomEvent("cooking:cooked", cooked);
  if (!cooked.cookedId) return;
  const count = yieldCount(player, amount);
  if (!deliver(player, cooked.cookedId, count)) return;
  if (cooked.xp > 0) player.getSkillManager().addExperiences(core.Skill.COOKING, cooked.xp * count);
  const extra = count - amount;
  if (extra > 0 && xp > 0) player.getSkillManager().addExperiences(core.Skill.FISHING, (xp * extra) / amount);
  request.stored = amount;
  request.gatherProcessed = true;
}

function gather(request) {
  burnLogs(request);
  smeltOre(request);
  cookFish(request);
}

/** Burnt logs need no room; smelted / cooked output needs inventory or bank space. */
function room(request) {
  if (request.room || !processing(request.player)) return;
  const { player, itemId, skill } = request;
  if (skill === core.Skill.WOODCUTTING) {
    if (!holdsTool(player, "TRAILBLAZER_AXE")) return;
    const fire = { logId: itemId, xp: null };
    api.emitCustomEvent("firemaking:log-xp", fire);
    if (fire.xp > 0) request.room = true;
    return;
  }
  if (skill === core.Skill.MINING && holdsTool(player, "TRAILBLAZER_PICKAXE") && smeltBars.has(itemId)) {
    const bar = { oreId: itemId, outputId: smeltBars.get(itemId), barId: null, xp: null };
    api.emitCustomEvent("smithing:bar-for-ore", bar);
    if (bar.barId && (Common.bankHasRoom(player, bar.barId) || player.getInventory().getAddableAmount(new core.Item(bar.barId, 1)) > 0)) {
      request.room = true;
    }
    return;
  }
  if (skill === core.Skill.FISHING && holdsTool(player, "TRAILBLAZER_HARPOON")) {
    const cooked = { rawId: itemId, cookedId: null, xp: null };
    api.emitCustomEvent("cooking:cooked", cooked);
    if (cooked.cookedId && (Common.bankHasRoom(player, cooked.cookedId) || player.getInventory().getAddableAmount(new core.Item(cooked.cookedId, 1)) > 0)) {
      request.room = true;
    }
  }
}

function axeInterval(request) {
  if (request.skill === core.Skill.WOODCUTTING && request.kind === "chop" && active(request.player)
    && holdsTool(request.player, "TRAILBLAZER_AXE")) {
    request.ticks = Math.max(1, request.ticks - effect.axeTicksFaster);
  }
}

function harpoonInterval(request) {
  if (active(request.player) && holdsTool(request.player, "TRAILBLAZER_HARPOON")) {
    request.ticks -= effect.harpoonTicksFaster;
  }
}

/** Equipped, the harpoon stands in for any fishing tool (Wiki). */
function fishingTool(request) {
  if (request.variant || !active(request.player) || !wieldsHarpoon(request.player)) return;
  request.variant = { ids: [core.ItemIdentifiers.TRAILBLAZER_HARPOON], level: 1, bonus: effect.harpoonBonus };
}

function toggle({ player }) {
  if (!active(player)) return;
  const modes = effect.modes;
  const next = modes[(modes.indexOf(mode(player)) + 1) % modes.length];
  player.setAttribute(MODE_ATTRIBUTE, next);
  player.sendMessage(Common.message("infernalGatheringToggle", { mode: effect.modeText[next] }));
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  effect = Common.data.effects.infernalGathering;
  smeltBars = new Map(Object.entries(effect.smeltBars).map(([ore, bar]) => [core.ItemIdentifiers[ore], core.ItemIdentifiers[bar]]));
  api.persistAttribute(MODE_ATTRIBUTE, effect.modes[0]);
  for (const name of effect.toolNames) api.onItemAction(name, { Toggle: toggle });
  // Before Endless Harvest so burn/smelt/cook can claim the doubled yield (Wiki).
  api.onCustomEvent("storage:gather", gather);
  api.onCustomEvent("storage:room", room);
  api.onCustomEvent("skills:action-interval", axeInterval);
  api.onCustomEvent("fishing:interval", harpoonInterval);
  api.onCustomEvent("fishing:tool", fishingTool);
};
