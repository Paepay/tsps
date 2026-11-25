/**
 * Monkey Madness II's post-quest Zooknock replacements when Quests is off.
 *
 * QuestAutoComplete marks the quest complete (stage 195) but leaves the quest module's hooks
 * behind a definition-only proxy. NpcDialogues still plays the canonical post-quest transcript,
 * whose "already have one of those" branches were unresolved and therefore always taken. The
 * shared reclaim unit supplies the same ownership conditions and hand-outs as the Quests world
 * (issue 196).
 */
const QuestRuntime = require("./QuestRuntime");
const ZooknockReclaims = require("./monkeymadnessii/ZooknockReclaims.MonkeyMadnessII");

module.exports = function attachMonkeyMadnessIIQuests(api) {
  const quest = QuestRuntime.getRegisteredQuests().find((entry) => entry.key === "monkey_madness_ii");
  if (!quest) return false;
  ZooknockReclaims.attach(api, { stageOf: (player) => quest.getStage(player) });
  return true;
};
