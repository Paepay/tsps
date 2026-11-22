/**
 * Slayer Master (https://oldschool.runescape.wiki/w/Slayer_Master_(Raging_Echoes_League)), Raging
 * Echoes' tier 5 relic:
 * - Every Slayer monster counts as on task (its Slayer XP, the slayer helmet's bonus and every
 *   "on task" check), without counting down the real task. This off-task credit does not bring
 *   a superior, which needs a genuine assignment kill.
 * - The Slayer reward shop's unlocks and extensions, cancelling and blocking, and its rune pouch,
 *   herb sack and looting bag cost no points (the unlocks still take a click: ours).
 * - The 100th kill of each Slayer monster gives 1,000 to 15,000 bonus Slayer XP by its Slayer
 *   requirement (ours: in a straight line from level 1 to 99), with the usual multipliers.
 * Not here: the Brimstone and Larran's keys anywhere (they follow the league's areas).
 */
const Common = require("./Common.LeagueRelics");

const KILLS_ATTRIBUTE = "league:slayer-kills";

let core;
let effect;
let freeItems;

function active(player) {
  return Common.effectActive(player, effect);
}

function alwaysOnTask(request) {
  if (active(request.player)) request.onTask = true;
}

function rewardCost(request) {
  if (!active(request.player)) return;
  if (request.kind === "buy" ? freeItems.has(request.itemId) : effect.freeKinds.includes(request.kind)) request.cost = 0;
}

function bonusXp(level) {
  const [low, high] = effect.bonusXp;
  const share = (Math.max(1, Math.min(99, level)) - 1) / 98;
  return Math.round(low + (high - low) * share);
}

/** Counts each Slayer monster's kills; the 100th brings the bonus. */
function taskKill({ player, npc }) {
  if (!player || !npc || !active(player)) return;
  const definition = npc.getCurrentDefinition?.() ?? npc.getDefinition?.();
  const name = String(definition?.getName?.() ?? "");
  if (!name) return;
  const kills = { ...(player.getAttribute(KILLS_ATTRIBUTE) ?? {}) };
  kills[name] = (kills[name] ?? 0) + 1;
  player.setAttribute(KILLS_ATTRIBUTE, kills);
  if (kills[name] !== effect.bonusKill) return;
  const xp = bonusXp(definition?.getSlayerLevel?.() ?? 1);
  player.getSkillManager().addExperiences(core.Skill.SLAYER, xp);
  player.sendMessage(Common.message("slayerBonusXp", { xp: xp.toLocaleString("en-US") }));
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.slayerMaster;
  freeItems = new Set(effect.freeItems.map((name) => core.ItemIdentifiers[name]));
  api.persistAttribute(KILLS_ATTRIBUTE, {});
  api.onCustomEvent("slayer:always-on-task", alwaysOnTask);
  api.onCustomEvent("slayer:reward-cost", rewardCost);
  api.onCustomEvent("slayer:task-kill", taskKill);
};

module.exports.KILLS_ATTRIBUTE = KILLS_ATTRIBUTE;
