/**
 * Combat Mastery points (https://oldschool.runescape.wiki/w/Raging_Echoes_League/Combat_Masteries#Unlocking):
 * ten challenges, a point each, in any order. A kill is judged against the data's rules (the
 * NPC's name, combat level or Slayer requirement, alone or counted); the combat level challenge
 * is checked on every level-up and at login. As captured (227/00075), a point flips its
 * league_combat_mastery_point_unlock varbit, raises points_earned and points_to_spend and shows
 * the green game message. No Echo boss is in this cache, so `::mastery point` is the only way to
 * those three (the data says so).
 */
const Common = require("./Common.LeagueCombatMasteries");

/** The challenges this character can complete: Level-Up omits entries the cache cannot support. */
function challenges(player) {
  return player && Common.isLevelUp(player) ? Common.levelUpChallenges() : Common.data.challenges.list;
}

function challenge(key, player) {
  return challenges(player).find((entry) => entry.key === key) ?? null;
}

/** The names a kill rule matches: its own list, or a named list of the data (giants, echo bosses). */
function ruleNames(rule) {
  return Array.isArray(rule.names) ? rule.names : Common.data.challenges[rule.names] ?? [];
}

function sendPoints(player) {
  const { varbits } = Common.data;
  const sender = player.getPacketSender();
  const done = Common.pointsEarned(player);
  // The interface draws one row per challenge actually listed, so an unlock
  // varbit belongs to that row's position. Level-Up drops the unsupported Echo
  // challenges, which moves TzKal-Zuk's highlight up with it.
  const visible = challenges(player);
  visible.forEach((entry, index) => sender.sendVarbit(varbits.pointUnlocks[index], done[entry.key] ? 1 : 0));
  for (let index = visible.length; index < varbits.pointUnlocks.length; index++) {
    sender.sendVarbit(varbits.pointUnlocks[index], 0);
  }
  sender.sendVarbit(varbits.pointsEarned, Common.earned(player));
  sender.sendVarbit(varbits.pointsToSpend, Common.available(player));
}

/** Awards the challenge's point once. Returns true when it was new. */
function award(player, key) {
  if (!Common.isEchoes(player) || !challenge(key, player)) return false;
  const done = Common.pointsEarned(player);
  if (done[key]) return false;
  player.setAttribute(Common.POINTS_ATTRIBUTE, { ...done, [key]: 1 });
  sendPoints(player);
  player.sendMessage(Common.data.notifications.pointEarned.text);
  Common.api.emitCustomEvent("league:mastery-point", { player, challenge: key, earned: Common.earned(player) });
  return true;
}

function npcName(npc) {
  return npc?.getCurrentDefinition?.()?.getName?.() ?? npc?.getDefinition?.()?.getName?.() ?? null;
}

function killMatches(rule, name, definition) {
  if (rule.names && !ruleNames(rule).includes(name)) return false;
  if (rule.minCombatLevel && !((definition?.getCombatLevel?.() | 0) >= rule.minCombatLevel)) return false;
  if (rule.minSlayerLevel && !((definition?.getSlayerLevel?.() | 0) >= rule.minSlayerLevel)) return false;
  return true;
}

function npcDeath({ killer, damagers, npc }) {
  if (!killer || !Common.isEchoes(killer)) return;
  const name = npcName(npc);
  const definition = npc?.getCurrentDefinition?.() ?? npc?.getDefinition?.();
  const done = Common.pointsEarned(killer);
  let progress = null;
  const earnedNow = [];
  for (const entry of challenges(killer)) {
    const { rule } = entry;
    if (!rule.kill || done[entry.key] || !killMatches(rule.kill, name, definition)) continue;
    if (rule.kill.solo && (damagers ?? [killer]).some((damager) => damager !== killer)) continue;
    const track = rule.track ?? entry.key;
    if (rule.count) {
      progress ??= { ...Common.progress(killer) };
      progress[track] = (Number(progress[track]) || 0) + 1;
      if (progress[track] < rule.count) continue;
    } else if (rule.unique) {
      progress ??= { ...Common.progress(killer) };
      const seen = Array.isArray(progress[track]) ? progress[track] : [];
      progress[track] = seen.includes(name) ? seen : [...seen, name];
      if (progress[track].length < rule.unique) continue;
    }
    earnedNow.push(entry.key);
  }
  if (progress) killer.setAttribute(Common.PROGRESS_ATTRIBUTE, progress);
  for (const key of earnedNow) award(killer, key);
}

function checkCombatLevel(player) {
  if (!Common.isEchoes(player)) return;
  const level = player.getSkillManager().getCombatLevel();
  for (const entry of challenges(player)) {
    if (entry.rule.combatLevel && level >= entry.rule.combatLevel) award(player, entry.key);
  }
}

function levelUp({ player }) {
  checkCombatLevel(player);
}

function login({ player }) {
  if (!Common.isEchoes(player)) return;
  sendPoints(player);
  checkCombatLevel(player);
}

module.exports = function attach(api) {
  api.persistAttribute(Common.POINTS_ATTRIBUTE, {});
  api.persistAttribute(Common.PROGRESS_ATTRIBUTE, {});
  api.onNpcDeath(npcDeath);
  api.onPlayerLevelUp(levelUp);
  api.onCustomEvent("league:login", login);
};

module.exports.award = award;
module.exports.challenge = challenge;
module.exports.challenges = challenges;
module.exports.sendPoints = sendPoints;
module.exports.checkCombatLevel = checkCombatLevel;
