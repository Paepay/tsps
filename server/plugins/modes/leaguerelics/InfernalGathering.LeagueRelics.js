/**
 * Infernal Gathering (https://oldschool.runescape.wiki/w/Infernal_Gathering), Trailblazer Reloaded's
 * tier 5 relic: the Trailblazer axe, pickaxe and harpoon (custom items: the cache reused their ids
 * for the Echo tools). They act as crystal tools with no requirement. Toggle turns the burn / smelt
 * / cook effect on or off for all three. With the effect on, the matching tool must be carried or
 * wielded: the axe burns chopped logs for Firemaking XP, the pickaxe smelts mined ore into bars for
 * Smithing XP (coal waived, as Power Miner's), and the harpoon cooks caught fish for Cooking XP;
 * with Endless Harvest the doubled yield is processed the same way (Wiki). The axe chops one tick
 * faster, the pickaxe always rolls every 2 ticks (Mining's own table), and the harpoon fishes two
 * ticks sooner. Equipped, the harpoon stands in for any fishing tool (bait still needed).
 */
const Common = require("./Common.LeagueRelics");

const MODE_ATTRIBUTE = "league:infernal-gathering-mode";
const BURN_GRAPHIC = 86;
const BURN_GRAPHIC_HEIGHT = 150;

let api;
let core;
let effect;
let smeltBars;
let toolIdsByName;

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

function toolId(name) {
  if (!toolIdsByName) {
    toolIdsByName = Object.fromEntries(
      effect.tools.map((tool) => [tool, core.ItemIdentifiers[tool]]).filter(([, id]) => Number.isInteger(id))
    );
  }
  return toolIdsByName[name];
}

/** Carried or wielded, as the Echo tools (Wiki). */
function holdsTool(player, name) {
  const id = toolId(name);
  return Number.isInteger(id) && (player.getInventory().contains(id) || player.getEquipment().contains(id));
}

function holdsAxe(player) {
  return holdsTool(player, "TRAILBLAZER_AXE");
}

function holdsPickaxe(player) {
  return holdsTool(player, "TRAILBLAZER_PICKAXE");
}

function holdsHarpoon(player) {
  return holdsTool(player, "TRAILBLAZER_HARPOON");
}

function wieldsHarpoon(player) {
  const id = toolId("TRAILBLAZER_HARPOON");
  return Number.isInteger(id) && player.getEquipment().contains(id);
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
  if (request.stored >= amount || request.skill !== core.Skill.WOODCUTTING || !processing(player) || !holdsAxe(player)) return;
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
  if (request.stored >= amount || request.skill !== core.Skill.MINING || !processing(player) || !holdsPickaxe(player)) return;
  if (!smeltBars.has(itemId)) return;
  const bar = { oreId: itemId, outputId: smeltBars.get(itemId), allowSecondary: true, barId: null, xp: null };
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
  if (request.stored >= amount || request.skill !== core.Skill.FISHING || !processing(player) || !holdsHarpoon(player)) return;
  const cooked = { rawId: itemId, cookedId: null, xp: null };
  api.emitCustomEvent("cooking:cooked", cooked);
  if (!cooked.cookedId) return;
  const count = yieldCount(player, amount);
  if (!deliver(player, cooked.cookedId, count)) return;
  if (cooked.xp > 0) player.getSkillManager().addExperiences(core.Skill.COOKING, cooked.xp * count);
  player.performGraphic(new core.Graphic(BURN_GRAPHIC, 0, BURN_GRAPHIC_HEIGHT));
  player.getPacketSender().sendSoundEffect(core.Sound.FIRE_SUCCESSFUL.getId(), 1, 0, 1);
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
  // Endless Harvest is the only thing that banks the processed output: without it, a full
  // inventory has no room for a bar or cooked fish just because the bank has a free slot (#18).
  const endless = Common.data.effects.endlessHarvest;
  const bankRoom = endless !== undefined && Common.effectActive(player, endless);
  if (skill === core.Skill.WOODCUTTING && holdsAxe(player)) {
    const fire = { logId: itemId, xp: null };
    api.emitCustomEvent("firemaking:log-xp", fire);
    if (fire.xp > 0) request.room = true;
    return;
  }
  if (skill === core.Skill.MINING && holdsPickaxe(player) && smeltBars.has(itemId)) {
    const bar = { oreId: itemId, outputId: smeltBars.get(itemId), allowSecondary: true, barId: null, xp: null };
    api.emitCustomEvent("smithing:bar-for-ore", bar);
    if (bar.barId && ((bankRoom && Common.bankHasRoom(player, bar.barId))
        || player.getInventory().getAddableAmount(new core.Item(bar.barId, 1)) > 0)) {
      request.room = true;
    }
    return;
  }
  if (skill === core.Skill.FISHING && holdsHarpoon(player)) {
    const cooked = { rawId: itemId, cookedId: null, xp: null };
    api.emitCustomEvent("cooking:cooked", cooked);
    if (cooked.cookedId && ((bankRoom && Common.bankHasRoom(player, cooked.cookedId))
        || player.getInventory().getAddableAmount(new core.Item(cooked.cookedId, 1)) > 0)) {
      request.room = true;
    }
  }
}

function axeInterval(request) {
  if (request.skill === core.Skill.WOODCUTTING && request.kind === "chop" && active(request.player) && holdsAxe(request.player)) {
    request.ticks = Math.max(1, request.ticks - effect.axeTicksFaster);
  }
}

function harpoonInterval(request) {
  if (active(request.player) && holdsHarpoon(request.player)) {
    request.ticks = Math.max(1, request.ticks - effect.harpoonTicksFaster);
  }
}

/** Equipped, the harpoon stands in for any fishing tool (Wiki). */
function fishingTool(request) {
  if (request.variant || !active(request.player) || !wieldsHarpoon(request.player)) return;
  const id = toolId("TRAILBLAZER_HARPOON");
  if (!Number.isInteger(id)) return;
  request.variant = { ids: [id], level: 1, bonus: effect.harpoonBonus };
}

function toggle({ player }) {
  // The tools are untradeable league items; still answer Toggle without the relic so a spawned
  // copy is not a silent no-op (the burn/smelt/cook effects themselves need the relic).
  const modes = effect.modes;
  const next = modes[(modes.indexOf(mode(player)) + 1) % modes.length];
  player.setAttribute(MODE_ATTRIBUTE, next);
  player.sendMessage(Common.message("infernalGatheringToggle", { mode: effect.modeText[next] }));
  return true;
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  effect = Common.data.effects.infernalGathering;
  toolIdsByName = null;
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
