/**
 * Unlocking a mastery: the checks (a Raging Echoes character, a real tier, not yet unlocked, the
 * previous tier of its style, a point to spend), the save and the captured presentation (the
 * style's progress varbit, points_to_spend, human_relic_unlock 8524, the league's mastery
 * graphic at height 92, the modal closed, four sounds). Masteries are permanent (the interface's
 * own confirm text: "You cannot go back on this decision"). Also the varbits at login and the
 * `league:masteries` query.
 */
const Common = require("./Common.LeagueCombatMasteries");

function sendProgress(player) {
  const { varbits, tutorialValue } = Common.data;
  const sender = player.getPacketSender();
  // The client's node scripts gate their Unlocked/Locked/Select texts on the cached league
  // feature flag, so it must arrive with the progress values even before the interface opens.
  Common.sendFeatureFlags(player);
  const tiers = Common.masteries(player);
  for (const key of Common.STYLE_KEYS) sender.sendVarbit(Common.style(key).progressVarbit, tiers[key]);
  sender.sendVarbit(varbits.tutorial, tutorialValue);
  sender.sendVarbit(varbits.lastViewed, 0);
  sender.sendVarbit(varbits.tab, 0);
}

/** Why an unlock is refused (a message key), or null when it may go ahead. */
function refusal(player, styleKey, tierNumber) {
  if (!Common.isEchoes(player)) return "notLeague";
  if (!Common.mastery(styleKey, tierNumber)) return "noSuchMastery";
  if (Common.tier(player, styleKey) >= tierNumber) return "alreadyUnlocked";
  const required = Common.required(styleKey, tierNumber);
  if (required && Common.tier(player, required.styleKey) < required.tier) return "needsPrevious";
  if (Common.available(player) < 1) return "noPoints";
  return null;
}

function present(player, styleKey) {
  const { Animation, Graphic } = Common.core;
  const { interface: ui, varbits } = Common.data;
  const sender = player.getPacketSender();
  sender.sendVarbit(Common.style(styleKey).progressVarbit, Common.tier(player, styleKey));
  sender.sendVarbit(varbits.pointsToSpend, Common.available(player));
  player.performAnimation(new Animation(ui.unlockAnimation));
  player.performGraphic(new Graphic(ui.unlockSpotanim, 0, ui.unlockGraphicHeight));
  sender.sendInterfaceRemoval();
  for (const [sound, delay] of ui.unlockSounds) sender.sendSound(sound, 1, delay);
}

/** Unlocks tier `tierNumber` (1-6) of `styleKey` for the player, or tells them why not. Returns true when unlocked. */
function unlock(player, styleKey, tierNumber) {
  const why = refusal(player, styleKey, tierNumber);
  if (why) {
    player.sendMessage(Common.message(why, { previous: Common.required(styleKey, tierNumber)?.name ?? "" }));
    return false;
  }
  const passiveBefore = Common.passiveTier(player);
  player.setAttribute(Common.MASTERIES_ATTRIBUTE, { ...Common.masteries(player), [styleKey]: tierNumber });
  present(player, styleKey);
  Common.api.emitCustomEvent("league:mastery-unlocked", {
    player, style: styleKey, tier: tierNumber, key: Common.mastery(styleKey, tierNumber).key,
    passiveUnlocked: tierNumber > passiveBefore,
  });
  return true;
}

function login({ player }) {
  if (Common.isEchoes(player)) sendProgress(player);
}

/** `league:masteries` { player } -> league, masteries { melee, ranged, magic }, passiveTier, points { earned, spent, available }, challenges (keys done). */
function answerMasteries(query) {
  if (!query) return;
  const { player } = query;
  const echoes = player ? Common.isEchoes(player) : false;
  query.league = echoes ? Common.data.league : null;
  query.masteries = echoes ? Common.masteries(player) : Common.emptyMasteries();
  query.passiveTier = echoes ? Common.passiveTier(player) : 0;
  query.points = echoes
    ? { earned: Common.earned(player), spent: Common.spent(player), available: Common.available(player) }
    : { earned: 0, spent: 0, available: 0 };
  query.challenges = echoes ? Object.keys(Common.pointsEarned(player)) : [];
}

module.exports = function attach(api) {
  api.persistAttribute(Common.MASTERIES_ATTRIBUTE, Common.emptyMasteries());
  api.onCustomEvent("league:login", login);
  api.onCustomEvent("league:masteries", answerMasteries);
};

module.exports.unlock = unlock;
module.exports.refusal = refusal;
module.exports.sendProgress = sendProgress;
