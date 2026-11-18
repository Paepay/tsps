/**
 * Achievement-diary completion provider.
 *
 * With the real AchievementDiaries plugin loaded this unit only answers
 * `diary:complete-all` (the Level-Up template calls it on login). When the platform's
 * Achievement Diaries switch removes that plugin, this unit takes its place so a world
 * that has diaries off still behaves as if every diary were finished:
 *
 * - every task is marked done on login, so the diary tab shows each tier complete;
 * - the diary:* queries other content uses for perks are answered;
 * - the journal, reward NPCs, Twiggy's cape and noted drops stay available, so every
 *   unique reward item and perk can still be obtained.
 *
 * Rewards are deliberately left unclaimed: each diary's reward NPC can then hand out
 * that tier's unique item, reward varbit and daily effects. The tier's antique lamp is
 * withheld because the task was auto-completed rather than earned.
 */
const { TIERS, DIARIES, BY_KEY } = require("./diaries/Data.AchievementDiaries");
const Progress = require("./diaries/Progress.AchievementDiaries");
const Journal = require("./diaries/Journal.AchievementDiaries");
const Rewards = require("./diaries/Rewards.AchievementDiaries");
const Lamps = require("./diaries/Lamps.AchievementDiaries");
const Cape = require("./diaries/Cape.AchievementDiaries");
const NotedDrops = require("./diaries/NotedDrops.AchievementDiaries");

let api = null;
let standalone = false;

function allTaskKeys(diary) {
  return TIERS.flatMap((tier) => diary.tiers[tier].tasks.map((task) => task.key));
}

/** Writes every current task as done and sends the tab's varbits. Rewards stay claimable. */
function completeAll(player) {
  if (!player?.getAttribute || !player?.setAttribute) return false;
  const tasks = {};
  for (const diary of DIARIES) tasks[diary.key] = allTaskKeys(diary);
  player.setAttribute(Progress.TASKS_ATTRIBUTE, tasks);
  for (const diary of DIARIES) Progress.sendDiary(player, diary);
  api?.emitCustomEvent?.("persistence:save", { player, reason: "diary-complete-all" });
  return true;
}

function onCompleteAll(request) {
  if (request?.player) completeAll(request.player);
}

function onIsComplete(request) {
  if (!standalone) return;
  const diary = BY_KEY.get(request.diary);
  if (diary && request.player && TIERS.includes(request.tier)) {
    request.complete = Progress.isTierComplete(request.player, diary, request.tier);
  }
}

function onIsStarted(request) {
  if (!standalone) return;
  const diary = BY_KEY.get(request.diary);
  if (diary && request.player) request.started = Progress.isStarted(request.player, diary);
}

function onHasTask(request) {
  if (!standalone) return;
  const diary = BY_KEY.get(request.diary);
  if (diary && request.player && typeof request.task === "string") {
    request.done = Progress.doneTasks(request.player, diary).has(request.task);
  }
}

function onIsRewardClaimed(request) {
  if (!standalone) return;
  const diary = BY_KEY.get(request.diary);
  if (diary && request.player && TIERS.includes(request.tier)) {
    request.claimed = Progress.claimedTiers(request.player, diary).has(request.tier);
  }
}

/**
 * Every tier is complete, so the reward NPC must not refuse it for the tier's stat
 * requirement. The lamp is withheld because the completion was automatic.
 */
function onRewardsUnrestricted(request) {
  if (!standalone) return;
  request.unrestricted = true;
  request.includeXpLamps = false;
}

function onAllComplete(request) {
  if (!standalone) return;
  if (request.player) {
    request.complete = DIARIES.every((diary) => TIERS.every((tier) => Progress.isTierComplete(request.player, diary, tier)));
  }
}

function onTokkul(request) {
  if (!standalone) return;
  const diary = BY_KEY.get("karamja");
  if (diary && request.player && Progress.isTierComplete(request.player, diary, "elite")) request.amount *= 2;
}

function completeOnLogin({ player }) {
  if (standalone) completeAll(player);
}

function onPluginsLoaded({ names }) {
  if (names?.has?.("AchievementDiaries")) return;
  standalone = true;
  Progress(api);
  Journal(api);
  Rewards(api);
  Lamps(api);
  Cape(api);
  NotedDrops(api);
  api.log?.("AchievementDiaries is off: diary tasks are complete and reward NPCs are available.");
}

module.exports = {
  name: "AchievementDiaryCompletion",
  description: "Marks achievement diaries complete when AchievementDiaries is off, and completes them for every Level-Up account.",
  members: true,
  register(pluginApi) {
    api = pluginApi;
    standalone = false;
    api.onCustomEvent("plugins:loaded", onPluginsLoaded);
    api.onCustomEvent("diary:complete-all", onCompleteAll);
    api.onPlayerLogin(completeOnLogin);
    api.onCustomEvent("diary:is-complete", onIsComplete);
    api.onCustomEvent("diary:is-started", onIsStarted);
    api.onCustomEvent("diary:has-task", onHasTask);
    api.onCustomEvent("diary:is-reward-claimed", onIsRewardClaimed);
    api.onCustomEvent("diary:rewards-unrestricted", onRewardsUnrestricted);
    api.onCustomEvent("diary:all-complete", onAllComplete);
    api.onCustomEvent("diary:tokkul", onTokkul);
  },
  _test: {
    completeAll, onIsComplete, onIsStarted, onHasTask, onIsRewardClaimed,
    onRewardsUnrestricted, onAllComplete, onTokkul, onPluginsLoaded,
  },
};
