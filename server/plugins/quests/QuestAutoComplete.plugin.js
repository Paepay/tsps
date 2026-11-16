/**
 * Worlds that switch the Quests plugin off still count every implemented quest as complete.
 * Only the definitions are loaded (their hook registrations are no-ops); quest gameplay stays off.
 */
const QuestRuntime = require("./QuestRuntime");
const Quests = require("./Quests.plugin.js");

let pluginApi = null;

function shouldAutoComplete(api) {
  return api.core.PluginManager?.getPluginSwitch?.("Quests") === false;
}

/**
 * Level-Up's auto-completed quests stand in for the Knight Waves too: its template hands out
 * Chivalry and Piety with the rest of the quest completion. Other Quests-off worlds keep the
 * activity's own gate (the Knight Waves plugin still answers false there).
 */
function levelUpPrayerUnlocks(request) {
  if (!request || request.bypass === true) return;
  if (typeof pluginApi?.getPluginConfig !== "function"
    || pluginApi.getPluginConfig("template:id", null) !== "level_up") return;
  const { CHIVALRY, PIETY } = pluginApi.core.PrayerData;
  if (request.prayer === CHIVALRY || request.prayer === PIETY) request.bypass = true;
}

/** The quest modules only need `core`, `persistAttribute` and a log sink while registering definitions. */
function definitionApi(api) {
  const core = api.core;
  const noop = () => undefined;
  let proxy;
  proxy = new Proxy(api, {
    get(target, property) {
      if (property === "core") return core;
      if (property === "withProfileLabel") return () => proxy;
      if (property === "persistAttribute") return (...args) => target.persistAttribute(...args);
      if (property === "log") return (...args) => target.log(...args);
      if (typeof property === "symbol") return target[property];
      return noop;
    },
  });
  return proxy;
}

function attach(api) {
  pluginApi = api;
  if (!shouldAutoComplete(api)) return;
  const names = Quests.questsForWorld(api.core);
  const definitions = QuestRuntime.registerQuestDefinitions(definitionApi(api), names);
  if (definitions.length === 0) return;
  QuestRuntime.registerQuestCompletion(api);
  // Quest shops and Sir Tiffy's common dialogue only existed through Quests. Their gates read
  // "quest:is-complete", which the completion hooks now answer.
  require("./Shops.Quests")(api);
  api.onCustomEvent("prayer:unlocks-bypass", levelUpPrayerUnlocks);
  if (api.core.WorldDefinition.isMembersWorld()) {
    require("./SirTiffy.Quests")(api);
    require("./ApeAtollGate.Quests").register(api);
  }
  api.log?.(`QuestAutoComplete: Quests is off; ${definitions.length} quests count as complete`);
}

module.exports = {
  name: "QuestAutoComplete",
  description: "Completes every implemented quest when the Quests plugin is switched off.",
  register(api) {
    attach(api);
  },
  _test: { shouldAutoComplete, definitionApi, levelUpPrayerUnlocks },
};
